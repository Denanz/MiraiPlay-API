import { upstreamJson } from '../upstream/client.js';
import { getReleaseRating, setReleaseRating } from './ratings.js';
import { resolveBucket } from './identity.js';
import { SHIKI_API_BASE, SHIKI_UA, getAuth, validAccessToken } from './shikimori-auth.js';
import { exportShikiRates } from './shikimori-migrate.js';
import { findByShikiId, flush, getState, rememberItem, type SyncedItem } from './shikimori-state.js';

/**
 * Регулярная двусторонняя сверка списков.
 *
 * Работает ТОЛЬКО по уже сопоставленным парам из снимка: сопоставление по
 * названиям неточное, и делать его в фоне, без человека, который посмотрит
 * отчёт, нельзя. Новые тайтлы попадают в карту через ручной перенос или импорт.
 *
 * За счёт этого цикл дешёвый: один запрос к Shikimori отдаёт весь список,
 * списки MiraiHub берутся у своего upstream, а наружу уходят только изменения.
 */

const THROTTLE_MS = 750;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Номера списков Anixart ↔ статусы Shikimori. */
const LIST_TO_STATUS: Record<number, string> = {
  1: 'watching',
  2: 'planned',
  3: 'completed',
  4: 'on_hold',
  5: 'dropped',
};
const STATUS_TO_LIST: Record<string, number> = {
  watching: 1,
  rewatching: 1,
  planned: 2,
  completed: 3,
  on_hold: 4,
  dropped: 5,
};

/** Порядок «продвижения» — при споре двигаемся вперёд, а не назад. */
const PROGRESS_ORDER = ['planned', 'watching', 'rewatching', 'on_hold', 'dropped', 'completed'];
const rank = (s: string): number => {
  const i = PROGRESS_ORDER.indexOf(s);
  return i < 0 ? -1 : i;
};

interface MiraiSide {
  status: string;
  episodes: number;
  score: number;
}

/** Текущее состояние тайтлов в MiraiHub — списки профиля плюс наши оценки. */
async function readMiraiSide(token: string, bucket: string): Promise<Map<string, MiraiSide>> {
  const out = new Map<string, MiraiSide>();
  for (const listId of [1, 2, 3, 4, 5]) {
    for (let page = 0; page < 40; page++) {
      const res = await upstreamJson<{ content?: any[] }>({
        path: `/profile/list/all/${listId}/${page}`,
        query: { token },
      }).catch(() => null);
      const items = res?.data?.content ?? [];
      if (items.length === 0) break;
      for (const raw of items) {
        const r = raw.release ?? raw;
        const id = r?.id != null ? String(r.id) : '';
        if (!id || out.has(id)) continue;
        const total = Number(r.episodes_total) || 0;
        const lastView = Number(r.last_view_episode?.position) || 0;
        out.set(id, {
          status: LIST_TO_STATUS[listId] ?? 'planned',
          episodes: listId === 3 ? total : lastView,
          score: getReleaseRating(bucket, id) ?? 0,
        });
      }
      if (items.length < 20) break;
    }
  }
  return out;
}

