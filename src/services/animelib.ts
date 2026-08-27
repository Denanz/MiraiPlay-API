import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * Собственный плеер AnimeLib — честные 1080p там, где Kodik упирается в 720p.
 *
 * Каталог у AnimeLib свой, с Anixart не пересекается: тайтл ищем по названию,
 * ручной пин releaseId → animeId лежит запасным вариантом (см. setOverride).
 * Поиск и запрос эпизода идут от имени того, кто смотрит: анониму приходит
 * `src: null`, а лицензированные тайтлы поиск молча прячет.
 *
 * На сами байты видео токен не нужен — DDoS-Guard перед CDN смотрит на
 * Referer и Origin, а не на того, кто пришёл (см. /animelib/stream).
 */
const CATALOG_API = 'https://api.cdnlibs.org/api'; // public, unauthenticated search/listing
const AUTH_API = 'https://hapi.hentaicdn.org/api'; // authenticated episode/player detail
const VIDEO_HOST = 'video1.cdnlibs.org';
const SITE_ID = '5'; // the anime vertical of the shared lib backend (vs manga/ranobe/hentai)
const UA = 'Mozilla/5.0';
const REQUEST_HEADERS = {
  'user-agent': UA,
  accept: 'application/json',
  referer: 'https://animelib.org/',
  origin: 'https://animelib.org',
  'site-id': SITE_ID,
};

const STORE_DIR = join(settings.STATE_DIR, 'animelib');
const TOKENS_FILE = join(STORE_DIR, 'tokens.json');
const REFRESH_FILE = join(STORE_DIR, 'refresh.json');
const OVERRIDES_FILE = join(STORE_DIR, 'overrides.json');

type TokenStore = Record<string, string>; // MiraiHub userId -> AnimeLib bearer token
type OverrideStore = Record<string, number>; // Anixart releaseId -> AnimeLib anime_id

function loadJson<T>(file: string, fallback: T): T {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as T;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Файла ещё нет.
  }
  return fallback;
}

function persist(file: string, data: unknown): void {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    // В памяти состояние живёт до перезапуска.
  }
}

let tokens: TokenStore = loadJson(TOKENS_FILE, {});
let refreshTokens: TokenStore = loadJson(REFRESH_FILE, {});
let overrides: OverrideStore = loadJson(OVERRIDES_FILE, {});

export function setToken(userId: number, token: string): void {
  tokens[String(userId)] = token;
  persist(TOKENS_FILE, tokens);
}

export function getToken(userId: number): string | undefined {
  return tokens[String(userId)];
}

export function clearToken(userId: number): void {
  delete tokens[String(userId)];
  delete refreshTokens[String(userId)];
  persist(TOKENS_FILE, tokens);
  persist(REFRESH_FILE, refreshTokens);
}

export function setRefreshToken(userId: number, token: string): void {
  refreshTokens[String(userId)] = token;
  persist(REFRESH_FILE, refreshTokens);
}

export function hasRefreshToken(userId: number): boolean {
  return !!refreshTokens[String(userId)];
}

/**
 * Срок жизни токена прямо из payload JWT, только для показа. Проверять подпись
 * нам нечем и незачем — аудитория токена не мы, а AnimeLib.
 */
