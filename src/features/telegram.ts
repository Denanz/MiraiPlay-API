import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settings } from '../config/settings.js';
import { denylist } from '../services/blocklist.js';
import { telemetry } from '../services/monitor.js';
import { ackCallback, htmlEscape, notify, rewriteMessage } from '../services/notifier.js';
import type { TgButton } from '../services/notifier.js';
import { checkNewEpisodes } from '../services/notify-episodes.js';
import { animeHasEpisodes, setOverride } from '../services/animelib.js';
import { upstreamJson } from '../upstream/client.js';

/**
 * Входящий вебхук Telegram — админка владельца. Проверяет общий секрет, затем
 * разбирает нажатия инлайн-кнопок и слэш-команды.
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
    return;
  }

  if (data.startsWith('al-set:')) {
    const [releaseId, animeIdStr] = data.slice('al-set:'.length).split(':');
    const animeId = Number(animeIdStr);
    if (!releaseId || !animeId) return;
    setOverride(releaseId, animeId);
    await ackCallback(cb.id, 'Привязано');
    if (messageId) {
      const rel = await upstreamJson<{ release?: { title_ru?: string } }>({ path: `/release/${releaseId}` });
      const title = rel.data?.release?.title_ru || `releaseId ${releaseId}`;
      await rewriteMessage(
        messageId,
        `✅ <b>${htmlEscape(title)}</b> привязан к AnimeLib id <code>${animeId}</code>.`,
      );
    }
    return;
  }

  if (data === 'al-cancel') {
    await ackCallback(cb.id, 'Отменено');
    if (messageId) await rewriteMessage(messageId, '❌ Отменено.');
  }
}

// Ссылка на страницу аниме animelib.org: забираем id и slug. Ссылки на мангу и
// ранобэ с того же домена игнорируем — интеграция только про аниме.
const ANIMELIB_LINK_RE = /animelib\.org\/(?:[a-z]{2}\/)?anime\/(\d+)--([a-z0-9-]+)/i;

// Slug у AnimeLib собран из ромадзи и достаточно близок к оригинальному
// названию, чтобы скормить его поиску Anixart — тот, в отличие от AnimeLib,
// ничего не прячет. Убираем хвостовой маркер типа и меняем дефисы на пробелы.
function deriveSearchQuery(slug: string): string {
  return slug.replace(/-(anime|tv|ova|ona|movie|special)$/i, '').replace(/-/g, ' ').trim();
}

interface ReleaseSearchItem {
  id: number;
  title_ru?: string;
  title_original?: string;
  year?: number | string;
}

function extractSearchResults(data: unknown): ReleaseSearchItem[] {
  const obj = data as { content?: ReleaseSearchItem[] | { content?: ReleaseSearchItem[] }; releases?: ReleaseSearchItem[] };
  if (Array.isArray(obj?.content)) return obj.content;
  if (obj?.content && 'content' in obj.content && Array.isArray(obj.content.content)) return obj.content.content;
  return obj?.releases ?? [];
}

/**
 * Позволяет кинуть боту голую ссылку на AnimeLib вместо похода в поле пина на
 * сайте. Автоматического сопоставления здесь нет: проверяем, что тайтл реален,
 * из slug выводим поисковый запрос, а нужный релиз владелец выбирает руками.
 */
async function handleAnimelibLink(text: string): Promise<void> {
  const match = text.match(ANIMELIB_LINK_RE);
  if (!match) return;
  const animeId = Number(match[1]);
  const slug = match[2];

  if (!(await animeHasEpisodes(animeId))) {
    await notify(`⚠️ AnimeLib id <code>${animeId}</code> из ссылки не отдаёт серии — проверь ссылку.`);
    return;
  }

  const query = deriveSearchQuery(slug);
  const res = await upstreamJson({
    method: 'POST',
    path: '/search/releases/0',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, searchBy: 0 }),
  });
  const items = extractSearchResults(res.data).slice(0, 5);

  if (items.length === 0) {
    await notify(
      `🔎 AnimeLib id <code>${animeId}</code> подтверждён, но по запросу «${htmlEscape(query)}» на сайте ничего не нашлось.\n` +
        'Привяжи вручную на странице серий — сама ссылка рабочая.',
    );
    return;
  }

  const keyboard: TgButton[][] = items.map((r) => [
    {
      text: `${r.title_ru || r.title_original || r.id} (${r.year || '?'})`,
      callback_data: `al-set:${r.id}:${animeId}`,
    },
  ]);
  keyboard.push([{ text: '❌ Отмена', callback_data: 'al-cancel' }]);

  await notify(
    `🔗 AnimeLib id <code>${animeId}</code> (по ссылке: «${htmlEscape(query)}»).\nС каким тайтлом на сайте связать?`,
    keyboard,
  );
}

async function handleCommand(text: string): Promise<void> {
  const [cmd, arg] = text.trim().split(/\s+/);
  // Аргумент из одних цифр может быть и id, и логином: числовые логины Anixart
  // не запрещает. Догадка «цифры значит id» забанила бы не того, поэтому при
  // числовом аргументе бьём сразу по обоим полям — каждое сверяется точно.
  const numericId = arg && /^\d+$/.test(arg) ? Number(arg) : undefined;

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
        denylist.banAccount(numericId, arg);
        await notify(`🚫 Забанен: ${htmlEscape(arg)}`);
      } else await notify('Использование: /ban_user &lt;id|логин&gt;');
      break;
    case '/unban_user':
      if (arg) {
        denylist.unbanAccount(numericId, arg);
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
          '/ban_ip &lt;ip&gt; · /unban_ip &lt;ip&gt;\n\n' +
          '🔗 Просто кинь ссылку на animelib.org/anime/... — предложу, с каким тайтлом на сайте её связать.',
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

    // Отвечаем сразу, обработку делаем отдельно.
    reply.code(200).send();

    const update = (req.body ?? {}) as any;
    try {
      // Секрет вебхука подтверждает только то, что запрос пришёл от Telegram, но
      // ничего не говорит об отправителе. Без этой проверки админские команды мог
      // бы отдавать любой, кто нашёл бота. Команды принимаем лишь из чата владельца.
      const senderChatId = String(
        update.callback_query?.message?.chat?.id ?? update.message?.chat?.id ?? '',
      );
      if (!settings.TELEGRAM_CHAT_ID || senderChatId !== settings.TELEGRAM_CHAT_ID) return;

      if (update.callback_query) {
        await handleCallback(update.callback_query);
        return;
      }
      const text: string = update.message?.text ?? '';
      if (text.startsWith('/')) await handleCommand(text);
      else if (text) await handleAnimelibLink(text);
    } catch {
      // Из обработчика вебхука наружу ничего не бросаем.
    }
  });
}
