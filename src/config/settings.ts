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
  // Прикидываемся нативным Android-клиентом, чтобы запросы не выглядели прокси.
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

  // Отдельно от GATEWAY_KEY: тот лежит в публичном бандле и секретом не является.
  // Пока не задан, вся диагностика отвечает 404.
  ADMIN_KEY: z.string().optional(),

  // Ключ read-only хроники просмотров (X-Timeline-Key), которую опрашивает
  // MiraiTimeline. Если не задан, роут принимает GATEWAY_KEY; если не задано
  // ни то, ни другое — роута нет (404).
  TIMELINE_KEY: z.string().optional(),
  // Хроника теперь пишется всем и метится Anixart-id, а отдаётся строго по
  // запрошенному пользователю — фильтр «только владелец» больше не нужен.

  // Адрес и ключ mirai-auth: по ним шлюз узнаёт, кто вошёл в MiraiHub, и
  // связывает его учётку с аккаунтом Anixart.
  AUTH_BASE_URL: z.string().default('http://mirai-hub:8000'),
  SERVICE_KEY: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  STATE_DIR: z.string().default('.state'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Заголовок в дополненных примечаниях к релизу.
  BRAND_LABEL: z.string().default('MiraiPlay'),

  // Обогащение карточек через Shikimori. Включено, пока явно не выключат.
  RELEASE_ENRICH: z
    .string()
    .optional()
    .transform((v) => (v == null ? true : !/^(0|false|no|off)$/i.test(v))),

  // Ресайз и WebP на лету в прокси /img. Включено, пока явно не выключат.
  IMG_OPTIMIZE: z
    .string()
    .optional()
    .transform((v) => (v == null ? true : !/^(0|false|no|off)$/i.test(v))),
});

export type Settings = z.infer<typeof schema>;

function load(): Settings {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Падаем сразу: узел с кривой конфигурацией не должен подниматься наполовину.
    console.error('[settings] invalid environment:');
    console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
    process.exit(1);
  }
  return parsed.data;
}

export const settings = load();

/** Origin upstream API — по нему сверяется защита от SSRF. */
export const upstreamOrigin = new URL(settings.UPSTREAM_BASE_URL).origin;

/**
 * Какие origin пускаем в шлюз через CORS. Кроме боевых фронтов сюда входят
 * приложение на Capacitor и локальный dev-сервер.
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
  // Упакованное Tizen-приложение (телевизоры Samsung) открывается с file://,
  // и Chromium шлёт такой origin как «file://» или «null».
  'file://',
  'null',
]);
