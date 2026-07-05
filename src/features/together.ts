import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { settings } from '../config/settings.js';

/**
 * Watch Together — host-authoritative synchronized playback rooms over a single
 * WebSocket route (/api/v1/together). The host drives content/playback; guests
 * receive state and soft-sync. The message envelope (the `t` discriminator and
 * its fields) is the wire contract the front-end speaks.
 */

interface Content {
  releaseId: string;
  sourceId: number;
  position: number;
  episodeName: string;
  releaseName?: string;
  dubberName?: string;
  sourceName?: string;
  totalEpisodes?: number;
  kodikUrl?: string;
}

interface Playback {
  time: number;
  paused: boolean;
}

interface Room {
  code: string;
  host: WebSocket | null;
  guests: Set<WebSocket>;
  content: Content | null;
  playback: Playback | null;
  queue: Content[];
  touchedAt: number;
}

const MAX_ROOMS = 500;
const MAX_GUESTS = 30;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map<string, Room>();

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const empty = !room.host && room.guests.size === 0;
    if (empty || now - room.touchedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60_000).unref();

function newCode(): string {
  let code: string;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]).join('');
  } while (rooms.has(code));
  return code;
}

function deliver(socket: WebSocket | null, message: unknown): void {
  if (socket && socket.readyState === 1) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Drop on a broken pipe; the close handler does the cleanup.
    }
  }
}

function toGuests(room: Room, message: unknown): void {
  for (const guest of room.guests) deliver(guest, message);
}

function peerCount(room: Room): number {
  return (room.host ? 1 : 0) + room.guests.size;
}

function broadcastPeers(room: Room): void {
  const message = { t: 'peers', count: peerCount(room) };
  deliver(room.host, message);
  toGuests(room, message);
}

interface Inbound {
  t?: string;
  room?: string;
  content?: Content;
  queue?: Content[];
  time?: number;
  paused?: boolean;
}

function onConnection(socket: WebSocket): void {
  let role: 'host' | 'guest' | null = null;
  let roomCode: string | null = null;
  let alive = true;

  socket.on('pong', () => {
    alive = true;
  });

  socket.on('message', (raw: Buffer) => {
    let msg: Inbound;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const room = roomCode ? rooms.get(roomCode) ?? null : null;
    if (room) room.touchedAt = Date.now();

    switch (msg.t) {
      case 'create': {
        if (rooms.size >= MAX_ROOMS) {
          deliver(socket, { t: 'error', error: 'server_full' });
          return;
        }
        const code = newCode();
        rooms.set(code, {
          code,
          host: socket,
          guests: new Set(),
          content: null,
          playback: null,
          queue: [],
          touchedAt: Date.now(),
        });
        role = 'host';
        roomCode = code;
        deliver(socket, { t: 'created', room: code });
        break;
      }

      case 'join': {
        const code = String(msg.room ?? '').toUpperCase();
        const target = rooms.get(code);
        if (!target) {
          deliver(socket, { t: 'error', error: 'no_room' });
          return;
        }
        if (target.guests.size >= MAX_GUESTS) {
          deliver(socket, { t: 'error', error: 'room_full' });
          return;
        }
        role = 'guest';
        roomCode = code;
        target.guests.add(socket);
        target.touchedAt = Date.now();
        deliver(socket, {
          t: 'joined',
          room: code,
          content: target.content,
          pb: target.playback,
          queue: target.queue,
          host: Boolean(target.host),
        });
        broadcastPeers(target);
        break;
      }

      case 'content': {
        if (role !== 'host' || !room || !msg.content) return;
        room.content = msg.content;
        room.playback = null; // new episode resets the playback baseline
        toGuests(room, { t: 'content', content: room.content });
        break;
      }

      case 'pb': {
        if (role !== 'host' || !room) return;
        room.playback = { time: Number(msg.time) || 0, paused: Boolean(msg.paused) };
        toGuests(room, { t: 'pb', time: room.playback.time, paused: room.playback.paused });
        break;
      }

      case 'control': {
        // Any participant may pause/resume for everyone.
        if (!room) return;
        room.playback = { time: Number(msg.time) || 0, paused: Boolean(msg.paused) };
        const message = { t: 'pb', time: room.playback.time, paused: room.playback.paused };
        deliver(room.host, message);
        toGuests(room, message);
        break;
      }

      case 'queue': {
        if (role !== 'host' || !room || !Array.isArray(msg.queue)) return;
        room.queue = msg.queue.slice(0, 50);
        toGuests(room, { t: 'queue', queue: room.queue });
        break;
      }
    }
  });

  socket.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    if (role === 'host') {
      room.host = null;
      toGuests(room, { t: 'host_left' });
    } else {
      room.guests.delete(socket);
    }
    room.touchedAt = Date.now();
    if (!room.host && room.guests.size === 0) rooms.delete(roomCode);
    else broadcastPeers(room);
  });

  // Per-socket liveness probe.
  const ping = setInterval(() => {
    if (!alive) {
      clearInterval(ping);
      socket.terminate();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      clearInterval(ping);
    }
  }, 30_000);
  socket.on('close', () => clearInterval(ping));
}

export function registerTogether(scope: FastifyInstance): void {
  scope.get(
    '/together',
    { websocket: true },
    (socket: WebSocket, req: FastifyRequest) => {
      // Same gateway lock as the HTTP side, passed as a query param since a
      // WebSocket handshake can't carry custom headers.
      if (settings.GATEWAY_KEY && (req.query as Record<string, unknown>).key !== settings.GATEWAY_KEY) {
        socket.close(1008, 'forbidden');
        return;
      }
      onConnection(socket);
    },
  );
}
