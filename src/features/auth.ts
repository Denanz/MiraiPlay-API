import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { upstreamJson } from '../upstream/client.js';
import { denylist, isLocalIp, trimIp } from '../services/blocklist.js';
import { telemetry } from '../services/monitor.js';
import { htmlEscape, notify, type TgButton } from '../services/notifier.js';
import { hubUserFromCookie, bindAnixart } from '../services/mirai-auth.js';
import { getLinkedAccount, linkAccount, unlinkAccount } from '../services/linked-accounts.js';
import { resolveUserId } from '../services/identity.js';

/**
 * Перехват входа. Логин и пароль уходят в upstream как есть, но при успехе мы
 * запоминаем сессию и шлём в Telegram карточку профиля с кнопками бана.
 */

function clientIp(req: FastifyRequest): string {
  return trimIp(req.ip) || 'unknown';
}

function whenTs(ts?: number): string {
  if (!ts || ts <= 0) return '—';
  return new Date(ts * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

async function announceLogin(
  req: FastifyRequest,
  userId: number,
  login: string,
  token: string,
): Promise<void> {
  let profile: Record<string, any> = {};
  try {
    const res = await upstreamJson<{ profile?: Record<string, any> }>({
      path: `/profile/${userId}`,
      query: { token },
    });
    profile = res.data?.profile ?? {};
  } catch {
    // Профиль подтянуть не вышло — обойдёмся одним логином.
  }

  const ip = clientIp(req);
  const agent = req.headers['user-agent'] ?? '—';

  telemetry.openSession(token, userId, login, ip);
  telemetry.recordLogin({
    at: Date.now(),
    id: userId,
    login: String(profile.login || login),
    ip,
    agent: String(agent),
  });

  const socials = ['vk_page', 'tg_page', 'inst_page', 'tt_page', 'discord_page']
    .map((k) => profile[k])
    .filter(Boolean)
    .join(', ') || '—';

  const lines = [
    '🔐 <b>Новый вход</b>',
    '',
    `👤 Логин: <b>${htmlEscape(profile.login || login)}</b>`,
    `🆔 ID: <code>${htmlEscape(profile.id ?? userId)}</code>`,
    `📊 Статус: ${htmlEscape(profile.status || '—')}`,
    `⭐ Привилегия: ${htmlEscape(profile.privilege_level)} ${profile.is_sponsor ? '(спонсор)' : ''}`,
    `🚫 Бан: ${profile.is_banned ? 'да' : 'нет'}${profile.is_perm_banned ? ' (перм)' : ''}`,
    '',
    `📺 Серий: ${htmlEscape(profile.watched_episode_count)} · время: ${htmlEscape(profile.watched_time)} мин`,
    `💬 Комментарии: ${htmlEscape(profile.comment_count)} · 👥 друзья: ${htmlEscape(profile.friend_count)}`,
    `🔗 Соцсети: ${htmlEscape(socials)}`,
    `🗓 Регистрация: ${whenTs(profile.register_date)}`,
    `🕑 Онлайн: ${whenTs(profile.last_activity_time)}`,
    '',
    `🌐 IP: <code>${htmlEscape(ip)}</code>`,
    `🖥 UA: <code>${htmlEscape(String(agent).slice(0, 160))}</code>`,
    `⏰ ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`,
  ];

  const buttons: TgButton[][] = [[{ text: '🚫 Бан аккаунта', callback_data: `ban-user:${userId}` }]];
  if (!isLocalIp(ip)) {
    buttons[0].push({ text: '🚫 Бан IP', callback_data: `ban-ip:${ip}` });
  }

  await notify(lines.join('\n'), buttons);
}

/**
 * Единый вход: связка аккаунта Mirai с сессией Anixart.
 *
 * Кука `mirai_session` выдана на весь `.denanz.fun`, поэтому долетает и до
 * API-поддомена — но только с `credentials: 'include'` на стороне фронта, так
 * как origin у него другой (см. CORS в app.ts). В APK этого не происходит:
 * приложение живёт на `capacitor://localhost`, куки домена там просто нет, и
 * вход остаётся по Anixart.
 */
function registerMiraiLink(scope: FastifyInstance): void {
  scope.get('/auth/mirai/status', async (req: FastifyRequest, reply: FastifyReply) => {
    const hubUserId = await hubUserFromCookie(req.headers.cookie);
    if (hubUserId === null) return reply.send({ available: false, linked: false });
    const linked = getLinkedAccount(hubUserId);
    return reply.send({
      available: true,
      linked: !!linked,
      login: linked?.login ?? null,
      linkedAt: linked?.linkedAt ?? null,
    });
  });

  scope.post('/auth/mirai/link', async (req: FastifyRequest, reply: FastifyReply) => {
    const hubUserId = await hubUserFromCookie(req.headers.cookie);
    if (hubUserId === null) return reply.code(401).send({ error: 'no_mirai_session' });

    const q = req.query as Record<string, unknown>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof q.token === 'string' ? q.token : typeof b.token === 'string' ? b.token : '';
    if (!token) return reply.code(400).send({ error: 'missing_token' });

    // Личность берём у upstream по самому токену, а не со слов клиента: иначе
    // привязать к своей учётке можно было бы любой присланный id.
    const userId = await resolveUserId(token);
    if (!userId) return reply.code(401).send({ error: 'invalid_token' });
    const owner = denylist.getOwner(token);

    linkAccount(hubUserId, { token, userId, login: owner?.login ?? String(userId) });
    await bindAnixart(hubUserId, userId);
    return reply.send({ ok: true, login: owner?.login ?? String(userId) });
  });

  scope.post('/auth/mirai/unlink', async (req: FastifyRequest, reply: FastifyReply) => {
    const hubUserId = await hubUserFromCookie(req.headers.cookie);
    if (hubUserId === null) return reply.code(401).send({ error: 'no_mirai_session' });
    unlinkAccount(hubUserId);
    return reply.send({ ok: true });
  });

  // Автовход: отдаёт сохранённую сессию Anixart предъявителю куки Mirai.
  scope.get('/auth/mirai/session', async (req: FastifyRequest, reply: FastifyReply) => {
    const hubUserId = await hubUserFromCookie(req.headers.cookie);
    if (hubUserId === null) return reply.code(401).send({ error: 'no_mirai_session' });
    const linked = getLinkedAccount(hubUserId);
    if (!linked) return reply.code(404).send({ error: 'not_linked' });

    // Токен Anixart живёт долго, но не вечно. Протухший лучше убрать сразу,
    // чем отдать фронту сессию, которая молча не работает.
    const stillValid = await resolveUserId(linked.token);
    if (!stillValid) {
      unlinkAccount(hubUserId);
      return reply.code(410).send({ error: 'token_expired' });
    }

    if (denylist.accountBlocked(linked.userId, linked.login)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.send({ token: linked.token, userId: linked.userId, login: linked.login });
  });
}

/**
 * Вход на телевизоре по коду (как у YouTube на ТВ): вводить логин и пароль
 * пультом мучительно. ТВ заводит заявку и показывает короткий код, телефон,
 * где пользователь уже вошёл, подтверждает его своим токеном, ТВ забирает
 * сессию опросом по секрету, который знает только он.
 *
 * Подобрать чужой код бессмысленно: подтверждение отдаёт на ТВ сессию того,
 * кто подтверждает, а не наоборот. Заявки живут в памяти 10 минут.
 */
const TV_PAIR_TTL_MS = 10 * 60_000;
const TV_PAIR_MAX = 2000;

interface TvPairing {
  code: string;
  expiresAt: number;
  session: { token: string; userId: number; login: string } | null;
}

const tvPairings = new Map<string, TvPairing>(); // secret → заявка

function sweepTvPairings(): void {
  const now = Date.now();
  for (const [secret, p] of tvPairings) if (p.expiresAt <= now) tvPairings.delete(secret);
}

function findTvPairingByCode(code: string): TvPairing | undefined {
  const now = Date.now();
  for (const p of tvPairings.values()) if (p.code === code && p.expiresAt > now) return p;
  return undefined;
}

function registerTvPairing(scope: FastifyInstance): void {
  scope.post('/auth/tv/start', async (_req: FastifyRequest, reply: FastifyReply) => {
    sweepTvPairings();
    if (tvPairings.size >= TV_PAIR_MAX) return reply.code(503).send({ error: 'busy' });

    let code = '';
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    while (findTvPairingByCode(code));
    const secret = randomBytes(24).toString('hex');
    tvPairings.set(secret, { code, expiresAt: Date.now() + TV_PAIR_TTL_MS, session: null });
    return reply.send({ code, secret, expiresIn: TV_PAIR_TTL_MS / 1000 });
  });

  scope.get('/auth/tv/poll', async (req: FastifyRequest, reply: FastifyReply) => {
    const secret = String((req.query as Record<string, unknown>).secret ?? '');
    const p = tvPairings.get(secret);
    if (!p || p.expiresAt <= Date.now()) {
      tvPairings.delete(secret);
      return reply.send({ status: 'expired' });
    }
    if (!p.session) return reply.send({ status: 'pending' });
    tvPairings.delete(secret); // сессия выдаётся один раз
    return reply.send({ status: 'ok', ...p.session });
  });

  scope.post('/auth/tv/approve', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, unknown>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof q.token === 'string' ? q.token : typeof b.token === 'string' ? b.token : '';
    const code = String(b.code ?? '').replace(/\D/g, '');
    if (!token) return reply.code(401).send({ error: 'missing_token' });
    if (code.length !== 6) return reply.code(400).send({ error: 'bad_code' });

    const p = findTvPairingByCode(code);
    if (!p || p.session) return reply.code(404).send({ error: 'no_such_code' });

    // Как и при привязке Mirai: личность — по самому токену у upstream.
    const userId = await resolveUserId(token);
    if (!userId) return reply.code(401).send({ error: 'invalid_token' });
    const login = denylist.getOwner(token)?.login ?? String(userId);
    if (denylist.accountBlocked(userId, login)) return reply.code(403).send({ error: 'forbidden' });

    p.session = { token, userId, login };
    return reply.send({ ok: true });
  });
}

export function registerAuth(scope: FastifyInstance): void {
  registerMiraiLink(scope);
  registerTvPairing(scope);

  scope.post('/auth/signIn', async (req: FastifyRequest, reply: FastifyReply) => {
    const { login, password } = (req.body ?? {}) as { login?: unknown; password?: unknown };
    if (!login || !password) {
      return reply.code(400).send({ error: 'missing_credentials' });
    }

    const form = new URLSearchParams({ login: String(login), password: String(password) });

    let upstream;
    try {
      upstream = await upstreamJson<any>({
        method: 'POST',
        path: '/auth/signIn',
        body: form.toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    } catch {
      return reply.code(502).send({ error: 'auth_upstream_failed' });
    }

    const data = upstream.data;
    const token: string | undefined = data?.profileToken?.token;
    const profile = data?.profile;

    if (data?.code === 0 && token && profile) {
      const userId = Number(profile.id);
      const userLogin = String(profile.login || login);

      if (denylist.accountBlocked(userId, userLogin) || denylist.ipBlocked(clientIp(req))) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      denylist.bindToken(token, userId, userLogin);
      void announceLogin(req, userId, userLogin, token).catch(() => {});
    }

    reply.status(upstream.status);
    reply.header('content-type', 'application/json; charset=utf-8');
    return reply.send(upstream.body);
  });
}
