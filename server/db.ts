// Persistent storage (SQLite via Node's built-in node:sqlite - no native dependencies).
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Cosmetics, DEFAULT_COSMETICS, ProgressStats, levelForXp, sanitizeCosmetics, unlockedIds, xpForMatch } from '../shared/cosmetics';

export interface UserRow {
  id: number;
  username: string | null;
  display_name: string;
  pass_hash: string | null;
  is_guest: number;
  xp: number;
  wins: number;
  kills: number;
  matches: number;
  best_score: number;
  cosmetics: string;
  unlocked: string;
  created_at: number;
}

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

export type Period = 'all' | 'week' | 'day';
export type Metric = 'score' | 'kills' | 'wins' | 'matches';
export type Mode = 'online' | 'solo';

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        pass_hash TEXT,
        is_guest INTEGER NOT NULL DEFAULT 1,
        xp INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        kills INTEGER NOT NULL DEFAULT 0,
        matches INTEGER NOT NULL DEFAULT 0,
        best_score INTEGER NOT NULL DEFAULT 0,
        cosmetics TEXT NOT NULL DEFAULT '{}',
        unlocked TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        score INTEGER NOT NULL,
        kills INTEGER NOT NULL,
        won INTEGER NOT NULL,
        placement INTEGER NOT NULL,
        players INTEGER NOT NULL,
        difficulty TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS results_time ON results(mode, created_at);
      CREATE INDEX IF NOT EXISTS results_user ON results(user_id);
      CREATE TABLE IF NOT EXISTS friends (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, friend_id)
      );
    `);
  }

  // ------------------------------------------------------------- users

  private toProfile(u: UserRow): Profile {
    const stats = this.stats(u);
    let cos: Partial<Cosmetics> = {};
    try { cos = JSON.parse(u.cosmetics); } catch { /* default */ }
    return {
      id: u.id, name: u.display_name, username: u.username, isGuest: !!u.is_guest,
      xp: u.xp, level: levelForXp(u.xp), wins: u.wins, kills: u.kills, matches: u.matches, bestScore: u.best_score,
      cosmetics: sanitizeCosmetics(cos, stats), unlocked: unlockedIds(stats),
    };
  }

  private stats(u: UserRow): ProgressStats {
    return { xp: u.xp, wins: u.wins, kills: u.kills, matches: u.matches };
  }

  getUser(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  profile(id: number): Profile | null {
    const u = this.getUser(id);
    return u ? this.toProfile(u) : null;
  }

  createGuest(name: string): { token: string; profile: Profile } {
    const res = this.db
      .prepare('INSERT INTO users (display_name, is_guest, cosmetics, created_at) VALUES (?, 1, ?, ?)')
      .run(name, JSON.stringify(DEFAULT_COSMETICS), Date.now());
    const id = Number(res.lastInsertRowid);
    return { token: this.createSession(id), profile: this.profile(id)! };
  }

  createSession(userId: number): string {
    const token = randomBytes(24).toString('hex');
    this.db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
    return token;
  }

  userForToken(token: string | undefined | null): UserRow | undefined {
    if (!token || typeof token !== 'string' || token.length > 100) return undefined;
    const row = this.db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: number } | undefined;
    return row ? this.getUser(row.user_id) : undefined;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  usernameTaken(name: string, exceptId = -1): boolean {
    const row = this.db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(name, exceptId);
    return !!row;
  }

  /** Upgrades a guest to a registered account (keeps all stats), or creates a fresh one. */
  register(username: string, password: string, guestId: number | null): { token: string; profile: Profile } | { error: string } {
    if (this.usernameTaken(username, guestId ?? -1)) return { error: 'That username is already taken.' };
    const hash = hashPassword(password);
    let id = guestId;
    const guest = guestId != null ? this.getUser(guestId) : undefined;
    if (guest && guest.is_guest) {
      this.db.prepare('UPDATE users SET username = ?, display_name = ?, pass_hash = ?, is_guest = 0 WHERE id = ?').run(username, username, hash, guest.id);
    } else {
      const res = this.db
        .prepare('INSERT INTO users (username, display_name, pass_hash, is_guest, cosmetics, created_at) VALUES (?, ?, ?, 0, ?, ?)')
        .run(username, username, hash, JSON.stringify(DEFAULT_COSMETICS), Date.now());
      id = Number(res.lastInsertRowid);
    }
    return { token: this.createSession(id!), profile: this.profile(id!)! };
  }

  login(username: string, password: string): { token: string; profile: Profile } | { error: string } {
    const u = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    if (!u || !u.pass_hash || !verifyPassword(password, u.pass_hash)) return { error: 'Wrong username or password.' };
    return { token: this.createSession(u.id), profile: this.toProfile(u) };
  }

  updateProfile(id: number, name: string | undefined, cosmetics: Partial<Cosmetics> | undefined): Profile | { error: string } {
    const u = this.getUser(id);
    if (!u) return { error: 'Unknown user.' };
    if (name !== undefined) {
      if (!u.is_guest) return { error: 'Registered players use their username as display name.' };
      if (this.usernameTaken(name)) return { error: 'That name belongs to a registered player.' };
      this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, id);
    }
    if (cosmetics !== undefined) {
      const clean = sanitizeCosmetics(cosmetics, this.stats(u));
      this.db.prepare('UPDATE users SET cosmetics = ? WHERE id = ?').run(JSON.stringify(clean), id);
    }
    return this.profile(id)!;
  }

  // ------------------------------------------------------------- results

  recordResult(userId: number, r: { mode: Mode; score: number; kills: number; won: boolean; placement: number; players: number; difficulty?: string }): { gained: number; total: number; level: number; newUnlocks: string[] } {
    const u = this.getUser(userId);
    if (!u) return { gained: 0, total: 0, level: 1, newUnlocks: [] };
    const before = new Set(unlockedIds(this.stats(u)));
    let gained = xpForMatch(r.score, r.kills, r.won);
    if (r.mode === 'solo') gained = Math.round(gained * (r.difficulty === 'hard' ? 1 : r.difficulty === 'normal' ? 0.75 : 0.5));
    this.db
      .prepare('INSERT INTO results (user_id, mode, score, kills, won, placement, players, difficulty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, r.mode, r.score, r.kills, r.won ? 1 : 0, r.placement, r.players, r.difficulty ?? null, Date.now());
    this.db
      .prepare('UPDATE users SET xp = xp + ?, wins = wins + ?, kills = kills + ?, matches = matches + 1, best_score = MAX(best_score, ?) WHERE id = ?')
      .run(gained, r.won ? 1 : 0, r.kills, r.score, userId);
    const after = this.getUser(userId)!;
    const unlocked = unlockedIds(this.stats(after));
    this.db.prepare('UPDATE users SET unlocked = ? WHERE id = ?').run(JSON.stringify(unlocked), userId);
    return { gained, total: after.xp, level: levelForXp(after.xp), newUnlocks: unlocked.filter((id) => !before.has(id)) };
  }

  // ------------------------------------------------------------- friends

  addFriend(userId: number, username: string): { ok: true } | { error: string } {
    const f = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
    if (!f) return { error: 'No registered player with that username.' };
    if (f.id === userId) return { error: "You can't add yourself." };
    this.db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').run(userId, f.id);
    return { ok: true };
  }

  removeFriend(userId: number, username: string): void {
    this.db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = (SELECT id FROM users WHERE username = ?)').run(userId, username);
  }

  friends(userId: number): { name: string; level: number; wins: number; bestScore: number }[] {
    const rows = this.db
      .prepare('SELECT u.* FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY u.display_name')
      .all(userId) as unknown as UserRow[];
    return rows.map((u) => ({ name: u.username ?? u.display_name, level: levelForXp(u.xp), wins: u.wins, bestScore: u.best_score }));
  }

  // ------------------------------------------------------------- leaderboards

  leaderboard(o: { period: Period; metric: Metric; mode: Mode; friendsOf?: number; meId?: number; limit?: number }) {
    const since = o.period === 'day' ? Date.now() - 86400000 : o.period === 'week' ? Date.now() - 7 * 86400000 : 0;
    const agg = { score: 'MAX(r.score)', kills: 'SUM(r.kills)', wins: 'SUM(r.won)', matches: 'COUNT(*)' }[o.metric];
    const params: (number | string)[] = [o.mode, since];
    let friendFilter = '';
    if (o.friendsOf != null) {
      friendFilter = 'AND (r.user_id = ? OR r.user_id IN (SELECT friend_id FROM friends WHERE user_id = ?))';
      params.push(o.friendsOf, o.friendsOf);
    }
    const rows = this.db
      .prepare(
        `SELECT u.id AS id, u.display_name AS name, u.is_guest AS guest, u.xp AS xp,
                ${agg} AS value, MAX(r.score) AS best, SUM(r.kills) AS kills, SUM(r.won) AS wins, COUNT(*) AS matches
         FROM results r JOIN users u ON u.id = r.user_id
         WHERE r.mode = ? AND r.created_at >= ? ${friendFilter}
         GROUP BY u.id HAVING value > 0
         ORDER BY value DESC, best DESC LIMIT ?`,
      )
      .all(...params, o.limit ?? 50) as { id: number; name: string; guest: number; xp: number; value: number; best: number; kills: number; wins: number; matches: number }[];
    return rows.map((r, i) => ({
      rank: i + 1, name: r.name, guest: !!r.guest, level: levelForXp(r.xp), value: r.value,
      best: r.best, kills: r.kills, wins: r.wins, matches: r.matches, me: r.id === o.meId,
    }));
  }
}

function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
