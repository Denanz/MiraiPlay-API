import { settings } from '../config/settings.js';

/**
 * Мост к mirai-auth: кто вошёл в MiraiHub и связка с аккаунтом Anixart.
 *
 * Ключевое наблюдение: cookie `mirai_session` выдана на весь `.denanz.fun`, а
 * страница плеера живёт на поддомене того же домена — значит в одном и том же
 * запросе к шлюзу присутствуют СРАЗУ обе личности: сессия хаба в cookie и
 * токен Anixart в параметрах. Связать их можно прямо здесь, без кодов
 * подтверждения и ручного ввода идентификаторов.
 *
 * Подпись cookie не разбираем сами — спрашиваем auth: там уже есть ручка
 * проверки, и второй реализации криптографии на другом языке лучше не
 * заводить.
 */

const TIMEOUT_MS = 5000;

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fn(ctrl.signal);
  } catch {
    // Auth недоступен — просто не связываем. Просмотр от этого страдать не должен.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** id пользователя MiraiHub по его cookie — или null, если сессии нет. */
export async function hubUserFromCookie(cookieHeader: string | undefined): Promise<number | null> {
  if (!cookieHeader || !cookieHeader.includes('mirai_session=')) return null;

  return withTimeout(async (signal) => {
    const res = await fetch(`${settings.AUTH_BASE_URL}/api/auth/verify`, {
      headers: { cookie: cookieHeader },
      signal,
    });
    if (!res.ok) return null;
    const raw = res.headers.get('x-mirai-user-id');
    if (!raw || raw === 'service') return null;
    const id = Number(raw);
    return Number.isFinite(id) ? id : null;
  });
}

/** Привязать аккаунт Anixart к учётной записи хаба (идемпотентно). */
export async function bindAnixart(hubUserId: number, anixartUserId: number): Promise<void> {
  if (!settings.SERVICE_KEY) return;
  await withTimeout(async (signal) => {
    await fetch(`${settings.AUTH_BASE_URL}/api/internal/anixart/bind`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-key': settings.SERVICE_KEY as string,
      },
      body: JSON.stringify({ user_id: hubUserId, anixart_user_id: anixartUserId }),
      signal,
    });
    return null;
  });
}
