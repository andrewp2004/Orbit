// Integration test: boots the real server and drives it with several Socket.IO clients.
import { spawn } from 'node:child_process';
import { io, Socket } from 'socket.io-client';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const DB = 'data/test.sqlite';
rmSync(DB, { force: true });

const server = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT), DB_FILE: DB }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>((resolve) => server.stdout!.on('data', (d) => String(d).includes('listening') && resolve()));

const post = async (path: string, body: unknown, token?: string) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
const get = async (path: string, token?: string) => (await fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} })).json() as any;
const connect = (token: string) => new Promise<Socket>((res, rej) => { const s = io(BASE, { auth: { token }, transports: ['websocket'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const emitAck = <T>(s: Socket, ev: string, data: unknown) => new Promise<T>((res) => s.emit(ev, data, res));
const once = <T>(s: Socket, ev: string, ms = 8000) => new Promise<T>((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, (d: T) => { clearTimeout(t); res(d); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = false;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log('  ✓', name); } catch (e) { failed = true; console.log('  ✗', name, '\n   ', e); }
}

const guests = await Promise.all(['Alice', 'Bob', 'Carol'].map((n) => post('/api/auth/guest', { name: n })));
const [A, B, C] = guests.map((g) => g.json);
let sa: Socket, sb: Socket, sc: Socket;
let code = '';
let rejoinB = '';

await test('guest accounts are created', async () => {
  assert.equal(A.profile.name, 'Alice');
  assert.ok(A.token && B.token && C.token);
});

await test('register upgrades guest, login works, duplicate username rejected', async () => {
  const r = await post('/api/auth/register', { username: 'alice_pro', password: 'secret123' }, A.token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  A.token = r.json.token;
  assert.equal(r.json.profile.isGuest, false);
  const dup = await post('/api/auth/register', { username: 'ALICE_PRO', password: 'secret123' });
  assert.equal(dup.status, 409);
  const l = await post('/api/auth/login', { username: 'alice_pro', password: 'secret123' });
  assert.equal(l.status, 200);
  const bad = await post('/api/auth/login', { username: 'alice_pro', password: 'nope' });
  assert.equal(bad.status, 401);
});

await test('locked cosmetics are refused by the server', async () => {
  const r = await post('/api/profile', { cosmetics: { skin: 'skin-molten', color: 'c3' } }, A.token);
  assert.equal(r.json.profile.cosmetics.skin, 'skin-plain');
  assert.equal(r.json.profile.cosmetics.color, 'c3');
});

await test('host creates a room and friends join by code', async () => {
  [sa, sb, sc] = await Promise.all([connect(A.token), connect(B.token), connect(C.token)]);
  const ack = await emitAck<any>(sa, 'room:create', { arenaSize: 'small', durationSec: 180, maxPlayers: 8 });
  assert.ok(ack.ok);
  code = ack.code;
  assert.match(code, /^[A-Z2-9]{5}$/);
  const jb = await emitAck<any>(sb, 'room:join', { code: code.toLowerCase() });
  assert.ok(jb.ok, jb.error);
  rejoinB = jb.rejoinToken;
  const lobbyP = new Promise<any>((res) => sa.on('lobby', (l: any) => l.members.length === 3 && res(l)));
  const jc = await emitAck<any>(sc, 'room:join', { code });
  assert.ok(jc.ok);
  const lobby = await lobbyP;
  sa.off('lobby');
  assert.equal(lobby.members.length, 3);
  assert.deepEqual(lobby.members.map((m: any) => m.name).sort(), ['Bob', 'Carol', 'alice_pro']);
  const bad = await emitAck<any>(sc, 'room:join', { code: 'ZZZZZ' });
  assert.equal(bad.ok, false);
});

await test('same account joining twice takes over the seat (no duplicate identity)', async () => {
  const dupe = await connect(C.token);
  const replaced = once(sc, 'room:replaced');
  const j = await emitAck<any>(dupe, 'room:join', { code });
  assert.ok(j.ok);
  await replaced;
  assert.equal(j.lobby.members.length, 3);
  sc.close();
  sc = dupe;
});

await test('only the host can start; all clients receive the same authoritative world', async () => {
  sb.emit('room:start');
  await sleep(300);
  const fullA = once<any>(sa, 'match:full'), fullB = once<any>(sb, 'match:full'), fullC = once<any>(sc, 'match:full');
  sa.emit('room:start');
  const [fa, fb, fc] = await Promise.all([fullA, fullB, fullC]);
  assert.equal(fa.roster.length, 3);
  assert.deepEqual(fa.p, fb.p);
  assert.deepEqual(fb.orbs.length, fc.orbs.length);
  // Snapshots broadcast to everyone are identical.
  const [snA, snB] = await Promise.all([once<any>(sa, 'snap'), once<any>(sb, 'snap')]);
  assert.equal(snA.t, snB.t);
  assert.deepEqual(snA.p, snB.p);
});

await test('inputs move the player on the server after the countdown', async () => {
  const myId = (await new Promise<any>((r) => sa.once('snap', r))).p[0][0];
  await sleep(3200);
  const before = await once<any>(sa, 'snap');
  const pb = before.p.find((p: number[]) => p[0] === myId);
  for (let i = 0; i < 20; i++) { sa.emit('input', { mx: 1, my: 0, aim: 0, a: false, r: false, d: i === 0, s: i + 1 }); await sleep(30); }
  const after = await once<any>(sa, 'snap');
  const pa = after.p.find((p: number[]) => p[0] === myId);
  assert.ok(after.ph === 'playing');
  assert.ok(pa[1] - pb[1] > 100, `moved ${pa[1] - pb[1]}`);
  assert.equal(pa[12], 20, 'input sequence acked');
});

await test('bogus inputs are sanitized (no teleport / NaN)', async () => {
  sb.emit('input', { mx: 1e9, my: 'x', aim: NaN, a: 1, s: 1 });
  const s = await once<any>(sb, 'snap');
  for (const p of s.p) for (const v of p) assert.ok(Number.isFinite(v));
});

await test('disconnect keeps the seat; rejoin with token restores it mid-match', async () => {
  const lobbyP = once<any>(sa, 'lobby');
  sb.disconnect();
  const lobby = await lobbyP;
  assert.equal(lobby.members.find((m: any) => m.name === 'Bob').connected, false);
  sb = await connect(B.token);
  const full = once<any>(sb, 'match:full');
  const ack = await emitAck<any>(sb, 'room:rejoin', { code, rejoinToken: rejoinB });
  assert.ok(ack.ok, ack.error);
  const f = await full;
  assert.ok(f.roster.some((r: any) => r.name === 'Bob'));
});

await test('leaving forfeits; last player standing wins and results are stored', async () => {
  const end = once<any>(sa, 'match:end', 10000);
  sb.emit('room:leave');
  sc.emit('room:leave');
  const e = await end;
  assert.equal(e.results[0].name, 'alice_pro');
  assert.equal(e.results[0].won, true);
  assert.ok(e.results[0].score >= 1000);
  const me = await get('/api/me', A.token);
  assert.equal(me.profile.wins, 1);
  assert.equal(me.profile.matches, 1);
  assert.ok(me.profile.xp > 0);
  const lb = await get('/api/leaderboard?metric=wins&period=day&mode=online', A.token);
  assert.equal(lb.rows[0].name, 'alice_pro');
  assert.equal(lb.rows[0].me, true);
});

await test('host can return the room to the lobby for a rematch', async () => {
  const lobbyP = once<any>(sa, 'lobby');
  sa.emit('room:lobby');
  const l = await lobbyP;
  assert.equal(l.state, 'lobby');
});

await test('solo results are validated', async () => {
  const bad = await post('/api/solo-result', { score: 999999, kills: 3, durationSec: 60, placement: 1, players: 11, won: true, difficulty: 'hard' }, B.token);
  assert.equal(bad.status, 400);
  const good = await post('/api/solo-result', { score: 2400, kills: 3, durationSec: 200, placement: 1, players: 11, won: true, difficulty: 'hard' }, B.token);
  assert.equal(good.status, 200, JSON.stringify(good.json));
  assert.equal(good.json.profile.wins, 1);
});

await test('friends leaderboard', async () => {
  const guestAdd = await post('/api/friends', { username: 'alice_pro' }, C.token);
  assert.equal(guestAdd.status, 403);
  const r = await post('/api/auth/register', { username: 'bobby', password: 'secret123' }, B.token);
  B.token = r.json.token;
  const f = await post('/api/friends', { username: 'alice_pro' }, B.token);
  assert.equal(f.status, 200, JSON.stringify(f.json));
  const lb = await get('/api/leaderboard?scope=friends&metric=matches&mode=online', B.token);
  assert.deepEqual(lb.rows.map((x: any) => x.name), ['alice_pro']);
});

sa!.close(); sb!.close(); sc!.close();
server.kill();
console.log(failed ? '\nSOME TESTS FAILED' : '\nAll tests passed');
process.exit(failed ? 1 : 0);
