import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * App update channel. The Android build is sideloaded (offline-bundled frontend),
 * so it can't auto-update from a store — instead it polls this endpoint on launch
 * and, if a newer versionCode is advertised, prompts the user to grab the new APK.
 *
 * The advertised version lives in an editable file at STATE_DIR/app-version.json,
 * so a release only needs that file bumped + the new APK published — no rebuild of
 * this image. The constant below is the fallback when the file is absent.
 */

export interface AppVersion {
  versionCode: number; // monotonic; compared against the installed build
  versionName: string; // human label, e.g. "1.1"
  url: string; // where to download the APK
  notes: string; // short changelog shown in the prompt
  mandatory: boolean; // if true, the prompt can't be dismissed
}

const FALLBACK: AppVersion = {
  versionCode: 2,
  versionName: '1.1',
  url: 'https://anime.denanz.fun/mirai.apk',
  notes: 'Новая 10-балльная оценка, фикс кнопки «Назад» и переходов по закладкам.',
  mandatory: false,
};

const FILE = join(settings.STATE_DIR, 'app-version.json');

function currentVersion(): AppVersion {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<AppVersion>;
    return { ...FALLBACK, ...parsed };
  } catch {
    return FALLBACK;
  }
}

export function registerApp(scope: FastifyInstance): void {
  scope.get('/app/version', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send(currentVersion());
  });
}
