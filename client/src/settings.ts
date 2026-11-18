// Per-device preferences (volume, graphics). Gameplay data lives on the server.
export interface UserSettings {
  volume: number; // 0..1
  muted: boolean;
  music: boolean;
  sfx: boolean;
  quality: 'high' | 'low';
  showMinimap: boolean;
}

const KEY = 'orbit.settings';
const defaults: UserSettings = { volume: 0.7, muted: false, music: true, sfx: true, quality: 'high', showMinimap: true };

export function loadSettings(): UserSettings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...defaults };
  }
}

let current = loadSettings();
const listeners = new Set<(s: UserSettings) => void>();

export function getSettings(): UserSettings {
  return current;
}

export function saveSettings(patch: Partial<UserSettings>): UserSettings {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode */ }
  listeners.forEach((l) => l(current));
  return current;
}

export function onSettings(fn: (s: UserSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
