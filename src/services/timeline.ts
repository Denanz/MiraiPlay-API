import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';
import { upstreamJson } from '../upstream/client.js';

/**
 * Append-only лог просмотров для MiraiTimeline — сервиса, который сводит аниме,
 * музыку и игры на одну ось времени.
 *
 * Почему отдельный лог, а не существующий стейт: `progress` хранит только
 * текущее состояние серии (перезаписывается), `diary` — только момент
 * последней правки записи. Истории «что и когда я смотрел» в сервисе не было
 * вообще, поэтому она копится с нуля, одна строка JSON = одно событие.
 * Пишем синхронно, как и остальной стейт этого сервиса.
 */

export interface TimelineEvent {
  ts: string; // UTC ISO 8601 с Z
  source: 'play';
  kind: string;
  title: string;
  subtitle?: string;
  /** Anixart-id зрителя. Лог общий, а хроника у каждого своя — отбор идёт по нему. */
  userId?: number;
  payload?: Record<string, unknown>;
}

const ROOT = join(settings.STATE_DIR, 'timeline');
const FILE = join(ROOT, 'events.jsonl');

/**
 * Серия попадает в хронику один раз за полсуток.
 *
 * Окно большое не случайно: событие пишется только после порога в 90%, а
 * плеер продолжает пушить прогресс каждые ~3 секунды до самого конца серии —
 * с коротким окном последние минуты дали бы несколько записей об одной и той
 * же серии. Заодно это гасит повтор при пересмотре тем же вечером.
 */
const EPISODE_DEDUP_MS = 12 * 60 * 60 * 1000;
/** «Досмотрел тайтл» — событие раз в сутки на релиз, повторный запуск не дублирует. */
const COMPLETED_DEDUP_MS = 24 * 60 * 60 * 1000;

/** Ключ дедупликации → ts последней записи. Сеется хвостом файла (см. seed). */
const lastWritten = new Map<string, number>();
const MAX_DEDUP_KEYS = 2000;
let seeded = false;

// Ключи дедупликации включают зрителя: две серии, досмотренные разными
// людьми, — два разных события, а не повтор.
const episodeKey = (userId: number, releaseId: string, episode: string) =>
  `e:${userId}:${releaseId}:${episode}`;
const completedKey = (userId: number, releaseId: string) => `c:${userId}:${releaseId}`;

function readAllLines(): string[] {
  try {
    return readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
  } catch {
    return []; // файла ещё нет — лог просто пуст
  }
}

/**
 * Восстанавливает окно дедупликации после рестарта: без этого перезапуск
 * контейнера посреди серии дал бы вторую запись о том же эпизоде.
 */
function seed(): void {
  if (seeded) return;
  seeded = true;
  for (const line of readAllLines().slice(-300)) {
    try {
      const ev = JSON.parse(line) as TimelineEvent;
      const ts = Date.parse(ev.ts);
      const releaseId = String((ev.payload as { releaseId?: unknown })?.releaseId ?? '');
      const episode = String((ev.payload as { episode?: unknown })?.episode ?? '');
      const userId = Number(ev.userId ?? 0);
      if (!releaseId || !Number.isFinite(ts)) continue;
      if (ev.kind === 'episode_watched')
        lastWritten.set(episodeKey(userId, releaseId, episode), ts);
      if (ev.kind === 'anime_completed') lastWritten.set(completedKey(userId, releaseId), ts);
    } catch {
      // битая строка не должна ломать старт
    }
  }
}

/** true, если для ключа только что писали событие и повтор надо пропустить. */
function throttled(key: string, windowMs: number): boolean {
  seed();
  const now = Date.now();
  const prev = lastWritten.get(key);
  if (prev != null && now - prev < windowMs) return true;
  lastWritten.set(key, now);
  if (lastWritten.size > MAX_DEDUP_KEYS) {
    const oldest = lastWritten.keys().next().value;
    if (oldest !== undefined) lastWritten.delete(oldest);
  }
  return false;
}

let lastStamp = 0;

/**
 * Метка времени, строго большая предыдущей. Курсор поллинга — это `ts > since`,
 * так что два события с одинаковой миллисекундой на границе `limit` потеряли бы
 * второе; сдвиг на миллисекунду вперёд делает такую потерю невозможной.
 */
function stamp(): string {
  const now = Math.max(Date.now(), lastStamp + 1);
  lastStamp = now;
  return new Date(now).toISOString();
}

