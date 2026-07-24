import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * AnimeLib native-player integration ("Animelib" dub type — a distinct backend
 * from the Kodik link every dub also carries, hosted on AnimeLib's own CDN with
 * genuine 1080p encodes where Kodik regularly caps at 720p).
 *
 * Three things make this fundamentally different from kodik.ts/anilibria.ts:
 *
 * 1. Per-user auth. The video URL only appears in the episode response when the
 *    request carries a valid AnimeLib account Bearer token — anonymous requests
 *    see the same player listed with `src: null`. There's no app-wide service
 *    account to use instead; each MiraiHub user who wants this must paste their
 *    own token (extracted from their own logged-in browser session — AnimeLib
 *    has no public OAuth app registration to do this properly).
 *
 * 2. No shared catalog with Anixart. AnimeLib is a wholly separate catalog
 *    with its own anime/episode ids, matched here by title search. That
 *    search silently excludes licensed titles (exactly the ones with real
 *    1080p) *when called anonymously* — the same query with the caller's own
 *    `Authorization: Bearer` header returns the full catalog, specials
 *    included (confirmed directly: anonymous search for a licensed title
 *    returns 1 result, authenticated returns 5, including the real season).
 *    So search runs authenticated as whichever user is looking, using their
 *    own token — no shared/service account, so one account's ban or
 *    expiry can't take AnimeLib down for everyone. A manual releaseId →
 *    animeId override (see setOverride/getOverride) still exists as a
 *    fallback for whatever search still gets wrong (ambiguous titles, a
 *    user with no token yet) — global, not per-user, so one correct pin
 *    covers everyone regardless of whether search would've found it.
 *
 * 3. The video file itself needs no token. DDoS-Guard in front of the CDN gates
 *    on Referer/Origin, not caller identity — so the token is only spent on the
 *    one authenticated lookup that reveals the URL; relaying the actual bytes
 *    (see features/animelib.ts's /animelib/stream) never touches it again.
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
const OVERRIDES_FILE = join(STORE_DIR, 'overrides.json');

type TokenStore = Record<string, string>; // MiraiHub userId -> AnimeLib bearer token
type OverrideStore = Record<string, number>; // Anixart releaseId -> AnimeLib anime_id

function loadJson<T>(file: string, fallback: T): T {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as T;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // No file yet.
  }
  return fallback;
}

function persist(file: string, data: unknown): void {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {
    // In-memory state still works until the next restart.
  }
}

let tokens: TokenStore = loadJson(TOKENS_FILE, {});
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
  persist(TOKENS_FILE, tokens);
}

/**
 * Unix-ms expiry read straight from the JWT payload — display only. We're not
 * the token's audience (AnimeLib is), so there's nothing for us to verify;
 * this just lets Settings show "истекает через N дней" instead of the user
 * finding out the hard way when playback stops working.
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

// AnimeLib's edge (behind DDoS-Guard) occasionally drops a connection or
// times out for a request that succeeds moments later — observed directly
// while debugging this file more than once, including a blip that outlasted
// a single retry. Without retrying, that gets reported as "title not found" /
// "no native player" — indistinguishable from the title genuinely lacking
// one. Three attempts with growing backoff absorbs that class of flake; a
// real 4xx (title/episode truly doesn't exist) still fails immediately since
// retrying wouldn't change it.
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
// content (a "Kanwa" side story, a recap, etc.) — search ranks these above the
// real season they're attached to often enough to matter. A short interlude
// happening to have an episode 1 made this fail silently rather than loudly:
// matching one meant episode 1 "worked" while every later episode 404'd,
// which looks like a per-episode bug rather than what it actually was — the
// wrong anime_id entirely. Filtering these out trades a silent wrong match
// for an honest "title_not_found" (which still has the override fallback).
function isRealSeries(r: AnimeSearchResult): boolean {
  return r.type?.id !== 0;
}

// Anonymous search silently drops licensed titles from its results; the same
// query authenticated as a real AnimeLib account returns everything. Requires
// a token, so this only ever runs for a user who's connected their own
// account — there's no anonymous fallback attempt, since it would just widen
// the anonymous 403/hidden-content gap into an inconsistent partial result.
async function searchAnime(query: string, token: string): Promise<AnimeSearchResult[]> {
  const url = new URL(`${CATALOG_API}/anime`);
  url.searchParams.set('q', query);
  const j = await fetchJson<{ data?: AnimeSearchResult[] }>(url, {
    ...REQUEST_HEADERS,
    authorization: `Bearer ${token}`,
  });
  return (j?.data ?? []).filter(isRealSeries);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, ' ').trim();
}

/** Exact normalized match preferred (search ranks loosely); falls back to the top hit. */
function pickBestMatch(results: AnimeSearchResult[], titles: string[]): AnimeSearchResult | null {
  if (results.length === 0) return null;
  const wanted = new Set(titles.map(normalize));
  for (const r of results) {
    const candidates = [r.name, r.rus_name, r.eng_name].filter((s): s is string => !!s).map(normalize);
    if (candidates.some((c) => wanted.has(c))) return r;
  }
  return results[0] ?? null;
}

