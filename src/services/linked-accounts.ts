import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * Связка «аккаунт Mirai → сессия Anixart».
 *
 * MiraiPlay не может обойтись без токена Anixart: им ходят в каталог, списки и
 * профиль, и по id владельца адресуются все данные (см. identity.ts). Поэтому
 * единый вход здесь — не замена входу Anixart, а избавление от него: кто
 * привязал свой аккаунт Mirai, дальше попадает внутрь по сессии хаба, а токен
 * лежит у нас. Кто не привязывал — входит как раньше, ничего не меняется.
 *
 * Привязка сознательно сделана явным действием в Настройках, а не побочным
 * эффектом входа: здесь на сервере оседает рабочий токен от чужого аккаунта, и
 * это должно быть решением человека, а не сюрпризом.
 */

const FILE = join(settings.STATE_DIR, 'linked-accounts.json');

export interface LinkedAccount {
  token: string;
  userId: number;
  login: string;
  linkedAt: number;
}

type Store = Record<string, LinkedAccount>; // id пользователя mirai-auth -> сессия Anixart

function load(): Store {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Store;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Файла ещё нет.
  }
  return {};
}

let links: Store = load();

function persist(): void {
  try {
    mkdirSync(settings.STATE_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(links, null, 2));
  } catch {
    // В памяти связка живёт до перезапуска.
  }
}

export function linkAccount(hubUserId: number, account: Omit<LinkedAccount, 'linkedAt'>): void {
  links[String(hubUserId)] = { ...account, linkedAt: Date.now() };
  persist();
}

export function getLinkedAccount(hubUserId: number): LinkedAccount | undefined {
  return links[String(hubUserId)];
}

export function unlinkAccount(hubUserId: number): void {
  delete links[String(hubUserId)];
  persist();
}
