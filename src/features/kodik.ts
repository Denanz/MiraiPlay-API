import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/**
 * Kodik stream resolver. Given a Kodik iframe link it loads the player page,
 * finds the (obfuscated) info endpoint, requests the stream manifest and
 * returns a clean list of qualities. The cipher and URL shape are Kodik's own
 * protocol — we just speak it.
 */

const LINK_SHAPE =
  /\/\/(?<host>[^/]+)\/(?<kind>[^/]+)\/(?<id>\d+)\/(?<hash>[a-f0-9]+)\/(?<quality>\d+p)/i;
const QUALITY_PRIORITY = ['1080', '720', '480', '360', '240'];
const FALLBACK_HOST = 'kodikplayer.com';
const REWRITE_HOSTS = new Set(['kodik.info', 'kodik.biz', 'kodik.cc']);
const ALLOWED_HOSTS = new Set([
  FALLBACK_HOST,
  'kodik.info',
  'kodik.biz',
  'kodik.cc',
  'kodikdb.com',
  'aniqit.com',
]);
const BROWSER_UA = 'Mozilla/5.0';

export interface StreamQuality {
  label: string;
  url: string;
}

export interface ResolvedPlayback {
  qualities: StreamQuality[];
  defaultLabel: string;
}

/** Kodik ships sources Caesar-shifted by 18 then base64-encoded. */
function decodeSource(encoded: string): string {
  const unshifted = encoded.replace(/[a-z]/gi, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code <= 90 ? 65 : 97; // uppercase 'A' vs lowercase 'a'
    return String.fromCharCode(((code - base + 18) % 26) + base);
  });
  return Buffer.from(unshifted, 'base64').toString('utf8');
}

function toHttps(url: string): string {
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http')) return url;
  return `https://${url}`;
}

function canonicalUrl(url: string): string {
  let normalized = url.startsWith('//') ? `https:${url}` : url;
  if (!normalized.startsWith('http')) {
    normalized = `https://${FALLBACK_HOST}/${normalized.replace(/^\/+/, '')}`;
  }
  try {
    const parsed = new URL(normalized);
    if (REWRITE_HOSTS.has(parsed.hostname)) {
      parsed.hostname = FALLBACK_HOST;
      return parsed.toString();
    }
  } catch {
    // Leave unparseable input as-is; the allowlist check below rejects it.
  }
  return normalized;
}

export function isAllowedKodikUrl(url: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(canonicalUrl(url)).hostname);
  } catch {
    return false;
  }
}

interface LinkParts {
  host: string;
  kind: string;
  id: string;
  hash: string;
}

function dissect(url: string): LinkParts {
  const normalized = canonicalUrl(url);
  if (!isAllowedKodikUrl(normalized)) throw new Error('kodik host not allowed');
  const groups = normalized.match(LINK_SHAPE)?.groups;
  if (!groups?.host || !groups.kind || !groups.id || !groups.hash) {
    throw new Error('malformed kodik link');
  }
  // The fetch target must be the SAME hostname that was actually validated above —
  // never the regex-captured group. LINK_SHAPE is unanchored, so it can match a
  // //host/kind/id/hash/qualityp-shaped substring smuggled anywhere in the URL
  // (e.g. a query param) while the real, parsed hostname (what the allowlist check
  // above inspected) points somewhere else — an SSRF if the two are allowed to
  // diverge.
  const host = new URL(normalized).hostname;
  return { host, kind: groups.kind, id: groups.id, hash: groups.hash };
}

/** The info endpoint path is hidden in a JS chunk as an atob() literal. */
async function discoverInfoEndpoint(page: string, host: string): Promise<string> {
  const chunk = page.match(/src="(?<path>\/assets\/js\/app\.player_single\.[^"]+\.js)"/i)?.groups
    ?.path;
  if (!chunk) return '/ftor';
  try {
    const script = await fetch(`https://${host}${chunk}`, {
      headers: { 'user-agent': BROWSER_UA },
    }).then((r) => r.text());
    const b64 = script.match(/url:atob\("(?<b64>[^"]+)"\)/i)?.groups?.b64;
    if (!b64) return '/ftor';
    return Buffer.from(b64, 'base64').toString('utf8') || '/ftor';
  } catch {
    return '/ftor';
  }
}

type ManifestLinks = Record<string, Array<{ src?: string }> | undefined>;

function collectQualities(links: ManifestLinks): StreamQuality[] {
  const out: StreamQuality[] = [];
  const seen = new Set<string>();
  const extras = Object.keys(links).filter((q) => !QUALITY_PRIORITY.includes(q));

  for (const quality of [...QUALITY_PRIORITY, ...extras]) {
    const src = links[quality]?.[0]?.src;
    if (!src) continue;
    const url = toHttps(decodeSource(src));
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ label: quality.endsWith('p') ? quality : `${quality}p`, url });
  }
  return out;
}

export async function resolveKodik(rawUrl: string): Promise<ResolvedPlayback> {
  const parts = dissect(rawUrl);

  // Drop the auth params (d/s/ip) — Kodik rejects them when ip ≠ requester.
  const pageUrl = new URL(canonicalUrl(rawUrl));
  pageUrl.search = '';

  const page = await fetch(pageUrl.toString(), {
    headers: { 'user-agent': BROWSER_UA },
  }).then((r) => r.text());
  if (!page.includes('urlParams')) throw new Error('kodik player page missing params');

  const endpoint = await discoverInfoEndpoint(page, parts.host);
  const infoUrl = new URL(endpoint, `https://${parts.host}`);
  infoUrl.searchParams.set('type', parts.kind);
  infoUrl.searchParams.set('id', parts.id);
  infoUrl.searchParams.set('hash', parts.hash);

  const manifest = (await fetch(infoUrl.toString(), {
    headers: { 'user-agent': BROWSER_UA, referer: canonicalUrl(rawUrl) },
  }).then((r) => r.json())) as { links?: ManifestLinks };

  if (!manifest.links || typeof manifest.links !== 'object') {
    throw new Error('kodik returned no links');
  }

  const qualities = collectQualities(manifest.links);
  if (qualities.length === 0) throw new Error('no playable stream found');

  return { qualities, defaultLabel: qualities[0]?.label ?? 'Авто' };
}

export function registerKodik(scope: FastifyInstance): void {
  scope.get('/kodik/resolve', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = (req.query as Record<string, unknown>).url;
    if (typeof url !== 'string' || !url) {
      return reply.code(400).send({ error: 'missing query parameter: url' });
    }
    try {
      return reply.send(await resolveKodik(url));
    } catch (err) {
      return reply.code(500).send({
        error: 'kodik_resolve_failed',
        details: (err as Error).message,
      });
    }
  });
}
