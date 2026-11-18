import React, { useEffect, useRef, useState } from 'react';
import type { Difficulty } from '../../../shared/constants';
import { radiusForMass, DASH_COOLDOWN } from '../../../shared/constants';
import type { GameEvent, MatchResult } from '../../../shared/sim';
import { NO_INPUT } from '../../../shared/sim';
import { Renderer } from '../game/renderer';
import { InputManager } from '../game/input';
import type { EndInfo, RenderState, Session } from '../game/session';
import { audio } from '../audio';
import { getSettings, onSettings } from '../settings';
import { api, cacheProfile, Profile } from '../api';
import { onStatus, ConnStatus } from '../net';
import { Btn, Dot, fmtTime } from '../ui';

interface Hud {
  score: number; mass: number; energy: number; kills: number; alive: number; total: number;
  timeLeft: number; dashCd: number; ability: number; phase: string; countdown: number;
  top: { id: number; name: string; color: string; score: number }[];
  myAlive: boolean; spectating: string | null; outside: boolean;
}

interface Feed { id: number; text: string; mine: boolean; t: number }

export interface GameProps {
  session: Session;
  online: boolean;
  isHost?: boolean;
  difficulty?: Difficulty;
  onExit: () => void;
  onPlayAgain?: () => void;
  onBackToLobby?: () => void;
  onRematch?: () => void;
  onProfile: (p: Profile) => void;
}

const SPACE_TEXT: Record<string, string> = {
  storm: '⚡ ENERGY STORM: orbs are flooding in!',
  giant: '⚠ A GIANT BLACK HOLE IS FORMING',
  surge: '⚠ GRAVITY SURGE: black holes pull harder',
  escalation: 'A new black hole has appeared',
  zone: '⚠ The safe zone is collapsing. Stay inside the ring!',
};

function deathText(e: Extract<GameEvent, { t: 'death' }>, name: (id: number) => string): string {
  const v = name(e.id), k = e.killer >= 0 ? name(e.killer) : null;
  switch (e.cause) {
    case 'consumed': return `${k} consumed ${v}`;
    case 'blackhole': return k ? `${k} pushed ${v} into a black hole` : `${v} fell into a black hole`;
    case 'edge': return k ? `${k} knocked ${v} out of the arena` : `${v} drifted out of the arena`;
    case 'zone': return k ? `${k} trapped ${v} outside the zone` : `${v} was lost outside the zone`;
    default: return `${v} left the match`;
  }
}

