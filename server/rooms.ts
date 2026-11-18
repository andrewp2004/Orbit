// Private multiplayer rooms with an authoritative game loop.
import type { Server, Socket } from 'socket.io';
import { randomBytes } from 'node:crypto';
import { MatchSettings, PLANET_COLORS, SERVER_TICK_MS, SIM_DT, sanitizeSettings } from '../shared/constants';
import { Cosmetics, colorHex, levelForXp } from '../shared/cosmetics';
import { World } from '../shared/sim';
import {
  LobbyState, MatchEndPayload, RoomJoinAck, RosterEntry, buildFullSync, buildSnapshot,
} from '../shared/protocol';
import type { Store, UserRow } from './db';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DISCONNECT_GRACE_MS = 45_000;
const EMPTY_ROOM_TTL_MS = 120_000;

interface Member {
  memberId: string;
  userId: number;
  name: string;
  cosmetics: Cosmetics;
  isGuest: boolean;
  level: number;
  socketId: string | null;
  connected: boolean;
  disconnectedAt: number;
  rejoinToken: string;
  playerId: number; // -1 when not in the current match (spectating / waiting)
}

interface SocketData {
  user?: UserRow;
  roomCode?: string;
  memberId?: string;
  inputCount: number;
  inputWindow: number;
}

type GameSocket = Socket<any, any, any, SocketData>;

class Room {
  code: string;
  hostId = '';
  settings: MatchSettings;
  state: 'lobby' | 'playing' | 'ended' = 'lobby';
  members = new Map<string, Member>();
  world: World | null = null;
  timer: NodeJS.Timeout | null = null;
  emptySince = 0;
  lastEnd: MatchEndPayload | null = null;

  constructor(code: string, settings: MatchSettings) {
    this.code = code;
    this.settings = settings;
  }

  lobbyState(): LobbyState {
    return {
      code: this.code, hostId: this.hostId, state: this.state, settings: this.settings,
      members: [...this.members.values()].map((m) => ({
        memberId: m.memberId, name: m.name, color: colorHex(m.cosmetics), cosmetics: m.cosmetics,
        isHost: m.memberId === this.hostId, connected: m.connected, isGuest: m.isGuest, level: m.level,
      })),
    };
  }

  roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    if (!this.world) return out;
    for (const m of this.members.values()) {
      const p = m.playerId >= 0 ? this.world.getPlayer(m.playerId) : undefined;
      if (p) out.push({ id: p.id, name: p.name, color: p.color, cosmetics: p.cosmetics, memberId: m.memberId });
    }
    // Include players whose members already left so clients can still label them.
    for (const p of this.world.players) {
      if (!out.some((r) => r.id === p.id)) out.push({ id: p.id, name: p.name, color: p.color, cosmetics: p.cosmetics, memberId: '' });
    }
    return out;
  }
}

export class RoomManager {
  rooms = new Map<string, Room>();

