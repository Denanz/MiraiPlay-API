import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Кэш с временем жизни: карта в памяти, при желании с записью на диск, плюс
 * склейка одновременных промахов. `wrap` отдаёт сохранённое либо запускает
 * производителя ровно один раз. Для медленных идемпотентных запросов —
 * персональные ответы сюда класть нельзя.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface TtlCacheOptions {
  ttlMs: number;
  /** Каталог для записи на диск, переживающей перезапуск. Без него — только память. */
  dir?: string;
  /** Сколько записей держим в памяти, прежде чем выкинуть самую старую. */
  maxMemory?: number;
}

export class TtlCache<T> {
  private mem = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();

  constructor(private readonly opts: TtlCacheOptions) {}

  private fileFor(key: string): string | null {
    if (!this.opts.dir) return null;
    const hash = createHash('sha256').update(key).digest('hex');
    return join(this.opts.dir, `${hash}.json`);
  }

  private remember(key: string, entry: Entry<T>): void {
    this.mem.set(key, entry);
    const max = this.opts.maxMemory ?? 1000;
    if (this.mem.size > max) {
      const oldest = this.mem.keys().next().value;
      if (oldest !== undefined) this.mem.delete(oldest);
    }
  }

  async get(key: string): Promise<T | undefined> {
    const hot = this.mem.get(key);
    if (hot) {
      if (Date.now() < hot.expiresAt) return hot.value;
      this.mem.delete(key);
    }
    const file = this.fileFor(key);
    if (!file) return undefined;
    try {
      const entry = JSON.parse(await readFile(file, 'utf8')) as Entry<T>;
      if (Date.now() < entry.expiresAt) {
        this.remember(key, entry);
        return entry.value;
      }
      await unlink(file).catch(() => {});
    } catch {
      // промах
    }
    return undefined;
  }

  async set(key: string, value: T, ttlMs: number = this.opts.ttlMs): Promise<void> {
    const entry: Entry<T> = { value, expiresAt: Date.now() + ttlMs };
    this.remember(key, entry);
    const file = this.fileFor(key);
    if (!file || !this.opts.dir) return;
    try {
      await mkdir(this.opts.dir, { recursive: true });
      await writeFile(file, JSON.stringify(entry));
    } catch {
      // Не записалось на диск — запись в памяти всё равно осталась.
    }
  }

  /**
   * Отдаёт сохранённое либо зовёт `produce`, склеивая одновременные промахи.
   * `ttl` можно задать числом или вычислить по результату — например, дать
   * пустому ответу срок покороче.
   */
  async wrap(
    key: string,
    produce: () => Promise<T>,
    ttl?: number | ((value: T) => number),
  ): Promise<T> {
    const cached = await this.get(key);
    if (cached !== undefined) return cached;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = produce()
        .then(async (value) => {
          const ms = typeof ttl === 'function' ? ttl(value) : (ttl ?? this.opts.ttlMs);
          await this.set(key, value, ms);
          return value;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }
}
