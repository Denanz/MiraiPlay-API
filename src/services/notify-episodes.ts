import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';
import { upstreamJson } from '../upstream/client.js';
import { denylist } from './blocklist.js';
import { sendTo } from './notifier.js';

/**
 * Слежение за новыми сериями, у каждого своё. Подписчик — это тот, кто привязал
 * Telegram в настройках: храним его токен Anixart (чтобы читать его же списки),
 * чат и снимок уже виденного. Каждый проход сравнивает списки подписчиков
 * независимо и пишет каждому в свой чат.
 *
 * Ключ реестра — id чата, а id аккаунта лежит внутри: так обновившийся в другом
 * месте токен находит своего подписчика.
 */

const ROOT = join(settings.STATE_DIR, 'notify');
const SUBS_FILE = join(ROOT, 'subscribers.json');
// Файлы старой однопользовательской схемы, переносятся в подписчика при первой загрузке.
const LEGACY_TOKEN = join(ROOT, 'token');
const LEGACY_CHAT = join(ROOT, 'chatid');
const LEGACY_SEEN = join(ROOT, 'seen.json');

const LISTS = [1, 2]; // 1 = смотрю, 2 = в планах
const MAX_PAGES = 5;
const CHAT_RE = /^-?\d{3,20}$/;

interface ListItem {
  id?: number;
  title_ru?: string;
  episodes_released?: number;
  episodes_total?: number;
  release?: ListItem;
}

interface Subscriber {
  userId: number;
  token: string;
  chatId: string;
  seen: Record<string, number>;
  updatedAt: number;
  // Тайтлы, по которым не нужны еженедельные пинги — нужен ОДИН сигнал, когда
  // сезон вышел целиком. Держим прямо здесь: обходчик и так каждый раз читает
  // episodes_released/episodes_total по всем спискам, отдельный опрос не нужен.
  awaitFull?: Record<string, true>;
}

type Registry = Record<string, Subscriber>; // keyed by chatId

let registry: Registry = load();

function load(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(SUBS_FILE, 'utf8')) as Registry;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Реестра ещё нет — пробуем поднять старое состояние.
  }
  return migrateLegacy();
}

/** Перенос старого однопользовательского состояния в одного подписчика. */
function migrateLegacy(): Registry {
  try {
    const token = readFileSync(LEGACY_TOKEN, 'utf8').trim();
    const chatId = readFileSync(LEGACY_CHAT, 'utf8').trim();
    if (!token || !CHAT_RE.test(chatId)) return {};
    let seen: Record<string, number> = {};
    try {
      seen = JSON.parse(readFileSync(LEGACY_SEEN, 'utf8')) as Record<string, number>;
    } catch {
      // чистый снимок — нормально
    }
    const sub: Subscriber = {
      // При старте id владельца неизвестен — заполнится, когда он пересохранит
      // чат в настройках.
      userId: denylist.getOwner(token)?.id ?? 0,
      token,
      chatId,
      seen,
      updatedAt: Date.now(),
    };
    const reg: Registry = { [chatId]: sub };
    persist(reg);
    return reg;
  } catch {
    return {};
  }
}

function persist(reg: Registry = registry): void {
  try {
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(SUBS_FILE, JSON.stringify(reg, null, 2));
  } catch {
    // не страшно: в памяти реестр всё равно живёт
  }
}

/**
 * Подключение или обновление подписчика из настроек. Снимок виденного при
 * пересохранении не сбрасывается, а прежний чат этого же аккаунта убирается —
 * один аккаунт держит ровно один чат.
 */
export function registerSubscriber(userId: number, token: string, chatId: string): void {
  if (!CHAT_RE.test(chatId)) return;
  if (userId) {
    for (const [key, sub] of Object.entries(registry)) {
      if (sub.userId === userId && key !== chatId) delete registry[key];
    }
  }
  const prev = registry[chatId];
  registry[chatId] = {
    userId: userId || prev?.userId || 0,
    token: token || prev?.token || '',
    chatId,
    seen: prev?.seen ?? {},
    updatedAt: Date.now(),
  };
  persist();
}

/**
 * Освежает токен подписчика из его же авторизованного трафика. Только обновляет
 * существующего, никогда не создаёт нового, и опирается на связку токен→аккаунт
 * из момента входа.
 */