  constructor(private io: Server, private store: Store) {
    setInterval(() => this.sweep(), 5000).unref();
  }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) players += [...r.members.values()].filter((m) => m.connected).length;
    return { rooms: this.rooms.size, players };
  }

  attach(socket: GameSocket): void {
    socket.data.inputCount = 0;
    socket.data.inputWindow = Date.now();

    socket.on('room:create', (raw: unknown, ack: (a: RoomJoinAck) => void) => {
      if (typeof ack !== 'function') return;
      const user = this.refreshUser(socket);
      if (!user) return ack({ ok: false, error: 'Not signed in.' });
      this.leaveCurrent(socket);
      const room = new Room(this.newCode(), sanitizeSettings(raw as Partial<MatchSettings>));
      this.rooms.set(room.code, room);
      const m = this.addMember(room, socket, user);
      room.hostId = m.memberId;
      ack({ ok: true, code: room.code, memberId: m.memberId, rejoinToken: m.rejoinToken, lobby: room.lobbyState() });
      this.broadcastLobby(room);
    });

    socket.on('room:join', (raw: { code?: unknown }, ack: (a: RoomJoinAck) => void) => {
      if (typeof ack !== 'function') return;
      const user = this.refreshUser(socket);
      if (!user) return ack({ ok: false, error: 'Not signed in.' });
      const code = String(raw?.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const room = this.rooms.get(code);
      if (!room) return ack({ ok: false, error: `Room ${code || '?'} not found. Check the code and try again.` });
      // Same account joining twice (e.g. a second tab) takes over the existing seat instead of duplicating it.
      const existing = [...room.members.values()].find((m) => m.userId === user.id);
      if (existing) {
        this.leaveCurrent(socket, room.code);
        this.bindSocket(room, existing, socket);
        ack({ ok: true, code: room.code, memberId: existing.memberId, rejoinToken: existing.rejoinToken, lobby: room.lobbyState() });
        this.afterRejoin(room, existing, socket);
        return;
      }
      if (room.members.size >= room.settings.maxPlayers) return ack({ ok: false, error: 'That room is full.' });
      this.leaveCurrent(socket);
      const m = this.addMember(room, socket, user);
      ack({ ok: true, code: room.code, memberId: m.memberId, rejoinToken: m.rejoinToken, lobby: room.lobbyState() });
      this.broadcastLobby(room);
      if (room.state === 'playing' && room.world) socket.emit('match:full', buildFullSync(room.world, room.roster()));
    });

    socket.on('room:rejoin', (raw: { code?: unknown; rejoinToken?: unknown }, ack: (a: RoomJoinAck) => void) => {
      if (typeof ack !== 'function') return;
      const room = this.rooms.get(String(raw?.code ?? ''));
      const m = room && [...room.members.values()].find((x) => x.rejoinToken === raw?.rejoinToken);
      if (!room || !m) return ack({ ok: false, error: 'Your seat in that room has expired.' });
      if (socket.data.user && socket.data.user.id !== m.userId) return ack({ ok: false, error: 'Seat belongs to another player.' });
      this.leaveCurrent(socket, room.code);
      this.bindSocket(room, m, socket);
      ack({ ok: true, code: room.code, memberId: m.memberId, rejoinToken: m.rejoinToken, lobby: room.lobbyState() });
      this.afterRejoin(room, m, socket);
    });

    socket.on('room:leave', () => this.leaveCurrent(socket));

    socket.on('room:settings', (raw: unknown) => {
      const ctx = this.ctx(socket);
      if (!ctx || ctx.room.hostId !== ctx.member.memberId || ctx.room.state === 'playing') return;
      const next = sanitizeSettings({ ...ctx.room.settings, ...(raw as object) });
      next.maxPlayers = Math.max(next.maxPlayers, ctx.room.members.size);
      ctx.room.settings = next;
      this.broadcastLobby(ctx.room);
    });

    socket.on('room:start', () => {
      const ctx = this.ctx(socket);
      if (!ctx || ctx.room.hostId !== ctx.member.memberId || ctx.room.state === 'playing') return;
      this.startMatch(ctx.room);
    });

    socket.on('room:lobby', () => {
      const ctx = this.ctx(socket);
      if (!ctx || ctx.room.hostId !== ctx.member.memberId || ctx.room.state !== 'ended') return;
      ctx.room.state = 'lobby';
      this.broadcastLobby(ctx.room);
    });

    socket.on('input', (raw: { mx?: number; my?: number; aim?: number; a?: boolean; r?: boolean; d?: boolean; s?: number }) => {
      const now = Date.now();
      if (now - socket.data.inputWindow > 1000) { socket.data.inputWindow = now; socket.data.inputCount = 0; }
      if (++socket.data.inputCount > 90) return; // rate limit
      const ctx = this.ctx(socket);
      if (!ctx || !ctx.room.world || ctx.member.playerId < 0 || typeof raw !== 'object' || !raw) return;
      ctx.room.world.setInput(ctx.member.playerId, { mx: raw.mx, my: raw.my, aim: raw.aim, attract: raw.a, repel: raw.r, dash: raw.d }, raw.s);
    });

    socket.on('net:ping', (ack: (t: number) => void) => typeof ack === 'function' && ack(Date.now()));

    socket.on('disconnect', () => {
      const ctx = this.ctx(socket);
      if (!ctx || ctx.member.socketId !== socket.id) return;
      ctx.member.connected = false;
      ctx.member.socketId = null;
      ctx.member.disconnectedAt = Date.now();
      const p = ctx.room.world && ctx.member.playerId >= 0 ? ctx.room.world.getPlayer(ctx.member.playerId) : undefined;
      if (p) { p.connected = false; ctx.room.world!.setInput(p.id, { mx: 0, my: 0, attract: false, repel: false }); }
      this.migrateHostIfNeeded(ctx.room);
      this.broadcastLobby(ctx.room);
    });
  }

  // ------------------------------------------------------------------ helpers

  private refreshUser(socket: GameSocket): UserRow | undefined {
    if (!socket.data.user) return undefined;
    socket.data.user = this.store.getUser(socket.data.user.id) ?? socket.data.user;
    return socket.data.user;
  }

  private ctx(socket: GameSocket): { room: Room; member: Member } | null {
    const room = socket.data.roomCode ? this.rooms.get(socket.data.roomCode) : undefined;
    const member = room && socket.data.memberId ? room.members.get(socket.data.memberId) : undefined;
    return room && member ? { room, member } : null;
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      const bytes = randomBytes(5);
      for (let i = 0; i < 5; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
      if (!this.rooms.has(code)) return code;
    }
  }

  private uniqueName(room: Room, base: string, exceptMember?: string): string {
    const taken = new Set([...room.members.values()].filter((m) => m.memberId !== exceptMember).map((m) => m.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }

  /** Friends in the same room shouldn't look identical: give duplicates the first free planet color. */
  private assignColor(room: Room, m: Member): void {
    const taken = new Set([...room.members.values()].filter((o) => o !== m).map((o) => o.cosmetics.color));
    if (!taken.has(m.cosmetics.color)) return;
    const free = PLANET_COLORS.map((_, i) => `c${i}`).find((c) => !taken.has(c));
    if (free) m.cosmetics = { ...m.cosmetics, color: free };
  }

  private addMember(room: Room, socket: GameSocket, user: UserRow): Member {
    const profile = this.store.profile(user.id)!;
    const m: Member = {
      memberId: randomBytes(6).toString('hex'),
      userId: user.id,
      name: this.uniqueName(room, profile.name),
      cosmetics: profile.cosmetics,
      isGuest: profile.isGuest,
      level: profile.level,
      socketId: null, connected: false, disconnectedAt: 0,
      rejoinToken: randomBytes(16).toString('hex'),
      playerId: -1,
    };
    room.members.set(m.memberId, m);
    this.bindSocket(room, m, socket);
    this.assignColor(room, m);
    return m;
  }

  private bindSocket(room: Room, m: Member, socket: GameSocket): void {
    if (m.socketId && m.socketId !== socket.id) {
      const old = this.io.sockets.sockets.get(m.socketId) as GameSocket | undefined;
      if (old) {
        old.emit('room:replaced');
        old.leave(room.code);
        old.data.roomCode = undefined;
        old.data.memberId = undefined;
      }
    }
    m.socketId = socket.id;
    m.connected = true;
    socket.data.roomCode = room.code;
    socket.data.memberId = m.memberId;
    socket.join(room.code);
    room.emptySince = 0;
    if (room.world && m.playerId >= 0) {
      const p = room.world.getPlayer(m.playerId);
      if (p) p.connected = true;
    }
    // Profile changes (cosmetics) apply while sitting in the lobby.
    if (room.state !== 'playing') {
      const prof = this.store.profile(m.userId);
      if (prof) { m.cosmetics = prof.cosmetics; m.level = prof.level; m.isGuest = prof.isGuest; m.name = this.uniqueName(room, prof.name, m.memberId); this.assignColor(room, m); }
    }
  }

  private afterRejoin(room: Room, m: Member, socket: GameSocket): void {
    this.migrateHostIfNeeded(room);
    this.broadcastLobby(room);
    if (room.state === 'playing' && room.world) socket.emit('match:full', buildFullSync(room.world, room.roster()));
    else if (room.state === 'ended' && room.lastEnd) socket.emit('match:end', room.lastEnd);
  }

  private leaveCurrent(socket: GameSocket, unlessCode?: string): void {
    const ctx = this.ctx(socket);
    if (!ctx || ctx.room.code === unlessCode) return;
    socket.leave(ctx.room.code);
    socket.data.roomCode = undefined;
    socket.data.memberId = undefined;
    this.removeMember(ctx.room, ctx.member);
  }

  private removeMember(room: Room, m: Member): void {
    room.members.delete(m.memberId);
    if (room.world && m.playerId >= 0) room.world.forfeit(m.playerId);
    if (room.members.size === 0) { this.closeRoom(room); return; }
    this.migrateHostIfNeeded(room);
    this.broadcastLobby(room);
  }

  private migrateHostIfNeeded(room: Room): void {
    const host = room.members.get(room.hostId);
    if (host && host.connected) return;
    const next = [...room.members.values()].find((m) => m.connected);
    if (next) room.hostId = next.memberId;
    else if (!host) room.hostId = [...room.members.keys()][0] ?? '';
  }

  private closeRoom(room: Room): void {
    if (room.timer) clearInterval(room.timer);
    this.rooms.delete(room.code);
  }

  private broadcastLobby(room: Room): void {
    this.io.to(room.code).emit('lobby', room.lobbyState());
  }

  private sweep(): void {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      for (const m of [...room.members.values()]) {
        if (!m.connected && now - m.disconnectedAt > DISCONNECT_GRACE_MS) this.removeMember(room, m);
      }
      if (!this.rooms.has(room.code)) continue;
      const anyConnected = [...room.members.values()].some((m) => m.connected);
      if (!anyConnected) {
        room.emptySince ||= now;
        if (now - room.emptySince > EMPTY_ROOM_TTL_MS) this.closeRoom(room);
      }
    }
  }

  // ------------------------------------------------------------------ match loop

  private startMatch(room: Room): void {
    const players = [...room.members.values()].filter((m) => m.connected);
    if (players.length === 0) return;
    const world = new World(room.settings);
    world.trackOrbDeltas = true;
    for (const m of room.members.values()) m.playerId = -1;
    for (const m of players) {
      m.playerId = world.addPlayer({ name: m.name, cosmetics: m.cosmetics }).id;
    }
    world.start();
    world.orbAdded = [];
    world.orbRemoved = [];
    room.world = world;
    room.state = 'playing';
    room.lastEnd = null;
    this.broadcastLobby(room);
    this.io.to(room.code).emit('match:full', buildFullSync(world, room.roster()));

    if (room.timer) clearInterval(room.timer);
    let last = performance.now();
    let acc = 0;
    room.timer = setInterval(() => {
      const now = performance.now();
      acc += Math.min(0.25, (now - last) / 1000);
      last = now;
      while (acc >= SIM_DT) { world.step(SIM_DT); acc -= SIM_DT; }
      const snap = buildSnapshot(world, world.drainEvents());
      this.io.to(room.code).emit('snap', snap);
      if (world.phase === 'ended') this.finishMatch(room);
    }, SERVER_TICK_MS);
  }

  private finishMatch(room: Room): void {
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
    const world = room.world!;
    const results = world.results();
    const xp: MatchEndPayload['xp'] = {};
    const byPlayer = new Map([...room.members.values()].filter((m) => m.playerId >= 0).map((m) => [m.playerId, m]));
    const out = results.map((r) => {
      const m = byPlayer.get(r.id);
      if (m) {
        // Results are computed by the server simulation, never reported by clients.
        const rec = this.store.recordResult(m.userId, { mode: 'online', score: r.score, kills: r.kills, won: r.won, placement: r.placement, players: results.length });
        xp[m.memberId] = { gained: rec.gained, total: rec.total, level: rec.level };
        m.level = levelForXp(rec.total);
      }
      return { ...r, memberId: m?.memberId };
    });
    room.lastEnd = { results: out, xp };
    room.state = 'ended';
    this.io.to(room.code).emit('match:end', room.lastEnd);
    this.broadcastLobby(room);
  }
}
