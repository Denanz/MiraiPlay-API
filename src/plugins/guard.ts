import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settings } from '../config/settings.js';
import { denylist } from '../services/blocklist.js';
import { telemetry } from '../services/monitor.js';

/**
 * Сторож запросов: учёт трафика, лимит частоты с фиксированным окном, список
 * блокировок и замок на ключ шлюза. Стоит preHandler'ом, чтобы тело запроса уже
 * было разобрано и из него можно было достать токен.
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

/** Публичные ручки, которые не могут предъявить ключ шлюза: iframe, <img>, сокеты. */
function keyExempt(method: string, path: string): boolean {
  if (method === 'OPTIONS') return true;
  if (path === '/api/v1/tg/webhook') return true;
  if (path === '/api/v1/together') return true;
  if (method === 'GET' && path === '/api/v1/img') return true;
  if (method === 'GET' && path === '/api/v1/player') return true;
  if (method === 'GET' && path.startsWith('/api/v1/player/screenshots/file/')) return true;
  // Грузится через <video src>, а он не умеет слать свои заголовки. Исключение
  // безопасно: роут отдаёт только уже проверенный по списку адрес CDN.
  if (method === 'GET' && path === '/api/v1/animelib/stream') return true;
  // Хроника носит собственный ключ (X-Timeline-Key) и проверяет его сама —
  // MiraiTimeline ходит во все три трекера одним заголовком, а не двумя.
  if (method === 'GET' && path === '/api/v1/timeline/events') return true;
  return false;
}

export function installGuard(scope: FastifyInstance): void {
  scope.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = pathOnly(req);

    // Telegram доказывает себя своим заголовком, замок и список блокировок к нему
    // не применяются.
    if (path === '/api/v1/tg/webhook') return;

    const ip = req.ip || 'unknown';
    telemetry.tickRequest(ip);

    const token = extractToken(req);

    // За SNI-проксированием у всех клиентов один исходный IP, поэтому честный
    // ключ для лимита — токен пользователя, когда он есть.
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
      // Принимаем и новое имя заголовка, и старое.
      const provided = req.headers['x-gateway-key'] ?? req.headers['x-proxy-key'];
      if (provided !== settings.GATEWAY_KEY) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
  });
}
