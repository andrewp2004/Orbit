// A Session produces a RenderState every frame. LocalSession runs the simulation in the browser (solo, works
// offline). NetSession mirrors the authoritative server: snapshot interpolation for everything, plus client-side
// prediction with server reconciliation for your own planet so controls feel instant.
import type { Socket } from 'socket.io-client';
import { DEFAULT_SETTINGS, Difficulty, MatchSettings, SIM_DT, PLANET_COLORS, radiusForMass, START_MASS } from '../../../shared/constants';
import { CATALOG, Cosmetics, colorHex } from '../../../shared/cosmetics';
import { World, GameEvent, MatchResult, PlayerInput, Phase, SpaceEventKind, BlackHole, integrateMovement, applyBlackHoles, dashImpulse } from '../../../shared/sim';
import { addBots } from '../../../shared/ai';
import { F_ALIVE, F_CONNECTED, F_DASHING, F_PROTECTED, FullSync, MatchEndPayload, Snapshot, OrbTuple } from '../../../shared/protocol';

export interface RPlayer {
  id: number;
  name: string;
  color: string;
  cosmetics: Cosmetics;
  x: number; y: number; vx: number; vy: number;
  mass: number;
  energy: number;
  ability: number;
  alive: boolean;
  dashing: boolean;
  protected: boolean;
  connected: boolean;
  score: number;
  kills: number;
  dashCd: number;
  aim: number;
}

export interface ROrb { id: number; x: number; y: number; value: number; kind: number }
export interface RHole { id: number; x: number; y: number; r: number; range: number; growth: number; giant: boolean }

export interface RenderState {
  time: number;
  phase: Phase;
  countdown: number;
  zone: number;
  arena: number;
  duration: number;
  players: RPlayer[];
  orbs: Iterable<ROrb>;
  holes: RHole[];
  myId: number;
  spaceEvent: SpaceEventKind | null;
  surge: boolean;
}

export interface EndInfo {
  results: (MatchResult & { memberId?: string })[];
  xp?: { gained: number; total: number; level: number };
}

export interface Session {
  kind: 'solo' | 'online';
  update(dt: number, input: PlayerInput): void;
  state(): RenderState;
  drainEvents(): GameEvent[];
  ended(): EndInfo | null;
  destroy(): void;
}

// --------------------------------------------------------------------------- solo

export class LocalSession implements Session {
  kind = 'solo' as const;
  world: World;
  me: number;
  private acc = 0;
  private events: GameEvent[] = [];
  readonly difficulty: Difficulty;

  constructor(name: string, cosmetics: Cosmetics, difficulty: Difficulty, settings: Partial<MatchSettings> = {}) {
    this.difficulty = difficulty;
    this.world = new World({ ...DEFAULT_SETTINGS, durationSec: 300, ...settings });
    this.me = this.world.addPlayer({ name, cosmetics }).id;
    addBots(this.world, 10, difficulty);
    this.world.start();
  }

  update(dt: number, input: PlayerInput): void {
    this.world.setInput(this.me, input);
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= SIM_DT) {
      this.world.step(SIM_DT);
      this.acc -= SIM_DT;
      this.events.push(...this.world.drainEvents());
      // dash requests are edge-triggered: only the first substep should see it
      this.world.setInput(this.me, { ...input, dash: false });
    }
  }

  state(): RenderState {
    const w = this.world;
    return {
      time: w.time, phase: w.phase, countdown: w.countdown, zone: w.zoneRadius, arena: w.arenaRadius, duration: w.settings.durationSec,
      players: w.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, cosmetics: p.cosmetics, x: p.x, y: p.y, vx: p.vx, vy: p.vy, mass: p.mass,
        energy: p.energy, ability: p.ability, alive: p.alive, dashing: p.dashTime > 0, protected: p.protect > 0, connected: true,
        score: p.score, kills: p.kills, dashCd: Math.max(0, p.dashCd), aim: p.input.aim,
      })),
      orbs: w.orbs.values(),
      holes: w.blackHoles.map((b) => ({ id: b.id, x: b.x, y: b.y, r: b.r, range: b.range, growth: b.growth, giant: b.giant })),
      myId: this.me,
      spaceEvent: w.activeEvent?.kind ?? null,
      surge: w.surgeTime > 0,
    };
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  ended(): EndInfo | null {
    return this.world.phase === 'ended' ? { results: this.world.results() } : null;
  }

  destroy(): void {}
}

// --------------------------------------------------------------------------- online

interface SnapFrame {
  t: number;
  players: Map<number, number[]>;
  holes: Map<number, number[]>;
}

interface Roster { name: string; color: string; cosmetics: Cosmetics; memberId: string }

const INTERP_DELAY = 0.1; // seconds behind the newest snapshot
const SEND_INTERVAL = 1 / 30;

