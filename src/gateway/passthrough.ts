import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { callUpstream, passableHeaders, relayHeaders, UpstreamError } from '../upstream/client.js';
import { pickInterceptor } from './interceptors/index.js';

/**
 * Прокси на всё остальное: что не разобрали свои роуты, уходит в upstream, а на
 * обратном пути тело при совпадении правила переписывается.
 */

function upstreamPath(req: FastifyRequest): string {
  const tail = (req.params as Record<string, string>)['*'] ?? '';
  return `/${tail.replace(/^\/+/, '')}`;
}

function serializeBody(req: FastifyRequest): { body?: Buffer | string; contentType?: string } {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const raw = req.body as unknown;
  if (raw == null) return {};
  if (Buffer.isBuffer(raw)) return { body: raw };
  if (typeof raw === 'string') return { body: raw };

  if (typeof raw === 'object' && Object.keys(raw as object).length > 0) {
    const incomingType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (incomingType.includes('application/x-www-form-urlencoded')) {
      return {
        body: new URLSearchParams(raw as Record<string, string>).toString(),
        contentType: 'application/x-www-form-urlencoded',
      };
    }
    return { body: JSON.stringify(raw), contentType: 'application/json' };
  }
  return {};
}

async function handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = upstreamPath(req);
  const headers = passableHeaders(req.headers as Record<string, unknown>);
  const { body, contentType } = serializeBody(req);
  if (contentType) headers['content-type'] = contentType;

  try {
    const upstream = await callUpstream({
      method: req.method,
      path,
      query: req.query as Record<string, unknown>,
      headers,
      body,
    });

    relayHeaders(upstream.headers, (key, value) => reply.header(key, value));
    reply.status(upstream.status);

    const interceptor = pickInterceptor(req.method, path);
    const responseType = upstream.headers.get('content-type') ?? '';
    const isJson = responseType.includes('application/json');
    if (interceptor && upstream.status === 200 && (isJson || interceptor.force)) {
      let parsed: any = null;
      try {
        parsed = JSON.parse(upstream.body.toString('utf8'));
      } catch {
        // Правило с `force` сработает и поверх пустого тела.
        parsed = interceptor.force ? {} : null;
      }
      if (parsed !== null) {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.send(JSON.stringify(interceptor.transform(parsed)));
        return;
      }
    }

    reply.send(upstream.body);
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 502;
    reply.status(status).send({ error: 'upstream_unavailable' });
  }
}

export function registerPassthrough(scope: FastifyInstance): void {
  scope.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/*',
    handler: handle,
  });
}
