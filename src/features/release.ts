import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { settings } from '../config/settings.js';
import { passableHeaders, upstreamJson } from '../upstream/client.js';
import { absoluteShikiUrl, findAnime, relatedAnime, franchiseChain, type ShikiRelated } from '../services/shikimori.js';
import { bucketFor, getDiary, setDiary } from '../services/diary.js';
import { getChatId, registerSubscriber } from '../services/notify-episodes.js';
import { denylist } from '../services/blocklist.js';
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

export function registerRelease(scope: FastifyInstance): void {
  scope.get('/release/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const upstream = await upstreamJson<any>({
      path: `/release/${id}`,
      query: req.query as Record<string, unknown>,
      headers: passableHeaders(req.headers as Record<string, unknown>),
    });

    if (upstream.status !== 200 || !upstream.data) {
      reply.status(upstream.status);
      reply.header('content-type', 'application/json; charset=utf-8');
      return reply.send(upstream.body);
    }

    const data = upstream.data;
    if (settings.RELEASE_ENRICH && data.release) {
      await enrich(data.release).catch(() => {});
    }

    reply.header('content-type', 'application/json; charset=utf-8');
    return reply.send(JSON.stringify(data));
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
    return reply.send({ entry: getDiary(bucketFor(token), String(q.releaseId)) });
  });

  scope.post('/diary', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { releaseId, text, rating } = (req.body ?? {}) as Record<string, unknown>;
    if (!releaseId) return reply.code(400).send({ error: 'missing_fields' });
    setDiary(
      bucketFor(token),
      String(releaseId),
      typeof text === 'string' ? text : '',
      Number(rating) || 0,
    );
    return reply.send({ ok: true });
  });

  // ── Telegram chat id for new-episode notifications (per user) ──
  // The account id anchors the subscriber so each friend gets episodes from
  // their own watch lists; we take it from the request, falling back to the
  // token→account binding learned at sign-in.
  const userIdOf = (req: FastifyRequest, token: string): number => {
    const q = req.query as Record<string, unknown>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    return Number(q.profileId ?? b.profileId) || denylist.getOwner(token)?.id || 0;
  };

  scope.get('/notify/chat', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    return reply.send({ chatId: getChatId(userIdOf(req, token)) });
  });

  scope.post('/notify/chat', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: 'auth_required' });
    const { chatId } = (req.body ?? {}) as Record<string, unknown>;
    const clean = String(chatId ?? '').trim();
    if (!/^-?\d{3,20}$/.test(clean)) return reply.code(400).send({ ok: false, error: 'bad_chat_id' });
    registerSubscriber(userIdOf(req, token), token, clean);
    // Confirm the bot can actually reach this chat (needs a prior /start).
    const delivered = await sendTo(
      clean,
      '✅ <b>MiraiHub</b>: уведомления о новых сериях подключены.',
    );
    return reply.send({ ok: true, delivered });
  });
}