export function tokenExpiresAt(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Access живёт 31 день, и его истечение снаружи невидимо: 401 глотается, эпизод
 * отвечает «нет своего источника» — как тайтл, у которого плеера и не было.
 *
 * Клиент AnimeLib публичный, с PKCE и без секрета, поэтому refresh-грант
 * доступен и нам. Passport ротирует токены при обмене, так что сервер и браузер
 * не могут делить одну цепочку, а «Выйти» отзывает её целиком.
 */
const TOKEN_ENDPOINT = `${AUTH_API}/auth/oauth/token`;
const OAUTH_CLIENT_ID = '1';
const RENEW_MARGIN_MS = 3 * 24 * 60 * 60 * 1000;

// Обновления сериализованы по пользователю: при ротации две параллельные
// попытки затрут друг друга уже отозванным токеном.
const refreshInFlight = new Map<string, Promise<string | undefined>>();

async function requestRefresh(userId: number): Promise<string | undefined> {
  const refresh = refreshTokens[String(userId)];
  if (!refresh) return undefined;
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refresh,
      }),
    });
  } catch {
    return undefined; // Network blip — keep the pair and retry on the next lookup.
  }
  if (!res.ok) {
    // 401 окончателен: цепочку отозвали разлогином или она уже провернулась.
    // Убираем, чтобы не долбиться в заведомо мёртвый токен.
    if (res.status === 401) {
      delete refreshTokens[String(userId)];
      persist(REFRESH_FILE, refreshTokens);
    }
    return undefined;
  }
  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; refresh_token?: string }
    | null;
  if (!body?.access_token) return undefined;
  setToken(userId, body.access_token);
  if (body.refresh_token) setRefreshToken(userId, body.refresh_token);
  return body.access_token;
}

/** Access-токен пользователя, при необходимости сначала продлённый. */
export async function getValidToken(userId: number): Promise<string | undefined> {
  const current = getToken(userId);
  const expiresAt = current ? tokenExpiresAt(current) : null;
  const stale = !current || expiresAt === null || expiresAt - Date.now() < RENEW_MARGIN_MS;
  if (!stale || !refreshTokens[String(userId)]) return current;

  const key = String(userId);
  let pending = refreshInFlight.get(key);
  if (!pending) {
    pending = requestRefresh(userId).finally(() => refreshInFlight.delete(key));
    refreshInFlight.set(key, pending);
  }
  // Если обновить не вышло, отдаём что есть: близкий к истечению ещё работает,
  // а мёртвый деградирует так же, как раньше.
  return (await pending) ?? current;
}

export function setOverride(releaseId: string, animeId: number): void {
  overrides[releaseId] = animeId;
  persist(OVERRIDES_FILE, overrides);
}

export function getOverride(releaseId: string): number | undefined {
  return overrides[releaseId];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Кэш общий на всех, не по пользователям: содержимое ответа не зависит от того,
// чей токен спрашивал, — важно лишь, что запрос был авторизован.
//
// TTL нет: контейнер и так перезапускается еженедельным обслуживанием, и это
// лучшая граница свежести, чем выбранное на глаз число. Кэшируем только
// непустые результаты — иначе разовый сбой замёрзнет как ложное «ничего нет».

// Край AnimeLib за DDoS-Guard иногда рвёт соединение на запросе, который через
// мгновение проходит. Без ретраев это выглядит как «тайтл не найден». Три попытки
// с растущей паузой их поглощают; честный 4xx падает сразу, повтор его не изменит.
async function fetchJson<T>(url: string | URL, headers: Record<string, string>, attempts = 3): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const last = attempt === attempts - 1;
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return (await res.json()) as T;
      if (res.status >= 500 && !last) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      return null;
    } catch {
      if (!last) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

interface AnimeSearchResult {
  id: number;
  name: string;
  rus_name?: string;
  eng_name?: string;
  type?: { id: number; label?: string };
}

// type.id 0 ("Неизвестный") is what AnimeLib gives specials/interludes/omake
// Побочные материалы — рекапы, интерлюдии — поиск нередко ставит выше настоящего
// сезона. У короткой интерлюдии тоже есть серия 1, поэтому промах выглядел как
// баг конкретной серии, хотя был выбран не тот тайтл целиком. Лучше честный
// title_not_found, у него есть запасной ручной пин.
function isRealSeries(r: AnimeSearchResult): boolean {
  return r.type?.id !== 0;
}

// Анонимный поиск молча выбрасывает лицензированные тайтлы, авторизованный
// возвращает всё. Запасного анонимного захода нет: он дал бы частичный результат.
const searchCache = new Map<string, AnimeSearchResult[]>();
async function searchAnime(query: string, token: string): Promise<AnimeSearchResult[]> {
  const cached = searchCache.get(query);
  if (cached) return cached;
  const url = new URL(`${CATALOG_API}/anime`);
  url.searchParams.set('q', query);
  const j = await fetchJson<{ data?: AnimeSearchResult[] }>(url, {
    ...REQUEST_HEADERS,
    authorization: `Bearer ${token}`,
  });
  const results = (j?.data ?? []).filter(isRealSeries);
  if (results.length > 0) searchCache.set(query, results);
  return results;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ' ').trim();
}

