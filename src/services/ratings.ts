import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';


interface RatingEntry {
  rating: number; // 1–10
  ratedAt: number;
}

type Bucket = Record<string, RatingEntry>; // key = "releaseId:sourceId:episode"

const ROOT = join(settings.STATE_DIR, 'ratings');
const BUCKET_RE = /^[a-f0-9]{8,64}$/;
const safeBucket = (b: string) => (BUCKET_RE.test(b) ? b : '');
const fileFor = (b: string) => join(ROOT, `${b}.json`);
const key = (r: string, s: string, e: string) => `${r}:${s}:${e}`;

function load(bucket: string): Bucket {
  const b = safeBucket(bucket);
  if (!b) return {};
  try {
    return JSON.parse(readFileSync(fileFor(b), 'utf8')) as Bucket;
  } catch {
    return {};
  }
}

function persist(bucket: string, data: Bucket): void {
  const b = safeBucket(bucket);
  if (!b) return;
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(fileFor(b), JSON.stringify(data));
}

export function setRating(
  bucket: string,
  releaseId: string,
  sourceId: string,
  episode: string,
  rating: number,
): void {
  const r = Math.min(10, Math.max(1, Math.round(rating)));
  const data = load(bucket);
  data[key(releaseId, sourceId, episode)] = { rating: r, ratedAt: Date.now() };
  persist(bucket, data);
}

export function deleteRating(bucket: string, releaseId: string, sourceId: string, episode: string): void {
  const data = load(bucket);
  delete data[key(releaseId, sourceId, episode)];
  persist(bucket, data);
}

/** All ratings for a release+source, keyed by episode position string. */
export function getRatings(bucket: string, releaseId: string, sourceId: string): Record<string, number> {
  const data = load(bucket);
  const prefix = `${releaseId}:${sourceId}:`;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v.rating;
  }
  return out;
}

export function getRating(
  bucket: string,
  releaseId: string,
  sourceId: string,
  episode: string,
): number | null {
  const data = load(bucket);
  return data[key(releaseId, sourceId, episode)]?.rating ?? null;
}

// ── Release-level rating (personal, 1–10, independent of any source/episode) ──
// Stored under a sentinel source/episode so it never collides with per-episode
// ratings (which always use a real numeric source + episode position).
const REL = '_';

export function setReleaseRating(bucket: string, releaseId: string, rating: number): void {
  setRating(bucket, releaseId, REL, REL, rating);
}

export function getReleaseRating(bucket: string, releaseId: string): number | null {
  return getRating(bucket, releaseId, REL, REL);
}

export function deleteReleaseRating(bucket: string, releaseId: string): void {
  deleteRating(bucket, releaseId, REL, REL);
}
