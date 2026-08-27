import { createHmac } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { ReadStream } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * Личная галерея скриншотов на диске. Пользователь адресуется непрозрачным
 * bucket'ом, а не присланным клиентом id — иначе чужую галерею можно было бы
 * перебрать. Bucket в адресе файла и есть пропуск к нему.
 *
 * Сам адрес выдаёт services/identity.ts: он считается от стабильного id аккаунта,
 * а не от токена (раньше было от токена, из-за чего смена устройства или
 * перелогин показывали пустую галерею).
 */

export interface ShotMeta {
  id: string;
  releaseId?: string;
  title?: string;
  episode?: number;
  time?: number;
  note?: string;
  createdAt: number;
  ext: 'jpg' | 'png';
}

const ROOT = join(settings.STATE_DIR, 'screenshots');
const ID_RE = /^[A-Za-z0-9_-]+$/;

const safe = (v: string): string => (ID_RE.test(v) ? v : '');
const bucketDir = (bucket: string) => join(ROOT, bucket);
const indexFile = (bucket: string) => join(bucketDir(bucket), 'index.json');

function readIndex(bucket: string): ShotMeta[] {
  try {
    return JSON.parse(readFileSync(indexFile(bucket), 'utf8')) as ShotMeta[];
  } catch {
    return [];
  }
}

function writeIndex(bucket: string, list: ShotMeta[]): void {
  mkdirSync(bucketDir(bucket), { recursive: true });
  writeFileSync(indexFile(bucket), JSON.stringify(list));
}

export function saveShot(
  bucket: string,
  bytes: Buffer,
  ext: 'jpg' | 'png',
  meta: Omit<ShotMeta, 'id' | 'createdAt' | 'ext'>,
): ShotMeta {
  const b = safe(bucket);
  if (!b) throw new Error('bad bucket');
  mkdirSync(bucketDir(b), { recursive: true });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: ShotMeta = { id, createdAt: Date.now(), ext, ...meta };
  writeFileSync(join(bucketDir(b), `${id}.${ext}`), bytes);

  const list = readIndex(b);
  list.unshift(entry);
  writeIndex(b, list);
  return entry;
}

export function listShots(bucket: string): ShotMeta[] {
  const b = safe(bucket);
  return b ? readIndex(b) : [];
}

export function openShot(bucket: string, id: string): { stream: ReadStream; ext: string } | null {
  const b = safe(bucket);
  const sid = safe(id);
  if (!b || !sid) return null;
  const meta = readIndex(b).find((m) => m.id === sid);
  if (!meta) return null;
  const file = join(bucketDir(b), `${sid}.${meta.ext}`);
  return existsSync(file) ? { stream: createReadStream(file), ext: meta.ext } : null;
}

export function removeShot(bucket: string, id: string): boolean {
  const b = safe(bucket);
  const sid = safe(id);
  if (!b || !sid) return false;
  const list = readIndex(b);
  const meta = list.find((m) => m.id === sid);
  if (!meta) return false;
  try {
    unlinkSync(join(bucketDir(b), `${sid}.${meta.ext}`));
  } catch {
    // уже удалено
  }
  writeIndex(
    b,
    list.filter((m) => m.id !== sid),
  );
  return true;
}

/** Поставить или снять заметку у скриншота. */
export function setNote(bucket: string, id: string, note: string): boolean {
  const b = safe(bucket);
  const sid = safe(id);
  if (!b || !sid) return false;
  const list = readIndex(b);
  const meta = list.find((m) => m.id === sid);
  if (!meta) return false;
  const trimmed = note.trim().slice(0, 2000);
  if (trimmed) meta.note = trimmed;
  else delete meta.note;
  writeIndex(b, list);
  return true;
}