function pickExactMatch(results: AnimeSearchResult[], wanted: Set<string>): AnimeSearchResult | null {
  for (const r of results) {
    const candidates = [r.name, r.rus_name, r.eng_name].filter((s): s is string => !!s).map(normalize);
    if (candidates.some((c) => wanted.has(c))) return r;
  }
  return null;
}

export async function findAnimeId(
  releaseId: string,
  token: string | undefined,
  titles: { orig?: string; ru?: string; en?: string },
): Promise<number | null> {
  const override = getOverride(releaseId);
  if (override) return override;
  if (!token) return null;

  const variants = [...new Set([titles.orig, titles.en, titles.ru].filter((x): x is string => !!x))];
  if (variants.length === 0) return null;
  const wanted = new Set(variants.map(normalize));

  // Каждый вариант названия — отдельный поиск: поле `name` у AnimeLib бывает
  // покорёженным и не совпадает с оригинальным названием Anixart, зато находится
  // по русскому. Одного варианта недостаточно.
  let fallback: AnimeSearchResult | null = null;
  for (const query of variants) {
    const results = await searchAnime(query, token);
    if (results.length === 0) continue;
    fallback ??= results[0]!;
    const exact = pickExactMatch(results, wanted);
    if (exact) return exact.id;
  }
  return fallback?.id ?? null;
}

interface EpisodeListItem {
  id: number;
  number: string;
}

// Параметр `number` у этой ручки ничего не фильтрует — она всегда отдаёт все
// серии. Это и удобно: единственный дешёвый способ узнать настоящий список серий.
const episodesCache = new Map<string, EpisodeListItem[]>();
async function listEpisodes(animeId: number): Promise<EpisodeListItem[]> {
  const key = String(animeId);
  const cached = episodesCache.get(key);
  if (cached) return cached;
  const url = new URL(`${CATALOG_API}/episodes`);
  url.searchParams.set('anime_id', key);
  const j = await fetchJson<{ data?: EpisodeListItem[] }>(url, REQUEST_HEADERS);
  const episodes = j?.data ?? [];
  if (episodes.length > 0) episodesCache.set(key, episodes);
  return episodes;
}

// Дедуп нужен: в списке AnimeLib одна серия не всегда одна строка — рекап может
// нести тот же `number`, что и обычная серия, и сетка показала бы дубль.
function sortedEpisodeNumbers(episodes: EpisodeListItem[]): string[] {
  return [...new Set(episodes.map((e) => e.number).filter(Boolean))].sort(
    (a, b) => parseFloat(a) - parseFloat(b),
  );
}

async function findEpisodeId(animeId: number, episodeNumber: number): Promise<number | null> {
  const episodes = await listEpisodes(animeId);
  const match = episodes.find((e) => String(e.number) === String(episodeNumber));
  return match?.id ?? null;
}

export interface AnimelibQuality {
  label: string;
  url: string;
}

interface RawPlayer {
  player: string;
  team?: { name?: string };
  translation_type?: { label?: string };
  video?: { quality?: Array<{ href: string; quality: number }> };
}

// Сырой `href` из API сам по себе даёт 404: настоящий файл лежит за
// дополнительным сегментом пути.
const CDN_PATH_PREFIX = '/.аs';

function absoluteVideoUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const path = href.startsWith('/') ? href : `/${href}`;
  return `https://${VIDEO_HOST}${CDN_PATH_PREFIX}${path}`;
}