export class NetSession implements Session {
  kind = 'online' as const;
  myId = -1;
  private roster = new Map<number, Roster>();
  private frames: SnapFrame[] = [];
  private orbs = new Map<number, ROrb & { tx: number; ty: number }>();
  private latest!: Snapshot;
  private clockOffset: number | null = null; // serverTime - localTime
  private events: GameEvent[] = [];
  private endInfo: EndInfo | null = null;
  private duration = 300;
  private sendTimer = 0;
  private seq = 0;
  private lastSent: PlayerInput | null = null;
  private pendingDash = false;
  private history: { seq: number; dt: number; input: PlayerInput }[] = [];
  private pred: { x: number; y: number; vx: number; vy: number; mass: number; alive: boolean; dashCd: number } | null = null;
  private visualOffset = { x: 0, y: 0 };
  private latestHoles: BlackHole[] = [];
  private handlers: [string, (...a: never[]) => void][] = [];

  constructor(private socket: Socket, full: FullSync, private memberId: string) {
    this.applyFull(full);
    this.on('snap', (s: Snapshot) => this.onSnap(s));
    this.on('match:full', (f: FullSync) => this.applyFull(f));
    this.on('match:end', (e: MatchEndPayload) => {
      this.endInfo = { results: e.results, xp: e.xp[this.memberId] };
    });
  }

  private on(ev: string, fn: (...a: never[]) => void) {
    this.socket.on(ev, fn as never);
    this.handlers.push([ev, fn]);
  }

  applyFull(f: FullSync): void {
    this.roster.clear();
    for (const r of f.roster) this.roster.set(r.id, { name: r.name, color: r.color, cosmetics: r.cosmetics, memberId: r.memberId });
    this.myId = f.roster.find((r) => r.memberId === this.memberId)?.id ?? -1;
    this.duration = f.duration;
    this.orbs.clear();
    for (const o of f.orbs) this.addOrb(o);
    this.frames = [];
    this.pred = null;
    this.history = [];
    this.endInfo = null;
    this.clockOffset = null;
    this.onSnap(f);
  }

  private addOrb(o: OrbTuple) {
    this.orbs.set(o[0], { id: o[0], x: o[1], y: o[2], tx: o[1], ty: o[2], value: o[3], kind: o[4] });
  }

  private onSnap(s: Snapshot): void {
    const now = performance.now() / 1000;
    const sample = s.t - now;
    if (this.clockOffset === null || s.ph !== 'playing') this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * (sample > this.clockOffset ? 0.3 : 0.05);

    const myTuple = s.p.find((p) => p[0] === this.myId);
    for (const id of s.or) {
      const o = this.orbs.get(id);
      // Local pickup feedback for orbs we absorbed.
      if (o && myTuple && Math.hypot(o.x - myTuple[1], o.y - myTuple[2]) < radiusForMass(myTuple[5] / 10) + 60 && o.value < 2) {
        this.events.push({ t: 'pickup', id: this.myId, value: o.value, x: o.x, y: o.y });
      }
      this.orbs.delete(id);
    }
    for (const o of s.oa) this.addOrb(o);
    for (let i = 0; i < s.om.length; i += 3) {
      const o = this.orbs.get(s.om[i]);
      if (o) { o.tx = s.om[i + 1]; o.ty = s.om[i + 2]; }
    }
    this.events.push(...s.ev);

    this.frames.push({ t: s.t, players: new Map(s.p.map((p) => [p[0], p])), holes: new Map(s.b.map((b) => [b[0], b])) });
    if (this.frames.length > 40) this.frames.splice(0, this.frames.length - 40);
    this.latest = s;
    this.latestHoles = s.b.map((b) => ({ id: b[0], x: b[1], y: b[2], r: b[3], range: b[4], growth: b[5] / 100, giant: !!b[6], orbit: null, strength: b[7], ttl: Infinity }));

    // --- reconcile own prediction
    if (myTuple) {
      const alive = (myTuple[8] & F_ALIVE) !== 0;
      const ack = myTuple[12];
      this.history = this.history.filter((h) => h.seq > ack);
      const base = { x: myTuple[1], y: myTuple[2], vx: myTuple[3], vy: myTuple[4], mass: myTuple[5] / 10, alive, dashCd: myTuple[11] / 10 };
      if (alive && s.ph === 'playing') {
        for (const h of this.history) this.predictStep(base, h.input, h.dt);
      }
      if (this.pred && alive && this.pred.alive) {
        this.visualOffset.x += this.pred.x - base.x;
        this.visualOffset.y += this.pred.y - base.y;
        // Large corrections (teleport-level) snap instead of sliding.
        if (Math.hypot(this.visualOffset.x, this.visualOffset.y) > 250) this.visualOffset = { x: 0, y: 0 };
      } else this.visualOffset = { x: 0, y: 0 };
      this.pred = base;
    }
  }

  private predictStep(b: { x: number; y: number; vx: number; vy: number; mass: number; dashCd: number }, input: PlayerInput, dt: number) {
    if (input.dash && b.dashCd <= 0) {
      const imp = dashImpulse(b.mass);
      b.vx += Math.cos(input.aim) * imp;
      b.vy += Math.sin(input.aim) * imp;
      b.dashCd = 1.8;
    }
    b.dashCd -= dt;
    applyBlackHoles(b, this.latestHoles, dt, this.latest?.sg ? 1.8 : 1);
    integrateMovement(b, input, dt);
  }

