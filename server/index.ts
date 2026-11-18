// ORBIT game server: REST API (accounts, profiles, leaderboards) + Socket.IO realtime rooms + static client.
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { Store, UserRow, Period, Metric, Mode } from './db';
import { RoomManager } from './rooms';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = process.cwd();
const DB_FILE = process.env.DB_FILE ?? join(ROOT, 'data', 'orbit.sqlite');
const store = new Store(DB_FILE);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '16kb' }));

const NAME_RE = /^[A-Za-z0-9 _\-]{2,16}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

// --- tiny in-memory rate limiter
const buckets = new Map<string, { n: number; reset: number }>();
function limit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  b.n++;
  return b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

type AuthedRequest = Request & { user?: UserRow; token?: string };
function auth(required: boolean) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const user = store.userForToken(token);
    if (!user && required) return res.status(401).json({ error: 'Not signed in.' });
    req.user = user;
    req.token = token;
    next();
  };
}

const cleanName = (s: unknown) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');

app.get('/api/health', (_req, res) => res.json({ ok: true, ...rooms.stats() }));

app.post('/api/auth/guest', (req, res) => {
  if (!limit(`guest:${req.ip}`, 30, 3600_000)) return res.status(429).json({ error: 'Too many requests.' });
  let name = cleanName(req.body?.name);
  if (!NAME_RE.test(name) || store.usernameTaken(name)) name = `Guest${Math.floor(1000 + Math.random() * 9000)}`;
  res.json(store.createGuest(name));
});

app.get('/api/me', auth(true), (req: AuthedRequest, res) => res.json({ profile: store.profile(req.user!.id) }));

app.post('/api/auth/register', auth(false), (req: AuthedRequest, res) => {
  if (!limit(`reg:${req.ip}`, 10, 3600_000)) return res.status(429).json({ error: 'Too many requests.' });
  const username = cleanName(req.body?.username);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 3-16 letters, numbers or underscores.' });
  if (password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const out = store.register(username, password, req.user?.is_guest ? req.user.id : null);
  if ('error' in out) return res.status(409).json(out);
  if (req.token) store.deleteSession(req.token);
  res.json(out);
});

app.post('/api/auth/login', (req, res) => {
  if (!limit(`login:${req.ip}`, 20, 600_000)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const out = store.login(cleanName(req.body?.username), String(req.body?.password ?? ''));
  if ('error' in out) return res.status(401).json(out);
  res.json(out);
});

app.post('/api/auth/logout', auth(false), (req: AuthedRequest, res) => {
  if (req.token) store.deleteSession(req.token);
  res.json({ ok: true });
});

app.post('/api/profile', auth(true), (req: AuthedRequest, res) => {
  let name: string | undefined;
  if (req.body?.name !== undefined) {
    name = cleanName(req.body.name);
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'Name: 2-16 letters, numbers, spaces, - or _.' });
    if (!req.user!.is_guest && name === req.user!.display_name) name = undefined;
  }
  const out = store.updateProfile(req.user!.id, name, req.body?.cosmetics);
  if ('error' in out) return res.status(400).json(out);
  res.json({ profile: out });
});

// Solo matches are simulated in the browser (so they work offline). We accept them with plausibility checks.
const lastSolo = new Map<number, number>();
app.post('/api/solo-result', auth(true), (req: AuthedRequest, res) => {
  const b = req.body ?? {};
  const score = Math.floor(Number(b.score)), kills = Math.floor(Number(b.kills)), duration = Number(b.durationSec);
  const placement = Math.floor(Number(b.placement)), players = Math.floor(Number(b.players));
  const difficulty = ['easy', 'normal', 'hard'].includes(b.difficulty) ? b.difficulty : null;
  const won = b.won === true;
  const now = Date.now();
  const valid =
    difficulty && [score, kills, duration, placement, players].every(Number.isFinite) &&
    players >= 2 && players <= 16 && placement >= 1 && placement <= players && kills >= 0 && kills < players &&
    duration > 0 && duration <= 480 && score >= 0 && score <= duration * 40 + kills * 2500 + 3000 &&
    (!won || placement === 1) &&
    now - (lastSolo.get(req.user!.id) ?? 0) >= Math.min(duration, 60) * 1000 * 0.8;
  if (!valid) return res.status(400).json({ error: 'Result rejected.' });
  lastSolo.set(req.user!.id, now);
  const rec = store.recordResult(req.user!.id, { mode: 'solo', score, kills, won, placement, players, difficulty });
  res.json({ ...rec, profile: store.profile(req.user!.id) });
});

app.get('/api/leaderboard', auth(false), (req: AuthedRequest, res) => {
  const period = (['all', 'week', 'day'].includes(String(req.query.period)) ? req.query.period : 'all') as Period;
  const metric = (['score', 'kills', 'wins', 'matches'].includes(String(req.query.metric)) ? req.query.metric : 'score') as Metric;
  const mode = (req.query.mode === 'solo' ? 'solo' : 'online') as Mode;
  const friends = req.query.scope === 'friends';
  if (friends && !req.user) return res.status(401).json({ error: 'Sign in to see your friends leaderboard.' });
  res.json({ rows: store.leaderboard({ period, metric, mode, friendsOf: friends ? req.user!.id : undefined, meId: req.user?.id }) });
});

app.get('/api/friends', auth(true), (req: AuthedRequest, res) => res.json({ friends: store.friends(req.user!.id) }));
app.post('/api/friends', auth(true), (req: AuthedRequest, res) => {
  if (req.user!.is_guest) return res.status(403).json({ error: 'Create an account to add friends.' });
  const out = store.addFriend(req.user!.id, cleanName(req.body?.username));
  if ('error' in out) return res.status(400).json(out);
  res.json({ friends: store.friends(req.user!.id) });
});
app.delete('/api/friends/:username', auth(true), (req: AuthedRequest, res) => {
  store.removeFriend(req.user!.id, req.params.username);
  res.json({ friends: store.friends(req.user!.id) });
});

// --- static client (production build)
const here = dirname(fileURLToPath(import.meta.url));
const clientDir = [join(here, '../client'), join(ROOT, 'dist/client')].find((d) => existsSync(join(d, 'index.html')));
if (clientDir) {
  app.use(express.static(clientDir, { index: false, maxAge: '1h', setHeaders: (res, path) => { if (path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.get(/^\/(?!api|socket\.io).*/, (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(join(clientDir, 'index.html')); });
}

const http = createServer(app);
const io = new Server(http, { cors: { origin: true }, pingInterval: 5000, pingTimeout: 8000, maxHttpBufferSize: 1e5 });
const rooms = new RoomManager(io, store);

io.use((socket, next) => {
  const token = (socket.handshake.auth as { token?: string })?.token;
  const user = store.userForToken(token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});
io.on('connection', (socket) => rooms.attach(socket));

http.listen(PORT, () => console.log(`ORBIT server listening on http://localhost:${PORT}${clientDir ? '' : ' (API only - run the Vite dev server for the client)'}`));
