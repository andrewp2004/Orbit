// Compact wire format for server -> client snapshots.
import type { Cosmetics } from './cosmetics';
import type { MatchSettings } from './constants';
import type { GameEvent, MatchResult, Phase, SpaceEventKind, World } from './sim';

// [id, x, y, vx, vy, mass*10, energy, ability, flags, score, kills, dashCd*10, inputSeq, aim*100]
export type PlayerTuple = number[];
// [id, x, y, r, range, growth*100, giant, strength]
export type HoleTuple = number[];
// [id, x, y, value, kind]
export type OrbTuple = number[];

export const F_ALIVE = 1, F_DASHING = 2, F_PROTECTED = 4, F_CONNECTED = 8;

export interface Snapshot {
  t: number; // match time
  ph: Phase;
  cd: number; // countdown
  z: number; // zone radius
  ar: number; // arena radius
  p: PlayerTuple[];
  b: HoleTuple[];
  oa: OrbTuple[]; // orbs added
  or: number[]; // orbs removed
  om: number[]; // flattened [id,x,y,...] for moving orbs
  ev: GameEvent[];
  se: SpaceEventKind | null;
  sg: number; // gravity surge active
}

export interface RosterEntry {
  id: number;
  name: string;
  color: string;
  cosmetics: Cosmetics;
  memberId: string;
}

export interface FullSync extends Snapshot {
  roster: RosterEntry[];
  orbs: OrbTuple[];
  duration: number;
}

export interface LobbyMember {
  memberId: string;
  name: string;
  color: string;
  cosmetics: Cosmetics;
  isHost: boolean;
  connected: boolean;
  isGuest: boolean;
  level: number;
}

export interface LobbyState {
  code: string;
  hostId: string;
  state: 'lobby' | 'playing' | 'ended';
  settings: MatchSettings;
  members: LobbyMember[];
}

export interface RoomJoinAck {
  ok: boolean;
  error?: string;
  code?: string;
  memberId?: string;
  rejoinToken?: string;
  lobby?: LobbyState;
}

export interface MatchEndPayload {
  results: (MatchResult & { memberId?: string })[];
  xp: Record<string, { gained: number; total: number; level: number }>; // by memberId
}

const r1 = (v: number) => Math.round(v);

export function encodePlayers(w: World): PlayerTuple[] {
  return w.players.map((p) => [
    p.id, r1(p.x), r1(p.y), r1(p.vx), r1(p.vy), Math.round(p.mass * 10), Math.round(p.energy), p.ability,
    (p.alive ? F_ALIVE : 0) | (p.dashTime > 0 ? F_DASHING : 0) | (p.protect > 0 ? F_PROTECTED : 0) | (p.connected ? F_CONNECTED : 0),
    Math.floor(p.score), p.kills, Math.max(0, Math.round(p.dashCd * 10)), p.inputSeq, Math.round(p.input.aim * 100),
  ]);
}

export function encodeHoles(w: World): HoleTuple[] {
  return w.blackHoles.map((b) => [b.id, r1(b.x), r1(b.y), b.r, b.range, Math.round(b.growth * 100), b.giant ? 1 : 0, b.strength]);
}

export function encodeOrb(o: { id: number; x: number; y: number; value: number; kind: number }): OrbTuple {
  return [o.id, r1(o.x), r1(o.y), o.value, o.kind];
}

/** Builds a delta snapshot and clears the world's orb delta buffers. */
export function buildSnapshot(w: World, events: GameEvent[]): Snapshot {
  const om: number[] = [];
  for (const o of w.orbs.values()) if (o.moving) om.push(o.id, r1(o.x), r1(o.y));
  const snap: Snapshot = {
    t: Math.round(w.time * 1000) / 1000,
    ph: w.phase,
    cd: Math.round(w.countdown * 100) / 100,
    z: r1(w.zoneRadius),
    ar: w.arenaRadius,
    p: encodePlayers(w),
    b: encodeHoles(w),
    oa: w.orbAdded.map(encodeOrb),
    or: w.orbRemoved,
    om,
    ev: events.filter((e) => e.t !== 'pickup' || e.value >= 2),
    se: w.activeEvent?.kind ?? null,
    sg: w.surgeTime > 0 ? 1 : 0,
  };
  w.orbAdded = [];
  w.orbRemoved = [];
  return snap;
}

export function buildFullSync(w: World, roster: RosterEntry[]): FullSync {
  return {
    t: w.time, ph: w.phase, cd: w.countdown, z: r1(w.zoneRadius), ar: w.arenaRadius,
    p: encodePlayers(w), b: encodeHoles(w), oa: [], or: [], om: [], ev: [],
    se: w.activeEvent?.kind ?? null, sg: w.surgeTime > 0 ? 1 : 0,
    roster, orbs: [...w.orbs.values()].map(encodeOrb), duration: w.settings.durationSec,
  };
}
