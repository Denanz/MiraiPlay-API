import { createHmac } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from '../config/settings.js';
import { denylist } from './blocklist.js';
import { upstreamJson } from '../upstream/client.js';

/**
 * Кому принадлежат данные пользователя (скриншоты, оценки, прогресс, дневник).
 *
 * Исторически bucket считался как HMAC(токен). Токен — не личность: у одного
 * человека их столько, сколько устройств и перелогинов, и каждый новый токен
 * заводил ПУСТОЙ профиль, а прежние данные оставались осиротевшими. На проде это
 * дало 5 папок прогресса и 3 оценок на трёх реальных пользователей.
 *
 * Теперь bucket считается от стабильного id аккаунта. Чтобы никто не потерял
 * накопленное, при первом обращении старая папка переезжает на новый адрес
 * (см. migrateLegacy) — миграция ленивая и самолечащаяся, отдельного прогона не
 * требует. Пользователь, чей токен ещё жив, просто заходит и видит свои данные.
 */

const secret = (): string => settings.GATEWAY_KEY || 'miraihub';

/** Прежняя схема: адрес от токена. Нужна, чтобы найти данные для переезда. */
export function bucketForToken(token: string): string {
  return createHmac('sha256', secret()).update(token).digest('hex').slice(0, 32);
}

/** Новая схема: адрес от аккаунта. Префикс "user:" разводит пространства имён,
 *  чтобы id никогда случайно не совпал с хэшем токена. */
export function bucketForUser(userId: number): string {
  return createHmac('sha256', secret()).update(`user:${userId}`).digest('hex').slice(0, 32);
}

/**
 * Стабильный id владельца токена.
 *
 * denylist.getOwner заполняется только в момент /auth/signIn через этот шлюз.
 * Кто входил раньше (или просто не перезаходил — токены Anixart долгоживущие),
 * там не значится, поэтому одного этого мало. Запасной путь — спросить upstream
 * «чей это токен» тем же вызовом /profile/info, которым приложение грузит свой
 * профиль: подделать ответ клиент не может, upstream отвечает только про
 * предъявленный токен. Удачный ответ сразу закрепляем через bindToken, чтобы
 * следующие запросы обошлись без лишнего похода наружу.
 */
export async function resolveUserId(token: string): Promise<number> {
  const known = denylist.getOwner(token);
  if (known) return known.id;
  try {
    const res = await upstreamJson<{ id?: number; login?: string }>({
      path: '/profile/info',
      query: { token },
    });
    const id = Number(res.data?.id) || 0;
    const login = res.data?.login;
    if (res.status === 200 && id && login) {
      denylist.bindToken(token, id, login);
      return id;
    }
  } catch {
    // Upstream недоступен — считаем владельца неизвестным.
  }
  return 0;
}

/** Хранилища, адресуемые bucket'ом. Скриншоты — каталог, остальное — файл. */
const STORES: Array<{ dir: string; suffix: string }> = [
  { dir: 'screenshots', suffix: '' },
  { dir: 'ratings', suffix: '.json' },
  { dir: 'progress', suffix: '.json' },
  { dir: 'diary', suffix: '.json' },
];

/**
 * Переносит данные со старого адреса (по токену) на новый (по аккаунту).
 *
 * Намеренно НЕ трогает хранилище, если новый адрес уже занят: это значит, что
 * данные аккаунта уже на месте, и переезд затёр бы их содержимым одного
 * конкретного устройства. Такие остатки сливаются отдельным разовым скриптом,
 * где видно, что с чем объединяется.
 */
function migrateLegacy(legacy: string, next: string): void {
  if (legacy === next) return;
  for (const { dir, suffix } of STORES) {
    const from = join(settings.STATE_DIR, dir, legacy + suffix);
    const to = join(settings.STATE_DIR, dir, next + suffix);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      renameSync(from, to);
    } catch {
      // Переезд — не критичный путь: не вышло, значит данные останутся на
      // старом адресе и попробуем в следующий раз. Ронять запрос нельзя.
    }
  }
}

/**
 * Адрес данных для этого токена. Если владелец опознан — адрес аккаунта (с
 * ленивым переездом старых данных). Если нет (upstream лежит, токен протух) —
 * откат на прежнюю схему, чтобы запрос отработал как раньше, а не упал.
 */
export async function resolveBucket(token: string): Promise<string> {
  const legacy = bucketForToken(token);
  const id = await resolveUserId(token);
  if (!id) return legacy;
  const next = bucketForUser(id);
  migrateLegacy(legacy, next);
  return next;
}
