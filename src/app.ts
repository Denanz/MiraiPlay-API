import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import { settings, allowedOrigins } from './config/settings.js';
import { installGuard } from './plugins/guard.js';
import { registerAuth } from './features/auth.js';
import { registerTelegram } from './features/telegram.js';
import { registerKodik } from './features/kodik.js';
import { registerMedia } from './features/media.js';
import { registerRelease } from './features/release.js';
import { registerPlayer } from './features/player.js';
import { registerTogether } from './features/together.js';
import { registerApp } from './features/app.js';
import { registerAdmin } from './features/admin.js';
import { registerFeedback } from './features/feedback.js';
import { registerAnimelib } from './features/animelib.js';
import { registerTimeline } from './features/timeline.js';
import { registerPassthrough } from './gateway/passthrough.js';

/**
 * Assemble the Fastify instance: global plugins, the health probe, and the
 * /api/v1 scope (guard + feature routes + the catch-all proxy).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: 1, // first hop is our own reverse proxy
    bodyLimit: 10 * 1024 * 1024,
    logger: { level: settings.LOG_LEVEL },
  });

  await app.register(cors, {
    credentials: true,
    origin(origin, cb) {
      if (!origin || allowedOrigins.has(origin)) cb(null, true);
      else cb(new Error('origin not allowed'), false);
    },
  });

  await app.register(formbody);
  await app.register(websocket);

  // Buffer any body we don't otherwise parse so the proxy can forward it as-is.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/health', async () => ({ status: 'ok', service: 'miraihub' }));

  await app.register(
    async (scope) => {
      installGuard(scope);
      // Dedicated routes first; find-my-way prefers them over the wildcard proxy.
      registerAuth(scope);
      registerTelegram(scope);
      registerKodik(scope);
      registerMedia(scope);
      registerRelease(scope);
      registerPlayer(scope);
      registerTogether(scope);
      registerApp(scope);
      registerAdmin(scope);
      registerFeedback(scope);
      registerAnimelib(scope);
      registerTimeline(scope);
      registerPassthrough(scope);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
