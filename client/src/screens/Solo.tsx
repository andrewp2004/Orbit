import React, { useState } from 'react';
import type { ArenaSize, Difficulty } from '../../../shared/constants';
import { Btn, Panel } from '../ui';

const DIFFS: { id: Difficulty; name: string; desc: string }[] = [
  { id: 'easy', name: 'Easy', desc: 'Relaxed opponents that mostly collect energy. Half XP.' },
  { id: 'normal', name: 'Normal', desc: 'Opponents hunt, use gravity and avoid hazards. 75% XP.' },
  { id: 'hard', name: 'Hard', desc: 'Fast, aggressive rivals that set up black-hole knockouts. Full XP.' },
];

export function Solo(props: { onBack: () => void; onStart: (d: Difficulty, size: ArenaSize) => void }) {
  const [diff, setDiff] = useState<Difficulty>(() => (localStorage.getItem('orbit.diff') as Difficulty) || 'normal');
  const [size, setSize] = useState<ArenaSize>('medium');
  return (
    <Panel title="Play Solo" onBack={props.onBack}>
      <p className="muted">Battle 10 AI planets. Last planet standing wins a big bonus.</p>
      <div className="choice-grid">
        {DIFFS.map((d) => (
          <button key={d.id} className={`choice ${diff === d.id ? 'active' : ''} diff-${d.id}`} onClick={() => setDiff(d.id)}>
            <strong>{d.name}</strong>
            <span>{d.desc}</span>
          </button>
        ))}
      </div>
      <label className="field">
        <span>Arena</span>
        <div className="seg">
          {(['small', 'medium', 'large'] as ArenaSize[]).map((s) => (
            <button key={s} className={size === s ? 'active' : ''} onClick={() => setSize(s)}>{s}</button>
          ))}
        </div>
      </label>
      <Btn className="big" onClick={() => { try { localStorage.setItem('orbit.diff', diff); } catch { /* */ } props.onStart(diff, size); }}>Launch</Btn>
    </Panel>
  );
}
