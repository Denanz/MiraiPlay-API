import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import sharp from 'sharp';
import { settings } from '../config/settings.js';

/**
 * Image relay. Posters and screenshots are pulled through the edge node rather
 * than the browser hitting the CDNs directly, so a visitor's real IP and Referer
 * never reach upstream infrastructure. Hosts are restricted to a fixed suffix
 * allowlist to keep this from becoming an open image proxy.
 *
 * Optionally (IMG_OPTIMIZE) transforms on the fly: downscale to `?w=` and/or
 * serve WebP when the client accepts it. Transformed bytes are cached on disk
 * keyed by url+params; any transform failure falls back to the original image.
 */

const ALLOWED_SUFFIXES = [
  '.anixmirai.com',
  '.anixart.tv',
  '.anixart.live',
  'shikimori.one',
  '.shikimori.one',
  '.dere.shikimori.org',
  'nyaa.shikimori.one',
];

function hostAllowed(host: string): boolean {
  return ALLOWED_SUFFIXES.some((suffix) =>
    suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix,
  );
}

const CACHE_DIR = join(settings.STATE_DIR, 'cache', 'img');
type OutFmt = 'webp' | 'jpeg' | 'png';
const CT: Record<OutFmt, string> = { webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' };
const EXT: Record<OutFmt, string> = { webp: 'webp', jpeg: 'jpg', png: 'png' };

function clampInt(raw: unknown, lo: number, hi: number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function cacheKey(url: string, width: number | null, quality: number, fmt: OutFmt): string {
  const h = createHash('sha256').update(`${url}|w=${width ?? ''}|q=${quality}|f=${fmt}`).digest('hex');
  return join(CACHE_DIR, `${h}.${EXT[fmt]}`);
}

export function registerMedia(scope: FastifyInstance): void {
  scope.get('/img', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, unknown>;
    const target = String(q.u ?? '');

    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return reply.code(400).send();
    }
    if (url.protocol !== 'https:' || !hostAllowed(url.hostname)) {
      return reply.code(400).send();
    }

    // ── decide transform ──
    const accept = String(req.headers.accept ?? '');
    const acceptsWebp = accept.includes('image/webp');
    const fmtParam = String(q.fmt ?? 'auto').toLowerCase();
    const width = clampInt(q.w, 16, 2000);
    const quality = clampInt(q.q, 30, 95) ?? 82;
    const wantWebp = fmtParam === 'webp' || (fmtParam === 'auto' && acceptsWebp);
    const explicit = fmtParam === 'jpg' || fmtParam === 'jpeg' || fmtParam === 'png';
    const transform = settings.IMG_OPTIMIZE && (wantWebp || width !== null || explicit);

    let outFmt: OutFmt = 'jpeg';
    if (fmtParam === 'png') outFmt = 'png';
    else if (wantWebp) outFmt = 'webp';

    const sendImage = (bytes: Buffer, contentType: string) =>
      reply
        .header('content-type', contentType)
        .header('cache-control', 'public, max-age=604800, immutable')
        .header('cross-origin-resource-policy', 'cross-origin')
        .header('vary', 'Accept')
        .send(bytes);

    // ── serve from disk cache if we have this exact variant ──
    if (transform) {
      const file = cacheKey(url.toString(), width, quality, outFmt);
      if (existsSync(file)) {
        try {
          return sendImage(readFileSync(file), CT[outFmt]);
        } catch {
          // fall through and re-fetch
        }
      }
    }

    // ── fetch upstream ──
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12000);
    try {
      const upstream = await fetch(url.toString(), {
        headers: { 'user-agent': settings.UPSTREAM_USER_AGENT, accept: 'image/*' },
        signal: abort.signal,
      });
      if (!upstream.ok) {
        return reply.code(upstream.status === 404 ? 404 : 502).send();
      }
      const srcType = upstream.headers.get('content-type') ?? 'image/jpeg';
      if (!srcType.startsWith('image/')) {
        return reply.code(415).send();
      }
      const original = Buffer.from(await upstream.arrayBuffer());

      // Skip transform for animated GIFs (would lose animation) or when disabled.
      if (!transform || srcType.includes('gif')) {
        return sendImage(original, srcType);
      }

      try {
        let pipeline = sharp(original, { failOn: 'none' });
        if (width !== null) pipeline = pipeline.resize({ width, withoutEnlargement: true });
        if (outFmt === 'webp') pipeline = pipeline.webp({ quality });
        else if (outFmt === 'png') pipeline = pipeline.png();
        else pipeline = pipeline.jpeg({ quality, mozjpeg: true });

        const out = await pipeline.toBuffer();
        try {
          mkdirSync(CACHE_DIR, { recursive: true });
          writeFileSync(cacheKey(url.toString(), width, quality, outFmt), out);
        } catch {
          // cache write is best-effort
        }
        return sendImage(out, CT[outFmt]);
      } catch {
        // Transform failed (corrupt/unsupported) — serve the original untouched.
        return sendImage(original, srcType);
      }
    } catch {
      return reply.code(502).send();
    } finally {
      clearTimeout(timer);
    }
  });
}
