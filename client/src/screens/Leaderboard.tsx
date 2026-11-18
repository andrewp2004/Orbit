import React, { useEffect, useState } from 'react';
import { api, Profile } from '../api';
import { Panel } from '../ui';

type Period = 'day' | 'week' | 'all';
type Metric = 'score' | 'kills' | 'wins' | 'matches';
interface Row { rank: number; name: string; guest: boolean; level: number; value: number; best: number; kills: number; wins: number; matches: number; me: boolean }

const METRICS: { id: Metric; name: string }[] = [
  { id: 'score', name: 'Highest score' },
  { id: 'kills', name: 'Eliminations' },
  { id: 'wins', name: 'Wins' },
  { id: 'matches', name: 'Matches played' },
];

export function Leaderboard(props: { profile: Profile; onBack: () => void }) {
  const [period, setPeriod] = useState<Period>('week');
  const [metric, setMetric] = useState<Metric>('score');
  const [scope, setScope] = useState<'global' | 'friends'>('global');
  const [mode, setMode] = useState<'online' | 'solo'>('online');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    setErr(null);
    api<{ rows: Row[] }>(`/api/leaderboard?period=${period}&metric=${metric}&scope=${scope}&mode=${mode}`)
      .then((r) => setRows(r.rows))
      .catch((e) => setErr(e.message));
  }, [period, metric, scope, mode]);

  return (
    <Panel title="Leaderboards" onBack={props.onBack} wide>
      <div className="lb-filters">
        <div className="seg">
          {(['day', 'week', 'all'] as Period[]).map((p) => (
            <button key={p} className={period === p ? 'active' : ''} onClick={() => setPeriod(p)}>{p === 'day' ? 'Daily' : p === 'week' ? 'Weekly' : 'All-time'}</button>
          ))}
        </div>
        <div className="seg">
          <button className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>Global</button>
          <button className={scope === 'friends' ? 'active' : ''} onClick={() => setScope('friends')}>Friends</button>
        </div>
        <div className="seg">
          <button className={mode === 'online' ? 'active' : ''} onClick={() => setMode('online')}>Online</button>
          <button className={mode === 'solo' ? 'active' : ''} onClick={() => setMode('solo')}>Solo</button>
        </div>
      </div>
      <div className="tabs">
        {METRICS.map((m) => (
          <button key={m.id} className={metric === m.id ? 'active' : ''} onClick={() => setMetric(m.id)}>{m.name}</button>
        ))}
      </div>
      {scope === 'friends' && props.profile.isGuest && <p className="muted">Create an account (Profile) to add friends.</p>}
      {err && <div className="error">{err}</div>}
      {!rows && !err && <div className="muted">Loading…</div>}
      {rows && rows.length === 0 && <div className="empty">No results yet for this board. Play a match to claim the top spot!</div>}
      {rows && rows.length > 0 && (
        <table className="lb">
          <thead><tr><th>#</th><th>Player</th><th>{METRICS.find((m) => m.id === metric)!.name}</th><th className="hide-sm">Best</th><th className="hide-sm">Elims</th><th className="hide-sm">Wins</th><th className="hide-sm">Matches</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rank} className={r.me ? 'me' : ''}>
                <td className={`rank r${r.rank}`}>{r.rank}</td>
                <td>{r.name} <span className="muted small">Lv {r.level}{r.guest ? ' · guest' : ''}</span></td>
                <td className="val">{r.value.toLocaleString()}</td>
                <td className="hide-sm">{r.best.toLocaleString()}</td>
                <td className="hide-sm">{r.kills}</td>
                <td className="hide-sm">{r.wins}</td>
                <td className="hide-sm">{r.matches}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