export function GameScreen(props: GameProps) {
  const { session } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<InputManager | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [banner, setBanner] = useState<{ text: string; key: number } | null>(null);
  const [death, setDeath] = useState<{ placement: number; text: string } | null>(null);
  const [deathDismissed, setDeathDismissed] = useState(false);
  const [end, setEnd] = useState<EndInfo | null>(null);
  const [soloXp, setSoloXp] = useState<{ gained: number; newUnlocks: string[] } | null | 'offline'>(null);
  const [paused, setPaused] = useState(false);
  const [conn, setConn] = useState<{ s: ConnStatus; ping: number }>({ s: 'connected', ping: 0 });
  const [showMinimap, setShowMinimap] = useState(getSettings().showMinimap);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0) && window.matchMedia('(pointer: coarse)').matches;

  useEffect(() => onSettings((s) => setShowMinimap(s.showMinimap)), []);
  useEffect(() => (session.kind === 'online' ? onStatus((s, ping) => setConn({ s, ping })) : undefined), [session]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new Renderer(canvas);
    renderer.quality = getSettings().quality;
    const offSettings = onSettings((s) => (renderer.quality = s.quality));
    const input = new InputManager(canvas);
    inputRef.current = input;
    let spectateId = -1;
    let wasAlive = true;
    let lastCount = -1;
    let ended = false;
    let submitted = false;
    let zoneAnnounced = false;
    let lastHud = 0;
    let feedId = 0;
    let last = performance.now();
    let raf = 0;
    let firstFrame = true;
    let lastPhase = '';

    const nameOf = (s: RenderState, id: number) => s.players.find((p) => p.id === id)?.name ?? '???';

    input.onSpectateNext = () => {
      const s = session.state();
      const me = s.players.find((p) => p.id === s.myId);
      if (me?.alive) return;
      const alive = s.players.filter((p) => p.alive);
      if (alive.length === 0) return;
      const idx = alive.findIndex((p) => p.id === spectateId);
      spectateId = alive[(idx + 1) % alive.length].id;
    };

    const submitSolo = (s: RenderState) => {
      if (submitted || session.kind !== 'solo') return;
      submitted = true;
      const me = s.players.find((p) => p.id === s.myId)!;
      const results = session.ended()?.results;
      const placement = results?.find((r) => r.id === s.myId)?.placement ?? s.players.filter((p) => p.alive).length + 1;
      const won = results?.find((r) => r.id === s.myId)?.won ?? false;
      api<{ gained: number; newUnlocks: string[]; profile: Profile }>('/api/solo-result', {
        body: { score: Math.floor(me.score), kills: me.kills, won, placement, players: s.players.length, durationSec: Math.max(1, Math.round(s.time)), difficulty: props.difficulty },
      })
        .then((r) => { setSoloXp({ gained: r.gained, newUnlocks: r.newUnlocks }); cacheProfile(r.profile); props.onProfile(r.profile); })
        .catch(() => setSoloXp('offline'));
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      let s = session.state();
      const me = s.players.find((p) => p.id === s.myId);
      const myAlive = !!me?.alive;
      const scr = me ? renderer.worldToScreen(me.x, me.y) : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      let inp = input.read(scr.x, scr.y);
      if (!myAlive || pausedRef.current) inp = { ...NO_INPUT, aim: inp.aim };
      if (!(session.kind === 'solo' && pausedRef.current)) session.update(dt, inp);
      s = session.state();
      const meNow = s.players.find((p) => p.id === s.myId);

      // Events -> effects, sounds, kill feed
      const events = session.drainEvents();
      renderer.handleEvents(events, s);
      for (const e of events) {
        if (e.t === 'pickup' && e.id === s.myId) audio.pickup(e.value);
        else if (e.t === 'dash' && e.id === s.myId) audio.dash();
        else if (e.t === 'hit' && (e.a === s.myId || e.b === s.myId)) audio.hit(e.power);
        else if (e.t === 'death') {
          const d = meNow ? Math.hypot(meNow.x - e.x, meNow.y - e.y) : 9999;
          audio.elimination(e.id === s.myId || e.killer === s.myId ? 1 : Math.max(0, 1 - d / 1200) * 0.6);
          const text = deathText(e, (id) => nameOf(s, id));
          const mine = e.id === s.myId || e.killer === s.myId;
          setFeed((f) => [...f.slice(-5), { id: feedId++, text, mine, t: performance.now() }]);
          if (e.id === s.myId) {
            const placement = s.players.filter((p) => p.alive).length + 1;
            setDeath({ placement, text: e.killer >= 0 ? `by ${nameOf(s, e.killer)}` : text.replace(nameOf(s, e.id), 'You') });
          }
        } else if (e.t === 'space') {
          audio.warning();
          setBanner({ text: SPACE_TEXT[e.kind], key: now });
        } else if (e.t === 'go') {
          audio.beep(true);
          setBanner({ text: 'GO!', key: now });
        }
      }
      if (!zoneAnnounced && s.zone < s.arena - 5 && s.phase === 'playing') {
        zoneAnnounced = true;
        setBanner({ text: SPACE_TEXT.zone, key: now });
        audio.warning();
      }
      if (s.phase === 'countdown') {
        const c = Math.ceil(s.countdown);
        if (c !== lastCount && c > 0) { lastCount = c; if (!firstFrame) audio.beep(false); }
      }
      if (lastPhase === 'ended' && s.phase !== 'ended') {
        // Rematch started in the same room: reset per-match UI.
        ended = false; submitted = false; zoneAnnounced = false; wasAlive = true; spectateId = -1; lastCount = -1;
        setEnd(null); setDeath(null); setDeathDismissed(false); setFeed([]);
      }
      lastPhase = s.phase;
      firstFrame = false;

      // Abilities hum / damage
      audio.ability(meNow?.alive && !pausedRef.current ? meNow.ability : 0);
      const outside = !!meNow?.alive && Math.hypot(meNow.x, meNow.y) > s.zone;
      if (outside) audio.damage();

      if (wasAlive && meNow && !meNow.alive && s.phase !== 'countdown') {
        renderer.flash = 1;
        if (s.phase !== 'ended') audio.lose();
        submitSolo(s);
      }
      if (meNow?.alive) wasAlive = true;
      if (meNow && !meNow.alive) wasAlive = false;

      // Camera focus (spectate when eliminated or watching a match in progress)
      let focusId = s.myId;
      if (!meNow?.alive) {
        const target = s.players.find((p) => p.id === spectateId && p.alive);
        if (!target) {
          const leader = s.players.filter((p) => p.alive).sort((a, b) => b.score - a.score)[0];
          spectateId = leader?.id ?? -1;
        }
        focusId = spectateId;
      }

      renderer.render(s, dt, focusId);
      if (miniRef.current) renderer.renderMinimap(miniRef.current, s, focusId);

      const endInfo = session.ended();
      if (endInfo && !ended) {
        ended = true;
        const mine = endInfo.results.find((r: MatchResult) => r.id === s.myId);
        if (mine?.won) audio.win();
        submitSolo(s);
        setEnd(endInfo);
      }

      if (now - lastHud > 100) {
        lastHud = now;
        const alive = s.players.filter((p) => p.alive);
        const spec = !meNow?.alive ? s.players.find((p) => p.id === focusId) : undefined;
        setHud({
          score: Math.floor(meNow?.score ?? 0), mass: meNow?.mass ?? 0, energy: meNow?.energy ?? 0, kills: meNow?.kills ?? 0,
          alive: alive.length, total: s.players.length, timeLeft: s.duration - s.time, dashCd: meNow?.dashCd ?? 0,
          ability: meNow?.ability ?? 0, phase: s.phase, countdown: s.countdown,
          top: [...s.players].filter((p) => p.alive).sort((a, b) => b.score - a.score).slice(0, 5).map((p) => ({ id: p.id, name: p.name, color: p.color, score: Math.floor(p.score) })),
          myAlive: !!meNow?.alive, spectating: spec ? spec.name : null, outside,
        });
      }
    };
    raf = requestAnimationFrame(frame);

    const onResize = () => renderer.resize();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPaused((p) => !p);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      input.destroy();
      offSettings();
      audio.ability(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Fade old kill feed entries
  useEffect(() => {
    const t = setInterval(() => setFeed((f) => f.filter((x) => performance.now() - x.t < 7000)), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 3200);
    return () => clearTimeout(t);
  }, [banner]);

  const myId = session.state().myId;
  const isSolo = session.kind === 'solo';
  const showDeath = death && !end && !deathDismissed;

  return (
    <div className="game">
      <canvas ref={canvasRef} className="game-canvas" />

      {hud && (
        <>
          <div className="hud-tl">
            <div className="hud-card stats">
              <div><span>Score</span><b>{hud.score.toLocaleString()}</b></div>
              <div><span>Mass</span><b>{Math.round(hud.mass)}</b></div>
              <div><span>Elims</span><b>{hud.kills}</b></div>
            </div>
            <div className="hud-card top5">
              {hud.top.map((p, i) => (
                <div key={p.id} className={p.id === myId ? 'me' : ''}><span className="muted">{i + 1}</span><Dot color={p.color} /><span className="n">{p.name}</span><b>{p.score}</b></div>
              ))}
            </div>
          </div>

          <div className="hud-top">
            <div className="timer">{fmtTime(hud.timeLeft)}</div>
            <div className="alive">{hud.alive} / {hud.total} alive</div>
          </div>

          <div className="hud-tr">
            {showMinimap && <canvas ref={miniRef} className="minimap" />}
            {session.kind === 'online' && (
              <div className={`conn conn-${conn.s}`}><span className="conn-dot" />{conn.s === 'connected' ? `${conn.ping} ms` : conn.s === 'reconnecting' ? 'Reconnecting…' : conn.s}</div>
            )}
            <div className="feed">
              {feed.map((f) => <div key={f.id} className={f.mine ? 'mine' : ''}>{f.text}</div>)}
            </div>
          </div>

          {hud.phase === 'countdown' && hud.countdown > 0 && <div className="countdown" key={Math.ceil(hud.countdown)}>{Math.ceil(hud.countdown)}</div>}
          {banner && <div className="banner" key={banner.key}>{banner.text}</div>}
          {hud.outside && <div className="warning">OUTSIDE THE SAFE ZONE: losing mass!</div>}
          {hud.spectating && !end && (
            <div className="spectating">Spectating <b>{hud.spectating}</b> · click or Tab to switch</div>
          )}

          {hud.myAlive && (
            <div className="hud-bottom">
              <div className="energy">
                <div className="energy-label">ENERGY</div>
                <div className="energy-bar"><div style={{ width: `${hud.energy}%` }} className={hud.energy < 20 ? 'low' : ''} /></div>
              </div>
              <div className="abilities">
                <div className={`ability attract ${hud.ability === 1 ? 'on' : ''} ${hud.energy < 2 ? 'off' : ''}`}><b>ATTRACT</b><span>{isTouch ? 'hold' : 'L-click'}</span></div>
                <div className={`ability repel ${hud.ability === 2 ? 'on' : ''} ${hud.energy < 2 ? 'off' : ''}`}><b>REPEL</b><span>{isTouch ? 'hold' : 'R-click'}</span></div>
                <div className={`ability dash ${hud.dashCd > 0 ? 'cooldown' : ''}`}>
                  <div className="cd" style={{ height: `${(hud.dashCd / DASH_COOLDOWN) * 100}%` }} />
                  <b>DASH</b><span>{isTouch ? 'tap' : 'Space'}</span>
                </div>
              </div>
            </div>
          )}
          <button className="hud-menu" onClick={() => setPaused(true)} aria-label="Menu">❚❚</button>
        </>
      )}

      {isTouch && hud?.myAlive && inputRef.current && <TouchControls input={inputRef.current} />}

      {showDeath && (
        <div className="overlay">
          <div className="modal death">
            <div className="eyebrow">Eliminated</div>
            <h2>#{death!.placement}</h2>
            <p>{death!.text}</p>
            <div className="modal-actions">
              <Btn onClick={() => setDeathDismissed(true)}>Spectate</Btn>
              {isSolo && <Btn variant="ghost" onClick={props.onPlayAgain}>Play again</Btn>}
              {isSolo && <Btn variant="ghost" onClick={() => { (session as unknown as { world: { endMatch(): void } }).world.endMatch(); }}>Skip to results</Btn>}
              {!isSolo && <Btn variant="ghost" onClick={props.onBackToLobby}>Back to lobby</Btn>}
            </div>
          </div>
        </div>
      )}

      {end && <Results end={end} myId={myId} isSolo={isSolo} isHost={props.isHost} soloXp={soloXp} {...props} />}

      {paused && !end && (
        <div className="overlay" onClick={() => setPaused(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{isSolo ? 'Paused' : 'Menu'}</h2>
            {!isSolo && <p className="muted">The match keeps running while this menu is open.</p>}
            <div className="modal-actions col">
              <Btn onClick={() => setPaused(false)}>Resume</Btn>
              {isSolo && <Btn variant="ghost" onClick={props.onPlayAgain}>Restart</Btn>}
              {!isSolo && <Btn variant="ghost" onClick={props.onBackToLobby}>Back to lobby (spectate later)</Btn>}
              <Btn variant="danger" onClick={props.onExit}>{isSolo ? 'Quit to menu' : 'Leave room'}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Results(props: GameProps & { end: EndInfo; myId: number; isSolo: boolean; isHost?: boolean; soloXp: { gained: number; newUnlocks: string[] } | null | 'offline' }) {
  const { end, myId } = props;
  const mine = end.results.find((r) => r.id === myId);
  const xp = props.isSolo ? (props.soloXp && props.soloXp !== 'offline' ? props.soloXp.gained : null) : end.xp?.gained;
  const unlocks = props.isSolo && props.soloXp && props.soloXp !== 'offline' ? props.soloXp.newUnlocks : [];
  return (
    <div className="overlay">
      <div className="modal results">
        <div className="eyebrow">Match complete</div>
        <h2 className={mine?.won ? 'win' : ''}>{mine ? (mine.won ? 'VICTORY' : `You placed #${mine.placement}`) : 'Match over'}</h2>
        {mine && (
          <div className="result-stats">
            <div><b>{mine.score.toLocaleString()}</b><span>Score</span></div>
            <div><b>{mine.kills}</b><span>Eliminations</span></div>
            <div><b>{mine.peakMass}</b><span>Peak mass</span></div>
            <div><b>{fmtTime(mine.aliveTime)}</b><span>Survived</span></div>
            <div><b>{xp != null ? `+${xp}` : props.soloXp === 'offline' ? '–' : '…'}</b><span>XP</span></div>
          </div>
        )}
        {unlocks.length > 0 && <div className="notice good">New cosmetics unlocked! Check your profile.</div>}
        {props.soloXp === 'offline' && props.isSolo && <div className="muted small">Offline: this result was not saved to the leaderboard.</div>}
        <div className="table-wrap">
          <table className="lb results-table">
            <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Elims</th><th className="hide-sm">Peak mass</th><th className="hide-sm">Survived</th></tr></thead>
            <tbody>
              {end.results.map((r) => (
                <tr key={r.id} className={r.id === myId ? 'me' : ''}>
                  <td className={`rank r${r.placement}`}>{r.placement}</td>
                  <td><Dot color={r.color} /> {r.name}{r.won ? ' 👑' : ''}</td>
                  <td className="val">{r.score.toLocaleString()}</td>
                  <td>{r.kills}</td>
                  <td className="hide-sm">{r.peakMass}</td>
                  <td className="hide-sm">{fmtTime(r.aliveTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-actions">
          {props.isSolo ? (
            <>
              <Btn onClick={props.onPlayAgain}>Play again</Btn>
              <Btn variant="ghost" onClick={props.onExit}>Main menu</Btn>
            </>
          ) : (
            <>
              {props.isHost ? <Btn onClick={props.onRematch}>Rematch</Btn> : <div className="waiting">Waiting for host to start a rematch…</div>}
              <Btn variant="ghost" onClick={props.onBackToLobby}>Lobby</Btn>
              <Btn variant="danger" onClick={props.onExit}>Leave room</Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TouchControls({ input }: { input: InputManager }) {
  const [stick, setStick] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const stickId = useRef<number | null>(null);
  const R = 55;
  const onStart = (e: React.TouchEvent) => {
    const t = e.changedTouches[0];
    stickId.current = t.identifier;
    input.touch.active = true;
    setStick({ x: t.clientX, y: t.clientY, dx: 0, dy: 0 });
  };
  const onMove = (e: React.TouchEvent) => {
    if (!stick) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== stickId.current) continue;
      let dx = t.clientX - stick.x, dy = t.clientY - stick.y;
      const l = Math.hypot(dx, dy);
      if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
      input.touch.jx = dx / R;
      input.touch.jy = dy / R;
      setStick({ ...stick, dx, dy });
    }
  };
  const onEnd = () => {
    stickId.current = null;
    input.touch.jx = input.touch.jy = 0;
    setStick(null);
  };
  const hold = (k: 'attract' | 'repel') => ({
    onTouchStart: (e: React.TouchEvent) => { e.preventDefault(); input.touch.active = true; input.touch[k] = true; },
    onTouchEnd: (e: React.TouchEvent) => { e.preventDefault(); input.touch[k] = false; },
  });
  return (
    <>
      <div className="touch-zone" onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd} onTouchCancel={onEnd}>
        {stick && (
          <div className="stick" style={{ left: stick.x - R, top: stick.y - R, width: R * 2, height: R * 2 }}>
            <div className="knob" style={{ transform: `translate(${stick.dx}px, ${stick.dy}px)` }} />
          </div>
        )}
        {!stick && <div className="touch-hint">Drag to move</div>}
      </div>
      <div className="touch-buttons">
        <button className="tb attract" {...hold('attract')}>ATTRACT</button>
        <button className="tb repel" {...hold('repel')}>REPEL</button>
        <button className="tb dash" onTouchStart={(e) => { e.preventDefault(); input.touch.active = true; input.triggerDash(); }}>DASH</button>
      </div>
    </>
  );
}

export { radiusForMass };
