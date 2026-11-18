import React, { useEffect, useState } from 'react';
import { getSettings, onSettings, saveSettings } from '../settings';
import { Panel } from '../ui';
import { audio } from '../audio';

export function SettingsScreen(props: { onBack: () => void }) {
  const [s, setS] = useState(getSettings());
  useEffect(() => onSettings(setS), []);
  return (
    <Panel title="Settings" onBack={props.onBack}>
      <label className="field">
        <span>Master volume</span>
        <input type="range" min={0} max={1} step={0.05} value={s.volume} onChange={(e) => saveSettings({ volume: Number(e.target.value) })} onMouseUp={() => audio.beep(true)} />
      </label>
      <Toggle label="Mute all" value={s.muted} onChange={(v) => saveSettings({ muted: v })} />
      <Toggle label="Sound effects" value={s.sfx} onChange={(v) => saveSettings({ sfx: v })} />
      <Toggle label="Background music" value={s.music} onChange={(v) => saveSettings({ music: v })} />
      <Toggle label="Show minimap" value={s.showMinimap} onChange={(v) => saveSettings({ showMinimap: v })} />
      <label className="field">
        <span>Graphics quality</span>
        <div className="seg">
          {(['high', 'low'] as const).map((q) => (
            <button key={q} className={s.quality === q ? 'active' : ''} onClick={() => saveSettings({ quality: q })}>{q}</button>
          ))}
        </div>
      </label>
      <h3>Controls</h3>
      <table className="keys">
        <tbody>
          <tr><td>Move</td><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows</td></tr>
          <tr><td>Aim</td><td>Mouse</td></tr>
          <tr><td>Attract</td><td>Left click / <kbd>Q</kbd></td></tr>
          <tr><td>Repel</td><td>Right click / <kbd>E</kbd> / <kbd>Shift</kbd></td></tr>
          <tr><td>Dash</td><td><kbd>Space</kbd></td></tr>
          <tr><td>Spectate next</td><td>Click / <kbd>Tab</kbd> (while eliminated)</td></tr>
        </tbody>
      </table>
    </Panel>
  );
}

function Toggle(p: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field toggle">
      <span>{p.label}</span>
      <button className={`switch ${p.value ? 'on' : ''}`} onClick={() => p.onChange(!p.value)} aria-pressed={p.value}><i /></button>
    </label>
  );
}
