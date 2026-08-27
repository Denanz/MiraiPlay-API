import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settings, allowedOrigins } from '../config/settings.js';
import { callUpstream, upstreamJson } from '../upstream/client.js';
import { isAllowedKodikUrl, resolveKodik, type ResolvedPlayback } from './kodik.js';
import { isAllowedAniLibriaUrl, resolveAniLibria } from './anilibria.js';
import { resolveAnimelibTeam } from '../services/animelib.js';
import { buildPlayerPage } from './player.page.js';
import { listShots, openShot, removeShot, saveShot, setNote } from '../services/screenshots.js';
import { resolveBucket, resolveUserId } from '../services/identity.js';
import { getAuth as getShikiAuth } from '../services/shikimori-auth.js';
import { pushUserRate } from '../services/shikimori-sync.js';
import { getProgress, listContinue, saveProgress } from '../services/progress.js';
import { setNotifyToken } from '../services/notify-episodes.js';
import { recordWatch } from '../services/timeline.js';
import { bindAnixart, hubUserFromCookie } from '../services/mirai-auth.js';
import { findAnime } from '../services/shikimori.js';
import {
  setRating,
  deleteRating,
  getRatings,
  getRating,
  setReleaseRating,
  getReleaseRating,
  deleteReleaseRating,
  getAllReleaseRatings,
} from '../services/ratings.js';

