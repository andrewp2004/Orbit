// Computer-controlled opponents (single-player only - online rooms never contain bots).
import { Difficulty, abilityRange, radiusForMass, CONSUME_RATIO, PLANET_COLORS } from './constants';
import { CATALOG } from './cosmetics';
import type { Player, World } from './sim';

/** Adds AI planets with varied looks, avoiding colors already in use. Names are tagged so they read as bots. */
export function addBots(world: World, count: number, difficulty: Difficulty, opts: { tag?: boolean } = {}): void {
  if (count <= 0) return;
  world.brain = botBrain;
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  const skins = CATALOG.filter((c) => c.slot === 'skin').map((c) => c.id);
  const glows = ['glow-soft', 'glow-soft', 'glow-pulse', 'glow-halo'];
  const used = new Set(world.players.map((p) => p.cosmetics.color));
  const all = PLANET_COLORS.map((_, i) => `c${i}`);
  const colors = [...all.filter((c) => !used.has(c)), ...all.filter((c) => used.has(c))];
  for (let i = 0; i < count; i++) {
    world.addPlayer({
      name: opts.tag ? `${names[i % names.length]} [BOT]` : names[i % names.length],
      isBot: true,
      difficulty,
      cosmetics: { color: colors[i % colors.length], skin: skins[Math.floor(Math.random() * skins.length)], glow: glows[i % glows.length], trail: Math.random() < 0.5 ? 'trail-comet' : 'trail-sparkle', elimFx: 'fx-burst' },
    });
  }
}

interface Profile {
  reaction: number; // seconds between decisions
  aimNoise: number; // radians
  abilityUse: number; // 0..1 willingness to use gravity powers
  awareness: number; // multiplier on hazard avoidance distance
  aggression: number; // 0..1 how often to hunt players
  dashSkill: number; // 0..1
}

const PROFILES: Record<Difficulty, Profile> = {
  easy: { reaction: 0.5, aimNoise: 0.55, abilityUse: 0.3, awareness: 0.75, aggression: 0.15, dashSkill: 0.2 },
  normal: { reaction: 0.28, aimNoise: 0.25, abilityUse: 0.65, awareness: 1.0, aggression: 0.45, dashSkill: 0.55 },
  hard: { reaction: 0.13, aimNoise: 0.08, abilityUse: 1, awareness: 1.15, aggression: 0.8, dashSkill: 0.9 },
};

export const BOT_NAMES = [
  'Nebula', 'Quasar', 'Pulsar', 'Andromeda', 'Kepler', 'Halley', 'Vega', 'Orion', 'Nova', 'Titan',
  'Europa', 'Callisto', 'Rigel', 'Sirius', 'Zenith', 'Comet', 'Eclipse', 'Photon', 'Lyra', 'Draco',
];

const norm = (x: number, y: number) => {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
};

export function botBrain(world: World, p: Player, dt: number): void {
  const prof = PROFILES[p.difficulty ?? 'normal'];
  const m = (p.brain ??= { timer: 0, mx: 0, my: 0, gx: 0, gy: 0, aim: 0, attract: 0, repel: 0, dash: 0, phase: Math.random() * 100, target: -1 });
  m.timer -= dt;

  // Smoothly steer towards the current goal direction every frame (natural, non-jittery motion).
  const steer = 1 - Math.exp(-dt * 7);
  m.mx += (m.gx - m.mx) * steer;
  m.my += (m.gy - m.my) * steer;
  p.input.mx = m.mx;
  p.input.my = m.my;
  p.input.aim = m.aim;
  p.input.attract = m.attract > 0;
  p.input.repel = m.repel > 0;

  if (m.timer > 0) return;
  m.timer = prof.reaction * (0.7 + Math.random() * 0.6);
  decide(world, p, prof, m);
}