export function setNotifyToken(token: string): void {
  if (!token) return;
  const owner = denylist.getOwner(token);
  if (!owner) return;
  let changed = false;
  for (const sub of Object.values(registry)) {
    if (sub.userId === owner.id && sub.token !== token) {
      sub.token = token;
      sub.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) persist();
}

/** Сохранённый чат аккаунта — чтобы подставить его в поле настроек. */
/** Список тайтлов, по которым пользователь ждёт полного выхода. */
export function getAwaitFull(userId: number): string[] {
  if (!userId) return [];
  for (const sub of Object.values(registry)) {
    if (sub.userId === userId) return Object.keys(sub.awaitFull || {});
  }
  return [];
}

/**
 * Включить или выключить ожидание полного выхода.
 * Возвращает false, если у пользователя ещё не привязан Telegram — уведомлять
 * попросту некуда, и молча «включать» флаг было бы обманом.
 */
export function setAwaitFull(userId: number, releaseId: string, on: boolean): boolean {
  if (!userId || !releaseId) return false;
  for (const sub of Object.values(registry)) {
    if (sub.userId !== userId) continue;
    sub.awaitFull = sub.awaitFull || {};
    if (on) sub.awaitFull[releaseId] = true;
    else delete sub.awaitFull[releaseId];
    sub.updatedAt = Date.now();
    persist();
    return true;
  }
  return false;
}

export function getChatId(userId: number): string {
  if (!userId) return '';
  for (const sub of Object.values(registry)) {
    if (sub.userId === userId) return sub.chatId;
  }
  return '';
}

async function fetchList(listId: number, token: string): Promise<ListItem[]> {
  const out: ListItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await upstreamJson<{ content?: ListItem[] }>({
      path: `/profile/list/all/${listId}/${page}`,
      query: { token },
    }).catch(() => null);
    const items = res?.data?.content ?? [];
    for (const it of items) out.push(it.release ?? it);
    if (items.length < 20) break;
  }
  return out;
}

/** Один проход по подписчику: сравнить его списки со снимком. */
async function checkSubscriber(sub: Subscriber): Promise<{ checked: number; notified: number }> {
  const first = Object.keys(sub.seen).length === 0; // establish baseline silently
  let checked = 0;
  let notified = 0;

  const byId = new Map<string, ListItem>();
  for (const listId of LISTS) {
    for (const it of await fetchList(listId, sub.token)) {
      const id = it.id != null ? String(it.id) : '';
      if (id) byId.set(id, it);
    }
  }

  for (const [id, it] of byId) {
    const cur = Number(it.episodes_released) || 0;
    checked++;
    const prev = sub.seen[id];
    sub.seen[id] = cur;

    // Режим «дождусь целиком»: понедельные уведомления подавляем, а когда сезон
    // закрылся — шлём один сигнал и снимаем флаг, чтобы не повторяться.
    if (sub.awaitFull?.[id]) {
      const total = Number(it.episodes_total) || 0;
      if (!first && total > 0 && cur >= total && notified < 10) {
        notified++;
        delete sub.awaitFull[id];
        await sendTo(
          sub.chatId,
          `✅ <b>${escapeTg(it.title_ru || 'Аниме')}</b>\n` +
            `Вышло целиком — <b>${total}</b> серий, можно смотреть запоем\n` +
            `https://anime.denanz.fun/release/${id}`,
        ).catch(() => {});
      }
      continue;
    }

    if (!first && prev !== undefined && cur > prev && notified < 10) {
      notified++;
      const total = it.episodes_total ? ` из ${it.episodes_total}` : '';
      await sendTo(
        sub.chatId,
        `🎬 <b>${escapeTg(it.title_ru || 'Аниме')}</b>\n` +
          `Вышла серия <b>${cur}</b>${total}\n` +
          `https://anime.denanz.fun/release/${id}`,
      ).catch(() => {});
    }
  }

  return { checked, notified };
}

/** Один проход по всем подписчикам. */
export async function checkNewEpisodes(): Promise<{ checked: number; notified: number }> {
  if (!settings.TELEGRAM_BOT_TOKEN) return { checked: 0, notified: 0 };
  let checked = 0;
  let notified = 0;
  for (const sub of Object.values(registry)) {
    if (!sub.token || !sub.chatId) continue;
    const r = await checkSubscriber(sub).catch(() => ({ checked: 0, notified: 0 }));
    checked += r.checked;
    notified += r.notified;
  }
  persist();
  return { checked, notified };
}

function escapeTg(v: string): string {
  return v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Запуск слежения: снимок через минуту, дальше раз в два часа. */
export function startEpisodeWatcher(): void {
  setTimeout(() => void checkNewEpisodes().catch(() => {}), 60_000);
  setInterval(() => void checkNewEpisodes().catch(() => {}), 2 * 60 * 60_000);
}
