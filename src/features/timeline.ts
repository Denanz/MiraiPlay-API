import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settings } from '../config/settings.js';
import { readEvents } from '../services/timeline.js';

/**
 * Read-only хроника просмотров для MiraiTimeline. Формат ответа общий для всех
 * трёх трекеров (play/beat/track): события строго новее `since`, по возрастанию
 * `ts`, плюс курсор `next_since` для следующего опроса.
 *
 * Ключ: `X-Timeline-Key`. Отдельный `TIMELINE_KEY` предпочтительнее, но при его
 * отсутствии принимается `GATEWAY_KEY` — механика ключа здесь уже есть, а
 * заводить второй секрет ради одного роута необязательно. Если не задан ни
 * один — роут отвечает 404, чтобы личная история не открывалась «по умолчанию».
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function expectedKey(): string | undefined {
  return settings.TIMELINE_KEY || settings.GATEWAY_KEY || undefined;
}

function keyMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerTimeline(scope: FastifyInstance): void {
  scope.get('/timeline/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const expected = expectedKey();
    // Не 401: без настроенного ключа роут не должен даже выдавать, что он есть.
    if (!expected) return reply.code(404).send({ error: 'not_found' });
    if (!keyMatches(req.headers['x-timeline-key'], expected)) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const q = req.query as Record<string, string>;
    // Чей просмотр отдавать. Ключ служебный, один на весь сервис, поэтому без
    // явного зрителя поллер вытянул бы чужую историю просмотров.
    const user = Number(q.user);
    if (!Number.isInteger(user) || user <= 0) {
      return reply.code(400).send({ error: 'user_required' });
    }
    const since = typeof q.since === 'string' && q.since ? q.since : undefined;
    if (since && !Number.isFinite(Date.parse(since))) {
      return reply.code(400).send({ error: 'invalid_since' });
    }
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || DEFAULT_LIMIT));

    const events = readEvents(user, since, limit);
    return reply.send({
      events,
      // Пусто → отдаём обратно то, что прислали: клиент продолжит с той же точки.
      next_since: events.length ? events[events.length - 1]!.ts : (since ?? null),
    });
  });
}
