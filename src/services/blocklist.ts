import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * Список блокировок с сохранением в JSON. Бан вешается на IP, id аккаунта или
 * логин; вход привязывает токен к владельцу, поэтому живые сессии тоже рвутся.
 */

export function trimIp(ip: string | null | undefined): string {
  return (ip ?? '').replace('::ffff:', '').trim();
}

// Приватная часть 172.x по RFC1918 — только 172.16.0.0–172.31.255.255. Проверка
// по префиксу «172.» захватывала бы весь /8, включая публичные диапазоны
// Cloudflare и Google, и бан по таким адресам молча не срабатывал бы.
const PRIVATE_172_RE = /^172\.(1[6-9]|2\d|3[01])\./;

export function isLocalIp(ip: string): boolean {
  const v = trimIp(ip);
  if (!v || v === 'unknown' || v === 'localhost') return true;
  return (
    v === '127.0.0.1' ||
    v === '::1' ||
    v.startsWith('10.') ||
    v.startsWith('192.168.') ||
    PRIVATE_172_RE.test(v) ||
    v.startsWith('169.254.')
  );
}

interface Owner {
  id: number;
  login: string;
}

interface Snapshot {
  ips: string[];
  accounts: number[];
  logins: string[];
  owners?: [string, Owner][];
}

class Denylist {
  private readonly file = join(settings.STATE_DIR, 'blocklist.json');
  private ips = new Set<string>();
  private accounts = new Set<number>();
  private logins = new Set<string>();
  // токен → аккаунт, узнаётся при входе. Сохраняем, чтобы после перезапуска
  // уведомлялка понимала, чей это токен.
  private owners = new Map<string, Owner>();

  constructor() {
    try {
      const snap = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
      this.ips = new Set(snap.ips ?? []);
      this.accounts = new Set(snap.accounts ?? []);
      this.logins = new Set((snap.logins ?? []).map((l) => l.toLowerCase()));
      this.owners = new Map(snap.owners ?? []);
    } catch {
      // Первый запуск, файла нет — начинаем с пустого списка.
    }
  }

  private persist(): void {
    try {
      mkdirSync(settings.STATE_DIR, { recursive: true });
      const snap: Snapshot = {
        ips: [...this.ips],
        accounts: [...this.accounts],
        logins: [...this.logins],
        owners: [...this.owners],
      };
      writeFileSync(this.file, JSON.stringify(snap, null, 2));
    } catch {
      // Не записалось — не страшно, в памяти бан всё равно действует.
    }
  }

  bindToken(token: string, id: number, login: string): void {
    if (!token) return;
    const prev = this.owners.get(token);
    if (prev && prev.id === id && prev.login === login) return;
    this.owners.set(token, { id, login });
    this.persist();
  }

  /** Чей это токен — связка ставится при входе. */
  /** Все известные пары «токен → аккаунт» — для фоновых задач, которым нужно
   *  обойти пользователей, а не отвечать на конкретный запрос. */
  knownTokens(): Array<{ userId: number; token: string }> {
    const out: Array<{ userId: number; token: string }> = [];
    for (const [token, owner] of this.owners) {
      if (owner?.id) out.push({ userId: owner.id, token });
    }
    return out;
  }

  getOwner(token: string): Owner | undefined {
    return token ? this.owners.get(token) : undefined;
  }

  ipBlocked(ip: string): boolean {
    return this.ips.has(trimIp(ip));
  }

  accountBlocked(id?: number, login?: string): boolean {
    if (id != null && this.accounts.has(id)) return true;
    if (login && this.logins.has(login.toLowerCase())) return true;
    return false;
  }

  tokenBlocked(token?: string): boolean {
    if (!token) return false;
    const owner = this.owners.get(token);
    return owner ? this.accountBlocked(owner.id, owner.login) : false;
  }

  /** Не даёт забанить локальные адреса и запереть самого себя. */
  banIp(ip: string): boolean {
    const v = trimIp(ip);
    if (isLocalIp(v)) return false;
    this.ips.add(v);
    this.persist();
    return true;
  }

  unbanIp(ip: string): void {
    this.ips.delete(trimIp(ip));
    this.persist();
  }

  banAccount(id?: number, login?: string): void {
    if (id != null) this.accounts.add(id);
    if (login) this.logins.add(login.toLowerCase());
    this.persist();
  }

  unbanAccount(id?: number, login?: string): void {
    if (id != null) this.accounts.delete(id);
    if (login) this.logins.delete(login.toLowerCase());
    this.persist();
  }

  snapshot(): Snapshot {
    return {
      ips: [...this.ips],
      accounts: [...this.accounts],
      logins: [...this.logins],
    };
  }
}

export const denylist = new Denylist();
