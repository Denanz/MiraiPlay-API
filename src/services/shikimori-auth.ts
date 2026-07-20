import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * OAuth-подключение аккаунта Shikimori — чтобы отмечать просмотренное и оценки
 * в его списке, а не только читать оттуда метаданные.
 *
 * Приложение зарегистрировано с redirect_uri "out of band": Shikimori показывает
 * код на экране, пользователь вставляет его в настройках. Для трёх человек это
 * проще публичного callback и не требует отдельного открытого эндпоинта.
 *
 * Токены привязаны к стабильному userId (адресация по аккаунту появилась в 2.8),
 * поэтому подключение переживает смену устройства и перелогин.
 */

// Канонический домен — .io: shikimori.one отдаёт 301, а POST через редирект
// рискует потерять тело, и обмен кода на токен молча ломается.
const AUTH_BASE = 'https://shikimori.io';
const API_BASE = 'https://shikimori.io';
const OOB = 'urn:ietf:wg:oauth:2.0:oob';
const UA = 'MiraiHub/1.0';
const FILE = join(settings.STATE_DIR, 'shikimori-auth.json');

export interface ShikiAuth {
  accessToken: string;
  refreshToken: string;
  /** Unix-время в мс, когда access-токен протухнет. */
  expiresAt: number;
  shikiUserId: number;
  shikiNickname: string;
}

type Store = Record<string, ShikiAuth>; // ключ — userId нашего аккаунта

let store: Store = load();

function load(): Store {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Store;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* файла ещё нет */ }
  return {};
}

function persist(): void {
  try {
    mkdirSync(settings.STATE_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch { /* в памяти всё равно работает до перезапуска */ }
}

export function isConfigured(): boolean {
  return Boolean(settings.SHIKIMORI_CLIENT_ID && settings.SHIKIMORI_CLIENT_SECRET);
}

/** Ссылка, по которой пользователь выдаёт доступ и получает код. */
export function authorizeUrl(): string {
  const params = new URLSearchParams({
    client_id: settings.SHIKIMORI_CLIENT_ID || '',
    redirect_uri: settings.SHIKIMORI_REDIRECT_URI || OOB,
    response_type: 'code',
    scope: 'user_rates',
  });
  return `${AUTH_BASE}/oauth/authorize?${params}`;
}

export function getAuth(userId: number): ShikiAuth | null {
  return store[String(userId)] ?? null;
}

export function disconnect(userId: number): void {
  delete store[String(userId)];
  persist();
}

async function tokenRequest(body: Record<string, string>): Promise<{
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
} | null> {
  try {
    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({
        client_id: settings.SHIKIMORI_CLIENT_ID,
        client_secret: settings.SHIKIMORI_CLIENT_SECRET,
        ...body,
      }),
    });
    return (await res.json()) as Record<string, never>;
  } catch {
    return null;
  }
}

async function whoami(accessToken: string): Promise<{ id: number; nickname: string } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/users/whoami`, {
      headers: { authorization: `Bearer ${accessToken}`, 'user-agent': UA },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { id?: number; nickname?: string };
    return j?.id ? { id: j.id, nickname: j.nickname || '' } : null;
  } catch {
    return null;
  }
}

export interface ConnectResult {
  nickname?: string;
  /** Причина отказа, как её назвал Shikimori — без неё диагностировать нечего. */
  error?: string;
}

/**
 * Обменивает код, показанный Shikimori, на токены.
 *
 * Возвращает именно причину отказа, а не просто null: код одноразовый и живёт
 * считаные минуты, поэтому «не подошёл» бывает и из-за повторного использования,
 * и из-за опечатки, и из-за расхождения redirect_uri — а лечится это по-разному.
 */
export async function connectWithCode(userId: number, code: string): Promise<ConnectResult> {
  if (!isConfigured()) return { error: 'приложение Shikimori не настроено на сервере' };
  if (!userId) return { error: 'не удалось определить владельца токена' };
  if (!code) return { error: 'пустой код' };
  const t = await tokenRequest({
    grant_type: 'authorization_code',
    code: code.trim(),
    redirect_uri: settings.SHIKIMORI_REDIRECT_URI || OOB,
  });
  if (!t?.access_token || !t.refresh_token) {
    const detail = [t?.error, (t as Record<string, unknown> | null)?.error_description]
      .filter(Boolean).join(': ');
    return { error: detail || 'Shikimori не выдал токен' };
  }
  const me = await whoami(t.access_token);
  if (!me) return { error: 'токен получен, но профиль Shikimori не отвечает' };
  store[String(userId)] = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    // Обновляем чуть раньше срока, чтобы не ловить гонку на границе.
    expiresAt: Date.now() + Math.max(60, (t.expires_in ?? 86400) - 120) * 1000,
    shikiUserId: me.id,
    shikiNickname: me.nickname,
  };
  persist();
  return { nickname: me.nickname || String(me.id) };
}

/**
 * Действующий access-токен: при необходимости молча обновляет по refresh.
 * Если обновление не удалось, подключение сбрасывается — иначе оно висело бы
 * «подключённым», ничего на самом деле не отправляя.
 */
export async function validAccessToken(userId: number): Promise<ShikiAuth | null> {
  const auth = getAuth(userId);
  if (!auth) return null;
  if (Date.now() < auth.expiresAt) return auth;

  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
  if (!t?.access_token || !t.refresh_token) {
    disconnect(userId);
    return null;
  }
  auth.accessToken = t.access_token;
  auth.refreshToken = t.refresh_token;
  auth.expiresAt = Date.now() + Math.max(60, (t.expires_in ?? 86400) - 120) * 1000;
  persist();
  return auth;
}

export { API_BASE as SHIKI_API_BASE, UA as SHIKI_UA };
