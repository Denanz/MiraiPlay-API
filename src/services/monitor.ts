import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';
import { trimIp } from './blocklist.js';

/**
 * Телеметрия для команд бота /stats и /logins. Счётчики трафика живут в памяти и
 * обнуляются при перезапуске, журнал входов пишется на диск.
 */

export interface LoginRecord {
  at: number;
  id: number;
  login: string;
  ip: string;
  agent: string;
}

interface Session {
  id: number;
  login: string;
  ip: string;
  openedAt: number;
  seenAt: number;
  hits: number;
}

const JOURNAL_CAP = 200;
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

class Telemetry {
  private readonly file = join(settings.STATE_DIR, 'logins.json');
  private readonly bootedAt = Date.now();
  private totalRequests = 0;
  private byMinute = new Map<number, number>();
  private byIp = new Map<string, number>();
  private sessions = new Map<string, Session>();
  private journal: LoginRecord[] = [];

  constructor() {
    try {
      this.journal = JSON.parse(readFileSync(this.file, 'utf8')) as LoginRecord[];
    } catch {
      // Журнала ещё нет.
    }
  }

  private persist(): void {
    try {
      mkdirSync(settings.STATE_DIR, { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.journal.slice(-JOURNAL_CAP)));
    } catch {
      // Не критично.
    }
  }

  tickRequest(ip: string): void {
    this.totalRequests += 1;
    const minute = Math.floor(Date.now() / 60_000);
    this.byMinute.set(minute, (this.byMinute.get(minute) ?? 0) + 1);
    for (const key of this.byMinute.keys()) {
      if (key < minute - 90) this.byMinute.delete(key);
    }
    const addr = trimIp(ip) || 'unknown';
    this.byIp.set(addr, (this.byIp.get(addr) ?? 0) + 1);
    if (this.byIp.size > 2000) this.byIp.clear();
  }

  openSession(token: string, id: number, login: string, ip: string): void {
    if (!token) return;
    const now = Date.now();
    this.sessions.set(token, {
      id,
      login,
      ip: trimIp(ip),
      openedAt: now,
      seenAt: now,
      hits: 0,
    });
  }

  touchSession(token: string | undefined, ip: string): void {
    if (!token) return;
    const session = this.sessions.get(token);
    if (!session) return;
    session.seenAt = Date.now();
    session.hits += 1;
    if (ip) session.ip = trimIp(ip);
  }

  recordLogin(record: LoginRecord): void {
    this.journal.push(record);
    if (this.journal.length > JOURNAL_CAP) this.journal = this.journal.slice(-JOURNAL_CAP);
    this.persist();
  }

  private requestsLastHour(): number {
    const minute = Math.floor(Date.now() / 60_000);
    let sum = 0;
    for (const [key, count] of this.byMinute) {
      if (key > minute - 60) sum += count;
    }
    return sum;
  }

  overview() {
    const now = Date.now();
    const active = [...this.sessions.values()]
      .filter((s) => now - s.seenAt < ACTIVE_WINDOW_MS)
      .sort((a, b) => b.seenAt - a.seenAt);
    const topIps = [...this.byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    return {
      uptimeMs: now - this.bootedAt,
      totalRequests: this.totalRequests,
      lastHour: this.requestsLastHour(),
      sessionsSeen: this.sessions.size,
      active,
      topIps,
    };
  }

  recentLogins(limit = 15): LoginRecord[] {
    return this.journal.slice(-limit).reverse();
  }
}

export const telemetry = new Telemetry();
