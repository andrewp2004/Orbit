// ORBIT authoritative simulation.
// The exact same code runs on the game server (online rooms) and in the browser (offline solo mode).
import {
  ATTRACT_DRAIN, ATTRACT_FORCE, CLUSTER_RADIUS, CONSUME_RATIO, COUNTDOWN_SECONDS, DASH_COOLDOWN, DASH_DURATION,
  DASH_IMPULSE, ENERGY_MAX, ENERGY_REGEN, KILL_CREDIT_WINDOW, KILL_SCORE, LARGE_MASS_DECAY_START, MIN_MASS,
  MatchSettings, ORB_RADIUS, ORB_SCORE, REPEL_DRAIN, REPEL_FORCE, SPAWN_PROTECTION, START_MASS, VICTORY_BONUS,
  abilityRange, arenaRadiusFor, maxSpeedForMass, radiusForMass, Difficulty,
} from './constants';
import { Cosmetics, DEFAULT_COSMETICS, colorHex } from './cosmetics';
import { Rng } from './rng';

export interface PlayerInput {
  mx: number; // movement vector, each axis -1..1 (length <= 1)
  my: number;
  aim: number; // radians, world space
  attract: boolean;
  repel: boolean;
  dash: boolean; // edge-triggered request
}

export const NO_INPUT: PlayerInput = { mx: 0, my: 0, aim: 0, attract: false, repel: false, dash: false };

export type DeathCause = 'blackhole' | 'edge' | 'zone' | 'consumed' | 'left';
export type Phase = 'countdown' | 'playing' | 'ended';

export interface Player {
  id: number;
  name: string;
  cosmetics: Cosmetics;
  color: string;
  isBot: boolean;
  difficulty?: Difficulty;
  x: number; y: number; vx: number; vy: number;
  mass: number;
  energy: number;
  score: number;
  kills: number;
  alive: boolean;
  placement: number;
  dashCd: number;
  dashTime: number;
  protect: number;
  ability: 0 | 1 | 2; // none / attract / repel
  input: PlayerInput;
  dashQueued: boolean;
  inputSeq: number;
  lastHitBy: number;
  lastHitAt: number;
  orbs: number;
  peakMass: number;
  aliveTime: number;
  deathCause?: DeathCause;
  killedBy?: number;
  connected: boolean;
  brain?: Record<string, number>; // bot scratch memory
}

export interface Orb {
  id: number;
  x: number; y: number; vx: number; vy: number;
  value: number;
  kind: 0 | 1 | 2; // normal, cluster, dropped
  moving: boolean;
}

export interface Orbit { cx: number; cy: number; radius: number; angle: number; speed: number }

export interface BlackHole {
  id: number;
  x: number; y: number;
  r: number; // event horizon
  range: number; // gravity reach
  strength: number;
  orbit: Orbit | null;
  ttl: number; // seconds left (Infinity = permanent)
  growth: number; // 0..1 spawn / collapse animation
  giant: boolean;
}

export type SpaceEventKind = 'storm' | 'giant' | 'surge' | 'escalation';

export type GameEvent =
  | { t: 'death'; id: number; killer: number; cause: DeathCause; x: number; y: number }
  | { t: 'hit'; a: number; b: number; x: number; y: number; power: number }
  | { t: 'dash'; id: number }
  | { t: 'pickup'; id: number; value: number; x: number; y: number }
  | { t: 'space'; kind: SpaceEventKind; x: number; y: number }
  | { t: 'go' }
  | { t: 'end'; winner: number };

export interface AddPlayerOpts {
  name: string;
  cosmetics?: Cosmetics;
  isBot?: boolean;
  difficulty?: Difficulty;
}

export interface MatchResult {
  id: number;
  name: string;
  color: string;
  isBot: boolean;
  score: number;
  kills: number;
  placement: number;
  peakMass: number;
  aliveTime: number;
  orbs: number;
  won: boolean;
  deathCause?: DeathCause;
}

export type Brain = (world: World, p: Player, dt: number) => void;

const TAU = Math.PI * 2;