/** Same name a team would show under in the Anixart-style "Озвучка" list —
 *  используется и при перечислении команд, и при обратном поиске выбранной,
 *  поэтому они не разъезжаются. */
function dubDisplayName(p: RawPlayer): string {
  const name = p.team?.name || 'Озвучка';
  return p.translation_type?.label === 'Субтитры' ? `${name} (субтитры)` : name;
}

/** Все родные озвучки AnimeLib для серии. Записи Kodik здесь не нужны —
 *  их закрывает обычный список озвучек Anixart. */
const dubsCache = new Map<string, Array<{ team: string; qualities: AnimelibQuality[] }>>();
async function fetchAnimelibDubs(
  episodeId: number,
  token: string,
): Promise<Array<{ team: string; qualities: AnimelibQuality[] }>> {
  const key = String(episodeId);
  const cached = dubsCache.get(key);
  if (cached) return cached;

  // Пустой список плееров при честном 200 — та же флакость, но fetchJson её не
  // ловит: пустое тело выглядит нормальным ответом. У существующей серии плееры
  // почти всегда есть хоть какие-то, поэтому пустоту стоит перепросить.
  let players: RawPlayer[] = [];
  for (let attempt = 0; attempt < 3 && players.length === 0; attempt++) {
    if (attempt > 0) await sleep(300 * attempt);
    const j = await fetchJson<{ data?: { players?: RawPlayer[] } }>(`${AUTH_API}/episodes/${episodeId}`, {
      ...REQUEST_HEADERS,
      authorization: `Bearer ${token}`,
    });
    players = j?.data?.players ?? [];
  }
  const dubs: Array<{ team: string; qualities: AnimelibQuality[] }> = [];
  for (const p of players) {
    if (p.player !== 'Animelib' || !p.video?.quality?.length) continue;
    dubs.push({
      team: dubDisplayName(p),
      qualities: [...p.video.quality]
        .sort((a, b) => b.quality - a.quality)
        .map((q) => ({ label: `${q.quality}p`, url: absoluteVideoUrl(q.href) })),
    });
  }
  if (dubs.length > 0) dubsCache.set(key, dubs);
  return dubs;
}

export interface AnimelibLookupResult {
  found: boolean;
  reason?: 'no_token' | 'title_not_found' | 'episode_not_found' | 'no_native_source';
  team?: string;
  qualities?: AnimelibQuality[];
}

/** releaseId → anime_id → episode_id. Шаг с пином и поиском общий, чтобы все
 *  вызовы AnimeLib сходились на одном и том же тайтле. */
async function resolveEpisodeId(
  releaseId: string,
  episodeNumber: number,
  token: string,
  titles: { orig?: string; ru?: string; en?: string },
): Promise<{ animeId: number; episodeId: number } | null> {
  const animeId = await findAnimeId(releaseId, token, titles).catch(() => null);
  if (!animeId) return null;
  const episodeId = await findEpisodeId(animeId, episodeNumber).catch(() => null);
  if (!episodeId) return null;
  return { animeId, episodeId };
}

/**
 * Лучшая озвучка AnimeLib для серии. Лучшая — та, у чьей команды выше
 * собственный максимум качества: иначе можно выдать 480p, когда у соседней
 * команды на этой же серии есть 1080p.
 */
export async function lookupAnimelib(
  userId: number,
  releaseId: string,
  episodeNumber: number,
  titles: { orig?: string; ru?: string; en?: string },
): Promise<AnimelibLookupResult> {
  const token = await getValidToken(userId);
  if (!token) return { found: false, reason: 'no_token' };

  const found = await resolveEpisodeId(releaseId, episodeNumber, token, titles);
  if (!found) return { found: false, reason: 'title_not_found' };

  const dubs = await fetchAnimelibDubs(found.episodeId, token).catch(() => []);
  if (dubs.length === 0) return { found: false, reason: 'no_native_source' };

  const best = dubs.reduce((a, b) =>
    (b.qualities[0] ? parseInt(b.qualities[0].label, 10) : 0) >
    (a.qualities[0] ? parseInt(a.qualities[0].label, 10) : 0)
      ? b
      : a,
  );
  return { found: true, team: best.team, qualities: best.qualities };
}

