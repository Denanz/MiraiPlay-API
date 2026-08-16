import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settings } from '../config/settings.js';
import { passableHeaders, upstreamJson } from '../upstream/client.js';
import { absoluteShikiUrl, findAnime, relatedAnime, franchiseChain, scoresForTitles, type ShikiRelated } from '../services/shikimori.js';
import { getDiary, listDiary, setDiary } from '../services/diary.js';
import { resolveBucket, resolveUserId } from '../services/identity.js';
import { getAwaitFull, getChatId, registerSubscriber, setAwaitFull } from '../services/notify-episodes.js';
import { denylist } from '../services/blocklist.js';
import {
  authorizeUrl as shikiAuthorizeUrl,
  connectWithCode as shikiConnect,
  disconnect as shikiDisconnect,
  getAuth as getShikiAuth,
  isConfigured as isShikiConfigured,
} from '../services/shikimori-auth.js';
import { fetchProfileDigest } from '../services/shikimori-sync.js';
import {
  exportShikiRates,
  getJob,
  startMigration,
  type MiraiItem,
} from '../services/shikimori-migrate.js';
import { getImportJob, startImport } from '../services/shikimori-import.js';
import { runCycle } from '../services/shikimori-cycle.js';
import { getReleaseRating } from '../services/ratings.js';
import { sendTo } from '../services/notifier.js';

/**
 * GET /release/:id — relay the upstream release card, then (best-effort) enrich
 * the note with Shikimori data, estimated watch time and related titles. Unlike
 * a plain interceptor this route is async, so it lives outside the proxy.
 */

function watchTimeNote(release: any): string | null {
  const episodes = Number(release.episodes_released);
  const duration = Number(release.duration);
  if (!episodes || !duration) return null;
  const minutes = episodes * duration;
  const hours = (minutes / 60).toFixed(1);
  return (
    `~ ${settings.BRAND_LABEL}<br>` +
    `<b>Время просмотра:</b> ~${minutes} мин / ~${hours} ч<br>` +
    `<small>Серий × длительность</small>`
  );
}

function relatedNote(related: ShikiRelated[]): string | null {
  if (related.length === 0) return null;
  const lines = related.map((a) => {
    const title = a.russian || a.name;
    const rel = a.relation ? ` (${a.relation})` : '';
    return `• <a href="${a.url}">${title}</a>${rel}`;
  });
  return `<b>Связанное аниме:</b><br>${lines.join('<br>')}`;
}

async function shikimoriNote(release: any): Promise<string | null> {
  const anime = await findAnime({
    ru: release.title_ru,
    orig: release.title_original,
    alt: release.title_alt,
  });
  if (!anime) return null;

  const lines = ['~ Shikimori'];
  if (anime.score) lines.push(`<b>Рейтинг:</b> ${anime.score}★`);

  const mains = (anime.characterRoles ?? [])
    .filter((cr) => cr.rolesEn?.includes('Main'))
    .map((cr) => {
      const name = cr.character.russian || cr.character.name;
      return `<a href="${absoluteShikiUrl(cr.character.url)}">${name}</a>`;
    });
  if (mains.length > 0) lines.push(`<b>Главные персонажи:</b> ${mains.join(', ')}`);

  const cardName = anime.russian || anime.name;
  lines.push(`<b>Карточка:</b> <a href="${absoluteShikiUrl(anime.url)}">${cardName}</a>`);
  return lines.join('<br>');
}

