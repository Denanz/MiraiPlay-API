import { settings, upstreamOrigin } from '../config/settings.js';

/**
 * Тонкая обёртка над fetch для похода в upstream API.
 *
 * Две задачи: выглядеть для него как нативное приложение — User-Agent и узкий
 * список заголовков — и не превратиться в открытый релей, для чего origin прибит.
 */

// Наверх уходят только эти заголовки. Всё, по чему узнаётся браузер — Origin,
// Referer, Cookie, Sec-*, UA — отбрасывается намеренно.
const FORWARDABLE = new Set([
  'authorization',
  'content-type',
  'accept',
  'api-version',
  'x-api-version',
]);

// undici распаковывает сам, поэтому исходные encoding и length передавать нельзя —
// тело уже распаковано. Hop-by-hop заголовки тоже убираем.
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
  // Путь вида "//evil.tld/x" увёл бы new URL() на чужой хост.
  if (url.origin !== upstreamOrigin) {
    throw new UpstreamError('target origin rejected', 400);
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) appendParam(url.searchParams, key, value);
  }
  return url;
}

/** Оставляет от входящих заголовков только разрешённые; UA подставляется отдельно. */
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

/** Переносит заголовки ответа upstream в наш, отбрасывая небезопасные. */
export function relayHeaders(from: Headers, set: (key: string, value: string) => void): void {
  from.forEach((value, key) => {
    if (!NON_FORWARDABLE_RESPONSE.has(key.toLowerCase())) set(key, value);
  });
}

/** Сходить в upstream и сразу разобрать JSON. */
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
