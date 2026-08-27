import { settings } from '../config/settings.js';

/**
 * Исходящая половина моста в Telegram: сообщения владельцу без ожидания ответа.
 * Входящие команды — в features/telegram.ts.
 */

export interface TgButton {
  text: string;
  callback_data: string;
}

const endpoint = (method: string) =>
  `https://api.telegram.org/bot${settings.TELEGRAM_BOT_TOKEN}/${method}`;

export function notifierReady(): boolean {
  return Boolean(settings.TELEGRAM_BOT_TOKEN && settings.TELEGRAM_CHAT_ID);
}

async function call(method: string, payload: Record<string, unknown>): Promise<void> {
  if (!settings.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(endpoint(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Не доставилось — молчим: сбой уведомления не должен всплывать у пользователя.
  }
}

/** Экранирование пользовательского текста для HTML-разметки Telegram. */
export function htmlEscape(value: unknown): string {
  return String(value ?? '—')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function notify(text: string, keyboard?: TgButton[][]): Promise<void> {
  if (!notifierReady()) return Promise.resolve();
  return call('sendMessage', {
    chat_id: settings.TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

/** Отправить в конкретный чат и сказать, принял ли его Telegram. */
export async function sendTo(chatId: string, text: string): Promise<boolean> {
  if (!settings.TELEGRAM_BOT_TOKEN || !chatId) return false;
  try {
    const res = await fetch(endpoint('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

export function ackCallback(callbackId: string, text: string): Promise<void> {
  return call('answerCallbackQuery', { callback_query_id: callbackId, text });
}

export function rewriteMessage(messageId: number, text: string): Promise<void> {
  if (!notifierReady()) return Promise.resolve();
  return call('editMessageText', {
    chat_id: settings.TELEGRAM_CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}