export async function findAnimeId(
  releaseId: string,
  token: string | undefined,
  titles: { orig?: string; ru?: string; en?: string },
): Promise<number | null> {
  const override = getOverride(releaseId);
  if (override) return override;
  if (!token) return null;
  const query = titles.orig || titles.en || titles.ru;
  if (!query) return null;
  const results = await searchAnime(query, token);
  const wanted = [titles.orig, titles.en, titles.ru].filter((x): x is string => !!x);
  return pickBestMatch(results, wanted)?.id ?? null;
}

interface EpisodeListItem {
  id: number;
  number: string;
}

// The `number` query param this endpoint accepts doesn't actually filter —
// it always returns every episode for the anime_id, `number` and all. That
// turns out to be useful: it's the one cheap way to get AnimeLib's real
// episode roster, which is what makes matching by number reliable at all
// (see listAnimelibTeams below for why that matters).
async function listEpisodes(animeId: number): Promise<EpisodeListItem[]> {
  const url = new URL(`${CATALOG_API}/episodes`);
  url.searchParams.set('anime_id', String(animeId));
  const j = await fetchJson<{ data?: EpisodeListItem[] }>(url, REQUEST_HEADERS);
  return j?.data ?? [];
}

// Dedupes because AnimeLib's roster isn't always one row per real episode —
// e.g. a recap can carry the same `number` as a regular episode (seen on
// "О моём перерождении в слизь 3": id 121766, number "1", name "Рекап",
// alongside the real episode 1). Left un-deduped the grid would show two
// "серия 1" tiles.
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

// The raw `href` from the API 404s on its own — the real file sits behind an
// extra path segment (confirmed by comparing a URL copied straight out of a
// live <video> element against the API's href for the same file). Cyrillic
// "а" (U+0430), not Latin — written as an escape so it isn't "corrected" by
// someone who can't tell them apart at a glance.
const CDN_PATH_PREFIX = '/.аs';

function absoluteVideoUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const path = href.startsWith('/') ? href : `/${href}`;
  return `https://${VIDEO_HOST}${CDN_PATH_PREFIX}${path}`;
}

/** Same name a team would show under in the Anixart-style "Озвучка" list —
 *  used both when listing teams and when matching a chosen one back to its
 *  player entry, so the two stay in lockstep by construction. */
function dubDisplayName(p: RawPlayer): string {
  const name = p.team?.name || 'Озвучка';
  return p.translation_type?.label === 'Субтитры' ? `${name} (субтитры)` : name;
}

/** All "Animelib"-native dubs for one episode (Kodik-backed entries are irrelevant
 *  here — kodik.ts already covers those via the normal Anixart dubber list). */
async function fetchAnimelibDubs(
  episodeId: number,
  token: string,
): Promise<Array<{ team: string; qualities: AnimelibQuality[] }>> {
  const j = await fetchJson<{ data?: { players?: RawPlayer[] } }>(`${AUTH_API}/episodes/${episodeId}`, {
    ...REQUEST_HEADERS,
    authorization: `Bearer ${token}`,
  });
  const players = j?.data?.players ?? [];
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
  return dubs;
}

export interface AnimelibLookupResult {
  found: boolean;
  reason?: 'no_token' | 'title_not_found' | 'episode_not_found' | 'no_native_source';
  team?: string;
  qualities?: AnimelibQuality[];
}