async function pushToShikimori(
  accessToken: string,
  shikiUserId: number,
  shikiId: number,
  patch: { status?: string; episodes?: number; score?: number },
): Promise<boolean> {
  const rate: Record<string, unknown> = {
    user_id: shikiUserId,
    target_id: shikiId,
    target_type: 'Anime',
  };
  if (patch.status) rate.status = patch.status;
  if (patch.episodes && patch.episodes > 0) rate.episodes = patch.episodes;
  if (patch.score && patch.score > 0) rate.score = patch.score;
  try {
    const res = await fetch(`${SHIKI_API_BASE}/api/v2/user_rates`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': SHIKI_UA,
      },
      body: JSON.stringify({ user_rate: rate }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function pushToMirai(
  token: string,
  bucket: string,
  releaseId: string,
  currentList: number,
  patch: { status?: string; score?: number },
): Promise<boolean> {
  try {
    if (patch.status) {
      const listId = STATUS_TO_LIST[patch.status];
      // Anixart сам между списками не переносит — сначала убираем из прежнего.
      if (listId && listId !== currentList) {
        if (currentList) {
          await upstreamJson({ path: `/profile/list/delete/${currentList}/${releaseId}`, query: { token } });
        }
        await upstreamJson({ path: `/profile/list/add/${listId}/${releaseId}`, query: { token } });
      }
    }
    if (patch.score && patch.score > 0) setReleaseRating(bucket, releaseId, patch.score);
    return true;
  } catch {
    return false;
  }
}

export interface CycleReport {
  pairs: number;
  toShikimori: number;
  toMirai: number;
  conflicts: number;
  unchanged: number;
}

/**
 * Один проход сверки для пользователя.
 *
 * Для каждой пары сравниваем обе стороны со снимком:
 *   изменилась только одна — её значения и разъезжаются на другую;
 *   изменились обе — спор, решаем правилами;
 *   не изменилось ничего — пропускаем, это подавляющее большинство.
 */
export async function runCycle(userId: number, token: string): Promise<CycleReport | null> {
  const auth = await validAccessToken(userId);
  if (!auth) return null;

  const state = getState(userId);
  if (Object.keys(state).length === 0) {
    return { pairs: 0, toShikimori: 0, toMirai: 0, conflicts: 0, unchanged: 0 };
  }

  const bucket = await resolveBucket(token);
  const [rates, mirai] = await Promise.all([
    exportShikiRates(userId),
    readMiraiSide(token, bucket),
  ]);
  if (!rates) return null;

  const shikiById = new Map(rates.map((r) => [r.target_id, r]));
  const report: CycleReport = {
    pairs: Object.keys(state).length,
    toShikimori: 0,
    toMirai: 0,
    conflicts: 0,
    unchanged: 0,
  };

  for (const snap of Object.values(state)) {
    const shiki = shikiById.get(snap.shikiId);
    const mine = mirai.get(snap.releaseId);
    if (!shiki || !mine) continue;

    // Пара ещё ни разу не сверялась: снимок отражает только одну сторону,
    // поэтому «кто изменился» вычислить нельзя. Обращаемся с ней как со
    // спором и приводим обе стороны к общему знаменателю.
    const unbaselined = !snap.syncedAt;

    // Сравниваем ТОЛЬКО статус и оценку — то, что умеем записывать в обе
    // стороны. Число серий из сравнения исключено намеренно: в MiraiHub мы его
    // не пишем вовсе, а Shikimori обрезает присланное до количества серий у
    // своего аниме. Поле, которое нельзя привести к согласию, но которое
    // участвует в решении, даёт вечные качели: цикл гонял 19 тайтлов туда-сюда
    // каждый проход. Серии по-прежнему уезжают наружу, просто не решают.
    const shikiChanged =
      shiki.status !== snap.status || Number(shiki.score) !== snap.score;
    const miraiChanged =
      mine.status !== snap.status || mine.score !== snap.score;

    if (!shikiChanged && !miraiChanged) {
      report.unchanged++;
      continue;
    }

    let next: SyncedItem;

    if (!unbaselined && shikiChanged && !miraiChanged) {
      await pushToMirai(token, bucket, snap.releaseId, STATUS_TO_LIST[mine.status] ?? 0, {
        status: shiki.status,
        score: Number(shiki.score) || 0,
      });
      report.toMirai++;
      next = {
        ...snap,
        status: shiki.status,
        episodes: Number(shiki.episodes) || 0,
        score: Number(shiki.score) || 0,
        syncedAt: Date.now(),
      };
      await sleep(THROTTLE_MS);
    } else if (!unbaselined && miraiChanged && !shikiChanged) {
      await pushToShikimori(auth.accessToken, auth.shikiUserId, snap.shikiId, {
        status: mine.status,
        episodes: mine.episodes,
        score: mine.score,
      });
      report.toShikimori++;
      next = { ...snap, ...mine, syncedAt: Date.now() };
      await sleep(THROTTLE_MS);
    } else {
      // Обе стороны сдвинулись — либо пара сверяется впервые. Правила:
      // серий — больше (просмотр не
      // отматывается назад), статус — тот, что дальше по цепочке, оценка —
      // ненулевая, а при споре берём нашу как более свежую по смыслу.
      report.conflicts++;
      const episodes = Math.max(Number(shiki.episodes) || 0, mine.episodes);
      const status =
        rank(mine.status) >= rank(shiki.status) ? mine.status : shiki.status;
      const score = mine.score || Number(shiki.score) || 0;

      await pushToShikimori(auth.accessToken, auth.shikiUserId, snap.shikiId, {
        status,
        episodes,
        score,
      });
      await pushToMirai(token, bucket, snap.releaseId, STATUS_TO_LIST[mine.status] ?? 0, {
        status,
        score,
      });
      next = { ...snap, status, episodes, score, syncedAt: Date.now() };
      await sleep(THROTTLE_MS);
    }

    rememberItem(userId, next);
  }

  flush();
  return report;
}

/** Заполняет карту соответствий из уже сопоставленных пар. */
export function seedPair(
  userId: number,
  releaseId: string,
  shikiId: number,
  values: { status: string; episodes: number; score: number },
): void {
  rememberItem(userId, {
    releaseId,
    shikiId,
    status: values.status,
    episodes: values.episodes,
    score: values.score,
    syncedAt: Date.now(),
  });
}

export { findByShikiId };

// ── Периодический запуск ──
// Раз в 15 минут: опрос Shikimori стоит один запрос, наружу уходят только
// дельты, поэтому лимит частоты не задевается даже при нескольких аккаунтах.
const CYCLE_MS = 15 * 60_000;

export function startSyncCycle(getTokens: () => Array<{ userId: number; token: string }>): void {
  setInterval(() => {
    void (async () => {
      for (const { userId, token } of getTokens()) {
        if (!getAuth(userId)) continue; // Shikimori не подключён
        await runCycle(userId, token).catch(() => null);
      }
    })();
  }, CYCLE_MS);
}
