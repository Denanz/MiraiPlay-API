import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * Global override for the Home page hero. Unset (default) falls back to the
 * frontend's own automatic popularity-based pick — this only exists so the
 * owner can occasionally pin a specific title instead.
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