/** Movement integration for one body. Exported so online clients can predict their own planet. */
export function integrateMovement(
  p: { x: number; y: number; vx: number; vy: number; mass: number },
  input: PlayerInput,
  dt: number,
): void {
  const maxSpeed = maxSpeedForMass(p.mass);
  const accel = maxSpeed * 3.2;
  let mx = input.mx, my = input.my;
  const ml = Math.hypot(mx, my);
  if (ml > 1) { mx /= ml; my /= ml; }
  const before = Math.hypot(p.vx, p.vy);
  let nvx = p.vx + mx * accel * dt;
  let nvy = p.vy + my * accel * dt;
  const after = Math.hypot(nvx, nvy);
  // Input can't push you beyond max speed, but momentum from dashes/knockback is preserved.
  const cap = Math.max(maxSpeed, before);
  if (after > cap) { nvx *= cap / after; nvy *= cap / after; }
  // Drag: light while steering, stronger when coasting.
  const drag = ml > 0.05 ? 0.5 : 1.6;
  const k = Math.exp(-drag * dt);
  nvx *= k; nvy *= k;
  // Excess speed (knockback) bleeds away smoothly.
  const sp = Math.hypot(nvx, nvy);
  if (sp > maxSpeed) {
    const target = maxSpeed + (sp - maxSpeed) * Math.exp(-2.2 * dt);
    nvx *= target / sp; nvy *= target / sp;
  }
  p.vx = nvx; p.vy = nvy;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}

export function dashImpulse(mass: number): number {
  return DASH_IMPULSE * Math.pow(START_MASS / Math.max(mass, MIN_MASS), 0.12);
}

/** Gravity acceleration from black holes (applied to velocity). */
export function applyBlackHoles(
  p: { x: number; y: number; vx: number; vy: number },
  holes: BlackHole[],
  dt: number,
  surge = 1,
): void {
  for (const bh of holes) {
    const dx = bh.x - p.x, dy = bh.y - p.y;
    const range = bh.range * bh.growth;
    const d = Math.hypot(dx, dy);
    if (d >= range || d < 1e-3) continue;
    const f = bh.strength * surge * Math.pow(1 - d / range, 1.6) * bh.growth;
    p.vx += (dx / d) * f * dt;
    p.vy += (dy / d) * f * dt;
  }
}

export class World {
  readonly settings: MatchSettings;
  readonly rng: Rng;
  arenaRadius = 2000;
  zoneRadius = 2000;
  zoneMin = 320;
  time = 0; // seconds since the match went live
  countdown = COUNTDOWN_SECONDS;
  phase: Phase = 'countdown';
  players: Player[] = [];
  orbs = new Map<number, Orb>();
  blackHoles: BlackHole[] = [];
  events: GameEvent[] = [];
  orbAdded: Orb[] = [];
  orbRemoved: number[] = [];
  surgeTime = 0;
  activeEvent: { kind: SpaceEventKind; until: number } | null = null;
  winnerId = -1;
  initialPlayers = 0;
  brain: Brain | null = null;
  trackOrbDeltas = false;
  private nextId = 1;
  private nextSpaceEvent = 50;
  private nextEscalation = 75;
  private clusterTimer = 6;
  private baseHoles = 0;

  constructor(settings: MatchSettings, seed?: number) {
    this.settings = settings;
    this.rng = new Rng(seed);
  }

  get alivePlayers(): Player[] {
    return this.players.filter((p) => p.alive);
  }

  getPlayer(id: number): Player | undefined {
    return this.players.find((p) => p.id === id);
  }

  addPlayer(o: AddPlayerOpts): Player {
    const cosmetics = o.cosmetics ?? DEFAULT_COSMETICS;
    const p: Player = {
      id: this.nextId++, name: o.name, cosmetics, color: colorHex(cosmetics),
      isBot: !!o.isBot, difficulty: o.difficulty,
      x: 0, y: 0, vx: 0, vy: 0, mass: START_MASS, energy: ENERGY_MAX, score: 0, kills: 0,
      alive: true, placement: 0, dashCd: 0, dashTime: 0, protect: SPAWN_PROTECTION, ability: 0,
      input: { ...NO_INPUT }, dashQueued: false, inputSeq: 0, lastHitBy: -1, lastHitAt: -99,
      orbs: 0, peakMass: START_MASS, aliveTime: 0, connected: true,
    };
    this.players.push(p);
    return p;
  }

