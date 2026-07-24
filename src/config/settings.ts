import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  UPSTREAM_BASE_URL: z.string().url().default('https://api.anixart.tv'),
  // Pose as the native Android client so requests don't look like a web proxy.
  UPSTREAM_USER_AGENT: z.string().default('okhttp/4.12.0'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  GATEWAY_KEY: z.string().optional(),
  // OAuth-приложение Shikimori — для записи в список пользователя.
  // Метаданные (findAnime и прочее) читаются без них, поэтому необязательные:
  // без ключей синхронизация просто выключена, остальное работает как раньше.
  SHIKIMORI_CLIENT_ID: z.string().optional(),
  SHIKIMORI_CLIENT_SECRET: z.string().optional(),
  SHIKIMORI_REDIRECT_URI: z.string().optional(),
  PREMIUM_EXPIRES_AT: z.coerce.number().int().positive().default(4070908800),

  // Separate from GATEWAY_KEY, which ships inside the public frontend bundle
  // (not a real secret). Owner-only diagnostics stay 404 until this is set.
  ADMIN_KEY: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  STATE_DIR: z.string().default('.state'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Label used as a heading in enriched release notes.
  BRAND_LABEL: z.string().default('MiraiPlay'),

  // Release enrichment (Shikimori). Enabled unless explicitly disabled.
  RELEASE_ENRICH: z
    .string()
    .optional()
    .transform((v) => (v == null ? true : !/^(0|false|no|off)$/i.test(v))),

  // On-the-fly image resize/WebP in the /img proxy. Enabled unless disabled.
  IMG_OPTIMIZE: z
    .string()
    .optional()
    .transform((v) => (v == null ? true : !/^(0|false|no|off)$/i.test(v))),
});

export type Settings = z.infer<typeof schema>;

function load(): Settings {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast: a misconfigured edge node should never start half-broken.
    console.error('[settings] invalid environment:');
    console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
    process.exit(1);
  }
  return parsed.data;
}

export const settings = load();

/** Origin of the upstream API — used by the anti-SSRF guard. */
export const upstreamOrigin = new URL(settings.UPSTREAM_BASE_URL).origin;

/**
 * Browser origins permitted to call the gateway (CORS). Native/Capacitor apps
 * and the local dev server are included alongside the production front-ends.
 */
export const allowedOrigins = new Set<string>([
  'https://anime.denanz.fun',
  'https://watch.denanz.fun',
  'https://aniapi.denanz.fun',
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);
