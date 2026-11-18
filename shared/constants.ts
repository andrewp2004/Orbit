// Gameplay tuning. Shared by the authoritative server and the offline solo simulation.
export const SIM_DT = 1 / 60; // fixed physics step
export const SERVER_TICK_MS = 1000 / 30; // network tick (2 physics substeps per tick)
export const COUNTDOWN_SECONDS = 3;

export const START_MASS = 10;
export const MIN_MASS = 4;
export const CONSUME_RATIO = 1.3; // need 30% more mass to swallow a planet
export const LARGE_MASS_DECAY_START = 70; // mass above this slowly bleeds off (anti-snowball)

export const BASE_MAX_SPEED = 330;
export const DASH_COOLDOWN = 1.8;
export const DASH_DURATION = 0.35;
export const DASH_IMPULSE = 560;
export const SPAWN_PROTECTION = 2.5;

export const ENERGY_MAX = 100;
export const ENERGY_REGEN = 11; // per second while abilities are idle
export const ATTRACT_DRAIN = 26;
export const REPEL_DRAIN = 30;
export const ATTRACT_FORCE = 900;
export const REPEL_FORCE = 1350;

export const ORB_RADIUS = 6;
export const CLUSTER_RADIUS = 13;

export const KILL_CREDIT_WINDOW = 5; // seconds a "last hit" counts towards an elimination
export const VICTORY_BONUS = 1000;
export const KILL_SCORE = 150;
export const ORB_SCORE = 10;

export function radiusForMass(mass: number): number {
  return 10 + 3.2 * Math.sqrt(mass);
}

export function maxSpeedForMass(mass: number): number {
  return BASE_MAX_SPEED * Math.pow(START_MASS / Math.max(mass, MIN_MASS), 0.18);
}

export function abilityRange(radius: number): number {
  return 220 + radius * 2.5;
}

export type Difficulty = 'easy' | 'normal' | 'hard';
export type ArenaSize = 'small' | 'medium' | 'large';
export type HazardLevel = 'low' | 'normal' | 'high';

export interface MatchSettings {
  arenaSize: ArenaSize;
  durationSec: number; // 180..420
  hazards: HazardLevel;
  maxPlayers: number; // 2..16
  events: boolean; // random space events
}

export const DEFAULT_SETTINGS: MatchSettings = {
  arenaSize: 'medium',
  durationSec: 300,
  hazards: 'normal',
  maxPlayers: 12,
  events: true,
};

export function sanitizeSettings(s: Partial<MatchSettings> | undefined): MatchSettings {
  const out = { ...DEFAULT_SETTINGS };
  if (!s || typeof s !== 'object') return out;
  if (s.arenaSize === 'small' || s.arenaSize === 'medium' || s.arenaSize === 'large') out.arenaSize = s.arenaSize;
  if (s.hazards === 'low' || s.hazards === 'normal' || s.hazards === 'high') out.hazards = s.hazards;
  if (typeof s.durationSec === 'number' && isFinite(s.durationSec)) out.durationSec = Math.round(Math.min(420, Math.max(180, s.durationSec)));
  if (typeof s.maxPlayers === 'number' && isFinite(s.maxPlayers)) out.maxPlayers = Math.round(Math.min(16, Math.max(2, s.maxPlayers)));
  if (typeof s.events === 'boolean') out.events = s.events;
  return out;
}

export function arenaRadiusFor(size: ArenaSize, players: number): number {
  const base = size === 'small' ? 1300 : size === 'medium' ? 1700 : 2200;
  return Math.round(base + Math.min(16, players) * 45);
}

export const PLANET_COLORS = [
  '#38f9ff', '#ff4fd8', '#7dff6b', '#ffd23f', '#ff7a3d', '#a07bff',
  '#ff3b5c', '#3dffb9', '#5c8dff', '#fff36b', '#ff9de2', '#c6ff3d',
];
