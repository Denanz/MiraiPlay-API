import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settings, allowedOrigins } from '../config/settings.js';
import { callUpstream } from '../upstream/client.js';
import { isAllowedKodikUrl, resolveKodik } from './kodik.js';
import { buildPlayerPage } from './player.page.js';
import { bucketFor, listShots, openShot, removeShot, saveShot, setNote } from '../services/screenshots.js';
import { getProgress, listContinue, saveProgress } from '../services/progress.js';
import { setNotifyToken } from '../services/notify-episodes.js';
import { findAnime } from '../services/shikimori.js';
import {
  bucketFor as ratingBucket,
  setRating,
  deleteRating,
  getRatings,
  getRating,
  setReleaseRating,
  getReleaseRating,
  deleteReleaseRating,
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
 * Player endpoints: the HTML page (resolves a Kodik link into a self-hosted
 * player), watch-progress sync, and the personal screenshot gallery.
 */

const frameAncestors = [
  "'self'",
  ...[...allowedOrigins].filter((o) => o.startsWith('http')),
].join(' ');

function tokenFrom(req: FastifyRequest): string {
  const q = req.query as Record<string, unknown>;
  if (typeof q.token === 'string') return q.token;
  const b = (req.body ?? {}) as Record<string, unknown>;
  return typeof b.token === 'string' ? b.token : '';
}

export function registerPlayer(scope: FastifyInstance): void {
  // ── HTML player page ──
  scope.get('/player', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string>;
    const { url, title, subtitle, releaseId, sourceId, position, token } = q;

    if (!url || !releaseId || !sourceId || !position) {
      return reply.code(400).type('text/plain').send('missing: url, releaseId, sourceId, position');
    }
    if (!isAllowedKodikUrl(url)) {
      return reply.code(400).type('text/plain').send('invalid player url');
    }

    let playback;
    try {
      playback = await resolveKodik(url);
    } catch {
      return reply.code(502).type('text/plain').send('failed to resolve stream');
    }

    // Cross-device resume: pull the last saved position for this episode from
    // the user's bucket so playback continues even on a device with no
    // localStorage history. The page still merges in any newer local value.
    let resumeTime = 0;
    if (token) {
      const saved = getProgress(bucketFor(token), String(releaseId), String(sourceId), String(position));
      if (saved && saved.position > 15) resumeTime = saved.position;
    }

    // Best-effort MAL ID lookup for Aniskip (1.5s budget; cache makes it instant on repeat).
    // Search ONLY by the clean release title. `subtitle` is "dubber · source ·
    // серия N" — feeding that to Shikimori matches garbage (e.g. it returns the
    // wrong anime on the trailing episode number), which then yields skip times
    // for the wrong show. `origTitle` is an optional romaji/original fallback.
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
    });

    reply
      .header('content-security-policy', `frame-ancestors ${frameAncestors}`)
      .header('cache-control', 'no-store, must-revalidate')
      .removeHeader('x-frame-options');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // ── watch progress sync ──
  scope.post('/player/progress', async (req: FastifyRequest, reply: FastifyReply) => {
    const { releaseId, sourceId, episodePosition, time, duration, title, token } = (req.body ??
      {}) as {
      releaseId?: unknown;
      sourceId?: unknown;
      episodePosition?: unknown;
      time?: unknown;
      duration?: unknown;
      title?: unknown;
      token?: unknown;
    };
    if (!releaseId || !sourceId || !episodePosition) {
      return reply.code(400).send({ error: 'missing_fields' });
    }
    // Mark the episode watched upstream once the user is ~through it.
    if (
      typeof time === 'number' &&
      typeof duration === 'number' &&
      duration > 0 &&
      time / duration >= 0.9
    ) {
      void callUpstream({
        method: 'GET',
        path: `/episode/watch/${releaseId}/${sourceId}/${episodePosition}`,
        query: typeof token === 'string' ? { token } : undefined,
      }).catch(() => {});
    }
    // Persist fine-grained position for cross-device resume + continue-watching.
    if (typeof token === 'string' && token && typeof time === 'number' && time >= 0) {
      saveProgress(bucketFor(token), {
        releaseId: String(releaseId),
        sourceId: String(sourceId),
        episode: String(episodePosition),
        position: Math.floor(time),
        duration: typeof duration === 'number' && duration > 0 ? Math.floor(duration) : 0,
        title: typeof title === 'string' ? title.slice(0, 200) : undefined,
        updatedAt: Date.now(),
      });
      // Remember the owner's token so the new-episode watcher can read their list.
      setNotifyToken(token);
    }
    return reply.code(204).send();
  });

  // ── saved position for one episode (cross-device resume) ──
  scope.get('/player/progress', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId || !q.sourceId || !q.episode) {
      return reply.code(400).send({ error: 'missing_fields' });
    }
    const e = getProgress(bucketFor(token), q.releaseId, q.sourceId, q.episode);
    return reply.send({
      position: e?.position ?? 0,
      duration: e?.duration ?? 0,
      updatedAt: e?.updatedAt ?? 0,
    });
  });

  // ── in-progress episodes across releases (continue watching) ──
  scope.get('/player/continue', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    return reply.send({ items: listContinue(bucketFor(token)) });
  });

  // ── screenshot gallery ──
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
      const meta = saveShot(bucketFor(token), bytes, match[1] === 'png' ? 'png' : 'jpg', {
        releaseId: releaseId != null ? String(releaseId) : undefined,
        title: typeof title === 'string' ? title.slice(0, 200) : undefined,
        episode: Number(episode) || undefined,
        time: Number(time) || undefined,
      });
      return reply.send({ ok: true, id: meta.id });
    } catch {
      return reply.code(500).send({ error: 'save_failed' });
    }
  });

  scope.get('/player/screenshots', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const bucket = bucketFor(token);
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
    const ok = removeShot(bucketFor(token), id);
    return reply.code(ok ? 200 : 404).send({ ok });
  });

  // Attach/clear a free-text note on a screenshot.
  scope.post('/player/screenshots/:id/note', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ ok: false });
    const { id } = req.params as { id: string };
    const { note } = (req.body ?? {}) as Record<string, unknown>;
    const ok = setNote(bucketFor(token), id, typeof note === 'string' ? note : '');
    return reply.code(ok ? 200 : 404).send({ ok });
  });

  // ── Episode ratings ──
  scope.post('/player/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { releaseId, sourceId, episode, rating } = (req.body ?? {}) as Record<string, unknown>;
    if (!releaseId || !sourceId || !episode) return reply.code(400).send({ error: 'missing_fields' });
    const r = Number(rating);
    if (!r || r < 1 || r > 10) return reply.code(400).send({ error: 'rating must be 1–10' });
    setRating(ratingBucket(token), String(releaseId), String(sourceId), String(episode), r);
    return reply.send({ ok: true, rating: r });
  });

  scope.delete('/player/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId || !q.sourceId || !q.episode) return reply.code(400).send({ error: 'missing_fields' });
    deleteRating(ratingBucket(token), q.releaseId, q.sourceId, q.episode);
    return reply.send({ ok: true });
  });

  // All ratings for a release+source (used by the episode list)
  scope.get('/player/ratings', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId || !q.sourceId) return reply.code(400).send({ error: 'missing_fields' });
    return reply.send({ ratings: getRatings(ratingBucket(token), q.releaseId, q.sourceId) });
  });

  // Single episode rating (used by the player on load)
  scope.get('/player/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId || !q.sourceId || !q.episode) return reply.code(400).send({ error: 'missing_fields' });
    const rating = getRating(ratingBucket(token), q.releaseId, q.sourceId, q.episode);
    return reply.send({ rating });
  });

  // ── Personal release rating (1–10, stored on MiraiHub only — never sent to
  //    Anixart; separate from the upstream 5-star community vote) ──
  scope.post('/release/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { releaseId, rating } = (req.body ?? {}) as Record<string, unknown>;
    if (!releaseId) return reply.code(400).send({ error: 'missing_fields' });
    const r = Number(rating);
    if (!r || r < 1 || r > 10) return reply.code(400).send({ error: 'rating must be 1–10' });
    setReleaseRating(ratingBucket(token), String(releaseId), r);
    return reply.send({ ok: true, rating: r });
  });

  scope.delete('/release/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId) return reply.code(400).send({ error: 'missing_fields' });
    deleteReleaseRating(ratingBucket(token), q.releaseId);
    return reply.send({ ok: true });
  });

  scope.get('/release/rating', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenFrom(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId) return reply.code(400).send({ error: 'missing_fields' });
    const rating = getReleaseRating(ratingBucket(token), q.releaseId);
    return reply.send({ rating });
  });
}
