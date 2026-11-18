import React, { useEffect, useState } from 'react';
import { api, login, logout, Profile, register, updateProfile } from '../api';
import { CATALOG, Cosmetics, CosmeticSlot, describeReq, levelForXp } from '../../../shared/cosmetics';
import { Btn, Panel, PlanetPreview } from '../ui';

const SLOTS: { id: CosmeticSlot; name: string }[] = [
  { id: 'color', name: 'Color' },
  { id: 'skin', name: 'Skin' },
  { id: 'glow', name: 'Glow' },
  { id: 'trail', name: 'Trail' },
  { id: 'elimFx', name: 'Elimination' },
];

export function ProfileScreen(props: { profile: Profile; online: boolean; onBack: () => void; onProfile: (p: Profile, relogin?: boolean) => void }) {
  const { profile } = props;
  const [slot, setSlot] = useState<CosmeticSlot>('color');
  const [cos, setCos] = useState<Cosmetics>(profile.cosmetics);
  const [msg, setMsg] = useState<string | null>(null);
  const unlocked = new Set(profile.unlocked);

  const choose = async (id: string) => {
    const next = { ...cos, [slot]: id };
    setCos(next);
    if (!props.online) return;
    try { props.onProfile(await updateProfile({ cosmetics: next })); } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <Panel title="Profile" onBack={props.onBack} wide>
      <div className="profile-layout">
        <div className="profile-left">
          <PlanetPreview cosmetics={cos} size={200} />
          <div className="pname big">{profile.name}</div>
          <div className="stat-grid">
            <div><b>{levelForXp(profile.xp)}</b><span>Level</span></div>
            <div><b>{profile.xp}</b><span>XP</span></div>
            <div><b>{profile.wins}</b><span>Wins</span></div>
            <div><b>{profile.kills}</b><span>Eliminations</span></div>
            <div><b>{profile.bestScore}</b><span>Best score</span></div>
            <div><b>{profile.matches}</b><span>Matches</span></div>
          </div>
          {props.online ? <Account profile={profile} onProfile={props.onProfile} /> : <p className="muted">Connect to the server to manage your account.</p>}
        </div>
        <div className="profile-right">
          <div className="tabs">
            {SLOTS.map((s) => (
              <button key={s.id} className={slot === s.id ? 'active' : ''} onClick={() => setSlot(s.id)}>{s.name}</button>
            ))}
          </div>
          <div className="item-grid">
            {CATALOG.filter((c) => c.slot === slot).map((item) => {
              const ok = unlocked.has(item.id) || (!props.online && Object.keys(item.req).length === 0);
              const active = cos[slot] === item.id;
              return (
                <button key={item.id} className={`item ${active ? 'active' : ''} ${ok ? '' : 'locked'}`} disabled={!ok} onClick={() => choose(item.id)} title={ok ? item.name : describeReq(item.req)}>
                  {slot === 'color' ? <span className="swatch" style={{ background: item.value, boxShadow: `0 0 14px ${item.value}` }} /> : <PlanetPreview cosmetics={{ ...cos, [slot]: item.id }} size={64} seed={item.id.length} />}
                  <span className="item-name">{item.name}</span>
                  {!ok && <span className="req">🔒 {describeReq(item.req)}</span>}
                </button>
              );
            })}
          </div>
          <p className="muted small">Cosmetics are purely visual. Unlock more by leveling up, winning, and eliminating rivals.</p>
          {msg && <div className="error">{msg}</div>}
        </div>
      </div>
    </Panel>
  );
}

function Account({ profile, onProfile }: { profile: Profile; onProfile: (p: Profile, relogin?: boolean) => void }) {
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [u, setU] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!profile.isGuest) {
    return (
      <div className="account">
        <p>Signed in as <b>{profile.username}</b>. Your stats and unlocks are saved to your account.</p>
        <Friends />
        <Btn variant="ghost" onClick={async () => onProfile(await logout(), true)}>Sign out</Btn>
      </div>
    );
  }
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      onProfile(mode === 'register' ? await register(u, pw) : await login(u, pw), true);
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="account">
      <p className="muted small">You're playing as a guest. {mode === 'register' ? 'Create an account to keep your progress on any device, appear by name on leaderboards, and add friends.' : 'Sign in to an existing account.'}</p>
      <div className="seg">
        <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Create account</button>
        <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Sign in</button>
      </div>
      <input placeholder="Username" value={u} maxLength={16} onChange={(e) => setU(e.target.value)} autoComplete="username" />
      <input placeholder="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      {err && <div className="error">{err}</div>}
      <Btn onClick={submit} disabled={busy || !u || !pw}>{mode === 'register' ? 'Create account (keeps guest progress)' : 'Sign in'}</Btn>
    </div>
  );
}

function Friends() {
  const [friends, setFriends] = useState<{ name: string; level: number; wins: number; bestScore: number }[]>([]);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<{ friends: typeof friends }>('/api/friends').then((r) => setFriends(r.friends)).catch(() => {}); }, []);
  const add = async () => {
    setErr(null);
    try {
      setFriends((await api<{ friends: typeof friends }>('/api/friends', { body: { username: name.trim() } })).friends);
      setName('');
    } catch (e) { setErr((e as Error).message); }
  };
  const remove = async (n: string) => setFriends((await api<{ friends: typeof friends }>(`/api/friends/${encodeURIComponent(n)}`, { method: 'DELETE' })).friends);
  return (
    <div className="friends">
      <h3>Friends</h3>
      <div className="inline">
        <input placeholder="Friend's username" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="mini" onClick={add} disabled={!name.trim()}>Add</button>
      </div>
      {err && <div className="error small">{err}</div>}
      {friends.length === 0 ? <p className="muted small">Add friends to compare scores on the Friends leaderboard.</p> : (
        <ul className="friend-list">
          {friends.map((f) => (
            <li key={f.name}><span>{f.name}</span><span className="muted small">Lv {f.level} · {f.wins} wins</span><button className="mini ghost" onClick={() => remove(f.name)}>✕</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