export interface AnimelibTeamsResult {
  found: boolean;
  reason?: 'no_token' | 'title_not_found' | 'episode_not_found' | 'no_native_source';
  teams?: string[];
  /**
   * Настоящие номера серий AnimeLib, а не количество из Anixart. У split-cour
   * тайтла Anixart ведёт сквозную нумерацию, а AnimeLib держит части отдельными
   * тайтлами, каждый с первой серии. Сетка по количеству из Anixart упиралась
   * в episode_not_found за границей части.
   */
  episodeNumbers?: string[];
}

/**
 * Все команды AnimeLib для релиза и настоящий список серий — для выбора
 * «Источника». Опираемся на первую по сортировке серию. Покрытие у команды
 * может отличаться от серии к серии, это вскроется при запросе конкретной.
 */
export async function listAnimelibTeams(
  userId: number,
  releaseId: string,
  titles: { orig?: string; ru?: string; en?: string },
): Promise<AnimelibTeamsResult> {
  const token = await getValidToken(userId);
  if (!token) return { found: false, reason: 'no_token' };

  const animeId = await findAnimeId(releaseId, token, titles).catch(() => null);
  if (!animeId) return { found: false, reason: 'title_not_found' };

  const episodes = await listEpisodes(animeId).catch(() => []);
  if (episodes.length === 0) return { found: false, reason: 'episode_not_found' };

  const numbers = sortedEpisodeNumbers(episodes);
  // Щупаем именно серию «1», а не первую по сортировке: бонус или интерлюдия
  // может стоять под номером «0» впереди настоящего начала, и покрытие команд у
  // неё своё. На numbers[0] откатываемся только если серии «1» правда нет.
  const probeNumber = numbers.includes('1') ? '1' : numbers[0];
  const firstEpisode = episodes.find((e) => e.number === probeNumber);
  if (!firstEpisode) return { found: false, reason: 'episode_not_found' };

  const dubs = await fetchAnimelibDubs(firstEpisode.id, token).catch(() => []);
  if (dubs.length === 0) return { found: false, reason: 'no_native_source' };

  return { found: true, teams: dubs.map((d) => d.team), episodeNumbers: numbers };
}

/** Качества конкретной команды для серии — когда плеер открывают сразу с
 *  выбранным источником AnimeLib, а не переключают на него по ходу. */
export async function resolveAnimelibTeam(
  userId: number,
  releaseId: string,
  episodeNumber: number,
  team: string,
  titles: { orig?: string; ru?: string; en?: string },
): Promise<AnimelibLookupResult> {
  const token = await getValidToken(userId);
  if (!token) return { found: false, reason: 'no_token' };

  const found = await resolveEpisodeId(releaseId, episodeNumber, token, titles);
  if (!found) return { found: false, reason: 'episode_not_found' };

  const dubs = await fetchAnimelibDubs(found.episodeId, token).catch(() => []);
  const match = dubs.find((d) => d.team === team);
  if (!match) return { found: false, reason: 'no_native_source' };

  return { found: true, team: match.team, qualities: match.qualities };
}

/** Дешёвая проверка кандидата в пины: существует ли такой тайтл и есть ли у
 *  него серии, прежде чем бот предложит его привязать. */
export async function animeHasEpisodes(animeId: number): Promise<boolean> {
  const episodes = await listEpisodes(animeId).catch(() => []);
  return episodes.length > 0;
}

export function isAllowedAnimelibVideoUrl(url: string): boolean {
  try {
    return new URL(url).hostname === VIDEO_HOST;
  } catch {
    return false;
  }
}
