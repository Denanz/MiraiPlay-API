import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/**
 * Резолвер потоков Kodik: по ссылке на iframe загружает страницу плеера,
 * находит запрятанную ручку, запрашивает манифест и отдаёт список качеств.
 * Шифр и формат URL — протокол самого Kodik, мы только говорим на нём.
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

/** Источники приходят сдвинутыми шифром Цезаря на 18 и закодированными в base64. */
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
    // Неразбираемое оставляем как есть — его отсеет проверка списка ниже.
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
  // Качаем строго с того хоста, который проверили выше, а не с пойманного
  // регуляркой. LINK_SHAPE не привязан к началу строки и может совпасть с куском,
  // подсунутым в query, — если дать этим двум разойтись, получится SSRF.
  const host = new URL(normalized).hostname;
  return { host, kind: groups.kind, id: groups.id, hash: groups.hash };
}

/** Путь к ручке спрятан в JS-чанке литералом внутри atob(). */
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

  // Параметры авторизации убираем: Kodik отвергает их, когда ip не совпадает.
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
