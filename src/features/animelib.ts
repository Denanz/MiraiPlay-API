import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { resolveUserId } from '../services/identity.js';
import {
  setToken,
  getToken,
  setRefreshToken,
  hasRefreshToken,
  clearToken,
  tokenExpiresAt,
  setOverride,
  lookupAnimelib,
  listAnimelibTeams,
  isAllowedAnimelibVideoUrl,
} from '../services/animelib.js';

const UA = 'Mozilla/5.0';

function tokenOf(req: FastifyRequest): string {
  const q = req.query as Record<string, unknown>;
  if (typeof q.token === 'string') return q.token;
  const b = (req.body ?? {}) as Record<string, unknown>;
  return typeof b.token === 'string' ? b.token : '';
}

export function registerAnimelib(scope: FastifyInstance): void {
  // ── Подключение и отключение своего аккаунта AnimeLib ──
  scope.post('/animelib/token', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { animelibToken, animelibRefreshToken } = (req.body ?? {}) as Record<string, unknown>;
    const clean = typeof animelibToken === 'string' ? animelibToken.trim() : '';
    if (!clean) return reply.code(400).send({ error: 'missing_token' });
    const userId = await resolveUserId(token);
    if (!userId) return reply.code(401).send({ error: 'unknown_account' });
    setToken(userId, clean);
    // Необязателен, но с ним 31-дневный токен продлевается уже без участия человека.
    const refresh = typeof animelibRefreshToken === 'string' ? animelibRefreshToken.trim() : '';
    if (refresh) setRefreshToken(userId, refresh);
    return reply.send({
      ok: true,
      expiresAt: tokenExpiresAt(clean),
      autoRenew: hasRefreshToken(userId),
    });
  });

  scope.get('/animelib/status', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const userId = await resolveUserId(token);
    const saved = userId ? getToken(userId) : undefined;
    return reply.send({
      connected: !!saved,
      expiresAt: saved ? tokenExpiresAt(saved) : null,
      autoRenew: userId ? hasRefreshToken(userId) : false,
    });
  });

  scope.post('/animelib/disconnect', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const userId = await resolveUserId(token);
    if (userId) clearToken(userId);
    return reply.send({ ok: true });
  });

  // Ручной пин releaseId → anime_id: запасной вариант там, где поиск ошибается.
  scope.post('/animelib/override', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { releaseId, animeId } = (req.body ?? {}) as Record<string, unknown>;
    const id = Number(animeId);
    if (!releaseId || !id) return reply.code(400).send({ error: 'missing_fields' });
    setOverride(String(releaseId), id);
    return reply.send({ ok: true });
  });

  // Full team list for the "Источник" picker on the episode-selection screen —
  // В отличие от /animelib/episode ниже, который выбирает одну лучшую озвучку.
  scope.get('/animelib/teams', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    const { releaseId, titleOrig, titleRu, titleEn } = q;
    if (!releaseId) return reply.code(400).send({ error: 'missing_fields' });
    const userId = await resolveUserId(token);
    if (!userId) return reply.code(401).send({ error: 'unknown_account' });
    const result = await listAnimelibTeams(userId, releaseId, {
      orig: titleOrig,
      ru: titleRu,
      en: titleEn,
    });
    return reply.send(result);
  });

  scope.get('/animelib/episode', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    const { releaseId, episode, titleOrig, titleRu, titleEn } = q;
    if (!releaseId || !episode) return reply.code(400).send({ error: 'missing_fields' });
    const userId = await resolveUserId(token);
    if (!userId) return reply.code(401).send({ error: 'unknown_account' });
    const result = await lookupAnimelib(userId, releaseId, Number(episode), {
      orig: titleOrig,
      ru: titleRu,
      en: titleEn,
    });
    return reply.send(result);
  });

  // Ретрансляция видео. DDoS-Guard перед CDN смотрит на Referer и Origin, а не на
  // того, кто пришёл, — поэтому байты тянем без токена, но с нужными заголовками.
  // Потоком, а не в память: серия весит 200–300 МБ. Range пробрасываем, иначе
  // сломается перемотка.
  scope.get('/animelib/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    const { url } = req.query as Record<string, string>;
    if (!url || !isAllowedAnimelibVideoUrl(url)) {
      return reply.code(400).send({ error: 'invalid_url' });
    }
    const range = req.headers.range;
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        headers: {
          'user-agent': UA,
          referer: 'https://animelib.org/',
          origin: 'https://animelib.org',
          ...(range ? { range } : {}),
        },
      });
    } catch {
      return reply.code(502).send({ error: 'upstream_unreachable' });
    }
    reply.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) reply.header(h, v);
    }
    if (!upstream.body) return reply.send();
    return reply.send(Readable.fromWeb(upstream.body));
  });
}