  update(dt: number, input: PlayerInput): void {
    if (input.dash) this.pendingDash = true;
    const playing = this.latest?.ph === 'playing';
    // Predict own movement locally.
    if (this.pred && this.pred.alive && playing) {
      const frameInput = { ...input, dash: input.dash };
      this.predictStep(this.pred, frameInput, dt);
      this.history.push({ seq: this.seq + 1, dt, input: frameInput });
      if (this.history.length > 240) this.history.shift();
    }
    const k = Math.exp(-dt * 12);
    this.visualOffset.x *= k;
    this.visualOffset.y *= k;

    // Smooth moving orbs.
    const ok = 1 - Math.exp(-dt * 15);
    for (const o of this.orbs.values()) {
      if (o.x !== o.tx || o.y !== o.ty) { o.x += (o.tx - o.x) * ok; o.y += (o.ty - o.y) * ok; }
    }

    this.sendTimer -= dt;
    const changed = !this.lastSent || this.lastSent.attract !== input.attract || this.lastSent.repel !== input.repel || this.pendingDash;
    if (this.sendTimer <= 0 || changed) {
      this.sendTimer = SEND_INTERVAL;
      this.seq++;
      this.socket.emit('input', { mx: round2(input.mx), my: round2(input.my), aim: round2(input.aim), a: input.attract, r: input.repel, d: this.pendingDash, s: this.seq });
      this.pendingDash = false;
      this.lastSent = input;
    }
  }

  state(): RenderState {
    const s = this.latest;
    const now = performance.now() / 1000;
    const renderT = now + (this.clockOffset ?? 0) - INTERP_DELAY;
    // Find bracketing frames.
    let a = this.frames[0], b = this.frames[this.frames.length - 1];
    for (let i = this.frames.length - 1; i > 0; i--) {
      if (this.frames[i - 1].t <= renderT) { a = this.frames[i - 1]; b = this.frames[i]; break; }
    }
    const span = b.t - a.t;
    const alpha = span > 0 ? Math.max(0, Math.min(1, (renderT - a.t) / span)) : 1;
    const lerp = (x: number, y: number) => x + (y - x) * alpha;
    const lerpAngle = (x: number, y: number) => {
      let d = y - x;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return x + d * alpha;
    };

    const players: RPlayer[] = [];
    for (const pb of s.p) {
      const id = pb[0];
      const pa = a.players.get(id) ?? pb;
      const pbI = b.players.get(id) ?? pb;
      const r = this.roster.get(id) ?? { name: '???', color: '#ffffff', cosmetics: { color: 'c0', glow: 'glow-soft', skin: 'skin-plain', trail: 'trail-none', elimFx: 'fx-burst' }, memberId: '' };
      const latestFlags = pb[8];
      let x = lerp(pa[1], pbI[1]), y = lerp(pa[2], pbI[2]);
      let vx = lerp(pa[3], pbI[3]), vy = lerp(pa[4], pbI[4]);
      if (id === this.myId && this.pred && this.pred.alive) {
        x = this.pred.x + this.visualOffset.x;
        y = this.pred.y + this.visualOffset.y;
        vx = this.pred.vx; vy = this.pred.vy;
      }
      players.push({
        id, name: r.name, color: r.color, cosmetics: r.cosmetics, x, y, vx, vy,
        mass: lerp(pa[5], pbI[5]) / 10, energy: pb[6], ability: pb[7],
        alive: (latestFlags & F_ALIVE) !== 0, dashing: (latestFlags & F_DASHING) !== 0,
        protected: (latestFlags & F_PROTECTED) !== 0, connected: (latestFlags & F_CONNECTED) !== 0,
        score: pb[9], kills: pb[10], dashCd: pb[11] / 10,
        aim: id === this.myId ? (this.lastSent?.aim ?? pb[13] / 100) : lerpAngle(pa[13] / 100, pbI[13] / 100),
      });
    }
    const holes: RHole[] = [];
    for (const hb of s.b) {
      const ha = a.holes.get(hb[0]) ?? hb;
      const hB = b.holes.get(hb[0]) ?? hb;
      holes.push({ id: hb[0], x: lerp(ha[1], hB[1]), y: lerp(ha[2], hB[2]), r: hb[3], range: hb[4], growth: lerp(ha[5], hB[5]) / 100, giant: !!hb[6] });
    }
    const time = s.ph === 'playing' ? Math.min(s.t, Math.max(0, renderT + INTERP_DELAY)) : s.t;
    return {
      time, phase: s.ph, countdown: s.cd, zone: s.z, arena: s.ar, duration: this.duration,
      players, orbs: this.orbs.values(), holes, myId: this.myId, spaceEvent: s.se, surge: !!s.sg,
    };
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  ended(): EndInfo | null {
    return this.endInfo;
  }

  destroy(): void {
    for (const [ev, fn] of this.handlers) this.socket.off(ev, fn as never);
    this.handlers = [];
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;