function append(event: TimelineEvent): void {
  try {
    mkdirSync(ROOT, { recursive: true });
    appendFileSync(FILE, `${JSON.stringify(event)}\n`);
  } catch {
    // Хроника — побочный эффект просмотра: её сбой не должен ронять плеер.
  }
}

/** Сколько всего серий у релиза. Кэш на час: значение меняется раз в неделю. */
const totalEpisodes = new Map<string, { value: number; expiresAt: number }>();

async function episodesTotal(releaseId: string, token?: string): Promise<number> {
  const hot = totalEpisodes.get(releaseId);
  if (hot && Date.now() < hot.expiresAt) return hot.value;
  try {
    const res = await upstreamJson<{ release?: { episodes_total?: number } }>({
      path: `/release/${releaseId}`,
      query: token ? { token } : {},
    });
    const value = Number(res.data?.release?.episodes_total) || 0;
    totalEpisodes.set(releaseId, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
    return value;
  } catch {
    return 0;
  }
}

export interface WatchInput {
  /** Anixart-id зрителя: чей это просмотр. */
  userId: number;
  releaseId: string;
  sourceId: string;
  episode: string;
  title?: string;
  position: number; // секунды
  duration: number; // секунды, 0 если неизвестна
  /** Серия досмотрена (тот же порог ≥90%, по которому она помечается upstream). */
  finished: boolean;
  token?: string;
}

/**
 * Записывает досмотренную серию и, если это была последняя серия тайтла,
 * отдельное событие «досмотрел». Проверка «последняя ли» требует похода за
 * карточкой релиза, поэтому она асинхронная и никого не ждёт — сама запись
 * синхронна.
 *
 * В хронику попадают только серии, доведённые до 90% (`finished`), — тот же
 * порог, по которому серия помечается просмотренной в upstream. Раньше сюда
 * падал каждый пуш прогресса, и открытая на минуту серия оставляла запись
 * наравне с досмотренной.
 *
 * Побочный эффект: если источник не сообщает длительность, порог посчитать
 * не из чего и серия в хронику не попадёт вовсе.
 */
export function recordWatch(input: WatchInput): void {
  if (!input.finished) return;

  const releaseId = String(input.releaseId);
  const episode = String(input.episode);
  const name = input.title?.trim() || `Релиз ${releaseId}`;

  if (!throttled(episodeKey(input.userId, releaseId, episode), EPISODE_DEDUP_MS)) {
    append({
      ts: stamp(),
      source: 'play',
      kind: 'episode_watched',
      userId: input.userId,
      title: `${name} · Серия ${episode}`,
      subtitle: input.duration > 0 ? `${Math.round((input.position / input.duration) * 100)}%` : undefined,
      payload: {
        releaseId,
        sourceId: String(input.sourceId),
        episode,
        animeTitle: name,
        position: Math.floor(input.position),
        duration: Math.floor(input.duration),
      },
    });
  }

  // Сюда доходят только досмотренные серии, так что отдельная проверка
  // `finished` здесь больше не нужна.
  void (async () => {
    const total = await episodesTotal(releaseId, input.token);
    if (!total || Number(episode) < total) return;
    if (throttled(completedKey(input.userId, releaseId), COMPLETED_DEDUP_MS)) return;
    append({
      ts: stamp(),
      source: 'play',
      kind: 'anime_completed',
      userId: input.userId,
      title: name,
      subtitle: `${total} серий`,
      payload: { releaseId, animeTitle: name, episodes: total },
    });
  })();
}

/**
 * Хроника одного зрителя для MiraiTimeline: события строго новее `since`, по
 * возрастанию ts. Лог небольшой — читаем целиком, отдельный индекс не
 * окупается.
 */
export function readEvents(
  userId: number,
  since: string | undefined,
  limit: number,
): TimelineEvent[] {
  const after = since ? Date.parse(since) : NaN;
  const events: Array<{ at: number; ev: TimelineEvent }> = [];
  for (const line of readAllLines()) {
    try {
      const ev = JSON.parse(line) as TimelineEvent;
      const at = Date.parse(ev.ts);
      if (!Number.isFinite(at)) continue;
      // Записи без userId — до разделения по пользователям; они принадлежат
      // владельцу, чей id тогда был единственным.
      if (Number(ev.userId ?? 0) !== userId) continue;
      if (Number.isFinite(after) && at <= after) continue;
      events.push({ at, ev });
    } catch {
      // пропускаем недописанную/битую строку
    }
  }
  events.sort((a, b) => a.at - b.at);
  return events.slice(0, limit).map((e) => e.ev);
}
