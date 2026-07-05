import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settings } from '../config/settings.js';
import { denylist } from '../services/blocklist.js';
import { telemetry } from '../services/monitor.js';

/**
 * Per-scope request guard: traffic accounting, a fixed-window rate limiter, the
 * access denylist and the gateway-key lock. Installed as a preHandler so the
 * (already parsed) body is available for token extraction.
 */

interface Window {
  hits: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows) if (w.resetAt < now) windows.delete(key);
}, settings.RATE_LIMIT_WINDOW_MS).unref();

function extractToken(req: FastifyRequest): string | undefined {
  const query = (req.query ?? {}) as Record<string, unknown>;
  if (typeof query.token === 'string') return query.token;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.token === 'string') return body.token;
  return undefined;
}

function pathOnly(req: FastifyRequest): string {
  const q = req.url.indexOf('?');
  return q === -1 ? req.url : req.url.slice(0, q);
}

/** Public endpoints that cannot present the gateway key (iframes, <img>, sockets). */
function keyExempt(method: string, path: string): boolean {
  if (method === 'OPTIONS') return true;
  if (path === '/api/v1/tg/webhook') return true;
  if (path === '/api/v1/together') return true;
  if (method === 'GET' && path === '/api/v1/img') return true;
  if (method === 'GET' && path === '/api/v1/player') return true;
  if (method === 'GET' && path.startsWith('/api/v1/player/screenshots/file/')) return true;
  return false;
}

export function installGuard(scope: FastifyInstance): void {
  scope.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = pathOnly(req);

    // Telegram authenticates with its own secret header; the gateway lock and
    // denylist don't apply to its callbacks.
    if (path === '/api/v1/tg/webhook') return;

    const ip = req.ip || 'unknown';
    telemetry.tickRequest(ip);

    const token = extractToken(req);

    // Behind an SNI passthrough every client shares one source IP, so the user
    // token (when present) is the fair rate-limit key.
    const key = token ? `t:${token}` : `i:${ip}`;
    const now = Date.now();
    let window = windows.get(key);
    if (!window || window.resetAt < now) {
      window = { hits: 0, resetAt: now + settings.RATE_LIMIT_WINDOW_MS };
      windows.set(key, window);
    }
    window.hits += 1;
    if (window.hits > settings.RATE_LIMIT_MAX) {
      reply.header('retry-after', Math.ceil((window.resetAt - now) / 1000));
      return reply.code(429).send({ error: 'rate_limited' });
    }

    if (denylist.ipBlocked(ip)) return reply.code(403).send({ error: 'forbidden' });
    if (denylist.tokenBlocked(token)) return reply.code(403).send({ error: 'forbidden' });

    telemetry.touchSession(token, ip);

    if (settings.GATEWAY_KEY && !keyExempt(req.method, path)) {
      // Accept the new header name and the legacy one for drop-in migration.
      const provided = req.headers['x-gateway-key'] ?? req.headers['x-proxy-key'];
      if (provided !== settings.GATEWAY_KEY) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
  });
}
