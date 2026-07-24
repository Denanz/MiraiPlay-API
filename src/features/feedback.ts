import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { denylist } from '../services/blocklist.js';
import { resolveUserId } from '../services/identity.js';
import { htmlEscape, notify } from '../services/notifier.js';

/**
 * Кнопка «Сообщить о баге / предложить» в интерфейсе. Заявки не копятся нигде
 * на сервере — уходят напрямую в тот же Telegram-чат, куда падают остальные
 * уведомления (см. notifier.ts), чтобы не заводить отдельную админку ради
 * десятка сообщений в месяц.
 */
export function registerFeedback(scope: FastifyInstance): void {
  scope.post('/feedback', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as { type?: unknown; message?: unknown; page?: unknown };
    const message = String(body.message ?? '').trim().slice(0, 2000);
    if (!message) return reply.code(400).send({ error: 'empty_message' });

    const type = body.type === 'bug' ? 'bug' : 'idea';
    const token = String((req.query as Record<string, unknown>)?.token ?? '');

    let who = '—';
    if (token) {
      const owner = denylist.getOwner(token);
      if (owner) {
        who = `${htmlEscape(owner.login)} (id ${owner.id})`;
      } else {
        const id = await resolveUserId(token);
        if (id) who = `id ${id}`;
      }
    }

    const lines = [
      type === 'bug' ? '🐞 <b>Сообщение о баге</b>' : '💡 <b>Предложение</b>',
      '',
      htmlEscape(message),
      '',
      `👤 От: ${who}`,
      body.page ? `📍 Страница: ${htmlEscape(body.page)}` : '',
      `⏰ ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`,
    ].filter(Boolean);

    await notify(lines.join('\n'));
    return reply.send({ ok: true });
  });
}