async function enrich(release: any): Promise<void> {
  const originalNote: string | null = release.note || null;

  // Related list — both attached as structured data and woven into the note.
  let related: ShikiRelated[] = [];
  try {
    const anime = await findAnime({
      ru: release.title_ru,
      orig: release.title_original,
      alt: release.title_alt,
    });
    if (anime) {
      related = await relatedAnime(anime.id);
      // Trailer / PV from Shikimori videos (prefer an actual PV).
      const vids = anime.videos ?? [];
      const pv = vids.find((v) => v.kind === 'pv') || vids.find((v) => v.kind === 'op') || vids[0];
      if (pv?.url) release.trailer = { url: pv.url, image: pv.imageUrl || null, name: pv.name || null };
      // Franchise watch order (chronological), when this title is part of a chain.
      const chain = await franchiseChain(anime.id);
      if (chain.length > 1) release.watch_order = chain;
    }
  } catch {
    // ignore
  }
  release.related_anime = related;

  const parts = [
    watchTimeNote(release),
    await shikimoriNote(release).catch(() => null),
    relatedNote(related),
    originalNote ? `<b>Примечание:</b><br>${originalNote}` : null,
  ].filter(Boolean);

  release.note = parts.join('<br><br>');
}

/** Списки профиля в терминах статусов Shikimori. */
const LIST_TO_STATUS: Record<number, MiraiItem['status']> = {
  1: 'watching',
  2: 'planned',
  3: 'completed',
  4: 'on_hold',
  5: 'dropped',
};

/**
 * Собирает всё, что MiraiHub знает о тайтлах пользователя: список, число
 * просмотренных серий и personal-оценку. У просмотренного число серий берём из
 * общего количества — раз тайтл закрыт, значит просмотрен целиком; у остальных
 * из последней открытой серии, если она известна.
 */
async function collectMiraiItems(token: string, bucket: string): Promise<MiraiItem[]> {
  const out: MiraiItem[] = [];
  const seen = new Set<string>();
  for (const listId of [1, 2, 3, 4, 5]) {
    for (let page = 0; page < 40; page++) {
      const res = await upstreamJson<{ content?: any[] }>({
        path: `/profile/list/all/${listId}/${page}`,
        query: { token },
      }).catch(() => null);
      const items = res?.data?.content ?? [];
      if (items.length === 0) break;
      for (const raw of items) {
        const r = raw.release ?? raw;
        const id = r?.id != null ? String(r.id) : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const total = Number(r.episodes_total) || 0;
        const lastView = Number(r.last_view_episode?.position) || 0;
        out.push({
          releaseId: id,
          titleRu: r.title_ru,
          titleOrig: r.title_original,
          titleAlt: r.title_alt,
          status: LIST_TO_STATUS[listId],
          episodes: listId === 3 ? total : lastView,
          score: getReleaseRating(bucket, id) ?? 0,
        });
      }
      if (items.length < 20) break;
    }
  }
  return out;
}

