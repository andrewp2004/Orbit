// Animated space background for menus: drifting stars, a black hole with orbiting planets, warped grid.
import React, { useEffect, useRef } from 'react';
import { drawBlackHole, drawPlanet, drawWarpGrid, makeStarTile } from '../game/draw';
import { PLANET_COLORS } from '../../../shared/constants';

const planets = [
  { orbit: 260, speed: 0.22, r: 16, color: PLANET_COLORS[0], skin: 'skin-banded', phase: 0 },
  { orbit: 380, speed: -0.15, r: 24, color: PLANET_COLORS[1], skin: 'skin-ringed', phase: 2 },
  { orbit: 520, speed: 0.1, r: 12, color: PLANET_COLORS[2], skin: 'skin-cratered', phase: 4 },
  { orbit: 660, speed: -0.07, r: 30, color: PLANET_COLORS[5], skin: 'skin-swirl', phase: 1 },
  { orbit: 170, speed: 0.35, r: 9, color: PLANET_COLORS[3], skin: 'skin-plain', phase: 5 },
];

export function MenuBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const tiles = [makeStarTile(1024, 300, 0.8, 3), makeStarTile(1024, 80, 1.6, 9)];
    let raf = 0, w = 0, h = 0, dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth; h = window.innerHeight;
      c.width = w * dpr; c.height = h * dpr;
    };
    resize();
    window.addEventListener('resize', resize);
    const t0 = performance.now();
    const trails: { x: number; y: number }[][] = planets.map(() => []);
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = ctx.createRadialGradient(w * 0.7, h * 0.55, 0, w * 0.7, h * 0.55, Math.max(w, h));
      g.addColorStop(0, '#0d1030');
      g.addColorStop(1, '#03040a');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      tiles.forEach((tile, i) => {
        const ox = -((t * (6 + i * 10)) % 1024), oy = -((t * (2 + i * 4)) % 1024);
        for (let x = ox; x < w; x += 1024) for (let y = oy; y < h; y += 1024) ctx.drawImage(tile, x, y);
      });
      const scale = Math.min(1, Math.max(w, h) / 1500);
      const cx = w * (w > 800 ? 0.72 : 0.5), cy = h * 0.55;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, cx * dpr, cy * dpr);
      drawWarpGrid(ctx, { x0: -cx / scale - 100, y0: -cy / scale - 100, x1: (w - cx) / scale + 100, y1: (h - cy) / scale + 100 }, [{ x: 0, y: 0, m: 26000 }], 90, 1, 'rgba(90,120,255,0.08)');
      drawBlackHole(ctx, 0, 0, 55, 420, 1, t, false, false);
      planets.forEach((p, i) => {
        const a = p.phase + t * p.speed;
        const x = Math.cos(a) * p.orbit, y = Math.sin(a) * p.orbit * 0.62;
        const tr = trails[i];
        tr.push({ x, y });
        if (tr.length > 40) tr.shift();
        ctx.globalCompositeOperation = 'lighter';
        tr.forEach((q, j) => {
          ctx.fillStyle = `${p.color}${Math.floor((j / tr.length) * 40).toString(16).padStart(2, '0')}`;
          ctx.beginPath();
          ctx.arc(q.x, q.y, p.r * (0.2 + (j / tr.length) * 0.5), 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalCompositeOperation = 'source-over';
        drawPlanet(ctx, x, y, p.r, p.color, { color: 'c0', glow: 'glow-soft', skin: p.skin, trail: 'trail-none', elimFx: 'fx-burst' }, { t, seed: i + 2 });
      });
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);
  return <canvas ref={ref} className="menu-bg" />;
}
