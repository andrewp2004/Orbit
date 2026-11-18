import React, { useState } from 'react';
import { STANDALONE, type Profile } from '../api';
import { colorHex, levelForXp, xpForLevel } from '../../../shared/cosmetics';
import { Btn, PlanetPreview } from '../ui';
import type { ConnStatus } from '../net';

export type MenuTarget = 'solo' | 'create' | 'join' | 'leaderboard' | 'settings' | 'profile';

export function Menu(props: { profile: Profile; online: boolean; conn: ConnStatus; onNav: (t: MenuTarget) => void; onRename: (n: string) => Promise<string | null> }) {
  const { profile } = props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [err, setErr] = useState<string | null>(null);
  const lvl = levelForXp(profile.xp);
  const progress = (profile.xp - xpForLevel(lvl)) / (xpForLevel(lvl + 1) - xpForLevel(lvl));

  const saveName = async () => {
    const e = await props.onRename(name.trim());
    setErr(e);
    if (!e) setEditing(false);
  };

  return (
    <div className="menu">
      <div className="logo">
        <h1>ORBIT</h1>
        <div className="subtitle">Gravity Wars</div>
      </div>

      <div className="menu-buttons">
        <Btn onClick={() => props.onNav('solo')}>Play Solo</Btn>
        <Btn onClick={() => props.onNav('create')} disabled={!props.online} title={props.online ? '' : 'Server unreachable'}>Play With Friends</Btn>
        <Btn variant="ghost" onClick={() => props.onNav('join')} disabled={!props.online}>Join Game</Btn>
        <div className="menu-row">
          <Btn variant="ghost" onClick={() => props.onNav('leaderboard')} disabled={!props.online}>Leaderboards</Btn>
          <Btn variant="ghost" onClick={() => props.onNav('settings')}>Settings</Btn>
        </div>
        {!props.online && <div className="notice">{STANDALONE ? 'This preview has solo play. Playing with friends, accounts and leaderboards need the ORBIT game server to be running online.' : 'Offline: solo play is available. Online features return when the server is reachable.'}</div>}
      </div>

      <div className="profile-card" onClick={() => !editing && props.onNav('profile')} role="button" tabIndex={0}>
        <PlanetPreview cosmetics={profile.cosmetics} size={84} />
        <div className="profile-info">
          {editing ? (
            <div className="rename" onClick={(e) => e.stopPropagation()}>
              <input value={name} maxLength={16} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveName()} />
              <button className="mini" onClick={saveName}>Save</button>
              {err && <div className="error small">{err}</div>}
            </div>
          ) : (
            <div className="pname" style={{ color: colorHex(profile.cosmetics) }}>
              {profile.name}
              {profile.isGuest && props.online && (
                <button className="mini" onClick={(e) => { e.stopPropagation(); setName(profile.name); setEditing(true); }}>Edit</button>
              )}
            </div>
          )}
          <div className="plevel">Level {lvl} {profile.isGuest ? '· Guest' : ''}</div>
          <div className="xpbar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <div className="pstats">{profile.wins} wins · {profile.kills} elims · best {profile.bestScore}</div>
          <div className="customize-hint">Customize planet & account →</div>
        </div>
      </div>

      {!STANDALONE && <div className={`conn conn-${props.online ? props.conn : 'offline'}`}>
        <span className="conn-dot" /> {props.online ? 'Server online' : 'Offline mode'}
      </div>}
      <div className="controls-hint">WASD move · Mouse aim · Left click Attract · Right click Repel · Space Dash</div>
    </div>
  );
}
