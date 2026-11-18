// Drawing primitives shared by the game renderer, the menu background and the customization preview.
import type { Cosmetics } from '../../../shared/cosmetics';

const TAU = Math.PI * 2;

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
export function shade(hex: string, f: number): string {
  // f < 0 darkens, f > 0 lightens
  const [r, g, b] = hexToRgb(hex);
  const m = (c: number) => Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

function seeded(seed: number) {
  let s = seed * 9301 + 49297;
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
}

export interface PlanetOpts {
  t: number; // seconds, for animation
  seed?: number;
  glow?: boolean;
  alpha?: number;
  quality?: 'high' | 'low';
}

/** Draws a planet with its skin + glow cosmetics. (x, y, r) in the current transform's units. */
export function drawPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, cos: Cosmetics, o: PlanetOpts): void {
  const seed = o.seed ?? 1;
  const t = o.t;
  ctx.save();
  ctx.globalAlpha = o.alpha ?? 1;

  // --- glow (behind)
  if (o.glow !== false && cos.glow !== 'glow-none') {
    if (cos.glow === 'glow-corona') {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(t * 0.4);
      ctx.fillStyle = rgba(color, 0.22);
      ctx.beginPath();
      const spikes = 14;
      for (let i = 0; i <= spikes * 2; i++) {
        const a = (i / (spikes * 2)) * TAU;
        const rr = i % 2 === 0 ? r * (1.75 + 0.15 * Math.sin(t * 3 + i)) : r * 1.15;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.fill();
      ctx.restore();
    }
    const pulse = cos.glow === 'glow-pulse' ? 0.6 + 0.4 * Math.sin(t * 4) : 1;
    const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * (cos.glow === 'glow-pulse' ? 2.3 : 2));
    g.addColorStop(0, rgba(color, 0.45 * pulse));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.3, 0, TAU);
    ctx.fill();
    if (cos.glow === 'glow-halo') {
      ctx.strokeStyle = rgba(color, 0.7);
      ctx.lineWidth = Math.max(1.5, r * 0.08);
      ctx.beginPath();
      ctx.arc(x, y, r * 1.38 + Math.sin(t * 2) * r * 0.04, 0, TAU);
      ctx.stroke();
    }
  }

  // --- ring (back half)
  if (cos.skin === 'skin-ringed') drawRing(ctx, x, y, r, color, true);

  // --- body
  const body = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  if (cos.skin === 'skin-void') {
    body.addColorStop(0, '#1a1530');
    body.addColorStop(0.75, '#05040c');
    body.addColorStop(1, color);
  } else if (cos.skin === 'skin-molten') {
    body.addColorStop(0, shade(color, -0.3));
    body.addColorStop(1, '#120806');
  } else {
    body.addColorStop(0, shade(color, 0.55));
    body.addColorStop(0.55, color);
    body.addColorStop(1, shade(color, -0.55));
  }
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();

  if (cos.skin !== 'skin-plain' && cos.skin !== 'skin-ringed' && (o.quality ?? 'high') === 'high' || cos.skin === 'skin-void' || cos.skin === 'skin-molten') {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    const rnd = seeded(seed);
    switch (cos.skin) {
      case 'skin-banded': {
        for (let i = -4; i <= 4; i++) {
          const yy = y + (i / 4.5) * r + Math.sin(t * 0.6 + i) * r * 0.03;
          ctx.fillStyle = i % 2 === 0 ? rgba('#ffffff', 0.13) : 'rgba(0,0,0,0.16)';
          ctx.beginPath();
          ctx.ellipse(x, yy, r * 1.2, r * 0.09, Math.sin(t * 0.3) * 0.05, 0, TAU);
          ctx.fill();
        }
        break;
      }
      case 'skin-cratered': {
        for (let i = 0; i < 7; i++) {
          const a = rnd() * TAU, d = rnd() * r * 0.75, cr = r * (0.1 + rnd() * 0.18);
          const cx = x + Math.cos(a) * d, cy = y + Math.sin(a) * d;
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.beginPath(); ctx.arc(cx, cy, cr, 0, TAU); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.18)';
          ctx.lineWidth = Math.max(0.8, r * 0.025);
          ctx.beginPath(); ctx.arc(cx - cr * 0.1, cy - cr * 0.1, cr, Math.PI, Math.PI * 1.6); ctx.stroke();
        }
        break;
      }
      case 'skin-swirl': {
        ctx.translate(x, y);
        ctx.rotate(t * 0.8);
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth = Math.max(1, r * 0.09);
        for (let arm = 0; arm < 3; arm++) {
          ctx.beginPath();
          for (let s = 0; s < 30; s++) {
            const a = arm * (TAU / 3) + s * 0.16;
            const d = (s / 30) * r * 1.05;
            ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d);
          }
          ctx.stroke();
        }
        break;
      }
      case 'skin-crystal': {
        ctx.translate(x, y);
        ctx.rotate(t * 0.15);
        for (let i = 0; i < 6; i++) {
          const a1 = (i / 6) * TAU, a2 = ((i + 1) / 6) * TAU;
          ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)';
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(a1) * r * 1.1, Math.sin(a1) * r * 1.1);
          ctx.lineTo(Math.cos(a2) * r * 1.1, Math.sin(a2) * r * 1.1);
          ctx.fill();
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = Math.max(1, r * 0.04);
        ctx.beginPath();
        for (let i = 0; i <= 6; i++) ctx.lineTo(Math.cos((i / 6) * TAU) * r * 0.55, Math.sin((i / 6) * TAU) * r * 0.55);
        ctx.stroke();
        break;
      }
      case 'skin-molten': {
        const glow = 0.55 + 0.45 * Math.sin(t * 3);
        ctx.strokeStyle = rgba(color, 0.6 + 0.4 * glow);
        ctx.lineWidth = Math.max(1.2, r * 0.07);
        ctx.shadowColor = color;
        ctx.shadowBlur = r * 0.4;
        for (let i = 0; i < 6; i++) {
          let a = rnd() * TAU, d = rnd() * r * 0.3;
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
          for (let s = 0; s < 4; s++) {
            a += (rnd() - 0.5) * 1.2;
            d += r * 0.25;
            ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
          }
          ctx.stroke();
        }
        break;
      }
      case 'skin-void': {
        for (let i = 0; i < 9; i++) {
          const a = rnd() * TAU + t * 0.1, d = rnd() * r * 0.8;
          ctx.fillStyle = `rgba(255,255,255,${0.4 + 0.5 * Math.sin(t * 2 + i)})`;
          ctx.beginPath();
          ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.max(0.7, r * 0.04), 0, TAU);
          ctx.fill();
        }
        break;
      }
    }
    ctx.restore();
  }

  // Specular highlight + rim light
  const hl = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, 0, x - r * 0.4, y - r * 0.45, r * 0.7);
  hl.addColorStop(0, 'rgba(255,255,255,0.35)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = rgba(color, 0.9);
  ctx.lineWidth = Math.max(1, r * 0.06);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();

  if (cos.skin === 'skin-ringed') drawRing(ctx, x, y, r, color, false);
  ctx.restore();
}

function drawRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, back: boolean): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.4);
  ctx.strokeStyle = rgba(shade(color, 0.4).replace('rgb', 'rgb'), 1);
  ctx.strokeStyle = back ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.75)';
  ctx.lineWidth = Math.max(1.5, r * 0.13);
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.75, r * 0.45, 0, back ? Math.PI : 0, back ? TAU : Math.PI);
  ctx.stroke();
  ctx.strokeStyle = rgba(color, back ? 0.35 : 0.8);
  ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 1.5, r * 0.36, 0, back ? Math.PI : 0, back ? TAU : Math.PI);
  ctx.stroke();
  ctx.restore();
}

/** Black hole with accretion disk and lensing ring. */
export function drawBlackHole(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, range: number, growth: number, t: number, giant: boolean, surge: boolean): void {
  if (growth <= 0.01) return;
  const R = r * growth;
  ctx.save();
  // Gravity well haze across the pull range
  const haze = ctx.createRadialGradient(x, y, R, x, y, range * growth);
  const hue = giant ? '255,60,90' : '150,90,255';
  haze.addColorStop(0, `rgba(${hue},${surge ? 0.32 : 0.2})`);
  haze.addColorStop(0.35, `rgba(${hue},0.07)`);
  haze.addColorStop(1, `rgba(${hue},0)`);
  ctx.fillStyle = haze;
  ctx.beginPath();
  ctx.arc(x, y, range * growth, 0, TAU);
  ctx.fill();
  // Pull range boundary (predictability: show the danger area)
  ctx.strokeStyle = `rgba(${hue},0.16)`;
  ctx.setLineDash([10, 14]);
  ctx.lineDashOffset = -t * 20;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, range * growth, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);

  // Accretion disk: rotating arcs
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 5; i++) {
    const rr = R * (1.35 + i * 0.28);
    ctx.strokeStyle = i % 2 ? `rgba(255,170,90,${0.5 - i * 0.08})` : `rgba(${hue},${0.6 - i * 0.09})`;
    ctx.lineWidth = R * (0.22 - i * 0.03);
    const a0 = t * (1.6 - i * 0.22) + i * 1.3;
    ctx.beginPath();
    ctx.arc(x, y, rr, a0, a0 + Math.PI * (1.1 + 0.15 * i));
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  // Event horizon
  const core = ctx.createRadialGradient(x, y, 0, x, y, R * 1.25);
  core.addColorStop(0, '#000');
  core.addColorStop(0.78, '#000');
  core.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, R * 1.25, 0, TAU);
  ctx.fill();
  // Photon ring
  ctx.strokeStyle = giant ? 'rgba(255,120,140,0.9)' : 'rgba(210,180,255,0.85)';
  ctx.lineWidth = Math.max(1.5, R * 0.06);
  ctx.beginPath();
  ctx.arc(x, y, R, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

const orbSpriteCache = new Map<string, HTMLCanvasElement>();
/** Pre-rendered glowing dot (fast to blit hundreds of times). */
export function glowSprite(color: string, core = 0.22): HTMLCanvasElement {
  const key = color + core;
  let c = orbSpriteCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(core, color);
  grad.addColorStop(core + 0.15, rgba(color, 0.35));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  orbSpriteCache.set(key, c);
  return c;
}

export const ORB_COLORS = ['#7df9ff', '#ffe066', '#ff8ef0', '#9dff8a'];

/** Tileable star layer. */
export function makeStarTile(size: number, count: number, maxR: number, seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const rnd = seeded(seed);
  for (let i = 0; i < count; i++) {
    const x = rnd() * size, y = rnd() * size, r = 0.3 + rnd() * maxR;
    const tint = rnd();
    g.fillStyle = tint < 0.15 ? `rgba(160,190,255,${0.4 + rnd() * 0.6})` : tint < 0.25 ? `rgba(255,210,230,${0.4 + rnd() * 0.5})` : `rgba(255,255,255,${0.3 + rnd() * 0.7})`;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
  return c;
}

/** Background grid bent towards gravity wells. view = world-space rectangle. */
export function drawWarpGrid(
  ctx: CanvasRenderingContext2D,
  view: { x0: number; y0: number; x1: number; y1: number },
  wells: { x: number; y: number; m: number }[],
  spacing: number,
  lineWidth: number,
  color = 'rgba(90,120,255,0.07)',
): void {
  const step = spacing / 3;
  const disp = (x: number, y: number): [number, number] => {
    let dx = 0, dy = 0;
    for (const w of wells) {
      const ex = w.x - x, ey = w.y - y;
      const d2 = ex * ex + ey * ey;
      const d = Math.sqrt(d2) + 1;
      const pull = Math.min(d * 0.85, w.m / (d + 60));
      dx += (ex / d) * pull;
      dy += (ey / d) * pull;
    }
    return [x + dx, y + dy];
  };
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  const gx0 = Math.floor(view.x0 / spacing) * spacing, gy0 = Math.floor(view.y0 / spacing) * spacing;
  for (let x = gx0; x <= view.x1 + spacing; x += spacing) {
    for (let y = gy0; y <= view.y1 + spacing; y += step) {
      const [px, py] = disp(x, y);
      if (y === gy0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
  }
  for (let y = gy0; y <= view.y1 + spacing; y += spacing) {
    for (let x = gx0; x <= view.x1 + spacing; x += step) {
      const [px, py] = disp(x, y);
      if (x === gx0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
}