function decide(world: World, p: Player, prof: Profile, m: Record<string, number>): void {
  const myR = radiusForMass(p.mass);
  const range = abilityRange(myR);
  let dangerX = 0, dangerY = 0, danger = 0;
  let escapeDash = false;

  // --- Threats: black holes
  for (const b of world.blackHoles) {
    const dx = p.x - b.x, dy = p.y - b.y;
    const d = Math.hypot(dx, dy);
    const reach = b.range * b.growth * 0.85 * prof.awareness + myR;
    if (d < reach) {
      const w = Math.pow(1 - d / reach, 2) * 4;
      const n = norm(dx, dy);
      // Flee mostly outward, plus a tangential component so we orbit out instead of fighting straight.
      dangerX += (n.x * 0.8 - n.y * 0.4) * w;
      dangerY += (n.y * 0.8 + n.x * 0.4) * w;
      danger += w;
      const inward = -(p.vx * n.x + p.vy * n.y);
      if (d < b.r * 3.2 && inward > 60) escapeDash = true;
    }
  }
  // --- Threats: zone / arena edge
  const dc = Math.hypot(p.x, p.y);
  const edge = Math.min(world.zoneRadius, world.arenaRadius);
  const margin = 260 * prof.awareness;
  if (dc > edge - margin) {
    const w = ((dc - (edge - margin)) / margin) * 3;
    dangerX -= (p.x / dc) * w;
    dangerY -= (p.y / dc) * w;
    danger += w;
    if (dc > world.arenaRadius - 120) escapeDash = true;
  }
  // --- Threats: much bigger planets nearby
  let biggestThreat: Player | null = null;
  for (const q of world.players) {
    if (q === p || !q.alive) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (q.mass > p.mass * CONSUME_RATIO && d < 320 + radiusForMass(q.mass)) {
      const w = (1 - d / (320 + radiusForMass(q.mass))) * 2.2 * prof.awareness;
      const n = norm(p.x - q.x, p.y - q.y);
      dangerX += n.x * w; dangerY += n.y * w; danger += w;
      if (!biggestThreat || d < Math.hypot(biggestThreat.x - p.x, biggestThreat.y - p.y)) biggestThreat = q;
    }
  }

  let goalX = 0, goalY = 0;
  let aimX = Math.cos(m.aim), aimY = Math.sin(m.aim);
  let attract = false, repel = false, dash = false;

  // --- Opportunities: hunt a player
  let target: Player | null = null;
  let targetScore = 0;
  if (Math.random() < prof.aggression + 0.1) {
    for (const q of world.players) {
      if (q === p || !q.alive || q.protect > 0) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d > 650) continue;
      let s = 0;
      if (p.mass > q.mass * CONSUME_RATIO) s = 2.5; // can swallow them
      const hole = nearestHole(world, q.x, q.y);
      if (hole && hole.d < hole.b.range * 0.75) s = Math.max(s, 2); // can knock them in
      if (Math.hypot(q.x, q.y) > edge - 250) s = Math.max(s, 1.5); // near the edge
      s *= 1 - d / 700;
      if (q.id === m.target) s *= 1.3; // commit to a target
      if (s > targetScore) { targetScore = s; target = q; }
    }
  }

  if (target) {
    m.target = target.id;
    const dx = target.x - p.x, dy = target.y - p.y;
    const d = Math.hypot(dx, dy);
    const n = norm(dx, dy);
    aimX = n.x; aimY = n.y;
    const hole = nearestHole(world, target.x, target.y);
    if (p.mass > target.mass * CONSUME_RATIO) {
      goalX = n.x; goalY = n.y;
      if (d < range && p.energy > 15 && Math.random() < prof.abilityUse) attract = true;
      if (d < 200 && p.dashCd <= 0 && Math.random() < prof.dashSkill) dash = true;
    } else if (hole) {
      // Get "behind" the target relative to the hazard, then shove them in.
      const hn = norm(hole.b.x - target.x, hole.b.y - target.y);
      const alignment = n.x * hn.x + n.y * hn.y; // 1 = target sits between us and the hole
      const behindX = target.x - hn.x * 170, behindY = target.y - hn.y * 170;
      const g = norm(behindX - p.x, behindY - p.y);
      goalX = g.x; goalY = g.y;
      if (alignment > 0.55 && d < range && p.energy > 15 && Math.random() < prof.abilityUse) repel = true;
      if (alignment > 0.75 && d < 230 && p.dashCd <= 0 && Math.random() < prof.dashSkill) dash = true;
    } else {
      // Push them outward towards the arena edge.
      const out = norm(target.x, target.y);
      const g = norm(target.x - out.x * 160 - p.x, target.y - out.y * 160 - p.y);
      goalX = g.x; goalY = g.y;
      const alignment = n.x * out.x + n.y * out.y;
      if (alignment > 0.5 && d < range && p.energy > 15 && Math.random() < prof.abilityUse) repel = true;
    }
  } else {
    m.target = -1;
    // --- Collect orbs: best value per distance, preferring safe orbs.
    let best: { x: number; y: number; s: number } | null = null;
    let nearbyOrbs = 0;
    for (const o of world.orbs.values()) {
      const dx = o.x - p.x, dy = o.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 900 * 900) continue;
      const d = Math.sqrt(d2);
      if (d < range) nearbyOrbs++;
      if (Math.hypot(o.x, o.y) > edge - 120) continue;
      const hole = nearestHole(world, o.x, o.y);
      if (hole && hole.d < hole.b.range * 0.45 * prof.awareness) continue;
      const s = (o.value + 0.5) / (d + 60);
      if (!best || s > best.s) best = { x: o.x, y: o.y, s };
    }
    if (best) {
      const g = norm(best.x - p.x, best.y - p.y);
      goalX = g.x; goalY = g.y;
    } else {
      const g = norm(-p.x, -p.y);
      goalX = g.x; goalY = g.y;
    }
    // Wander a little for organic movement.
    const t = world.time + m.phase;
    goalX += Math.sin(t * 0.7) * 0.25;
    goalY += Math.cos(t * 0.53) * 0.25;
    if (nearbyOrbs > 6 && p.energy > 60 && Math.random() < prof.abilityUse * 0.6) attract = true;
    aimX = goalX; aimY = goalY;
  }

  // --- Blend in danger avoidance (it dominates when strong).
  if (danger > 0) {
    const dn = norm(dangerX, dangerY);
    const w = Math.min(1, danger) * (0.6 + 0.4 * prof.awareness);
    goalX = goalX * (1 - w) + dn.x * w * 1.5;
    goalY = goalY * (1 - w) + dn.y * w * 1.5;
    if (danger > 1.2) { attract = false; repel = repel && !!biggestThreat; }
    if (biggestThreat && Math.hypot(biggestThreat.x - p.x, biggestThreat.y - p.y) < range * 0.7 && p.energy > 10 && Math.random() < prof.abilityUse) {
      repel = true; attract = false;
    }
    if (escapeDash && p.dashCd <= 0 && Math.random() < prof.dashSkill + 0.15) {
      dash = true;
      aimX = dn.x; aimY = dn.y;
    }
  }

  const g = norm(goalX, goalY);
  m.gx = g.x; m.gy = g.y;
  m.aim = Math.atan2(aimY, aimX) + (Math.random() - 0.5) * prof.aimNoise;
  m.attract = attract ? 1 : 0;
  m.repel = repel ? 1 : 0;
  if (dash) {
    p.input.aim = m.aim;
    p.dashQueued = true;
  }
}

function nearestHole(world: World, x: number, y: number) {
  let best: { b: World['blackHoles'][number]; d: number } | null = null;
  for (const b of world.blackHoles) {
    const d = Math.hypot(b.x - x, b.y - y);
    if (!best || d < best.d) best = { b, d };
  }
  return best;
}
