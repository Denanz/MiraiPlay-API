import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readdirSync, statSync, existsSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';
import { getSpotlightOverride, setSpotlightOverride } from '../services/spotlight.js';
import { telemetry } from '../services/monitor.js';
import { denylist } from '../services/blocklist.js';

/**
 * Owner-only diagnostics. Gated behind ADMIN_KEY — a separate secret from
 * GATEWAY_KEY (which ships inside the public frontend bundle and therefore
 * isn't actually secret). The whole surface 404s, not 403s, when ADMIN_KEY
 * is unset, so its existence isn't discoverable on a server that hasn't
 * opted in.
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
        // File removed mid-scan — skip it.
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

  // Intentionally NOT admin-gated — the Home page hero reads this on every
  // visit to know whether to skip its own popularity pick. Read-only, no
  // sensitive data, same trust level as any other public catalog data.
  scope.get('/spotlight', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ releaseId: getSpotlightOverride() });
  });

  scope.post('/admin/spotlight', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply)) return;
    const { releaseId } = (req.body ?? {}) as Record<string, unknown>;
    setSpotlightOverride(releaseId != null ? String(releaseId) : null);
    return reply.send({ ok: true, releaseId: getSpotlightOverride() });
  });

  // Same data already surfaced by the Telegram /stats and /logins commands —
  // this just gives it a web face for when a phone isn't handy.
  scope.get('/admin/telemetry', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply)) return;
    return reply.send({
      overview: telemetry.overview(),
      recentLogins: telemetry.recentLogins(15),
      denylist: denylist.snapshot(),
    });
  });

  // Same ban/unban the Telegram /ban_ip /ban_user commands already do — a
  // web face for the same denylist.
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
    // See telegram.ts handleCommand for why: an all-digits value could be an
    // account id or a numeric login, so target both fields instead of guessing.
    const numericId = /^\d+$/.test(value) ? Number(value) : undefined;
    if (action === 'unban') {
      denylist.unbanAccount(numericId, value);
    } else {
      denylist.banAccount(numericId, value);
    }
    return reply.send({ ok: true });
  });
}
