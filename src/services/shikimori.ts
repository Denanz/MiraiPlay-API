import { join } from 'node:path';
import { settings } from '../config/settings.js';
import { TtlCache } from './cache.js';

/**
 * Shikimori lookups used to enrich a release card: a GraphQL title search
 * (score + main characters) and the REST "related" list. Best-effort — every
 * call degrades to null/[] on failure so enrichment never breaks the response.
 *
 * Results are cached (memory + disk) since they change slowly: a positive hit
 * lives for 12h, an empty/failed one for 1h so it gets retried sooner.
 */

const GRAPHQL_ENDPOINT = 'https://shikimori.io/api/graphql';
const REST_BASE = 'https://shikimori.io';
const CLIENT_UA = 'MiraiHub/1.0';
const REQUEST_TIMEOUT_MS = 5000;

const HOUR = 3_600_000;
const cacheRoot = join(settings.STATE_DIR, 'cache', 'shikimori');
const searchCache = new TtlCache<ShikiAnime | null>({
  ttlMs: 12 * HOUR,
  dir: join(cacheRoot, 'search'),
  maxMemory: 2000,
});
const relatedCache = new TtlCache<ShikiRelated[]>({
  ttlMs: 12 * HOUR,
  dir: join(cacheRoot, 'related'),
  maxMemory: 2000,
});
const scoreCache = new TtlCache<number>({
  ttlMs: 12 * HOUR,
  dir: join(cacheRoot, 'score'),
  maxMemory: 5000,
});
const franchiseCache = new TtlCache<ShikiFranchiseNode[]>({
  ttlMs: 12 * HOUR,
  dir: join(cacheRoot, 'franchise'),
  maxMemory: 2000,
});

export interface ShikiCharacter {
  id: string;
  name: string;
  russian: string | null;
  url: string;
}

export interface ShikiCharacterRole {
  rolesEn: string[];
  character: ShikiCharacter;
}

export interface ShikiVideo {
  kind: string | null;
  name: string | null;
  url: string;
  playerUrl: string | null;
  imageUrl: string | null;
}

export interface ShikiAnime {
  id: string;
  malId: number | null;
  name: string;
  russian: string | null;
  url: string;
  score: number | null;
  characterRoles: ShikiCharacterRole[];
  videos?: ShikiVideo[];
}

export interface ShikiFranchiseNode {
  id: string;
  name: string;
  year: number | null;
  kind: string | null;
  url: string;
  current: boolean;
}

export interface ShikiRelated {
  id: string;
  name: string;
  russian: string;
  url: string;
  relation: string | null;
}

