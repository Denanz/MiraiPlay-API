import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * Снимок последнего согласованного состояния — фундамент двусторонней синхронизации.
 *
 * Без него нельзя ответить на главный вопрос: стороны различаются, но КТО из них
 * изменился? Сравнение двух текущих состояний этого не даёт, и без точки отсчёта
 * получаются качели — одна сторона затирает другую, на следующем цикле наоборот.
 *
 * Снимок хранит и карту соответствий releaseId ↔ shikiId. Сопоставление по
 * названиям дорогое и неточное, поэтому делается один раз при первом переносе,
 * а дальше пара просто помнится. Благодаря этому регулярный цикл не ищет ничего:
 * один запрос к Shikimori, несколько к своему upstream, и запись только дельт.
 */

export interface SyncedItem {
  releaseId: string;
  shikiId: number;
  /** Значения на момент последней удачной сверки — точка отсчёта. */
  status: string;
  episodes: number;
  score: number;
  /** 0 означает «пара только сопоставлена, но стороны ещё не сверялись».
   *  Такую пару первый цикл обязан согласовать по правилам, а не считать,
   *  что изменилась одна из сторон: снимок при сопоставлении заполняется
   *  значениями ОДНОЙ стороны и реального согласия не отражает. */
  syncedAt: number;
}

type UserState = Record<string, SyncedItem>; // ключ — releaseId
type Store = Record<string, UserState>; // ключ — наш userId

const FILE = join(settings.STATE_DIR, 'shikimori-sync-state.json');
let store: Store = load();

function load(): Store {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Store;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* файла ещё нет */ }
  return {};
}

function persist(): void {
  try {
    mkdirSync(settings.STATE_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(store));
  } catch { /* в памяти состояние живёт до перезапуска */ }
}

export function getState(userId: number): UserState {
  return store[String(userId)] ?? {};
}

export function rememberItem(userId: number, item: SyncedItem): void {
  const key = String(userId);
  store[key] = store[key] ?? {};
  store[key][item.releaseId] = item;
}

export function forgetUser(userId: number): void {
  delete store[String(userId)];
  persist();
}

export function flush(): void {
  persist();
}

/** Ищем по shikiId — при обходе со стороны Shikimori releaseId ещё неизвестен. */
export function findByShikiId(userId: number, shikiId: number): SyncedItem | null {
  for (const item of Object.values(getState(userId))) {
    if (item.shikiId === shikiId) return item;
  }
  return null;
}

export function pairCount(userId: number): number {
  return Object.keys(getState(userId)).length;
}
