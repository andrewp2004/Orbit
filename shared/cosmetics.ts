// Cosmetic catalog. Cosmetics are purely visual and never affect gameplay.
import { PLANET_COLORS } from './constants';

export type CosmeticSlot = 'color' | 'glow' | 'skin' | 'trail' | 'elimFx';

export interface Requirement {
  level?: number;
  wins?: number;
  kills?: number;
  matches?: number;
}

export interface CosmeticItem {
  id: string;
  slot: CosmeticSlot;
  name: string;
  req: Requirement; // empty = free
  value?: string; // e.g. hex color
}

export interface Cosmetics {
  color: string; // item id
  glow: string;
  skin: string;
  trail: string;
  elimFx: string;
}

export interface ProgressStats {
  xp: number;
  wins: number;
  kills: number;
  matches: number;
}

const colorNames = ['Cyan', 'Magenta', 'Lime', 'Solar', 'Ember', 'Violet', 'Crimson', 'Mint', 'Azure', 'Lemon', 'Blossom', 'Acid'];
const colorReqs: Requirement[] = [{}, {}, {}, {}, {}, {}, { level: 2 }, { level: 3 }, { level: 4 }, { matches: 10 }, { wins: 2 }, { level: 6 }];

export const CATALOG: CosmeticItem[] = [
  ...PLANET_COLORS.map((hex, i) => ({ id: `c${i}`, slot: 'color' as const, name: colorNames[i], req: colorReqs[i], value: hex })),
  { id: 'glow-soft', slot: 'glow', name: 'Soft Glow', req: {} },
  { id: 'glow-none', slot: 'glow', name: 'No Glow', req: {} },
  { id: 'glow-pulse', slot: 'glow', name: 'Pulse', req: { level: 2 } },
  { id: 'glow-halo', slot: 'glow', name: 'Halo Ring', req: { level: 4 } },
  { id: 'glow-corona', slot: 'glow', name: 'Corona', req: { wins: 3 } },
  { id: 'skin-plain', slot: 'skin', name: 'Smooth', req: {} },
  { id: 'skin-banded', slot: 'skin', name: 'Gas Giant', req: {} },
  { id: 'skin-cratered', slot: 'skin', name: 'Cratered', req: { level: 3 } },
  { id: 'skin-ringed', slot: 'skin', name: 'Ringed', req: { level: 5 } },
  { id: 'skin-swirl', slot: 'skin', name: 'Storm Swirl', req: { level: 7 } },
  { id: 'skin-crystal', slot: 'skin', name: 'Crystal', req: { wins: 5 } },
  { id: 'skin-molten', slot: 'skin', name: 'Molten Core', req: { wins: 10 } },
  { id: 'skin-void', slot: 'skin', name: 'Void Walker', req: { kills: 50 } },
  { id: 'trail-none', slot: 'trail', name: 'No Trail', req: {} },
  { id: 'trail-comet', slot: 'trail', name: 'Comet', req: {} },
  { id: 'trail-sparkle', slot: 'trail', name: 'Sparkle', req: { level: 2 } },
  { id: 'trail-ribbon', slot: 'trail', name: 'Ribbon', req: { level: 6 } },
  { id: 'trail-stardust', slot: 'trail', name: 'Stardust', req: { wins: 3 } },
  { id: 'fx-burst', slot: 'elimFx', name: 'Burst', req: {} },
  { id: 'fx-nova', slot: 'elimFx', name: 'Nova Ring', req: { level: 3 } },
  { id: 'fx-shatter', slot: 'elimFx', name: 'Shatter', req: { level: 5 } },
  { id: 'fx-vortex', slot: 'elimFx', name: 'Vortex', req: { wins: 1 } },
  { id: 'fx-supernova', slot: 'elimFx', name: 'Supernova', req: { wins: 10 } },
];

export const DEFAULT_COSMETICS: Cosmetics = {
  color: 'c0',
  glow: 'glow-soft',
  skin: 'skin-plain',
  trail: 'trail-comet',
  elimFx: 'fx-burst',
};

const byId = new Map(CATALOG.map((c) => [c.id, c]));
export function getItem(id: string): CosmeticItem | undefined {
  return byId.get(id);
}

export function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}
export function xpForLevel(level: number): number {
  return (level - 1) * (level - 1) * 100;
}

export function isUnlocked(item: CosmeticItem, s: ProgressStats): boolean {
  const r = item.req;
  if (r.level && levelForXp(s.xp) < r.level) return false;
  if (r.wins && s.wins < r.wins) return false;
  if (r.kills && s.kills < r.kills) return false;
  if (r.matches && s.matches < r.matches) return false;
  return true;
}

export function unlockedIds(s: ProgressStats): string[] {
  return CATALOG.filter((c) => isUnlocked(c, s)).map((c) => c.id);
}

export function describeReq(r: Requirement): string {
  const parts: string[] = [];
  if (r.level) parts.push(`Reach level ${r.level}`);
  if (r.wins) parts.push(`Win ${r.wins} match${r.wins > 1 ? 'es' : ''}`);
  if (r.kills) parts.push(`${r.kills} eliminations`);
  if (r.matches) parts.push(`Play ${r.matches} matches`);
  return parts.join(', ') || 'Free';
}

/** Returns a valid cosmetics object, replacing anything unknown or locked with defaults. */
export function sanitizeCosmetics(c: Partial<Cosmetics> | undefined, s: ProgressStats | null): Cosmetics {
  const out = { ...DEFAULT_COSMETICS };
  if (!c || typeof c !== 'object') return out;
  for (const slot of Object.keys(DEFAULT_COSMETICS) as CosmeticSlot[]) {
    const id = (c as Record<string, unknown>)[slot];
    if (typeof id !== 'string') continue;
    const item = byId.get(id);
    if (!item || item.slot !== slot) continue;
    if (s && !isUnlocked(item, s)) continue;
    if (!s && Object.keys(item.req).length > 0) continue;
    out[slot] = id;
  }
  return out;
}

export function colorHex(c: Cosmetics): string {
  return byId.get(c.color)?.value ?? PLANET_COLORS[0];
}

/** XP awarded for one match. Same formula on client (display) and server (authoritative). */
export function xpForMatch(score: number, kills: number, won: boolean): number {
  return 25 + Math.floor(score / 12) + kills * 20 + (won ? 150 : 0);
}