  /** Lays out the arena and puts everyone at their spawn points. Call once after adding players. */
  start(): void {
    const n = this.players.length;
    this.initialPlayers = n;
    this.arenaRadius = arenaRadiusFor(this.settings.arenaSize, n);
    this.zoneRadius = this.arenaRadius;
    const R = this.arenaRadius;

    // Black holes on slow, predictable orbits around the arena centre.
    const count = { low: 2, normal: 4, high: 6 }[this.settings.hazards] + (this.settings.arenaSize === 'large' ? 1 : 0);
    for (let i = 0; i < count; i++) {
      for (let tries = 0; tries < 40; tries++) {
        const ang = this.rng.range(0, TAU);
        const rad = this.rng.range(0.28, 0.72) * R;
        const x = Math.cos(ang) * rad, y = Math.sin(ang) * rad;
        if (this.blackHoles.every((b) => Math.hypot(b.x - x, b.y - y) > 650) || tries === 39) {
          const moving = i % 2 === 0;
          this.addBlackHole(x, y, {
            orbit: moving ? { cx: 0, cy: 0, radius: rad, angle: ang, speed: this.rng.range(0.025, 0.05) * (this.rng.next() < 0.5 ? -1 : 1) } : null,
          });
          break;
        }
      }
    }
    this.baseHoles = this.blackHoles.length;
    for (const b of this.blackHoles) b.growth = 1;

    // Spawn players evenly around a ring, away from black holes.
    const offset = this.rng.range(0, TAU);
    this.players.forEach((p, i) => {
      let best = { x: 0, y: 0, score: -Infinity };
      for (let t = 0; t < 12; t++) {
        const ang = offset + (i / n) * TAU + this.rng.range(-0.25, 0.25) * (t / 12 + 0.2);
        const rad = R * this.rng.range(0.5, 0.68);
        const x = Math.cos(ang) * rad, y = Math.sin(ang) * rad;
        const clearance = Math.min(...this.blackHoles.map((b) => Math.hypot(b.x - x, b.y - y) - b.range), 9999);
        if (clearance > best.score) best = { x, y, score: clearance };
        if (clearance > 60) break;
      }
      p.x = best.x; p.y = best.y;
      p.vx = p.vy = 0;
      p.input.aim = Math.atan2(-p.y, -p.x);
    });

    const target = this.targetOrbCount();
    for (let i = 0; i < target; i++) this.spawnOrb();
    for (let i = 0; i < 4; i++) this.spawnCluster();
    this.phase = 'countdown';
    this.countdown = COUNTDOWN_SECONDS;
  }

  setInput(id: number, input: Partial<PlayerInput>, seq?: number): void {
    const p = this.getPlayer(id);
    if (!p) return;
    if (typeof input.mx === 'number' && isFinite(input.mx)) p.input.mx = Math.max(-1, Math.min(1, input.mx));
    if (typeof input.my === 'number' && isFinite(input.my)) p.input.my = Math.max(-1, Math.min(1, input.my));
    if (typeof input.aim === 'number' && isFinite(input.aim)) p.input.aim = input.aim;
    p.input.attract = !!input.attract;
    p.input.repel = !!input.repel;
    if (input.dash) p.dashQueued = true;
    if (typeof seq === 'number' && isFinite(seq)) p.inputSeq = seq;
  }

  /** Removes a player mid-match (e.g. they left the room). */
  forfeit(id: number): void {
    const p = this.getPlayer(id);
    if (p && p.alive && this.phase !== 'ended') this.kill(p, 'left', -1);
  }

  step(dt: number): void {
    if (this.phase === 'ended') return;
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      this.moveBlackHoles(dt);
      if (this.countdown <= 0) {
        this.phase = 'playing';
        this.countdown = 0;
        this.events.push({ t: 'go' });
      }
      return;
    }
    this.time += dt;

    if (this.brain) for (const p of this.players) if (p.alive && p.isBot) this.brain(this, p, dt);

