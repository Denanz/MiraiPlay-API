import { findAnime } from './shikimori.js';
import { SHIKI_API_BASE, SHIKI_UA, validAccessToken } from './shikimori-auth.js';

/**
 * Отправка прогресса и оценок в список пользователя на Shikimori.
 *
 * Сложность здесь одна: у нас тайтл известен по id Anixart, а Shikimori знает
 * свои id. Сопоставление уже решено — findAnime ищет по названиям и кеширует
 * результат, тем же путём строятся связанные тайтлы и порядок франшизы.
 *
 * Всё делается «по возможности»: если Shikimori лежит, не подключён или тайтл
 * не сопоставился — просто ничего не отправляем. Просмотр в MiraiHub не должен
 * зависеть от чужого сервиса.
 */

export interface SyncTarget {
  titleRu?: string;
  titleOrig?: string;
  titleAlt?: string;
}

export interface SyncPayload {
  /** Сколько серий просмотрено. 0 — не трогаем поле. */
  episodes?: number;
  /** Оценка 1–10. 0 — не трогаем поле. */
  score?: number;
  /** Статус списка; по умолчанию Shikimori выставит сам при первом создании. */
  status?: 'planned' | 'watching' | 'completed' | 'on_hold' | 'dropped';
}

export async function pushUserRate(
  userId: number,
  target: SyncTarget,
  payload: SyncPayload,
): Promise<boolean> {
  const auth = await validAccessToken(userId);
  if (!auth) return false;

  const anime = await findAnime({
    ru: target.titleRu,
    orig: target.titleOrig,
    alt: target.titleAlt,
  }).catch(() => null);
  if (!anime?.id) return false;

  const rate: Record<string, unknown> = {
    user_id: auth.shikiUserId,
    target_id: Number(anime.id),
    target_type: 'Anime',
  };
  if (payload.episodes && payload.episodes > 0) rate.episodes = payload.episodes;
  if (payload.score && payload.score > 0) rate.score = payload.score;
  if (payload.status) rate.status = payload.status;

  try {
    // v2/user_rates работает как upsert: одна и та же пара user+target
    // обновляется, а не плодит дубликаты.
    const res = await fetch(`${SHIKI_API_BASE}/api/v2/user_rates`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.accessToken}`,
        'user-agent': SHIKI_UA,
      },
      body: JSON.stringify({ user_rate: rate }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ShikiProfileDigest {
  nickname: string;
  url: string;
  avatar: string;
  lastOnline: string;
  /** Строки вида «муж.», «на сайте с 2010 г.» — Shikimori отдаёт их с разметкой. */
  about: string[];
  /** Сколько тайтлов в каждом статусе списка: смотрю, просмотрено, в планах… */
  statuses: Array<{ name: string; size: number }>;
  /** Распределение оценок: сколько раз поставлена каждая. */
  scores: Array<{ score: number; count: number }>;
  /** По типам: сериал, фильм, OVA… */
  types: Array<{ name: string; count: number }>;
}

const STATUS_RU: Record<string, string> = {
  planned: 'В планах',
  watching: 'Смотрю',
  rewatching: 'Пересматриваю',
  completed: 'Просмотрено',
  on_hold: 'Отложено',
  dropped: 'Брошено',
};

/** Убираем разметку, которой Shikimori сдабривает common_info. */
function stripTags(v: string): string {
  return String(v).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Сводка профиля Shikimori для страницы профиля.
 *
 * Сам профиль публичный и токена не требует — токен нужен только чтобы понять,
 * ЧЕЙ профиль показывать, поэтому без подключения возвращаем null.
 */
export async function fetchProfileDigest(userId: number): Promise<ShikiProfileDigest | null> {
  const auth = await validAccessToken(userId);
  if (!auth?.shikiUserId) return null;
  try {
    const res = await fetch(`${SHIKI_API_BASE}/api/users/${auth.shikiUserId}`, {
      headers: { 'user-agent': SHIKI_UA },
    });
    if (!res.ok) return null;
    const u = (await res.json()) as Record<string, any>;
    const st = u.stats ?? {};
    const animeStatuses: any[] = st.statuses?.anime ?? [];
    const animeScores: any[] = st.scores?.anime ?? [];
    const animeTypes: any[] = st.types?.anime ?? [];

    return {
      nickname: String(u.nickname ?? ''),
      url: String(u.url ?? ''),
      avatar: String(u.image?.x64 ?? u.avatar ?? ''),
      lastOnline: String(u.last_online ?? ''),
      about: (u.common_info ?? []).map(stripTags).filter(Boolean),
      statuses: animeStatuses
        .filter((s) => Number(s.size) > 0)
        // Ключ берём из name, а не из grouped_id: у «смотрю» grouped_id равен
        // 'watching,rewatching' (составное), и поиск по нему промахивается,
        // оставляя английскую подпись среди русских.
        .map((s) => ({
          name: STATUS_RU[String(s.name)] ?? STATUS_RU[String(s.grouped_id)] ?? String(s.name),
          size: Number(s.size),
        })),
      scores: animeScores
        .map((s) => ({ score: Number(s.name), count: Number(s.value) }))
        .filter((s) => s.count > 0)
        .sort((a, b) => b.score - a.score),
      types: animeTypes
        .map((t) => ({ name: String(t.name), count: Number(t.value) }))
        .filter((t) => t.count > 0),
    };
  } catch {
    return null;
  }
}
