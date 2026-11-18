import React, { useEffect, useRef } from 'react';
import type { Cosmetics } from '../../shared/cosmetics';
import { colorHex } from '../../shared/cosmetics';
import { drawPlanet } from './game/draw';
import { audio } from './audio';

export function Panel(props: { title: string; onBack?: () => void; children: React.ReactNode; wide?: boolean; right?: React.ReactNode }) {
  return (
    <div className={`panel ${props.wide ? 'wide' : ''}`}>
      <div className="panel-head">
        {props.onBack && (
          <button className="back" onClick={() => { audio.click(); props.onBack!(); }} aria-label="Back">←</button>
        )}
        <h2>{props.title}</h2>
        <div className="panel-right">{props.right}</div>
      </div>
      <div className="panel-body">{props.children}</div>
    </div>
  );
}

export function Btn(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const { variant = 'primary', className, onClick, ...rest } = props;
  return <button {...rest} className={`btn ${variant} ${className ?? ''}`} onClick={(e) => { audio.click(); onClick?.(e); }} />;
}

/** Animated planet preview using the in-game renderer. */
export function PlanetPreview({ cosmetics, size = 120, seed = 3 }: { cosmetics: Cosmetics; size?: number; seed?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cosRef = useRef(cosmetics);
  cosRef.current = cosmetics;
  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawPlanet(ctx, size / 2, size / 2, size * 0.24, colorHex(cosRef.current), cosRef.current, { t, seed });
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [size, seed]);
  return <canvas ref={ref} style={{ width: size, height: size }} className="planet-preview" />;
}

export function Dot({ color }: { color: string }) {
  return <span className="dot" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />;
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
