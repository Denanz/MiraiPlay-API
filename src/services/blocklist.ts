import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * Access denylist with JSON persistence. Bans can target an IP, an account id,
 * or a login; sign-in binds a token to its owner so live sessions of a banned
 * account are cut off too.
 */

export function trimIp(ip: string | null | undefined): string {
  return (ip ?? '').replace('::ffff:', '').trim();
}

// RFC1918 private space for 172.x is only 172.16.0.0–172.31.255.255 (a /12) — the
// old `startsWith('172.')` check matched the entire /8, wrongly treating huge
// public ranges (e.g. Cloudflare 172.64.0.0/13, Google 172.217.0.0/16 and
// 172.253.0.0/16) as "local", so banIp() silently refused to ban abusive clients
// sitting in any of those ranges.
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
  // token → account, learned at sign-in. Persisted so the notifier can resolve
  // which subscriber a captured token belongs to across restarts.
  private owners = new Map<string, Owner>();

  constructor() {
    try {
      const snap = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
      this.ips = new Set(snap.ips ?? []);
      this.accounts = new Set(snap.accounts ?? []);
      this.logins = new Set((snap.logins ?? []).map((l) => l.toLowerCase()));
      this.owners = new Map(snap.owners ?? []);
    } catch {
      // No file on first boot — start with an empty list.
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
      // Persistence is best-effort; in-memory state still enforces the ban.
    }
  }

  bindToken(token: string, id: number, login: string): void {
    if (!token) return;
    const prev = this.owners.get(token);
    if (prev && prev.id === id && prev.login === login) return;
    this.owners.set(token, { id, login });
    this.persist();
  }

  /** Resolve the account a token belongs to (set at sign-in). */
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

  /** Refuses loopback/private addresses so the operator can't self-lock the node. */
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
