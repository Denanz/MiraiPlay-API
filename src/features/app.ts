import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';

/**
 * Канал обновлений приложения. APK ставится в обход магазина, поэтому обновиться
 * само оно не может: при запуске спрашивает эту ручку и, если объявлен versionCode
 * повыше, предлагает скачать новую сборку.
 *
 * Объявленная версия лежит в app-version.json, так что релиз — это правка файла и
 * публикация APK, без пересборки образа. Константа ниже нужна, если файла нет.
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
