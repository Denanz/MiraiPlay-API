import { upstreamJson } from '../upstream/client.js';
import { setReleaseRating } from './ratings.js';
import { SHIKI_API_BASE, SHIKI_UA, validAccessToken } from './shikimori-auth.js';
import { exportShikiRates, type ShikiRate } from './shikimori-migrate.js';
import { flush, rememberItem } from './shikimori-state.js';

/**
 * Импорт Shikimori → MiraiHub.
 *
 * Сопоставление идёт по ОРИГИНАЛЬНОМУ названию (ромадзи), а не по русскому:
 * переводы у сервисов расходятся сильно («Golden Kamuy» — «Золотое божество»,
 * «Sousou no Frieren» — «Провожающая в последний путь Фрирен»), и по ним
 * половина тайтлов не находится вовсе.
 *
 * Но поиск возвращает ближайшее, а не «ничего», поэтому результат обязательно
 * проверяется. Двух видов промахов, оба молчаливые:
 *   1. Похожее имя, другое аниме — Quanzhi Gaoshou против Quanzhi Fashi V.
 *   2. Та же франшиза, не та часть — основной сериал против OVA.
 * Второй не ловится сравнением по началу строки (запрос формально является
 * началом результата), поэтому сверяем на ТОЧНОЕ равенство после нормализации.
 * Лучше отправить тайтл в ручной разбор, чем записать чужие данные.
 */

const THROTTLE_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Статусы Shikimori → номера списков Anixart. */
const STATUS_TO_LIST: Record<string, number> = {
  watching: 1,
  rewatching: 1,
  planned: 2,
  completed: 3,
  on_hold: 4,
  dropped: 5,
};

export interface ImportCandidate {
  shikiId: number;
  shikiName: string;
  shikiEpisodes: number;
  status: string;
  score: number;
  /** Найденный релиз Anixart — null, если сопоставить не удалось. */
  releaseId?: number;
  releaseTitle?: string;
  releaseOriginal?: string;
  reason?: string;
}

export interface ImportReport {
  total: number;
  matched: number;
  applied: number;
  skipped: ImportCandidate[];
  failed: string[];
}

const normalize = (v: string): string =>
  String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Названия аниме по id — пачками, чтобы не бить по одному запросу на тайтл. */
async function fetchShikiNames(
  ids: number[],
): Promise<Map<number, { name: string; episodes: number }>> {
  const out = new Map<number, { name: string; episodes: number }>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const query = `{ animes(ids: ${JSON.stringify(chunk.join(','))}, limit: 50) { id name episodes } }`;
    try {
      const res = await fetch(`${SHIKI_API_BASE}/api/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': SHIKI_UA },
        body: JSON.stringify({ query }),
      });
      if (res.ok) {
        const j = (await res.json()) as { data?: { animes?: Array<{ id: string; name: string; episodes: number }> } };
        for (const a of j.data?.animes ?? []) {
          out.set(Number(a.id), { name: a.name || '', episodes: Number(a.episodes) || 0 });
        }
      }
    } catch { /* пачка не вышла — эти тайтлы просто не сопоставятся */ }
    await sleep(THROTTLE_MS);
  }
  return out;
}

/** Ищет релиз в Anixart по оригинальному названию и проверяет, что это он. */
async function findRelease(
  token: string,
  name: string,
  shikiEpisodes: number,
): Promise<{ id: number; title: string; original: string } | { reason: string }> {
  if (!name) return { reason: 'нет оригинального названия' };
  let content: any[] = [];
  try {
    const res = await upstreamJson<{ content?: any[] }>({
      method: 'POST',
      path: '/search/releases/0',
      query: { token },
      body: JSON.stringify({ query: name, searchBy: 0 }),
      headers: { 'content-type': 'application/json' },
    });
    content = res.data?.content ?? [];
  } catch {
    return { reason: 'поиск не ответил' };
  }
  if (content.length === 0) return { reason: 'не найдено' };

  const target = normalize(name);
  for (const c of content.slice(0, 5)) {
    if (normalize(c.title_original) !== target) continue;
    // Подстраховка по длине: если у Shikimori многосерийный тайтл, а здесь
    // одна серия — это спецвыпуск или OVA той же франшизы, не он.
    const total = Number(c.episodes_total) || 0;
    if (shikiEpisodes > 3 && total === 1) continue;
    return { id: Number(c.id), title: String(c.title_ru || ''), original: String(c.title_original || '') };
  }
  const first = content[0];
  return {
    reason: `не совпало: «${first?.title_original ?? '?'}»`,
  };
}

/**
 * Готовит план импорта. dryRun не пишет ничего — только показывает, что
 * сопоставилось, а что уйдёт в ручной разбор.
 */
export async function importFromShikimori(
  userId: number,
  token: string,
  bucket: string,
  opts: { dryRun?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<ImportReport | null> {
  const auth = await validAccessToken(userId);
  if (!auth) return null;

  const rates = (await exportShikiRates(userId)) ?? [];
  const names = await fetchShikiNames(rates.map((r) => r.target_id));

  const report: ImportReport = { total: rates.length, matched: 0, applied: 0, skipped: [], failed: [] };
  let done = 0;

  for (const rate of rates as ShikiRate[]) {
    done++;
    opts.onProgress?.(done, rates.length);

    const meta = names.get(rate.target_id);
    const cand: ImportCandidate = {
      shikiId: rate.target_id,
      shikiName: meta?.name ?? '',
      shikiEpisodes: meta?.episodes ?? 0,
      status: rate.status,
      score: Number(rate.score) || 0,
    };

    const found = await findRelease(token, cand.shikiName, cand.shikiEpisodes);
    await sleep(THROTTLE_MS);

    if ('reason' in found) {
      cand.reason = found.reason;
      report.skipped.push(cand);
      continue;
    }
    cand.releaseId = found.id;
    cand.releaseTitle = found.title;
    cand.releaseOriginal = found.original;
    report.matched++;
    rememberItem(userId, {
      releaseId: String(found.id),
      shikiId: rate.target_id,
      status: rate.status,
      episodes: Number(rate.episodes) || 0,
      score: cand.score,
      // 0 = ещё не сверялись; первый цикл согласует стороны по правилам.
      syncedAt: 0,
    });
    if (opts.dryRun) continue;

    const listId = STATUS_TO_LIST[rate.status];
    try {
      if (listId) {
        // Anixart не переносит между списками сам — сначала убираем из старого.
        await upstreamJson({ path: `/profile/list/add/${listId}/${found.id}`, query: { token } });
      }
      if (cand.score > 0) setReleaseRating(bucket, String(found.id), cand.score);
      report.applied++;
    } catch {
      report.failed.push(cand.shikiName || String(found.id));
    }
    await sleep(THROTTLE_MS);
  }

  flush();
  return report;
}

// ── Фоновый прогон импорта ──
export interface ImportJob {
  running: boolean;
  dryRun: boolean;
  done: number;
  total: number;
  startedAt: number;
  finishedAt?: number;
  report?: ImportReport;
  error?: string;
}

const jobs = new Map<number, ImportJob>();

export function getImportJob(userId: number): ImportJob | null {
  return jobs.get(userId) ?? null;
}

export function startImport(userId: number, token: string, bucket: string, dryRun: boolean): boolean {
  const existing = jobs.get(userId);
  if (existing?.running) return false;
  const state: ImportJob = { running: true, dryRun, done: 0, total: 0, startedAt: Date.now() };
  jobs.set(userId, state);
  void (async () => {
    try {
      const report = await importFromShikimori(userId, token, bucket, {
        dryRun,
        onProgress: (done, total) => { state.done = done; state.total = total },
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
