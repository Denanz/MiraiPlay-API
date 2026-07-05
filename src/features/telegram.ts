import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settings } from '../config/settings.js';
import { denylist } from '../services/blocklist.js';
import { telemetry } from '../services/monitor.js';
import { ackCallback, htmlEscape, notify, rewriteMessage } from '../services/notifier.js';
import { checkNewEpisodes } from '../services/notify-episodes.js';

/**
 * Inbound Telegram webhook — the operator's admin console. Validates the shared
 * secret, then handles inline-button taps (quick bans) and slash commands
 * (stats, journal, denylist management).
 */

function humanUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d ? `${d}д` : '', h ? `${h}ч` : '', `${m}м`].filter(Boolean).join(' ') || '0м';
}

function humanAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}с назад`;
  if (s < 3600) return `${Math.floor(s / 60)}м назад`;
  if (s < 86400) return `${Math.floor(s / 3600)}ч назад`;
  return new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

async function handleCallback(cb: any): Promise<void> {
  const data: string = cb.data ?? '';
  const messageId: number | undefined = cb.message?.message_id;

  if (data.startsWith('ban-user:')) {
    const userId = Number(data.slice('ban-user:'.length));
    denylist.banAccount(userId);
    await ackCallback(cb.id, `Аккаунт ${userId} забанен`);
    if (messageId) await rewriteMessage(messageId, `🚫 Аккаунт <code>${userId}</code> забанен.`);
    return;
  }

  if (data.startsWith('ban-ip:')) {
    const ip = data.slice('ban-ip:'.length);
    const ok = denylist.banIp(ip);
    await ackCallback(cb.id, ok ? `IP ${ip} забанен` : 'Этот IP нельзя забанить');
    if (messageId && ok) await rewriteMessage(messageId, `🚫 IP <code>${ip}</code> забанен.`);
  }
}

async function handleCommand(text: string): Promise<void> {
  const [cmd, arg] = text.trim().split(/\s+/);
  const asLogin = arg && !/^\d+$/.test(arg);

  switch (cmd) {
    case '/stats': {
      const o = telemetry.overview();
      const bl = denylist.snapshot();
      const top = o.topIps.length
        ? o.topIps.map(([ip, c]) => `  <code>${htmlEscape(ip)}</code> — ${c}`).join('\n')
        : '  —';
      const active = o.active.length
        ? o.active
            .slice(0, 15)
            .map(
              (s) =>
                `  ${htmlEscape(s.login)} (<code>${s.id}</code>) · <code>${htmlEscape(s.ip)}</code> · ${humanAgo(s.seenAt)}`,
            )
            .join('\n')
        : '  —';
      await notify(
        '📊 <b>Статистика</b>\n' +
          `⏱ Аптайм: ${humanUptime(o.uptimeMs)}\n` +
          `📨 Запросов: ${o.totalRequests} всего · ${o.lastHour} за час\n` +
          `🔑 Сессий: ${o.sessionsSeen}\n` +
          `🚫 Денилист: ${bl.accounts.length + bl.logins.length} акк · ${bl.ips.length} IP\n\n` +
          `👥 <b>Активные (15 мин): ${o.active.length}</b>\n${active}\n\n` +
          `🌐 <b>Топ IP</b>\n${top}`,
      );
      break;
    }
    case '/logins': {
      const list = telemetry.recentLogins(15);
      const body = list.length
        ? list
            .map(
              (l) =>
                `• ${humanAgo(l.at)} — <b>${htmlEscape(l.login)}</b> (<code>${l.id}</code>)\n  <code>${htmlEscape(l.ip)}</code> · ${htmlEscape(l.agent.slice(0, 60))}`,
            )
            .join('\n')
        : '—';
      await notify('🔐 <b>Последние входы</b>\n' + body);
      break;
    }
    case '/denylist': {
      const bl = denylist.snapshot();
      await notify(
        '📋 <b>Денилист</b>\n' +
          `👤 Аккаунты: ${bl.accounts.join(', ') || '—'}\n` +
          `👤 Логины: ${bl.logins.join(', ') || '—'}\n` +
          `🌐 IP: ${bl.ips.join(', ') || '—'}`,
      );
      break;
    }
    case '/ban_user':
      if (arg) {
        denylist.banAccount(asLogin ? undefined : Number(arg), asLogin ? arg : undefined);
        await notify(`🚫 Забанен: ${htmlEscape(arg)}`);
      } else await notify('Использование: /ban_user &lt;id|логин&gt;');
      break;
    case '/unban_user':
      if (arg) {
        denylist.unbanAccount(asLogin ? undefined : Number(arg), asLogin ? arg : undefined);
        await notify(`✅ Разбанен: ${htmlEscape(arg)}`);
      } else await notify('Использование: /unban_user &lt;id|логин&gt;');
      break;
    case '/ban_ip':
      if (arg) {
        const ok = denylist.banIp(arg);
        await notify(ok ? `🚫 IP забанен: ${htmlEscape(arg)}` : 'Этот IP нельзя забанить');
      } else await notify('Использование: /ban_ip &lt;ip&gt;');
      break;
    case '/unban_ip':
      if (arg) {
        denylist.unbanIp(arg);
        await notify(`✅ IP разбанен: ${htmlEscape(arg)}`);
      } else await notify('Использование: /unban_ip &lt;ip&gt;');
      break;
    case '/episodes': {
      const r = await checkNewEpisodes();
      await notify(
        r.checked === 0
          ? 'ℹ️ Не могу проверить: нет сохранённого токена (открой любую серию в приложении) или бот не настроен.'
          : `✅ Проверено релизов: ${r.checked}. Новых серий: ${r.notified}.`,
      );
      break;
    }
    case '/help':
      await notify(
        '🛡 <b>Команды</b>\n' +
          '/stats — статистика и активные сессии\n' +
          '/logins — журнал входов\n' +
          '/episodes — проверить новые серии из вотчлиста\n' +
          '/denylist — показать денилист\n' +
          '/ban_user &lt;id|логин&gt; · /unban_user &lt;id|логин&gt;\n' +
          '/ban_ip &lt;ip&gt; · /unban_ip &lt;ip&gt;',
      );
      break;
  }
}

export function registerTelegram(scope: FastifyInstance): void {
  scope.post('/tg/webhook', async (req: FastifyRequest, reply: FastifyReply) => {
    if (
      !settings.TELEGRAM_WEBHOOK_SECRET ||
      req.headers['x-telegram-bot-api-secret-token'] !== settings.TELEGRAM_WEBHOOK_SECRET
    ) {
      return reply.code(403).send();
    }

    // Acknowledge immediately; process the update out of band.
    reply.code(200).send();

    const update = (req.body ?? {}) as any;
    try {
      if (update.callback_query) {
        await handleCallback(update.callback_query);
        return;
      }
      const text: string = update.message?.text ?? '';
      if (text.startsWith('/')) await handleCommand(text);
    } catch {
      // Never throw out of a webhook handler.
    }
  });
}