    this.updateZone();
    this.updateSpaceEvents(dt);
    this.moveBlackHoles(dt);
    this.updatePlayers(dt);
    this.collidePlayers();
    this.updateOrbs(dt);
    this.maintainOrbs(dt);
    this.checkEnd();
  }

  // ---------------------------------------------------------------- internals

  private targetOrbCount(): number {
    const zoneFrac = (this.zoneRadius / this.arenaRadius) ** 2;
    return Math.max(50, Math.floor((this.arenaRadius ** 2 / 9500) * Math.max(0.25, zoneFrac)));
  }

  addBlackHole(x: number, y: number, o: Partial<BlackHole> = {}): BlackHole {
    const bh: BlackHole = {
      id: this.nextId++, x, y, r: 38, range: 440, strength: 850, orbit: null, ttl: Infinity, growth: 0, giant: false, ...o,
    };
    if (bh.orbit) { bh.x = bh.orbit.cx + Math.cos(bh.orbit.angle) * bh.orbit.radius; bh.y = bh.orbit.cy + Math.sin(bh.orbit.angle) * bh.orbit.radius; }
    this.blackHoles.push(bh);
    return bh;
  }

  private randomPointInZone(frac = 0.95): { x: number; y: number } {
    const R = Math.min(this.zoneRadius, this.arenaRadius) * frac;
    for (let i = 0; i < 20; i++) {
      const a = this.rng.range(0, TAU);
      const r = Math.sqrt(this.rng.next()) * R;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (this.blackHoles.every((b) => Math.hypot(b.x - x, b.y - y) > b.r * 2 + 60)) return { x, y };
    }
    return { x: 0, y: 0 };
  }

  private pushOrb(o: Orb): void {
    this.orbs.set(o.id, o);
    if (this.trackOrbDeltas) this.orbAdded.push(o);
  }

  private removeOrb(id: number): void {
    if (this.orbs.delete(id) && this.trackOrbDeltas) this.orbRemoved.push(id);
  }

  spawnOrb(x?: number, y?: number, value = 1, kind: 0 | 1 | 2 = 0, vx = 0, vy = 0): Orb {
    if (x === undefined || y === undefined) ({ x, y } = this.randomPointInZone());
    const o: Orb = { id: this.nextId++, x, y, vx, vy, value, kind, moving: vx !== 0 || vy !== 0 };
    this.pushOrb(o);
    return o;
  }

  private spawnCluster(): void {
    const { x, y } = this.randomPointInZone(0.85);
    this.spawnOrb(x, y, 8, 1);
  }

  private updateZone(): void {
    const start = 35;
    const end = this.settings.durationSec * 0.8;
    const t = Math.max(0, Math.min(1, (this.time - start) / (end - start)));
    const e = t * t * (3 - 2 * t);
    this.zoneRadius = this.arenaRadius + (this.zoneMin - this.arenaRadius) * e;
  }

  private updateSpaceEvents(dt: number): void {
    if (this.surgeTime > 0) this.surgeTime -= dt;
    if (this.activeEvent && this.time > this.activeEvent.until) this.activeEvent = null;

    this.clusterTimer -= dt;
    if (this.clusterTimer <= 0) {
      this.clusterTimer = this.rng.range(7, 11);
      let clusters = 0;
      for (const o of this.orbs.values()) if (o.kind === 1) clusters++;
      if (clusters < 6) this.spawnCluster();
    }

    // Escalation: extra black holes appear inside the shrinking zone.
    if (this.time >= this.nextEscalation) {
      this.nextEscalation += 70;
      if (this.blackHoles.filter((b) => b.ttl === Infinity).length < this.baseHoles + 3 && this.zoneRadius > 700) {
        const rad = this.zoneRadius * this.rng.range(0.45, 0.6);
        const ang = this.rng.range(0, TAU);
        const bh = this.addBlackHole(0, 0, {
          r: 32, range: 380, strength: 760,
          orbit: { cx: 0, cy: 0, radius: rad, angle: ang, speed: this.rng.range(0.04, 0.07) * (this.rng.next() < 0.5 ? -1 : 1) },
        });
        this.events.push({ t: 'space', kind: 'escalation', x: bh.x, y: bh.y });
      }
    }

    if (!this.settings.events || this.time < this.nextSpaceEvent) return;
    this.nextSpaceEvent += this.rng.range(55, 75);
    const kind = this.rng.pick<SpaceEventKind>(['storm', 'giant', 'surge']);
    if (kind === 'storm') {
      const c = this.randomPointInZone(0.6);
      for (let i = 0; i < 45; i++) {
        const a = this.rng.range(0, TAU), r = Math.sqrt(this.rng.next()) * 240;
        this.spawnOrb(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, this.rng.next() < 0.3 ? 2 : 1, 0);
      }
      for (let i = 0; i < 3; i++) this.spawnOrb(c.x + this.rng.range(-120, 120), c.y + this.rng.range(-120, 120), 8, 1);
      this.activeEvent = { kind, until: this.time + 10 };
      this.events.push({ t: 'space', kind, x: c.x, y: c.y });
    } else if (kind === 'giant') {
      let c = this.randomPointInZone(0.5);
      for (let i = 0; i < 15; i++) {
        const cand = this.randomPointInZone(0.5);
        if (this.players.every((p) => !p.alive || Math.hypot(p.x - cand.x, p.y - cand.y) > 420)) { c = cand; break; }
      }
      this.addBlackHole(c.x, c.y, { r: 70, range: 760, strength: 1250, ttl: 22, giant: true });
      this.activeEvent = { kind, until: this.time + 22 };
      this.events.push({ t: 'space', kind, x: c.x, y: c.y });
    } else {
      this.surgeTime = 12;
      this.activeEvent = { kind, until: this.time + 12 };
      this.events.push({ t: 'space', kind, x: 0, y: 0 });
    }
  }

  private moveBlackHoles(dt: number): void {
    for (const b of this.blackHoles) {
      if (b.orbit) {
        b.orbit.angle += b.orbit.speed * dt;
        b.x = b.orbit.cx + Math.cos(b.orbit.angle) * b.orbit.radius;
        b.y = b.orbit.cy + Math.sin(b.orbit.angle) * b.orbit.radius;
      }
      if (b.ttl !== Infinity) {
        b.ttl -= dt;
        b.growth = b.ttl < 3 ? Math.max(0, b.ttl / 3) : Math.min(1, b.growth + dt / 3);
      } else if (b.growth < 1) b.growth = Math.min(1, b.growth + dt / 3);
    }
    this.blackHoles = this.blackHoles.filter((b) => b.ttl > 0);
  }

  private updatePlayers(dt: number): void {
    const surge = this.surgeTime > 0 ? 1.8 : 1;
    // 1) Gravity abilities.
    for (const p of this.players) {
      if (!p.alive) continue;
      const wantRepel = p.input.repel && p.energy > 1;
      const wantAttract = !wantRepel && p.input.attract && p.energy > 1;
      p.ability = wantRepel ? 2 : wantAttract ? 1 : 0;
      if (p.ability === 0) { p.energy = Math.min(ENERGY_MAX, p.energy + ENERGY_REGEN * dt); continue; }
      p.energy = Math.max(0, p.energy - (p.ability === 1 ? ATTRACT_DRAIN : REPEL_DRAIN) * dt);
      const range = abilityRange(radiusForMass(p.mass));
      const power = Math.pow(p.mass / START_MASS, 0.4);
      const sign = p.ability === 1 ? -1 : 1; // -1 pulls towards p
      for (const q of this.players) {
        if (q === p || !q.alive || q.protect > 0) continue;
        const dx = q.x - p.x, dy = q.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d >= range || d < 1e-3) continue;
        const falloff = 1 - d / range;
        const force = (p.ability === 1 ? ATTRACT_FORCE : REPEL_FORCE) * power / Math.pow(q.mass / START_MASS, 0.4) * (0.35 + 0.65 * falloff);
        q.vx += (dx / d) * force * sign * dt;
        q.vy += (dy / d) * force * sign * dt;
        q.lastHitBy = p.id;
        q.lastHitAt = this.time;
      }
      if (p.ability === 1) {
        for (const o of this.orbs.values()) {
          const dx = p.x - o.x, dy = p.y - o.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= range * range) continue;
          const d = Math.sqrt(d2);
          const f = 1500 * (1 - d / range) + 200;
          o.vx += (dx / d) * f * dt;
          o.vy += (dy / d) * f * dt;
          o.moving = true;
        }
      }
    }

    // 2) Movement, dash, hazards.
    for (const p of this.players) {
      if (!p.alive) continue;
      p.aliveTime += dt;
      p.score += dt; // survival points
      if (p.protect > 0) p.protect -= dt;
      if (p.dashCd > 0) p.dashCd -= dt;
      if (p.dashTime > 0) p.dashTime -= dt;
      if (p.dashQueued) {
        p.dashQueued = false;
        if (p.dashCd <= 0) {
          const imp = dashImpulse(p.mass);
          p.vx += Math.cos(p.input.aim) * imp;
          p.vy += Math.sin(p.input.aim) * imp;
          p.dashCd = DASH_COOLDOWN;
          p.dashTime = DASH_DURATION;
          this.events.push({ t: 'dash', id: p.id });
        }
      }
      applyBlackHoles(p, this.blackHoles, dt, surge);
      integrateMovement(p, p.input, dt);

      // Natural decay for very large planets keeps matches from snowballing.
      if (p.mass > LARGE_MASS_DECAY_START) p.mass -= (p.mass - LARGE_MASS_DECAY_START) * 0.006 * dt;

      const dc = Math.hypot(p.x, p.y);
      if (dc > this.zoneRadius) {
        p.mass -= (1.5 + p.mass * 0.06) * dt;
        p.energy = Math.max(0, p.energy - 12 * dt);
        if (p.mass < MIN_MASS) { this.kill(p, 'zone', this.creditFor(p)); continue; }
      }
      if (dc > this.arenaRadius) { this.kill(p, 'edge', this.creditFor(p)); continue; }
      for (const b of this.blackHoles) {
        if (Math.hypot(b.x - p.x, b.y - p.y) < b.r * b.growth) { this.kill(p, 'blackhole', this.creditFor(p)); break; }
      }
    }
  }

  private creditFor(p: Player): number {
    return p.lastHitBy >= 0 && this.time - p.lastHitAt <= KILL_CREDIT_WINDOW ? p.lastHitBy : -1;
  }

  private collidePlayers(): void {
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (!b.alive || !a.alive) continue;
        const ra = radiusForMass(a.mass), rb = radiusForMass(b.mass);
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.001;
        if (d >= ra + rb) continue;
        const big = a.mass >= b.mass ? a : b;
        const small = big === a ? b : a;
        const rBig = big === a ? ra : rb, rSmall = big === a ? rb : ra;
        if (big.mass >= small.mass * CONSUME_RATIO && d < rBig - rSmall * 0.3 && small.protect <= 0 && big.protect <= 0) {
          big.mass += small.mass * 0.6;
          big.peakMass = Math.max(big.peakMass, big.mass);
          big.score += small.mass * 3;
          this.kill(small, 'consumed', big.id);
          continue;
        }
        const nx = dx / d, ny = dy / d;
        const overlap = ra + rb - d;
        const ma = a.mass, mb = b.mass;
        a.x -= nx * overlap * (mb / (ma + mb));
        a.y -= ny * overlap * (mb / (ma + mb));
        b.x += nx * overlap * (ma / (ma + mb));
        b.y += ny * overlap * (ma / (ma + mb));
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv < 0) {
          let j = (-(1 + 0.85) * rv) / (1 / ma + 1 / mb);
          if (a.dashTime > 0 || b.dashTime > 0) j *= 1.4; // dash-checks hit harder
          a.vx -= (j / ma) * nx; a.vy -= (j / ma) * ny;
          b.vx += (j / mb) * nx; b.vy += (j / mb) * ny;
          if (-rv > 90) this.events.push({ t: 'hit', a: a.id, b: b.id, x: a.x + nx * ra, y: a.y + ny * ra, power: Math.min(1, -rv / 700) });
        }
        a.lastHitBy = b.id; a.lastHitAt = this.time;
        b.lastHitBy = a.id; b.lastHitAt = this.time;
      }
    }
  }

  private updateOrbs(dt: number): void {
    const alive = this.players.filter((p) => p.alive);
    for (const o of this.orbs.values()) {
      if (o.moving) {
        o.x += o.vx * dt; o.y += o.vy * dt;
        const k = Math.exp(-3 * dt);
        o.vx *= k; o.vy *= k;
        if (Math.abs(o.vx) + Math.abs(o.vy) < 4) { o.vx = o.vy = 0; o.moving = false; }
      }
      const orbR = o.kind === 1 ? CLUSTER_RADIUS : ORB_RADIUS;
      let eaten = false;
      for (const p of alive) {
        const r = radiusForMass(p.mass) + orbR;
        const dx = p.x - o.x, dy = p.y - o.y;
        if (dx * dx + dy * dy < r * r) {
          p.mass += o.value;
          p.peakMass = Math.max(p.peakMass, p.mass);
          p.energy = Math.min(ENERGY_MAX, p.energy + o.value * 2);
          p.score += o.value * ORB_SCORE;
          p.orbs += 1;
          this.events.push({ t: 'pickup', id: p.id, value: o.value, x: o.x, y: o.y });
          this.removeOrb(o.id);
          eaten = true;
          break;
        }
      }
      if (eaten) continue;
      for (const b of this.blackHoles) {
        if (Math.hypot(b.x - o.x, b.y - o.y) < b.r * b.growth) { this.removeOrb(o.id); break; }
      }
      if (Math.hypot(o.x, o.y) > this.arenaRadius) this.removeOrb(o.id);
    }
  }

  private maintainOrbs(dt: number): void {
    const target = this.targetOrbCount();
    let normal = 0;
    for (const o of this.orbs.values()) if (o.kind === 0) normal++;
    const toSpawn = Math.min(target - normal, Math.ceil(40 * dt));
    for (let i = 0; i < toSpawn; i++) this.spawnOrb();
  }

  private kill(p: Player, cause: DeathCause, killerId: number): void {
    if (!p.alive) return;
    const aliveBefore = this.players.filter((q) => q.alive).length;
    p.alive = false;
    p.placement = aliveBefore;
    p.deathCause = cause;
    p.ability = 0;
    const killer = killerId >= 0 ? this.getPlayer(killerId) : undefined;
    if (killer && killer !== p) {
      killer.kills += 1;
      killer.score += KILL_SCORE;
      p.killedBy = killer.id;
    }
    this.events.push({ t: 'death', id: p.id, killer: killer && killer !== p ? killer.id : -1, cause, x: p.x, y: p.y });
    // Drop a portion of mass as orbs (not when swallowed by a black hole or consumed).
    if (cause !== 'blackhole' && cause !== 'consumed') {
      const drop = Math.max(4, Math.floor(p.mass * 0.5));
      const pieces = Math.min(24, Math.ceil(drop / 3));
      for (let i = 0; i < pieces; i++) {
        const a = this.rng.range(0, TAU), sp = this.rng.range(80, 260);
        const px = p.x * (cause === 'edge' ? 0.97 : 1), py = p.y * (cause === 'edge' ? 0.97 : 1);
        this.spawnOrb(px, py, Math.max(1, Math.round(drop / pieces)), 2, Math.cos(a) * sp, Math.sin(a) * sp);
      }
    }
  }

  private checkEnd(): void {
    const alive = this.players.filter((p) => p.alive);
    const lastStanding = this.initialPlayers >= 2 ? alive.length <= 1 : alive.length === 0;
    if (lastStanding || this.time >= this.settings.durationSec) this.endMatch();
  }

  endMatch(): void {
    if (this.phase === 'ended') return;
    const alive = this.players.filter((p) => p.alive).sort((a, b) => b.score - a.score);
    alive.forEach((p, i) => (p.placement = i + 1));
    if (alive.length > 0) {
      const w = alive[0];
      w.score += VICTORY_BONUS;
      this.winnerId = w.id;
    }
    this.phase = 'ended';
    this.events.push({ t: 'end', winner: this.winnerId });
  }

  results(): MatchResult[] {
    return this.players
      .map((p) => ({
        id: p.id, name: p.name, color: p.color, isBot: p.isBot,
        score: Math.floor(p.score), kills: p.kills, placement: p.placement || 1,
        peakMass: Math.round(p.peakMass), aliveTime: Math.round(p.aliveTime), orbs: p.orbs,
        won: p.id === this.winnerId, deathCause: p.deathCause,
      }))
      .sort((a, b) => a.placement - b.placement || b.score - a.score);
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}
