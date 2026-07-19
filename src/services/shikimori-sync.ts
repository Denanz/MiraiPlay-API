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
