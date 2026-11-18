import React, { useState } from 'react';
import { DEFAULT_SETTINGS, MatchSettings, ArenaSize, HazardLevel } from '../../../shared/constants';
import type { LobbyState } from '../../../shared/protocol';
import { Btn, Dot, Panel, PlanetPreview } from '../ui';
import { getSocket } from '../net';

export function SettingsEditor({ value, onChange, disabled }: { value: MatchSettings; onChange: (s: MatchSettings) => void; disabled?: boolean }) {
  const set = (patch: Partial<MatchSettings>) => onChange({ ...value, ...patch });
  return (
    <div className={`settings-editor ${disabled ? 'readonly' : ''}`}>
      <label className="field">
        <span>Arena size</span>
        <div className="seg">
          {(['small', 'medium', 'large'] as ArenaSize[]).map((s) => (
            <button key={s} disabled={disabled} className={value.arenaSize === s ? 'active' : ''} onClick={() => set({ arenaSize: s })}>{s}</button>
          ))}
        </div>
      </label>
      <label className="field">
        <span>Match length</span>
        <div className="seg">
          {[180, 300, 420].map((d) => (
            <button key={d} disabled={disabled} className={value.durationSec === d ? 'active' : ''} onClick={() => set({ durationSec: d })}>{d / 60} min</button>
          ))}
        </div>
      </label>
      <label className="field">
        <span>Hazards</span>
        <div className="seg">
          {(['low', 'normal', 'high'] as HazardLevel[]).map((h) => (
            <button key={h} disabled={disabled} className={value.hazards === h ? 'active' : ''} onClick={() => set({ hazards: h })}>{h}</button>
          ))}
        </div>
      </label>
      <label className="field">
        <span>Max players: {value.maxPlayers}</span>
        <input type="range" min={2} max={16} value={value.maxPlayers} disabled={disabled} onChange={(e) => set({ maxPlayers: Number(e.target.value) })} />
      </label>
      <label className="field toggle">
        <span>Random space events</span>
        <button className={`switch ${value.events ? 'on' : ''}`} disabled={disabled} onClick={() => set({ events: !value.events })}><i /></button>
      </label>
    </div>
  );
}

export function CreateRoom(props: { onBack: () => void; onCreate: (s: MatchSettings) => Promise<string | null> }) {
  const [settings, setSettings] = useState<MatchSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Panel title="Create Private Room" onBack={props.onBack}>
      <SettingsEditor value={settings} onChange={setSettings} />
      {err && <div className="error">{err}</div>}
      <Btn className="big" disabled={busy} onClick={async () => { setBusy(true); setErr(await props.onCreate(settings)); setBusy(false); }}>{busy ? 'Creating…' : 'Create Room'}</Btn>
    </Panel>
  );
}

export function JoinRoom(props: { onBack: () => void; onJoin: (code: string) => Promise<string | null>; initialCode?: string }) {
  const [code, setCode] = useState(props.initialCode ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => { setBusy(true); setErr(await props.onJoin(code)); setBusy(false); };
  return (
    <Panel title="Join Game" onBack={props.onBack}>
      <p className="muted">Enter the room code your friend shared.</p>
      <input className="code-input" value={code} maxLength={5} placeholder="ABCDE" autoFocus
        onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
        onKeyDown={(e) => e.key === 'Enter' && code.length >= 4 && submit()} />
      {err && <div className="error">{err}</div>}
      <Btn className="big" disabled={busy || code.length < 4} onClick={submit}>{busy ? 'Joining…' : 'Join Room'}</Btn>
    </Panel>
  );
}

export function Lobby(props: { lobby: LobbyState; memberId: string; onLeave: () => void; onWatch: () => void }) {
  const { lobby } = props;
  const isHost = lobby.hostId === props.memberId;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };
  const link = `${location.origin}/?room=${lobby.code}`;
  const connected = lobby.members.filter((m) => m.connected).length;
  return (
    <Panel title="Room Lobby" onBack={props.onLeave} wide right={<span className="muted small">{lobby.members.length}/{lobby.settings.maxPlayers} players</span>}>
      <div className="lobby-layout">
        <div className="lobby-left">
          <div className="room-code">
            <span className="label">Room code</span>
            <div className="code" data-testid="room-code">{lobby.code}</div>
            <div className="inline">
              <Btn variant="ghost" onClick={() => copy(lobby.code, 'code')}>{copied === 'code' ? 'Copied!' : 'Copy code'}</Btn>
              <Btn variant="ghost" onClick={() => copy(link, 'link')}>{copied === 'link' ? 'Copied!' : 'Copy invite link'}</Btn>
            </div>
          </div>
          <ul className="members">
            {lobby.members.map((m) => (
              <li key={m.memberId} className={`${m.connected ? '' : 'disconnected'} ${m.memberId === props.memberId ? 'me' : ''}`}>
                <PlanetPreview cosmetics={m.cosmetics} size={44} />
                <Dot color={m.color} />
                <span className="mname">{m.name}</span>
                <span className="muted small">Lv {m.level}{m.isGuest ? ' · guest' : ''}</span>
                {m.isHost && <span className="badge host">HOST</span>}
                {!m.connected && <span className="badge warn">reconnecting…</span>}
              </li>
            ))}
          </ul>
        </div>
        <div className="lobby-right">
          <h3>Match settings {isHost ? '' : <span className="muted small">(host decides)</span>}</h3>
          <SettingsEditor value={lobby.settings} disabled={!isHost} onChange={(s) => getSocket().emit('room:settings', s)} />
          {lobby.state === 'playing' && (
            <div className="notice">
              A match is in progress. New arrivals spectate and join the next match.
              <Btn variant="ghost" onClick={props.onWatch}>Watch / return to match</Btn>
            </div>
          )}
          {isHost ? (
            <Btn className="big" disabled={lobby.state === 'playing'} onClick={() => getSocket().emit('room:start')}>
              {connected < 2 ? 'Start (waiting for friends…)' : `Start Match (${connected} players)`}
            </Btn>
          ) : (
            <div className="waiting">Waiting for the host to start…</div>
          )}
        </div>
      </div>
    </Panel>
  );
}
