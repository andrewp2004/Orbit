// Canvas 2D renderer for a RenderState.
import { abilityRange, radiusForMass, ORB_RADIUS, CLUSTER_RADIUS } from '../../../shared/constants';
import type { GameEvent } from '../../../shared/sim';
import { drawBlackHole, drawPlanet, drawWarpGrid, glowSprite, makeStarTile, ORB_COLORS, rgba } from './draw';
import type { RenderState, RPlayer } from './session';

const TAU = Math.PI * 2;

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number; color: string;
  kind: 0 | 1 | 2 | 3; // dot, ring, shard, spark-line
  rot?: number; vr?: number; drag?: number; swirl?: { cx: number; cy: number };
}

interface FloatText { x: number; y: number; text: string; color: string; life: number }

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  cam = { x: 0, y: 0, zoom: 1 };
  private shake = 0;
  private trails = new Map<number, { x: number; y: number }[]>();
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  private starTiles: HTMLCanvasElement[];
  private t = 0;
  private lastPos = new Map<number, RPlayer>();
  quality: 'high' | 'low' = 'high';
  flash = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.starTiles = [makeStarTile(1024, 260, 0.9, 7), makeStarTile(1024, 90, 1.5, 13)];
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.cam.x) * this.cam.zoom + this.w / 2, y: (y - this.cam.y) * this.cam.zoom + this.h / 2 };
  }

  addShake(v: number) {
    this.shake = Math.min(18, this.shake + v);
  }

  /** Process gameplay events into visual effects. */
  handleEvents(events: GameEvent[], s: RenderState): void {
    for (const e of events) {
      if (e.t === 'death') {
        const p = this.lastPos.get(e.id) ?? s.players.find((q) => q.id === e.id);
        if (!p) continue;
        this.eliminationFx(e.x, e.y, p.color, p.cosmetics.elimFx, radiusForMass(p.mass), e.cause === 'blackhole');
        const focus = s.players.find((q) => q.id === s.myId);
        const near = focus ? Math.max(0, 1 - Math.hypot(focus.x - e.x, focus.y - e.y) / 900) : 0;
        this.addShake(near * 10 + (e.id === s.myId ? 14 : 0));
        if (e.killer === s.myId) this.texts.push({ x: e.x, y: e.y - 30, text: 'ELIMINATED', color: '#ff4fd8', life: 1.6 });
        this.trails.delete(e.id);
      } else if (e.t === 'hit') {
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * TAU, sp = 100 + Math.random() * 300 * e.power;
          this.particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.4, max: 0.4, size: 2 + Math.random() * 2, color: '#ffffff', kind: 3, drag: 4 });
        }
        if (e.a === s.myId || e.b === s.myId) this.addShake(3 + e.power * 8);
      } else if (e.t === 'dash') {
        const p = s.players.find((q) => q.id === e.id);
        if (p) {
          this.particles.push({ x: p.x, y: p.y, vx: 0, vy: 0, life: 0.35, max: 0.35, size: radiusForMass(p.mass) * 1.2, color: p.color, kind: 1 });
        }
      } else if (e.t === 'pickup') {
        if (e.value >= 5) {
          this.texts.push({ x: e.x, y: e.y, text: `+${e.value * 10}`, color: '#ffe066', life: 1.1 });
          this.burst(e.x, e.y, '#ffe066', 18, 220, 0.6);
        } else if (e.id === s.myId && this.quality === 'high') {
          this.particles.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: 0.25, max: 0.25, size: 10, color: '#ffffff', kind: 1 });
        }
      } else if (e.t === 'space' && e.kind === 'giant') {
        this.particles.push({ x: e.x, y: e.y, vx: 0, vy: 0, life: 1.4, max: 1.4, size: 600, color: '#ff4060', kind: 1 });
      } else if (e.t === 'space' && e.kind === 'storm') {
        this.burst(e.x, e.y, '#7df9ff', 60, 420, 1.2);
      }
    }
  }

  private burst(x: number, y: number, color: string, n: number, speed: number, life: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: life * (0.6 + Math.random() * 0.4), max: life, size: 2 + Math.random() * 3, color, kind: 0, drag: 2.5 });
    }
  }

  private eliminationFx(x: number, y: number, color: string, fx: string, r: number, sucked: boolean) {
    switch (fx) {
      case 'fx-nova':
        this.burst(x, y, color, 30, 380, 0.9);
        for (let i = 0; i < 3; i++) this.particles.push({ x, y, vx: 0, vy: 0, life: 0.6 + i * 0.2, max: 0.6 + i * 0.2, size: r * (4 + i * 2), color, kind: 1 });
        break;
      case 'fx-shatter':
        for (let i = 0; i < 18; i++) {
          const a = Math.random() * TAU, sp = 120 + Math.random() * 280;
          this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1.2, max: 1.2, size: r * (0.25 + Math.random() * 0.35), color, kind: 2, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 12, drag: 1.5 });
        }
        break;
      case 'fx-vortex':
        for (let i = 0; i < 40; i++) {
          const a = Math.random() * TAU, d = r * (1 + Math.random() * 4);
          this.particles.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: 0, vy: 0, life: 1, max: 1, size: 2 + Math.random() * 3, color, kind: 0, swirl: { cx: x, cy: y } });
        }
        break;
      case 'fx-supernova':
        this.particles.push({ x, y, vx: 0, vy: 0, life: 0.5, max: 0.5, size: r * 10, color: '#ffffff', kind: 1 });
        this.burst(x, y, '#ffffff', 30, 600, 1.2);
        this.burst(x, y, color, 50, 450, 1.5);
        for (let i = 0; i < 4; i++) this.particles.push({ x, y, vx: 0, vy: 0, life: 0.8 + i * 0.25, max: 0.8 + i * 0.25, size: r * (5 + i * 3), color: i % 2 ? '#ffffff' : color, kind: 1 });
        break;
      default:
        this.burst(x, y, color, 36, 340, 1);
        this.particles.push({ x, y, vx: 0, vy: 0, life: 0.5, max: 0.5, size: r * 4, color, kind: 1 });
    }
    if (sucked) this.particles.push({ x, y, vx: 0, vy: 0, life: 0.7, max: 0.7, size: r * 3, color: '#b98cff', kind: 1 });
  }

  render(s: RenderState, dt: number, focusId: number): void {
    this.t += dt;
    const ctx = this.ctx;
    const focus = s.players.find((p) => p.id === focusId);

    // --- camera
    if (focus) {
      const r = radiusForMass(focus.mass);
      const base = Math.min(this.w, this.h) / 950 + Math.max(this.w, this.h) / 4200;
      const targetZoom = base * (1 / (1 + Math.max(0, r - 20) / 110));
      this.cam.zoom += (targetZoom - this.cam.zoom) * (1 - Math.exp(-dt * 2));
      const follow = focusId === s.myId ? 1 - Math.exp(-dt * 18) : 1 - Math.exp(-dt * 5);
      this.cam.x += (focus.x - this.cam.x) * follow;
      this.cam.y += (focus.y - this.cam.y) * follow;
    }
    this.shake *= Math.exp(-dt * 6);
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    const z = this.cam.zoom;

    // --- background
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#04050d';
    ctx.fillRect(0, 0, this.w, this.h);
    const vignette = ctx.createRadialGradient(this.w / 2, this.h / 2, 0, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
    vignette.addColorStop(0, '#0a0c22');
    vignette.addColorStop(1, '#03040a');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, this.w, this.h);
    this.starTiles.forEach((tile, i) => {
      const par = i === 0 ? 0.08 : 0.18;
      const ox = -((this.cam.x * par) % 1024) - 1024, oy = -((this.cam.y * par) % 1024) - 1024;
      for (let x = ox; x < this.w; x += 1024) for (let y = oy; y < this.h; y += 1024) ctx.drawImage(tile, x, y);
    });

    // --- world transform
    ctx.setTransform(z * this.dpr, 0, 0, z * this.dpr, (this.w / 2 - this.cam.x * z + sx) * this.dpr, (this.h / 2 - this.cam.y * z + sy) * this.dpr);
    const view = { x0: this.cam.x - this.w / 2 / z - 50, y0: this.cam.y - this.h / 2 / z - 50, x1: this.cam.x + this.w / 2 / z + 50, y1: this.cam.y + this.h / 2 / z + 50 };
    const inView = (x: number, y: number, r: number) => x + r > view.x0 && x - r < view.x1 && y + r > view.y0 && y - r < view.y1;

    // Warped spacetime grid
    const wells = s.holes.map((b) => ({ x: b.x, y: b.y, m: (b.giant ? 34000 : 16000) * b.growth * (s.surge ? 1.5 : 1) }));
    if (this.quality === 'high') {
      for (const p of s.players) if (p.alive && p.ability) wells.push({ x: p.x, y: p.y, m: (p.ability === 1 ? 5000 : -5000) * Math.sqrt(p.mass / 10) });
    }
    drawWarpGrid(ctx, view, wells, 100, 1.4 / z, 'rgba(90,120,255,0.09)');

    // Arena edge + shrinking zone
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
    ctx.arc(0, 0, s.arena, 0, TAU, true);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');
    if (s.zone < s.arena - 1) {
      ctx.beginPath();
      ctx.arc(0, 0, s.arena, 0, TAU);
      ctx.arc(0, 0, s.zone, 0, TAU, true);
      ctx.fillStyle = `rgba(255,40,90,${0.08 + 0.03 * Math.sin(this.t * 3)})`;
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(255,80,130,0.75)';
      ctx.lineWidth = 4 / z;
      ctx.setLineDash([30 / z, 18 / z]);
      ctx.lineDashOffset = this.t * 40;
      ctx.beginPath();
      ctx.arc(0, 0, s.zone, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const edgeGrad = ctx.createRadialGradient(0, 0, s.arena - 140, 0, 0, s.arena);
    edgeGrad.addColorStop(0, 'rgba(255,50,80,0)');
    edgeGrad.addColorStop(1, 'rgba(255,50,80,0.22)');
    ctx.fillStyle = edgeGrad;
    ctx.beginPath();
    ctx.arc(0, 0, s.arena, 0, TAU);
    ctx.arc(0, 0, s.arena - 140, 0, TAU, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,70,100,0.9)';
    ctx.lineWidth = 5 / z;
    ctx.beginPath();
    ctx.arc(0, 0, s.arena, 0, TAU);
    ctx.stroke();
    ctx.restore();

    // Black holes
    for (const b of s.holes) {
      if (inView(b.x, b.y, b.range)) drawBlackHole(ctx, b.x, b.y, b.r, b.range, b.growth, this.t, b.giant, s.surge);
    }

    // Orbs
    ctx.globalCompositeOperation = 'lighter';
    for (const o of s.orbs) {
      if (!inView(o.x, o.y, 40)) continue;
      if (o.kind === 1) {
        const pulse = 1 + 0.15 * Math.sin(this.t * 4 + o.id);
        const size = CLUSTER_RADIUS * 5 * pulse;
        ctx.drawImage(glowSprite('#ffd23f', 0.2), o.x - size / 2, o.y - size / 2, size, size);
        ctx.save();
        ctx.translate(o.x, o.y);
        ctx.rotate(this.t * 1.5 + o.id);
        ctx.strokeStyle = 'rgba(255,230,140,0.8)';
        ctx.lineWidth = 2;
        ctx.strokeRect(-CLUSTER_RADIUS * 0.7, -CLUSTER_RADIUS * 0.7, CLUSTER_RADIUS * 1.4, CLUSTER_RADIUS * 1.4);
        ctx.restore();
      } else {
        const color = o.kind === 2 ? '#ffffff' : ORB_COLORS[o.id % ORB_COLORS.length];
        const size = ORB_RADIUS * (o.kind === 2 ? 4.2 : 3.4) * (1 + 0.12 * Math.sin(this.t * 3 + o.id * 1.7)) * (o.value > 1 ? 1.3 : 1);
        ctx.drawImage(glowSprite(color), o.x - size / 2, o.y - size / 2, size, size);
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // Trails
    for (const p of s.players) {
      if (!p.alive) continue;
      let tr = this.trails.get(p.id);
      if (!tr) this.trails.set(p.id, (tr = []));
      tr.push({ x: p.x, y: p.y });
      const maxLen = p.cosmetics.trail === 'trail-ribbon' ? 26 : 16;
      while (tr.length > maxLen) tr.shift();
      if (!inView(p.x, p.y, 400)) continue;
      this.drawTrail(p, tr);
    }

    // Players (smaller first so big planets render on top)
    const sorted = [...s.players].filter((p) => p.alive).sort((a, b) => a.mass - b.mass);
    for (const p of sorted) {
      const r = radiusForMass(p.mass);
      if (!inView(p.x, p.y, abilityRange(r))) continue;
      this.drawAbility(p, r);
      if (p.dashing) {
        ctx.strokeStyle = rgba(p.color, 0.5);
        ctx.lineWidth = r * 0.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.08, p.y - p.vy * 0.08);
        ctx.stroke();
      }
      drawPlanet(ctx, p.x, p.y, r, p.color, p.cosmetics, { t: this.t, seed: p.id, alpha: p.connected ? 1 : 0.45, quality: this.quality });
      if (p.protected) {
        ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.25 * Math.sin(this.t * 10)})`;
        ctx.lineWidth = 2 / z;
        ctx.setLineDash([6 / z, 6 / z]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 8, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (p.id === s.myId) {
        // Aim pointer
        const ax = p.x + Math.cos(p.aim) * (r + 14), ay = p.y + Math.sin(p.aim) * (r + 14);
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(p.aim);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.moveTo(8, 0);
        ctx.lineTo(-4, -6);
        ctx.lineTo(-4, 6);
        ctx.fill();
        ctx.restore();
      }
      this.lastPos.set(p.id, p);
    }

    // Particles
    ctx.globalCompositeOperation = 'lighter';
    this.particles = this.particles.filter((pt) => (pt.life -= dt) > 0);
    for (const pt of this.particles) {
      const a = pt.life / pt.max;
      if (pt.swirl) {
        const dx = pt.swirl.cx - pt.x, dy = pt.swirl.cy - pt.y;
        pt.vx = dx * 3 - dy * 4;
        pt.vy = dy * 3 + dx * 4;
      }
      if (pt.drag) { const k = Math.exp(-pt.drag * dt); pt.vx *= k; pt.vy *= k; }
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      if (pt.kind === 0) {
        ctx.fillStyle = rgba(pt.color, a);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size * (0.5 + a * 0.5), 0, TAU);
        ctx.fill();
      } else if (pt.kind === 1) {
        ctx.strokeStyle = rgba(pt.color, a * 0.8);
        ctx.lineWidth = 3 / z + pt.size * 0.04 * a;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size * (1 - a * 0.85), 0, TAU);
        ctx.stroke();
      } else if (pt.kind === 2) {
        pt.rot! += pt.vr! * dt;
        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(pt.rot!);
        ctx.fillStyle = rgba(pt.color, a);
        ctx.beginPath();
        ctx.moveTo(pt.size, 0);
        ctx.lineTo(-pt.size * 0.6, pt.size * 0.5);
        ctx.lineTo(-pt.size * 0.4, -pt.size * 0.6);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.strokeStyle = rgba(pt.color, a);
        ctx.lineWidth = pt.size / 2;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x - pt.vx * 0.05, pt.y - pt.vy * 0.05);
        ctx.stroke();
      }
    }
    if (this.particles.length > 1500) this.particles.splice(0, this.particles.length - 1500);
    ctx.globalCompositeOperation = 'source-over';

    // Labels (screen-space sized)
    ctx.textAlign = 'center';
    for (const p of sorted) {
      const r = radiusForMass(p.mass);
      if (!inView(p.x, p.y, r + 40)) continue;
      const fs = Math.max(11, Math.min(16, 10 + r * 0.12)) / z;
      ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = p.id === s.myId ? 'rgba(255,255,255,0.95)' : 'rgba(220,230,255,0.8)';
      ctx.fillText(p.connected ? p.name : `${p.name} (reconnecting…)`, p.x, p.y - r - 10 / z);
    }
    this.texts = this.texts.filter((t) => (t.life -= dt) > 0);
    for (const t of this.texts) {
      ctx.font = `800 ${18 / z}px Orbitron, Inter, sans-serif`;
      ctx.fillStyle = rgba(t.color, Math.min(1, t.life * 2));
      ctx.fillText(t.text, t.x, t.y - (1.5 - t.life) * 40);
    }

    // Screen-space flash (e.g. when you're eliminated)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.5})`;
      ctx.fillRect(0, 0, this.w, this.h);
      this.flash = Math.max(0, this.flash - dt * 2);
    }
    // Danger vignette when outside the zone
    const me = s.players.find((p) => p.id === s.myId);
    if (me && me.alive && Math.hypot(me.x, me.y) > s.zone) {
      const g = ctx.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.3, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.7);
      g.addColorStop(0, 'rgba(255,0,60,0)');
      g.addColorStop(1, `rgba(255,0,60,${0.25 + 0.1 * Math.sin(this.t * 8)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }

  private drawTrail(p: RPlayer, tr: { x: number; y: number }[]) {
    const ctx = this.ctx;
    const r = radiusForMass(p.mass);
    const kind = p.cosmetics.trail;
    if (kind === 'trail-none' || tr.length < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (kind === 'trail-ribbon') {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 1; i < tr.length; i++) {
        const a = i / tr.length;
        ctx.strokeStyle = rgba(p.color, a * 0.5);
        ctx.lineWidth = r * 1.4 * a;
        ctx.beginPath();
        ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
        ctx.lineTo(tr[i].x, tr[i].y);
        ctx.stroke();
      }
    } else if (kind === 'trail-sparkle' || kind === 'trail-stardust') {
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > 40 && Math.random() < 0.6 && this.particles.length < 1200) {
        const colors = kind === 'trail-stardust' ? ['#ffffff', '#ffe066', '#ff8ef0', '#7df9ff'] : [p.color, '#ffffff'];
        this.particles.push({
          x: p.x + (Math.random() - 0.5) * r, y: p.y + (Math.random() - 0.5) * r,
          vx: -p.vx * 0.1 + (Math.random() - 0.5) * 40, vy: -p.vy * 0.1 + (Math.random() - 0.5) * 40,
          life: 0.7, max: 0.7, size: 1.5 + Math.random() * 2.5, color: colors[Math.floor(Math.random() * colors.length)], kind: 0,
        });
      }
      for (let i = 0; i < tr.length; i += 2) {
        const a = i / tr.length;
        ctx.fillStyle = rgba(p.color, a * 0.15);
        ctx.beginPath();
        ctx.arc(tr[i].x, tr[i].y, r * a * 0.8, 0, TAU);
        ctx.fill();
      }
    } else {
      // comet
      for (let i = 0; i < tr.length; i++) {
        const a = i / tr.length;
        ctx.fillStyle = rgba(p.color, a * 0.22);
        ctx.beginPath();
        ctx.arc(tr[i].x, tr[i].y, r * (0.3 + a * 0.6), 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawAbility(p: RPlayer, r: number) {
    if (!p.ability) return;
    const ctx = this.ctx;
    const range = abilityRange(r);
    const attract = p.ability === 1;
    const col = attract ? '#7df9ff' : '#ff6b9a';
    ctx.save();
    const g = ctx.createRadialGradient(p.x, p.y, r, p.x, p.y, range);
    g.addColorStop(0, rgba(col, 0.16));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, range, 0, TAU);
    ctx.fill();
    ctx.lineWidth = 2.5 / this.cam.zoom;
    for (let i = 0; i < 4; i++) {
      let ph = ((this.t * 1.4 + i / 4) % 1);
      if (attract) ph = 1 - ph;
      const rr = r + (range - r) * ph;
      ctx.strokeStyle = rgba(col, 0.5 * Math.sin(ph * Math.PI));
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, TAU);
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(col, 0.25);
    ctx.setLineDash([4 / this.cam.zoom, 8 / this.cam.zoom]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, range, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /** Minimap in its own small canvas. */
  renderMinimap(mm: HTMLCanvasElement, s: RenderState, focusId: number): void {
    const size = mm.clientWidth;
    const dpr = this.dpr;
    if (mm.width !== size * dpr) { mm.width = size * dpr; mm.height = size * dpr; }
    const c = mm.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, size, size);
    const k = (size / 2 - 4) / s.arena;
    c.translate(size / 2, size / 2);
    c.fillStyle = 'rgba(8,10,30,0.75)';
    c.beginPath(); c.arc(0, 0, s.arena * k, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,70,100,0.8)';
    c.lineWidth = 1.5;
    c.stroke();
    if (s.zone < s.arena) {
      c.strokeStyle = 'rgba(255,120,160,0.9)';
      c.setLineDash([3, 3]);
      c.beginPath(); c.arc(0, 0, s.zone * k, 0, TAU); c.stroke();
      c.setLineDash([]);
    }
    for (const b of s.holes) {
      c.fillStyle = b.giant ? 'rgba(255,60,90,0.35)' : 'rgba(150,90,255,0.3)';
      c.beginPath(); c.arc(b.x * k, b.y * k, b.range * b.growth * k * 0.6, 0, TAU); c.fill();
      c.fillStyle = '#000';
      c.strokeStyle = b.giant ? '#ff6680' : '#b98cff';
      c.beginPath(); c.arc(b.x * k, b.y * k, Math.max(2.5, b.r * k * 1.5), 0, TAU); c.fill(); c.stroke();
    }
    for (const o of s.orbs) {
      if (o.kind !== 1) continue;
      c.fillStyle = '#ffd23f';
      c.fillRect(o.x * k - 1.5, o.y * k - 1.5, 3, 3);
    }
    for (const p of s.players) {
      if (!p.alive) continue;
      const me = p.id === focusId;
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x * k, p.y * k, me ? 4 : Math.max(2.2, radiusForMass(p.mass) * k * 1.2), 0, TAU);
      c.fill();
      if (me) { c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke(); }
    }
    // Camera view rectangle
    const vw = this.w / this.cam.zoom, vh = this.h / this.cam.zoom;
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    c.lineWidth = 1;
    c.strokeRect((this.cam.x - vw / 2) * k, (this.cam.y - vh / 2) * k, vw * k, vh * k);
  }
}
