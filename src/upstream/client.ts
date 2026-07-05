import { settings, upstreamOrigin } from '../config/settings.js';

/**
 * Thin wrapper over the global fetch (undici) that talks to the upstream API.
 *
 * Two jobs: keep our edge node looking like the native app (User-Agent + a tight
 * header allowlist) and refuse to be turned into an open relay (origin pinning).
 */

// Only these request headers ever reach upstream. Browser fingerprints — Origin,
// Referer, Cookie, Sec-*, sec-ch-ua, the browser UA — are intentionally dropped.
const FORWARDABLE = new Set([
  'authorization',
  'content-type',
  'accept',
  'api-version',
  'x-api-version',
]);

// undici auto-decompresses, so re-advertising the original encoding/length would
// corrupt the (already-plain) body. Hop-by-hop headers are dropped too.
const NON_FORWARDABLE_RESPONSE = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
]);

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamReply {
  status: number;
  headers: Headers;
  body: Buffer;
}

function appendParam(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendParam(params, key, item);
    return;
  }
  params.append(key, String(value));
}

function targetUrl(path: string, query?: Record<string, unknown>): URL {
  const url = new URL(`/${path.replace(/^\/+/, '')}`, settings.UPSTREAM_BASE_URL);
  // A path like "//evil.tld/x" would re-point new URL() at another host.
  if (url.origin !== upstreamOrigin) {
    throw new UpstreamError('target origin rejected', 400);
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) appendParam(url.searchParams, key, value);
  }
  return url;
}

/** Reduce inbound headers to the native-app allowlist (UA injected separately). */
export function passableHeaders(incoming: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (FORWARDABLE.has(key.toLowerCase()) && typeof value === 'string') {
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}

export async function callUpstream(opts: {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Buffer | string;
}): Promise<UpstreamReply> {
  const url = targetUrl(opts.path, opts.query);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), settings.UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: opts.method,
      headers: { 'user-agent': settings.UPSTREAM_USER_AGENT, ...(opts.headers ?? {}) },
      body: opts.body,
      signal: abort.signal,
    });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError((err as Error)?.message ?? 'upstream request failed', 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Copy upstream headers onto an outgoing reply, skipping the unsafe ones. */
export function relayHeaders(from: Headers, set: (key: string, value: string) => void): void {
  from.forEach((value, key) => {
    if (!NON_FORWARDABLE_RESPONSE.has(key.toLowerCase())) set(key, value);
  });
}

/** Fetch upstream and parse JSON in one shot (used by interceptors/features). */
export async function upstreamJson<T = unknown>(opts: {
  method?: string;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Buffer | string;
}): Promise<{ status: number; data: T | null; body: Buffer }> {
  const reply = await callUpstream({ method: opts.method ?? 'GET', ...opts });
  let data: T | null = null;
  try {
    data = JSON.parse(reply.body.toString('utf8')) as T;
  } catch {
    data = null;
  }
  return { status: reply.status, data, body: reply.body };
}
