import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * Ручной выбор тайтла для баннера на главной. Пока не задан, фронт сам берёт
 * что-то популярное.
 */

const FILE = join(settings.STATE_DIR, 'spotlight.json');

interface SpotlightState {
  releaseId: string | null;
}

export function getSpotlightOverride(): string | null {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8')) as SpotlightState;
    return data.releaseId || null;
  } catch {
    return null;
  }
}

export function setSpotlightOverride(releaseId: string | null): void {
  mkdirSync(settings.STATE_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ releaseId } satisfies SpotlightState));
}