export function registerRelease(scope: FastifyInstance): void {
  scope.get('/release/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const upstream = await upstreamJson<any>({
      path: `/release/${id}`,
      query: req.query as Record<string, unknown>,
      headers: passableHeaders(req.headers as Record<string, unknown>),
    });

    if (upstream.status !== 200 || !upstream.data) {
      reply.header('content-type', 'application/json; charset=utf-8');
      // Пустое тело с заголовком application/json роняет клиента на разборе
      // JSON — а именно так отвечал upstream на нечисловой id («/release/abc»:
      // 200 и ноль байт). Отдаём осмысленный ответ вместо пустоты: при 200 без
      // данных это «не найдено» в том же формате, что уже понимает приложение
      // (upstream отвечает так на /release/-1), при ошибке — код ошибки.
      if (!upstream.body || upstream.body.length === 0) {
        if (upstream.status === 200) {
          reply.status(200);
          return reply.send(JSON.stringify({ code: 2, release: null }));
        }
        reply.status(upstream.status);
        return reply.send(JSON.stringify({ code: 1, release: null, error: 'upstream_error' }));
      }
      reply.status(upstream.status);
      return reply.send(upstream.body);
    }

    const data = upstream.data;
    if (settings.RELEASE_ENRICH && data.release) {
      await enrich(data.release).catch(() => {});
    }

    reply.header('content-type', 'application/json; charset=utf-8');
    return reply.send(JSON.stringify(data));
  });

  // Оценки Shikimori для пачки тайтлов — карточкам каталога и главной.
  // Токен не нужен: это публичные оценки, а не данные аккаунта.
  scope.post('/shikimori/scores', async (req: FastifyRequest, reply: FastifyReply) => {
    const { titles } = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(titles) || titles.length === 0) {
      return reply.send({ scores: {} });
    }
    const list = titles.filter((t): t is string => typeof t === 'string' && !!t).slice(0, 60);
    return reply.send({ scores: await scoresForTitles(list) });
  });

  // ── Personal per-anime diary (review text + score) ──
  const tokenOf = (req: FastifyRequest): string => {
    const q = req.query as Record<string, unknown>;
    if (typeof q.token === 'string') return q.token;
    const b = (req.body ?? {}) as Record<string, unknown>;
    return typeof b.token === 'string' ? b.token : '';
  };

  scope.get('/diary', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const q = req.query as Record<string, string>;
    if (!q.releaseId) return reply.code(400).send({ error: 'missing_fields' });
    return reply.send({ entry: getDiary(await resolveBucket(token), String(q.releaseId)) });
  });

  // Вся лента записей — чтобы дневник можно было перечитывать целиком, а не
  // только натыкаться на запись, открыв конкретный тайтл.
  scope.get('/diary/all', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    return reply.send({ entries: listDiary(await resolveBucket(token)) });
  });

  scope.post('/diary', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { releaseId, text, rating, title, image } = (req.body ?? {}) as Record<string, unknown>;
    if (!releaseId) return reply.code(400).send({ error: 'missing_fields' });
    setDiary(
      await resolveBucket(token),
      String(releaseId),
      typeof text === 'string' ? text : '',
      Number(rating) || 0,
      {
        title: typeof title === 'string' ? title : undefined,
        image: typeof image === 'string' ? image : undefined,
      },
    );
    return reply.send({ ok: true });
  });

  // ── Telegram chat id for new-episode notifications (per user) ──
  // The account id anchors the subscriber so each friend gets episodes from
  // their own watch lists — never a client-supplied id, which would let any
  // caller with a non-empty token string read or overwrite another account's
  // notification chat by guessing/enumerating its numeric id.
  //
  // resolveUserId переехал в services/identity.ts: тем же стабильным id теперь
  // адресуются и пользовательские данные (скриншоты, оценки, прогресс, дневник),
  // так что логика владения живёт в одном месте. Подробности про привязку
  // токена и запасной поход в /profile/info — там же.

  // ── Подключение Shikimori (OAuth «out of band») ──
  scope.get('/shikimori/status', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    if (!isShikiConfigured()) return reply.send({ configured: false, connected: false });
    const auth = getShikiAuth(await resolveUserId(token));
    return reply.send({
      configured: true,
      connected: Boolean(auth),
      nickname: auth?.shikiNickname ?? '',
      authorizeUrl: shikiAuthorizeUrl(),
    });
  });

  scope.post('/shikimori/connect', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { code } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof code !== 'string' || !code.trim()) {
      return reply.code(400).send({ error: 'missing_code' });
    }
    const res = await shikiConnect(await resolveUserId(token), code);
    // Отдаём причину наружу: без неё пользователь видит «не подошёл» и не знает,
    // получить новый код, поправить опечатку или дело вообще не в нём.
    if (!res.nickname) return reply.code(400).send({ error: 'bad_code', detail: res.error });
    return reply.send({ ok: true, nickname: res.nickname });
  });

  // Сводка профиля со стороны Shikimori — для страницы профиля.
  scope.get('/shikimori/profile', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const digest = await fetchProfileDigest(await resolveUserId(token));
    if (!digest) return reply.code(404).send({ error: 'not_connected' });
    return reply.send({ profile: digest });
  });

  // Выгрузка списка с Shikimori — бэкап перед любым переносом.
  scope.get('/shikimori/backup', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const rates = await exportShikiRates(await resolveUserId(token));
    if (!rates) return reply.code(404).send({ error: 'not_connected' });
    return reply
      .header('content-disposition', 'attachment; filename="shikimori-backup.json"')
      .send({ exportedAt: new Date().toISOString(), count: rates.length, rates });
  });

  // Перенос MiraiHub → Shikimori. dryRun проходит весь путь, включая
  // сопоставление названий, но ничего не пишет.
  scope.post('/shikimori/migrate', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const userId = await resolveUserId(token);
    if (!userId) return reply.code(401).send({ error: 'auth_required' });
    const { dryRun } = (req.body ?? {}) as Record<string, unknown>;

    const bucket = await resolveBucket(token);
    const items = await collectMiraiItems(token, bucket);
    const started = startMigration(userId, items, Boolean(dryRun));
    if (!started) return reply.code(409).send({ error: 'already_running' });
    return reply.send({ started: true, total: items.length, dryRun: Boolean(dryRun) });
  });

  // Импорт Shikimori → MiraiHub. dryRun обязателен как первый шаг: сопоставление
  // по названиям может промахнуться, и вслепую писать в списки нельзя.
  scope.post('/shikimori/import', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const userId = await resolveUserId(token);
    if (!userId) return reply.code(401).send({ error: 'auth_required' });
    const { dryRun } = (req.body ?? {}) as Record<string, unknown>;
    const bucket = await resolveBucket(token);
    const started = startImport(userId, token, bucket, Boolean(dryRun));
    if (!started) return reply.code(409).send({ error: 'already_running' });
    return reply.send({ started: true, dryRun: Boolean(dryRun) });
  });

  // Ручной запуск сверки — чтобы не ждать очередного цикла.
  scope.post('/shikimori/sync', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const userId = await resolveUserId(token);
    if (!userId) return reply.code(401).send({ error: 'auth_required' });
    const report = await runCycle(userId, token);
    if (!report) return reply.code(404).send({ error: 'not_connected' });
    return reply.send({ report });
  });

  scope.get('/shikimori/import/status', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    return reply.send({ job: getImportJob(await resolveUserId(token)) });
  });

  // Состояние фонового прогона — клиент опрашивает его, пока идёт перенос.
  scope.get('/shikimori/migrate/status', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    return reply.send({ job: getJob(await resolveUserId(token)) });
  });

  scope.post('/shikimori/disconnect', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    shikiDisconnect(await resolveUserId(token));
    return reply.send({ ok: true });
  });

  // ── «Подожду, пока выйдет целиком» ──
  scope.get('/notify/await-full', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    return reply.send({ releases: getAwaitFull(await resolveUserId(token)) });
  });

  scope.post('/notify/await-full', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { releaseId, on } = (req.body ?? {}) as Record<string, unknown>;
    if (!releaseId) return reply.code(400).send({ error: 'missing_fields' });
    const ok = setAwaitFull(await resolveUserId(token), String(releaseId), Boolean(on));
    // Без привязанного Telegram уведомлять некуда — честно говорим об этом,
    // а не делаем вид, что подписали.
    if (!ok) return reply.code(409).send({ error: 'telegram_not_linked' });
    return reply.send({ ok: true });
  });

  scope.get('/notify/chat', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    return reply.send({ chatId: getChatId(await resolveUserId(token)) });
  });

  scope.post('/notify/chat', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { chatId } = (req.body ?? {}) as Record<string, unknown>;
    const clean = String(chatId ?? '').trim();
    if (!/^-?\d{3,20}$/.test(clean)) return reply.code(400).send({ ok: false, error: 'bad_chat_id' });
    registerSubscriber(await resolveUserId(token), token, clean);
    // Confirm the bot can actually reach this chat (needs a prior /start).
    const delivered = await sendTo(
      clean,
      '✅ <b>MiraiPlay</b>: уведомления о новых сериях подключены.',
    );
    return reply.send({ ok: true, delivered });
  });
}
