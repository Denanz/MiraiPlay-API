import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * Cross-device watch progress. Like the screenshot gallery, a user is addressed
 * by an opaque HMAC "bucket" of their token — never a client-supplied id — so a
 * saved position can't be read or overwritten for someone else. One file per
 * bucket holds the most-recent position per (release, source, episode).
 */

export interface ProgressEntry {
  releaseId: string;
  sourceId: string;
  episode: string;
  position: number;
  duration: number;
  title?: string;
  updatedAt: number;
}

const ROOT = join(settings.STATE_DIR, 'progress');
const MAX_PER_BUCKET = 400;
const BUCKET_RE = /^[a-f0-9]{8,64}$/;

const safeBucket = (b: string): string => (BUCKET_RE.test(b) ? b : '');
const fileFor = (bucket: string) => join(ROOT, `${bucket}.json`);
const keyOf = (r: string, s: string, e: string) => `${r}:${s}:${e}`;

function read(bucket: string): ProgressEntry[] {
  try {
    return JSON.parse(readFileSync(fileFor(bucket), 'utf8')) as ProgressEntry[];
  } catch {
    return [];
  }
}

function write(bucket: string, list: ProgressEntry[]): void {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(fileFor(bucket), JSON.stringify(list));
}


export function saveProgress(bucket: string, entry: ProgressEntry): void {
  const b = safeBucket(bucket);
  if (!b) return;
  const key = keyOf(entry.releaseId, entry.sourceId, entry.episode);
  let list = read(b).filter((x) => keyOf(x.releaseId, x.sourceId, x.episode) !== key);
  list.unshift(entry);
  if (list.length > MAX_PER_BUCKET) list = list.slice(0, MAX_PER_BUCKET);
  write(b, list);
}

export function getProgress(
  bucket: string,
  releaseId: string,
  sourceId: string,
  episode: string,
): ProgressEntry | null {
  const b = safeBucket(bucket);
  if (!b) return null;
  const key = keyOf(releaseId, sourceId, episode);
  return read(b).find((x) => keyOf(x.releaseId, x.sourceId, x.episode) === key) ?? null;
}

/** In-progress episodes (started but not ~finished), newest first. */
export function listContinue(bucket: string, limit = 60): ProgressEntry[] {
  const b = safeBucket(bucket);
  if (!b) return [];
  return read(b)
    .filter((x) => x.position > 30 && (!x.duration || x.position < x.duration * 0.92))
    .sort((a, b2) => b2.updatedAt - a.updatedAt)
    .slice(0, limit);
}