/** Resolves releaseId -> AnimeLib anime_id -> the episode_id for one episode
 *  number, sharing the override/search step so every AnimeLib call agrees on
 *  which catalog entry a release maps to. */
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
 * One release+episode -> the best AnimeLib-native dub available, if any.
 * "Best" = whichever team's own top quality is highest — teams don't all
 * upload the same tiers, so picking the max avoids surfacing a 480p-only
 * team when a different one on the same episode actually has 1080p.
 */
export async function lookupAnimelib(
  userId: number,
  releaseId: string,
  episodeNumber: number,
  titles: { orig?: string; ru?: string; en?: string },
): Promise<AnimelibLookupResult> {
  const token = getToken(userId);
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
   * AnimeLib's own real episode numbers — NOT Anixart's episode count. A
   * split-cour title can have Anixart running one continuous numbering while
   * AnimeLib carries the parts as separate entries each starting over at 1
   * (this exact franchise does — "4th Season" and "4th Season Part 2" are
   * distinct AnimeLib titles). Building the episode grid from Anixart's count
   * and reusing that number against AnimeLib produced "episode_not_found"
   * past wherever the part boundary falls. Returning AnimeLib's actual roster
   * means the grid only ever offers numbers that really resolve.
   */
  episodeNumbers?: string[];
}

/**
 * Every AnimeLib-native team dubbing this release, plus its real episode
 * roster, for the "Источник" picker on the episode-selection screen —
 * anchored on whichever episode sorts first (usually "1", but the roster is
 * asked for regardless in case it isn't). A team's per-episode coverage can
 * still vary; one missing a specific later episode surfaces when that
 * episode is actually requested, same as it already does for Kodik dubs.
 */
export async function listAnimelibTeams(
  userId: number,
  releaseId: string,
  titles: { orig?: string; ru?: string; en?: string },
): Promise<AnimelibTeamsResult> {
  const token = getToken(userId);
  if (!token) return { found: false, reason: 'no_token' };

  const animeId = await findAnimeId(releaseId, token, titles).catch(() => null);
  if (!animeId) return { found: false, reason: 'title_not_found' };

  const episodes = await listEpisodes(animeId).catch(() => []);
  if (episodes.length === 0) return { found: false, reason: 'episode_not_found' };

  const numbers = sortedEpisodeNumbers(episodes);
  // Probe episode "1" specifically rather than whichever number sorts first —
  // AnimeLib sometimes numbers a bonus/interlude "0" ahead of the real start
  // (same franchise again: id 118629, number "0", name «Беседа: "Дневник
  // Диабло"» — the very Kanwa special isRealSeries() filters out of search).
  // That episode had different (narrower) team coverage than the real season,
  // so anchoring on numbers[0] showed teams that then failed on every actual
  // episode. Falls back to numbers[0] only for titles that genuinely have no
  // episode "1" (e.g. start numbering at 0 throughout).
  const probeNumber = numbers.includes('1') ? '1' : numbers[0];
  const firstEpisode = episodes.find((e) => e.number === probeNumber);
  if (!firstEpisode) return { found: false, reason: 'episode_not_found' };

  const dubs = await fetchAnimelibDubs(firstEpisode.id, token).catch(() => []);
  if (dubs.length === 0) return { found: false, reason: 'no_native_source' };

  return { found: true, teams: dubs.map((d) => d.team), episodeNumbers: numbers };
}

/** One release+episode+specific team (picked from listAnimelibTeams) -> its
 *  qualities — used when the player is opened with AnimeLib chosen as the
 *  source up front, rather than as an opt-in swap mid-playback. */
export async function resolveAnimelibTeam(
  userId: number,
  releaseId: string,
  episodeNumber: number,
  team: string,
  titles: { orig?: string; ru?: string; en?: string },
): Promise<AnimelibLookupResult> {
  const token = getToken(userId);
  if (!token) return { found: false, reason: 'no_token' };

  const found = await resolveEpisodeId(releaseId, episodeNumber, token, titles);
  if (!found) return { found: false, reason: 'episode_not_found' };

  const dubs = await fetchAnimelibDubs(found.episodeId, token).catch(() => []);
  const match = dubs.find((d) => d.team === team);
  if (!match) return { found: false, reason: 'no_native_source' };

  return { found: true, team: match.team, qualities: match.qualities };
}

/** Cheap sanity check for a candidate override id — confirms it's a real
 *  AnimeLib anime with an episode roster before the Telegram bot offers it
 *  as something to link (see features/telegram.ts's link handler). */
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
