import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';
import { bucketFor } from './screenshots.js';

/**
 * Personal per-anime diary: a free-text review + optional 1–10 score, one entry
 * per release. Bucketed by an HMAC of the user's token (like ratings/notes) so
 * it's private and cross-device.
 */

export { bucketFor };

export interface DiaryEntry {
  text: string;
  rating: number; // 0 = unset, else 1–10
  updatedAt: number;
}

type Bucket = Record<string, DiaryEntry>; // key = releaseId

const ROOT = join(settings.STATE_DIR, 'diary');
const BUCKET_RE = /^[a-f0-9]{8,64}$/;
const safeBucket = (b: string) => (BUCKET_RE.test(b) ? b : '');
const fileFor = (b: string) => join(ROOT, `${b}.json`);

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

export function getDiary(bucket: string, releaseId: string): DiaryEntry | null {
  return load(bucket)[releaseId] ?? null;
}

export function setDiary(bucket: string, releaseId: string, text: string, rating: number): void {
  const data = load(bucket);
  const cleanText = text.trim().slice(0, 8000);
  const r = Math.min(10, Math.max(0, Math.round(rating || 0)));
  if (!cleanText && !r) {
    delete data[releaseId];
  } else {
    data[releaseId] = { text: cleanText, rating: r, updatedAt: Date.now() };
  }
  persist(bucket, data);
}
