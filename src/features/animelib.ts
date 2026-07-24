import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { resolveUserId } from '../services/identity.js';
import {
  setToken,
  getToken,
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
  // ── Connect/disconnect the caller's own AnimeLib account (token pasted from
  //    their own logged-in browser session — see services/animelib.ts) ──
  scope.post('/animelib/token', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { animelibToken } = (req.body ?? {}) as Record<string, unknown>;
    const clean = typeof animelibToken === 'string' ? animelibToken.trim() : '';
    if (!clean) return reply.code(400).send({ error: 'missing_token' });
    const userId = await resolveUserId(token);
    if (!userId) return reply.code(401).send({ error: 'unknown_account' });
    setToken(userId, clean);
    return reply.send({ ok: true, expiresAt: tokenExpiresAt(clean) });
  });

  scope.get('/animelib/status', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const userId = await resolveUserId(token);
    const saved = userId ? getToken(userId) : undefined;
    return reply.send({ connected: !!saved, expiresAt: saved ? tokenExpiresAt(saved) : null });
  });

  scope.post('/animelib/disconnect', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const userId = await resolveUserId(token);
    if (userId) clearToken(userId);
    return reply.send({ ok: true });
  });

  // Manual releaseId -> AnimeLib anime_id pin — fallback for whatever the
  // (now authenticated) search still gets wrong (see services/animelib.ts).
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
  // distinct from /animelib/episode below, which picks one best dub for the
  // in-player opt-in swap.
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

  // Video relay: DDoS-Guard in front of AnimeLib's CDN gates on Referer/Origin,
  // not caller identity, so once /animelib/episode has resolved a URL, no token
  // is needed to fetch the bytes — just the right headers, set here server-side
  // (a browser hitting the CDN directly from our domain would send the wrong
  // Referer and get a 403). Streamed, not buffered — episodes run 200-300MB —
  // with Range passthrough so seeking still works.
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