/** Absolute Shikimori URL from a possibly-relative `url` field. */
export function absoluteShikiUrl(url: string): string {
  if (url.startsWith('http')) return url;
  return `${REST_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await run(abort.signal);
  } finally {
    clearTimeout(timer);
  }
}

const SEARCH_QUERY = `
  query($search: String) {
    animes(search: $search, limit: 1) {
      id
      malId
      name
      russian
      url
      score
      characterRoles {
        rolesEn
        character { id name russian url }
      }
      videos { kind name url playerUrl imageUrl }
    }
  }
`;

async function searchOne(term: string): Promise<ShikiAnime | null> {
  return searchCache.wrap(
    `s:${term.toLowerCase()}`,
    async () => {
      try {
        const json = await withTimeout(async (signal) => {
          const res = await fetch(GRAPHQL_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': CLIENT_UA },
            body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: term } }),
            signal,
          });
          // Отказ сети или лимита — это НЕ «такого аниме нет». Бросаем, чтобы
          // wrap не закешировал пустой результат: иначе один всплеск «Retry
          // later» на часы превращает существующие тайтлы в ненайденные
          // (ровно это и сорвало массовый перенос).
          if (!res.ok) throw new Error(`shikimori search ${res.status}`);
          return (await res.json()) as { data?: { animes?: ShikiAnime[] } };
        });
        // А вот пустой ответ при HTTP 200 — честное «не нашлось», его кешируем.
        return json.data?.animes?.[0] ?? null;
      } catch (e) {
        throw e instanceof Error ? e : new Error('shikimori search failed');
      }
    },
    (hit) => (hit ? 12 * HOUR : 1 * HOUR),
  );
}

/** Try Russian, then original, then alternative title — first hit wins. */
export async function findAnime(titles: {
  ru?: string | null;
  orig?: string | null;
  alt?: string | null;
}): Promise<ShikiAnime | null> {
  for (const term of [titles.ru, titles.orig, titles.alt]) {
    if (!term) continue;
    try {
      const hit = await searchOne(term);
      if (hit) return hit;
    } catch {
      // Этот вариант названия не отработал — пробуем следующий, а не сдаёмся.
    }
  }
  return null;
}

export async function relatedAnime(animeId: string): Promise<ShikiRelated[]> {
  return relatedCache.wrap(
    `r:${animeId}`,
    async () => {
      try {
        const items = await withTimeout(async (signal) => {
          const res = await fetch(`${REST_BASE}/api/animes/${animeId}/related`, {
            headers: { 'content-type': 'application/json', 'user-agent': CLIENT_UA },
            signal,
          });
          return (await res.json()) as any[];
        });
        if (!Array.isArray(items)) return [];

        const out: ShikiRelated[] = [];
        for (const item of items) {
          const anime = item?.anime;
          const label = anime?.russian || anime?.name;
          if (!anime?.id || !anime?.url || !label) continue;
          out.push({
            id: String(anime.id),
            name: anime.name || anime.russian,
            russian: anime.russian || anime.name,
            url: absoluteShikiUrl(anime.url),
            relation: item?.relation_russian || item?.relation || null,
          });
        }
        return out;
      } catch {
        return [];
      }
    },
    (list) => (list.length ? 12 * HOUR : 1 * HOUR),
  );
}

/**
 * Chronological franchise chain (watch order) from Shikimori's franchise graph.
 * Nodes carry a `weight` that encodes the in-universe sequence; we sort by it
 * (then year) and drop music videos. `current` marks the requested title.
 */
export async function franchiseChain(animeId: string): Promise<ShikiFranchiseNode[]> {
  return franchiseCache.wrap(
    `f:${animeId}`,
    async () => {
      try {
        const data = await withTimeout(async (signal) => {
          const res = await fetch(`${REST_BASE}/api/animes/${animeId}/franchise`, {
            headers: { 'content-type': 'application/json', 'user-agent': CLIENT_UA },
            signal,
          });
          return (await res.json()) as { nodes?: any[]; current?: number | string };
        });
        const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
        if (nodes.length < 2) return []; // a lone title isn't a "franchise"
        const currentId = String(data?.current ?? animeId);
        return nodes
          .filter((n) => n?.id && !/music|clip|^cm$|promo/i.test(String(n.kind || '')))
          // Release order (year) is the reliable watch-order baseline; weight breaks ties.
          .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || (a.weight ?? 0) - (b.weight ?? 0))
          .map((n) => ({
            id: String(n.id),
            name: n.name || '',
            year: Number(n.year) || null,
            kind: n.kind ?? null,
            url: n.url ? absoluteShikiUrl(n.url) : `${REST_BASE}/animes/${n.id}`,
            current: String(n.id) === currentId,
          }));
      } catch {
        return [];
      }
    },
    (list) => (list.length ? 12 * HOUR : 1 * HOUR),
  );
}

/**
 * Оценки Shikimori для пачки тайтлов — одним запросом.
 *
 * Карточек на экране десятки, и отдельный поиск на каждую был бы шквалом
 * запросов. GraphQL позволяет назвать несколько поисков алиасами внутри одного
 * запроса, поэтому вся сетка обходится единственным обращением.
 *
 * Ищем по ОРИГИНАЛЬНОМУ названию: русские переводы у сервисов расходятся
 * («Golden Kamuy» — «Золотое божество»), и по ним половина не находится.
 */
export async function scoresForTitles(titles: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const missing: string[] = [];

  for (const t of titles) {
    if (!t) continue;
    const hit = await scoreCache.get(`sc:${t.toLowerCase()}`);
    if (hit !== undefined) {
      if (hit > 0) out[t] = hit;
    } else if (!missing.includes(t)) {
      missing.push(t);
    }
  }
  if (missing.length === 0) return out;

  // Больше тридцати алиасов за раз делают запрос слишком тяжёлым.
  for (let i = 0; i < missing.length; i += 30) {
    const chunk = missing.slice(i, i + 30);
    const parts = chunk.map(
      (t, idx) => `a${idx}: animes(search: ${JSON.stringify(t)}, limit: 1) { name score }`,
    );
    try {
      const json = await withTimeout(async (signal) => {
        const res = await fetch(GRAPHQL_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': CLIENT_UA },
          body: JSON.stringify({ query: `{ ${parts.join(' ')} }` }),
          signal,
        });
        if (!res.ok) throw new Error(`shikimori scores ${res.status}`);
        return (await res.json()) as { data?: Record<string, Array<{ score?: number }>> };
      });
      chunk.forEach((t, idx) => {
        const score = Number(json.data?.[`a${idx}`]?.[0]?.score) || 0;
        // Кешируем и нули: «оценки нет» — тоже ответ, и переспрашивать незачем.
        void scoreCache.set(`sc:${t.toLowerCase()}`, score, 12 * HOUR);
        if (score > 0) out[t] = score;
      });
    } catch {
      // Пачка не вышла — эти тайтлы просто останутся без оценки Shikimori.
    }
  }
  return out;
}
