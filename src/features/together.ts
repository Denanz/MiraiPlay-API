import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { settings } from '../config/settings.js';

/**
 * Watch Together — host-authoritative synchronized playback rooms over a single
 * WebSocket route (/api/v1/together). The host alone drives content/playback;
 * guests only ever receive and apply state. `hostToken` (returned on 'create',
 * presented again on 'rejoin_host') lets the host's own connection recover
 * from a network drop without losing the room — otherwise a blip on either
 * side just ends the session, which is most of what "works badly" reports
 * about this feature turned out to be. The message envelope (the `t`
 * discriminator and its fields) is the wire contract the front-end speaks.
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
  // Server clock at the moment this state was recorded — lets clients that
  // calibrated their clock offset (see the 'sync' message) work out how much
  // time has actually elapsed since, instead of applying `time` verbatim and
  // landing a fixed step behind (see the 'pb'/'sync' handling below).
  at: number;
}

interface Room {
  code: string;
  host: WebSocket | null;
  // Lets the host's own socket reconnect and reclaim the room (same code,
  // same content/queue/playback) after a network blip, rather than a dropped
  // connection permanently orphaning it — see 'rejoin_host'.
  hostToken: string;
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

function newToken(): string {
  return Array.from({ length: 24 }, () => CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]).join('');
}

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
  token?: string;
  ct?: number;
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
      // Clock calibration — independent of any room, just an echo carrying
      // both endpoints' clocks so the client can work out its offset from
      // server time and a round-trip estimate, and later correct the `time`
      // in a 'pb' broadcast for however long it's been in flight since `at`
      // (see the client for the actual compensation — this only supplies the
      // raw timing data).
      case 'sync': {
        deliver(socket, { t: 'sync', ct: msg.ct, st: Date.now() });
        return;
      }

      case 'create': {
        if (rooms.size >= MAX_ROOMS) {
          deliver(socket, { t: 'error', error: 'server_full' });
          return;
        }
        const code = newCode();
        const hostToken = newToken();
        rooms.set(code, {
          code,
          host: socket,
          hostToken,
          guests: new Set(),
          content: null,
          playback: null,
          queue: [],
          touchedAt: Date.now(),
        });
        role = 'host';
        roomCode = code;
        deliver(socket, { t: 'created', room: code, hostToken });
        break;
      }

      // Reclaims an existing room after the host's own connection drops and
      // reconnects — same code, same content/queue/playback, rather than a
      // blip permanently orphaning the room (guests would otherwise get
      // 'host_left' and the session would just be over).
      case 'rejoin_host': {
        const code = String(msg.room ?? '').toUpperCase();
        const target = rooms.get(code);
        if (!target || target.hostToken !== msg.token) {
          deliver(socket, { t: 'error', error: 'no_room' });
          return;
        }
        role = 'host';
        roomCode = code;
        target.host = socket;
        target.touchedAt = Date.now();
        deliver(socket, { t: 'created', room: code, hostToken: target.hostToken, resumed: true });
        broadcastPeers(target);
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

      // Host-only — see the file header. Guests receive and apply this but
      // never originate it; there's no separate "guest control" message.
      case 'pb': {
        if (role !== 'host' || !room) return;
        room.playback = { time: Number(msg.time) || 0, paused: Boolean(msg.paused), at: Date.now() };
        toGuests(room, { t: 'pb', time: room.playback.time, paused: room.playback.paused, at: room.playback.at });
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
