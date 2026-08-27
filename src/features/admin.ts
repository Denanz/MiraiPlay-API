import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readdirSync, statSync, existsSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';
import { getSpotlightOverride, setSpotlightOverride } from '../services/spotlight.js';
import { telemetry } from '../services/monitor.js';
import { denylist } from '../services/blocklist.js';

/**
 * Диагностика для владельца, за отдельным ADMIN_KEY. GATEWAY_KEY для этого не
 * годится: он лежит в публичном бандле фронта и секретом не является. Без
 * заданного ADMIN_KEY всё отвечает 404, а не 403 — чтобы не выдавать сам факт.
 */

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!settings.ADMIN_KEY) {
    reply.code(404).send({ error: 'not_found' });
    return false;
  }
  if (req.headers['x-admin-key'] !== settings.ADMIN_KEY) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  return true;
}

function dirSize(path: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else {
      try {
        total += statSync(full).size;
      } catch {
        // Файл исчез по ходу обхода — пропускаем.
      }
    }
  }
  return total;
}

function bucketCount(path: string): number {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

export function registerAdmin(scope: FastifyInstance): void {
  scope.get('/admin/storage', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply)) return;

    const root = settings.STATE_DIR;
    const screenshots = dirSize(join(root, 'screenshots'));
    const progress = dirSize(join(root, 'progress'));
    const ratings = dirSize(join(root, 'ratings'));
    const diary = dirSize(join(root, 'diary'));
    const cache = dirSize(join(root, 'cache'));
    const total = dirSize(root);
    const other = Math.max(0, total - (screenshots + progress + ratings + diary + cache));

    return reply.send({
      breakdown: {
        screenshots: { bytes: screenshots, buckets: bucketCount(join(root, 'screenshots')) },
        progress: { bytes: progress },
        ratings: { bytes: ratings },
        diary: { bytes: diary },
        cache: { bytes: cache },
        other: { bytes: other },
      },
      totalBytes: total,
    });
  });

  // Намеренно без админского ключа: главная читает это при каждом заходе.
  // Только чтение, ничего чувствительного.
  scope.get('/spotlight', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ releaseId: getSpotlightOverride() });
  });

  scope.post('/admin/spotlight', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply)) return;
    const { releaseId } = (req.body ?? {}) as Record<string, unknown>;
    setSpotlightOverride(releaseId != null ? String(releaseId) : null);
    return reply.send({ ok: true, releaseId: getSpotlightOverride() });
  });

  // Те же данные, что у команд бота /stats и /logins, только с веб-лицом.
  scope.get('/admin/telemetry', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply)) return;
    return reply.send({
      overview: telemetry.overview(),
      recentLogins: telemetry.recentLogins(15),
      denylist: denylist.snapshot(),
    });
  });

  // Тот же бан, что и командами бота, поверх того же списка.
  scope.post('/admin/denylist/ip', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply)) return;
    const { ip, action } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof ip !== 'string' || !ip) return reply.code(400).send({ error: 'missing_ip' });
    if (action === 'unban') {
      denylist.unbanIp(ip);
      return reply.send({ ok: true });
    }
    const ok = denylist.banIp(ip);
    if (!ok) return reply.code(400).send({ error: 'refused', reason: 'local/private IP' });
    return reply.send({ ok: true });
  });

  // Приватный APK хаба (fun.denanz.hub) — нигде публично не раздаётся,
  // единственный путь скачать его — эта кнопка в админке за ADMIN_KEY.
  scope.get('/admin/hub-apk', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply)) return;
    const path = join(settings.STATE_DIR, 'hub.apk');
    if (!existsSync(path)) return reply.code(404).send({ error: 'not_found' });
    reply.header('Content-Type', 'application/vnd.android.package-archive');
    reply.header('Content-Disposition', 'attachment; filename="mirai-hub.apk"');
    return reply.send(createReadStream(path));
  });

  scope.post('/admin/denylist/user', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply)) return;
    const { value, action } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof value !== 'string' || !value) return reply.code(400).send({ error: 'missing_value' });
    // Почему бьём по обоим полям при числовом аргументе — см. telegram.ts.
    const numericId = /^\d+$/.test(value) ? Number(value) : undefined;
    if (action === 'unban') {
      denylist.unbanAccount(numericId, value);
    } else {
      denylist.banAccount(numericId, value);
    }
    return reply.send({ ok: true });
  });
}
