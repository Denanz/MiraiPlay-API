import { findAnime } from './shikimori.js';
import { SHIKI_API_BASE, SHIKI_UA, validAccessToken } from './shikimori-auth.js';

/**
 * Перенос списков между MiraiHub и Shikimori.
 *
 * Операция массовая и пишет в живой аккаунт, поэтому здесь три обязательных
 * свойства: бэкап доступен до любой записи, есть холостой прогон, и запросы
 * идут с паузой — Shikimori держит ~90 запросов в минуту, и без throttle
 * перенос упрётся в блокировку на середине.
 */

/** ~1 запрос в 750 мс — с запасом под лимит 90/мин. */
const THROTTLE_MS = 750;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ShikiRate {
  target_id: number;
  target_type: string;
  status: string;
  episodes: number;
  score: number;
  rewatches?: number;
  text?: string | null;
  updated_at?: string;
}

/** Полная выгрузка списка с Shikimori — для бэкапа и для переноса в MiraiHub. */
export async function exportShikiRates(userId: number): Promise<ShikiRate[] | null> {
  const auth = await validAccessToken(userId);
  if (!auth) return null;
  // v2/user_rates ИГНОРИРУЕТ page и limit: любой запрос возвращает список
  // целиком. Пагинация здесь не просто лишняя — она давала N копий одних и тех
  // же записей (40 страниц → каждая запись по 40 раз). Поэтому один запрос,
  // плюс дедупликация по target_id как страховка на случай смены поведения.
  try {
    const res = await fetch(
      `${SHIKI_API_BASE}/api/v2/user_rates?user_id=${auth.shikiUserId}&target_type=Anime`,
      { headers: { authorization: `Bearer ${auth.accessToken}`, 'user-agent': SHIKI_UA } },
    );
    if (!res.ok) return [];
    const list = (await res.json()) as ShikiRate[];
    if (!Array.isArray(list)) return [];
    const byTarget = new Map<number, ShikiRate>();
    for (const r of list) if (r?.target_id) byTarget.set(r.target_id, r);
    return [...byTarget.values()];
  } catch {
    return [];
  }
}

/** Что переносим: один тайтл из MiraiHub в терминах Shikimori. */
export interface MiraiItem {
  releaseId: string;
  titleRu?: string;
  titleOrig?: string;
  titleAlt?: string;
  /** Сколько серий просмотрено. */
  episodes?: number;
  /** Оценка 1–10, если есть. */
  score?: number;
  status?: 'planned' | 'watching' | 'completed' | 'on_hold' | 'dropped';
}

export interface MigrateReport {
  total: number;
  matched: number;
  written: number;
  /** Тайтлы, которым не нашлось соответствия на Shikimori — переносить нечего. */
  unmatched: string[];
  failed: string[];
}

/**
 * MiraiHub → Shikimori. Пишет статус, число серий и оценку.
 *
 * dryRun проходит весь путь, включая сопоставление названий (самая ненадёжная
 * часть), но не отправляет ни одной записи — так видно заранее, что именно
 * уедет и что не нашлось.
 */
export async function migrateToShikimori(
  userId: number,
  items: MiraiItem[],
  opts: { dryRun?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<MigrateReport | null> {
  const auth = await validAccessToken(userId);
  if (!auth) return null;

  const report: MigrateReport = {
    total: items.length,
    matched: 0,
    written: 0,
    unmatched: [],
    failed: [],
  };

  let done = 0;
  for (const it of items) {
    done++;
    opts.onProgress?.(done, items.length);

    const anime = await findAnime({
      ru: it.titleRu,
      orig: it.titleOrig,
      alt: it.titleAlt,
    }).catch(() => null);

    // Пауза после КАЖДОГО поиска, а не только после записи. Раньше холостой
    // прогон пропускал sleep и молотил Shikimori на ~5 запросов в секунду —
    // тот начинал отвечать «Retry later», findAnime глотал ошибку и возвращал
    // null, из-за чего половина тайтлов ложно попадала в «не сопоставлено».
    await sleep(THROTTLE_MS);

    if (!anime?.id) {
      report.unmatched.push(it.titleRu || it.releaseId);
      continue;
    }
    report.matched++;
    if (opts.dryRun) continue;

    const rate: Record<string, unknown> = {
      user_id: auth.shikiUserId,
      target_id: Number(anime.id),
      target_type: 'Anime',
    };
    if (it.status) rate.status = it.status;
    if (it.episodes && it.episodes > 0) rate.episodes = it.episodes;
    if (it.score && it.score > 0) rate.score = it.score;

    try {
      const res = await fetch(`${SHIKI_API_BASE}/api/v2/user_rates`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${auth.accessToken}`,
          'user-agent': SHIKI_UA,
        },
        body: JSON.stringify({ user_rate: rate }),
      });
      if (res.ok) report.written++;
      else report.failed.push(`${it.titleRu || it.releaseId} (HTTP ${res.status})`);
    } catch {
      report.failed.push(it.titleRu || it.releaseId);
    }
    await sleep(THROTTLE_MS);
  }

  return report;
}


// ── Фоновый прогон ──
// Полный проход по нескольким сотням тайтлов с паузами занимает минуты, и
// держать всё это время HTTP-соединение нельзя. Поэтому запускаем в фоне, а
// клиент опрашивает состояние.

export interface JobState {
  running: boolean;
  dryRun: boolean;
  done: number;
  total: number;
  startedAt: number;
  finishedAt?: number;
  report?: MigrateReport;
  error?: string;
}

const jobs = new Map<number, JobState>();

export function getJob(userId: number): JobState | null {
  return jobs.get(userId) ?? null;
}

/** Возвращает false, если для этого пользователя прогон уже идёт. */
export function startMigration(userId: number, items: MiraiItem[], dryRun: boolean): boolean {
  const existing = jobs.get(userId);
  if (existing?.running) return false;

  const state: JobState = {
    running: true,
    dryRun,
    done: 0,
    total: items.length,
    startedAt: Date.now(),
  };
  jobs.set(userId, state);

  void (async () => {
    try {
      const report = await migrateToShikimori(userId, items, {
        dryRun,
        onProgress: (done, total) => {
          state.done = done;
          state.total = total;
        },
      });
      state.report = report ?? undefined;
      if (!report) state.error = 'not_connected';
    } catch (e) {
      state.error = (e as Error)?.message || 'failed';
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  })();

  return true;
}