async function resolveMalId(titles: { ru?: string; orig?: string }): Promise<number | null> {
  try {
    const anime = await Promise.race([
      findAnime(titles),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return anime?.malId ?? null;
  } catch {
    return null;
  }
}

/**
 * Ручки плеера: сама HTML-страница, синк прогресса просмотра и личная галерея
 * скриншотов.
 */

const frameAncestors = [
  "'self'",
  ...[...allowedOrigins].filter((o) => o.startsWith('http')),
].join(' ');

/** Тот же плеер обслуживает несколько бэкендов озвучки; какой резолвер звать —
 *  определяется хостом самой ссылки эпизода. */
function isAllowedPlayerUrl(url: string): boolean {
  return isAllowedKodikUrl(url) || isAllowedAniLibriaUrl(url);
}

function resolveStream(url: string): Promise<ResolvedPlayback> {
  return isAllowedKodikUrl(url) ? resolveKodik(url) : resolveAniLibria(url);
}

function tokenFrom(req: FastifyRequest): string {
  const q = req.query as Record<string, unknown>;
  if (typeof q.token === 'string') return q.token;
  const b = (req.body ?? {}) as Record<string, unknown>;
  return typeof b.token === 'string' ? b.token : '';
}

/**
 * Отправляет оценку/прогресс в список Shikimori. Тайтл там ищется по названиям,
 * поэтому сначала вытягиваем карточку релиза — id Anixart Shikimori ничего не
 * говорит. Всё best-effort: не подключён, не нашёлся, упало — молча выходим.
 */
async function syncReleaseToShikimori(
  token: string,
  releaseId: string,
  payload: { score?: number; episodes?: number; status?: 'watching' | 'completed' },
): Promise<void> {
  try {
    const userId = await resolveUserId(token);
    if (!userId || !getShikiAuth(userId)) return;
    const res = await upstreamJson<{ release?: { title_ru?: string; title_original?: string; title_alt?: string } }>({
      path: `/release/${releaseId}`,
      query: { token },
    });
    const rel = res.data?.release;
    if (!rel) return;
    await pushUserRate(
      userId,
      { titleRu: rel.title_ru, titleOrig: rel.title_original, titleAlt: rel.title_alt },
      payload,
    );
  } catch {
    // Синхронизация — приятное дополнение, а не условие работы плеера.
  }
}

export function registerPlayer(scope: FastifyInstance): void {
  // ── HTML-страница плеера ──
  scope.get('/player', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string>;
    const { url, title, subtitle, releaseId, sourceId, position, token, animelibTeam } = q;

    if (!releaseId || !sourceId || !position || (!url && !animelibTeam)) {
      return reply.code(400).type('text/plain').send('missing: url (or animelibTeam), releaseId, sourceId, position');
    }

    let playback;
    // AnimeLib chosen as the source up front (WatchPage's "Источник" picker) —
    // качества берём прямо из аккаунта зрителя на AnimeLib, минуя резолв
    // ссылок Kodik и AniLibria.
    if (animelibTeam) {
      const userId = await resolveUserId(token || '');
      if (!userId) return reply.code(401).type('text/plain').send('auth required');
      const result = await resolveAnimelibTeam(userId, releaseId, Number(position), animelibTeam, {
        orig: q.origTitle || undefined,
        ru: title || undefined,
      });
      if (!result.found || !result.qualities?.length) {
        return reply.code(502).type('text/plain').send('animelib: ' + (result.reason || 'not found'));
      }
      // Отдаём через /animelib/stream, а не ссылкой на CDN напрямую: DDoS-Guard
      // смотрит на Referer, а <video src> с нашего домена пришлёт неправильный.
      const qualities = result.qualities.map((q) => ({
        label: q.label,
        url: `/api/v1/animelib/stream?url=${encodeURIComponent(q.url)}`,
      }));
      playback = { qualities, defaultLabel: qualities[0]!.label };
    } else {
      if (!isAllowedPlayerUrl(url)) {
        return reply.code(400).type('text/plain').send('invalid player url');
      }
      try {
        playback = await resolveStream(url);
      } catch {
        return reply.code(502).type('text/plain').send('failed to resolve stream');
      }
    }

    // Продолжение с другого устройства: тянем сохранённую позицию из хранилища
    // пользователя. Страница всё равно возьмёт более свежее локальное значение.
    let resumeTime = 0;
    if (token) {
      const saved = getProgress(await resolveBucket(token), String(releaseId), String(sourceId), String(position));
      if (saved && saved.position > 15) resumeTime = saved.position;
    }

    // Ищем MAL ID для Aniskip, бюджет 1.5с, повторные попадают в кэш.
    // Только по чистому названию релиза: `subtitle` — это «озвучка · источник ·
    // серия N" — feeding that to Shikimori matches garbage (e.g. it returns the
    // номер серии в хвосте уводит поиск на чужой тайтл, и таймкоды приедут не те.
    // `origTitle` — необязательный запасной вариант с оригинальным названием.
    const malId = q.malId
      ? (Number(q.malId) || null)
      : await resolveMalId({ ru: title || undefined, orig: q.origTitle || undefined });

    const isHls = playback.qualities.some((qq) => qq.url.includes('.m3u8') || qq.url.includes('hls'));
    const html = buildPlayerPage({
      qualities: playback.qualities,
      defaultLabel: playback.defaultLabel,
      isHls,
      title: (title || `Серия ${position}`).slice(0, 120),
      subtitle: (subtitle || '').slice(0, 180),
      progressKey: `${releaseId}:${sourceId}:${position}`,
      resumeTime,
      releaseId,
      sourceId,
      episodePosition: position,
      token: token || undefined,
      gatewayKey: settings.GATEWAY_KEY || undefined,
      malId: malId ?? undefined,
      design: q.design === 'modern' ? 'modern' : 'legacy',
      titleOriginal: q.origTitle || undefined,
      markWatchedSourceId: q.markSourceId || undefined,
    });

    reply
      .header('content-security-policy', `frame-ancestors ${frameAncestors}`)
      .header('cache-control', 'no-store, must-revalidate')
      .removeHeader('x-frame-options');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // ── синк прогресса просмотра ──
  scope.post('/player/progress', async (req: FastifyRequest, reply: FastifyReply) => {
    const { releaseId, sourceId, episodePosition, time, duration, title, token, markWatchedSourceId } =
      (req.body ?? {}) as {
        releaseId?: unknown;
        sourceId?: unknown;
        episodePosition?: unknown;
        time?: unknown;
        duration?: unknown;
        title?: unknown;
        token?: unknown;
        markWatchedSourceId?: unknown;
      };
    if (!releaseId || !sourceId || !episodePosition) {
      return reply.code(400).send({ error: 'missing_fields' });
    }
    // Отмечаем серию просмотренной, когда она почти досмотрена. У AnimeLib
    // sourceId равен -1 — наш собственный признак, Anixart такого не знает,
    // поэтому для самого вызова подставляем настоящий id из markWatchedSourceId.
    // Прогресс ниже по-прежнему хранится под исходным sourceId, иначе
    // «продолжить смотреть» перестал бы отличать AnimeLib от прочих.
    const finished =
      typeof time === 'number' &&
      typeof duration === 'number' &&
      duration > 0 &&
      time / duration >= 0.9;
    if (finished) {
      const watchSourceId =
        typeof markWatchedSourceId === 'string' && markWatchedSourceId ? markWatchedSourceId : sourceId;
      void callUpstream({
        method: 'GET',
        path: `/episode/watch/${releaseId}/${watchSourceId}/${episodePosition}`,
        query: typeof token === 'string' ? { token } : undefined,
      }).catch(() => {});
      // Тем же моментом двигаем счётчик серий в списке на Shikimori.
      if (typeof token === 'string' && token) {
        void syncReleaseToShikimori(token, String(releaseId), {
          episodes: Number(episodePosition) || 0,
          status: 'watching',
        });
      }
    }
    // Точная позиция для продолжения с другого устройства.
    if (typeof token === 'string' && token && typeof time === 'number' && time >= 0) {
      // Хроника просмотров для MiraiTimeline — пишется всем и метится
      // Anixart-id зрителя; кому её показывать, решает уже сам MiraiTimeline.
      const viewerId = await resolveUserId(token);
      if (viewerId) {
        recordWatch({
          userId: viewerId,
          releaseId: String(releaseId),
          sourceId: String(sourceId),
          episode: String(episodePosition),
          title: typeof title === 'string' ? title.slice(0, 200) : undefined,
          position: time,
          duration: typeof duration === 'number' && duration > 0 ? duration : 0,
          finished,
          token,
        });

        // Заодно связываем аккаунт Anixart с учётной записью MiraiHub: в этом
        // же запросе есть и токен, и cookie хаба (она выдана на весь
        // .denanz.fun, а плеер живёт на его поддомене). Ни кодов, ни ручного
        // ввода идентификаторов не нужно — достаточно один раз посмотреть
        // серию, будучи залогиненным в хабе.
        void (async () => {
          const hubUserId = await hubUserFromCookie(req.headers.cookie);
          if (hubUserId !== null) await bindAnixart(hubUserId, viewerId);
        })();
      }
      saveProgress(await resolveBucket(token), {
        releaseId: String(releaseId),
        sourceId: String(sourceId),
        episode: String(episodePosition),
        position: Math.floor(time),
        duration: typeof duration === 'number' && duration > 0 ? Math.floor(duration) : 0,
        title: typeof title === 'string' ? title.slice(0, 200) : undefined,
        updatedAt: Date.now(),
      });
      // Запоминаем токен, чтобы следилка за новыми сериями читала его списки.
      setNotifyToken(token);
    }
    return reply.code(204).send();
  });

  // ── сохранённая позиция серии ──
  scope.get('/player/progress', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId || !q.sourceId || !q.episode) {
      return reply.code(400).send({ error: 'missing_fields' });
    }
    const e = getProgress(await resolveBucket(token), q.releaseId, q.sourceId, q.episode);
    return reply.send({
      position: e?.position ?? 0,
      duration: e?.duration ?? 0,
      updatedAt: e?.updatedAt ?? 0,
    });
  });

  // Все личные оценки одним запросом — для плиток в каталоге и на главной.
  scope.get('/player/rating/all', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    return reply.send({ ratings: getAllReleaseRatings(await resolveBucket(token)) });
  });

  // ── готовый поток для «горячей» смены озвучки ──
  // Отдаёт то же, что /player готовит для страницы, но в JSON: плеер подменяет
  // video.src на месте и возвращает таймкод, вместо того чтобы перезагружать
  // себя целиком (перезагрузка сбрасывала бы воспроизведение). Резолв ссылки
  // остаётся на сервере — клиенту незачем знать внутренние адреса, да и
  // проверка допустимого хоста не должна зависеть от клиента.
  scope.get('/player/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string>;
    const { releaseId, sourceId, position } = q;
    const token = tokenFrom(req);
    if (!releaseId || !sourceId || !position) {
      return reply.code(400).send({ error: 'missing_fields' });
    }

    const res = await upstreamJson<{ episode?: { url?: string; name?: string } }>({
      path: `/episode/target/${releaseId}/${sourceId}/${position}`,
      query: token ? { token } : {},
    });
    const raw = res.data?.episode?.url || '';
    // Нумерация серий у разных озвучек не совпадает: у выбранной этой серии
    // может просто не быть. Это штатный ответ, а не ошибка.
    if (!raw) return reply.code(404).send({ error: 'episode_unavailable' });

    const url = raw.startsWith('//') ? `https:${raw}` : raw;
    if (!isAllowedPlayerUrl(url)) return reply.code(400).send({ error: 'invalid_url' });

    let playback;
    try {
      playback = await resolveStream(url);
    } catch {
      return reply.code(502).send({ error: 'resolve_failed' });
    }

    const isHls = playback.qualities.some((qq) => qq.url.includes('.m3u8') || qq.url.includes('hls'));
    return reply.send({
      qualities: playback.qualities,
      defaultLabel: playback.defaultLabel,
      isHls,
      episodeName: res.data?.episode?.name || '',
    });
  });

  // ── недосмотренные серии по всем релизам: «продолжить смотреть» ──
  scope.get('/player/continue', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    return reply.send({ items: listContinue(await resolveBucket(token)) });
  });

  // ── галерея скриншотов ──
  scope.post('/player/screenshot', async (req: FastifyRequest, reply: FastifyReply) => {
    const { image, releaseId, title, episode, time } = (req.body ?? {}) as Record<string, unknown>;
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    if (typeof image !== 'string') return reply.code(400).send({ error: 'missing_image' });

    const match = image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return reply.code(400).send({ error: 'invalid_image' });

    const bytes = Buffer.from(match[2]!, 'base64');
    if (bytes.length > 8_000_000) return reply.code(413).send({ error: 'too_large' });

    try {
      const meta = saveShot(await resolveBucket(token), bytes, match[1] === 'png' ? 'png' : 'jpg', {
        releaseId: releaseId != null ? String(releaseId) : undefined,
        title: typeof title === 'string' ? title.slice(0, 200) : undefined,
        episode: Number(episode) || undefined,
        time: Number(time) || undefined,
      });
      return reply.send({ ok: true, id: meta.id });
    } catch (err) {
      req.log.error({ err }, 'screenshot save failed');
      return reply.code(500).send({ error: 'save_failed' });
    }
  });

  scope.get('/player/screenshots', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const bucket = await resolveBucket(token);
    return reply.send({ bucket, items: listShots(bucket) });
  });

  scope.get('/player/screenshots/file/:bucket/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { bucket, id } = req.params as { bucket: string; id: string };
    const found = openShot(bucket, id);
    if (!found) return reply.code(404).send();
    return reply
      .header('content-type', found.ext === 'png' ? 'image/png' : 'image/jpeg')
      .header('cache-control', 'private, max-age=86400')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(found.stream);
  });

  scope.delete('/player/screenshots/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ ok: false });
    const { id } = req.params as { id: string };
    const ok = removeShot(await resolveBucket(token), id);
    return reply.code(ok ? 200 : 404).send({ ok });
  });

  // Заметка к скриншоту: поставить или снять.
  scope.post('/player/screenshots/:id/note', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ ok: false });
    const { id } = req.params as { id: string };
    const { note } = (req.body ?? {}) as Record<string, unknown>;
    const ok = setNote(await resolveBucket(token), id, typeof note === 'string' ? note : '');
    return reply.code(ok ? 200 : 404).send({ ok });
  });

  // ── Оценки серий ──
  scope.post('/player/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { releaseId, sourceId, episode, rating } = (req.body ?? {}) as Record<string, unknown>;
    if (!releaseId || !sourceId || !episode) return reply.code(400).send({ error: 'missing_fields' });
    const r = Number(rating);
    if (!r || r < 1 || r > 10) return reply.code(400).send({ error: 'rating must be 1–10' });
    setRating(await resolveBucket(token), String(releaseId), String(sourceId), String(episode), r);
    return reply.send({ ok: true, rating: r });
  });

  scope.delete('/player/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId || !q.sourceId || !q.episode) return reply.code(400).send({ error: 'missing_fields' });
    deleteRating(await resolveBucket(token), q.releaseId, q.sourceId, q.episode);
    return reply.send({ ok: true });
  });

  // Все оценки релиза для списка серий
  scope.get('/player/ratings', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId || !q.sourceId) return reply.code(400).send({ error: 'missing_fields' });
    return reply.send({ ratings: getRatings(await resolveBucket(token), q.releaseId, q.sourceId) });
  });

  // Оценка одной серии, читается плеером при загрузке
  scope.get('/player/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId || !q.sourceId || !q.episode) return reply.code(400).send({ error: 'missing_fields' });
    const rating = getRating(await resolveBucket(token), q.releaseId, q.sourceId, q.episode);
    return reply.send({ rating });
  });

  // ── Личная оценка релиза, 1–10. Живёт только у нас и в Anixart не уходит:
  //    это не та же сущность, что общая пятизвёздочная. ──
  scope.post('/release/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { releaseId, rating } = (req.body ?? {}) as Record<string, unknown>;
    if (!releaseId) return reply.code(400).send({ error: 'missing_fields' });
    const r = Number(rating);
    if (!r || r < 1 || r > 10) return reply.code(400).send({ error: 'rating must be 1–10' });
    setReleaseRating(await resolveBucket(token), String(releaseId), r);
    // Заодно в список на Shikimori, если аккаунт подключён. Намеренно не ждём:
    // оценка уже сохранена у нас, и чужой сервис не должен задерживать ответ
    // или ронять запрос, если он лежит.
    void syncReleaseToShikimori(token, String(releaseId), { score: r });
    return reply.send({ ok: true, rating: r });
  });

  scope.delete('/release/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId) return reply.code(400).send({ error: 'missing_fields' });
    deleteReleaseRating(await resolveBucket(token), q.releaseId);
    return reply.send({ ok: true });
  });

  scope.get('/release/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId) return reply.code(400).send({ error: 'missing_fields' });
    const rating = getReleaseRating(await resolveBucket(token), q.releaseId);
    return reply.send({ rating });
  });
}
