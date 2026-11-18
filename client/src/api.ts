// REST client + profile session (guest or registered). Falls back to an offline profile when the server is unreachable.
import { Cosmetics, DEFAULT_COSMETICS, unlockedIds } from '../../shared/cosmetics';

export interface Profile {
  id: number;
  name: string;
  username: string | null;
  isGuest: boolean;
  xp: number;
  level: number;
  wins: number;
  kills: number;
  matches: number;
  bestScore: number;
  cosmetics: Cosmetics;
  unlocked: string[];
}

const TOKEN_KEY = 'orbit.token';
const PROFILE_KEY = 'orbit.profile';

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(t: string | null) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
export function cacheProfile(p: Profile) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
export function cachedProfile(): Profile | null {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null'); } catch { return null; }
}

export class ApiError extends Error {}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the ORBIT server. You can still play solo offline.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export function offlineProfile(): Profile {
  const cached = cachedProfile();
  if (cached) return cached;
  const stats = { xp: 0, wins: 0, kills: 0, matches: 0 };
  return { id: -1, name: 'Pilot', username: null, isGuest: true, ...stats, level: 1, bestScore: 0, cosmetics: { ...DEFAULT_COSMETICS }, unlocked: unlockedIds(stats) };
}

/** Restores the session or creates a guest account. Returns null profile on network failure. */
export async function bootstrap(): Promise<{ profile: Profile; online: boolean }> {
  try {
    if (getToken()) {
      try {
        const me = await api<{ profile: Profile }>('/api/me');
        cacheProfile(me.profile);
        return { profile: me.profile, online: true };
      } catch (e) {
        if ((e as Error).message.startsWith('Cannot reach')) throw e;
        setToken(null);
      }
    }
    const g = await api<{ token: string; profile: Profile }>('/api/auth/guest', { body: { name: cachedProfile()?.name } });
    setToken(g.token);
    cacheProfile(g.profile);
    return { profile: g.profile, online: true };
  } catch {
    return { profile: offlineProfile(), online: false };
  }
}

export async function register(username: string, password: string): Promise<Profile> {
  const r = await api<{ token: string; profile: Profile }>('/api/auth/register', { body: { username, password } });
  setToken(r.token);
  cacheProfile(r.profile);
  return r.profile;
}

export async function login(username: string, password: string): Promise<Profile> {
  const r = await api<{ token: string; profile: Profile }>('/api/auth/login', { body: { username, password } });
  setToken(r.token);
  cacheProfile(r.profile);
  return r.profile;
}

export async function logout(): Promise<Profile> {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  setToken(null);
  try { localStorage.removeItem(PROFILE_KEY); } catch { /* ignore */ }
  return (await bootstrap()).profile;
}

export async function updateProfile(patch: { name?: string; cosmetics?: Partial<Cosmetics> }): Promise<Profile> {
  const r = await api<{ profile: Profile }>('/api/profile', { body: patch });
  cacheProfile(r.profile);
  return r.profile;
}
