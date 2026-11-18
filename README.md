# ORBIT: Gravity Wars

A real-time multiplayer browser game. Grow your planet, bend gravity, and knock rivals into black holes.

- **Play Solo**: 10 AI planets (Easy / Normal / Hard). Runs entirely in the browser, so it keeps working offline once the page has loaded.
- **Play With Friends**: private rooms with a 5-character code or invite link, up to 16 players, run by an **authoritative game server** (Socket.IO). Every player is a real connected person. Online rooms have no bots.
- Accounts (guest or registered), persistent stats in SQLite, daily/weekly/all-time/friends leaderboards, unlockable cosmetics, procedural sound and music.

## Run it

Requires Node.js 22.5+ (uses the built-in `node:sqlite`, no native modules).

```bash
npm install
npm run build
npm start            # http://localhost:3000
```

Development with hot reload (server on :3000, Vite client on :5173):

```bash
npm run dev
```

Tests:

```bash
npm test                  # server integration tests: rooms, sync, reconnect, accounts, leaderboards
node tests/e2e.cjs .      # browser E2E (needs the server running on :3000 + Playwright)
```

## Playing with friends on different computers

The server must be reachable by everyone, so deploy it (any host that runs Docker or Node 22 and supports WebSockets):

```bash
docker build -t orbit .
docker run -p 3000:3000 -v orbit-data:/data orbit
```

Render, Railway and Fly.io all work with the included `Dockerfile`. Attach a **persistent volume at `/data`** so accounts and leaderboards survive restarts. On a LAN you can also just run `npm start` and have friends open `http://<your-ip>:3000`.

Then: **Play With Friends → Create Room → Copy invite link**, and friends open the link (or use **Join Game** with the code).

## Controls

| Action | Keyboard / mouse | Touch |
| --- | --- | --- |
| Move | WASD / arrows | drag left side |
| Aim | mouse | movement direction |
| Attract | left click / Q | ATTRACT |
| Repel | right click / E / Shift | REPEL |
| Dash | Space | DASH |
| Pause / menu | Esc | ❚❚ |
| Spectate next (when eliminated) | click / Tab | |

## How it plays

- Collect energy orbs to gain mass and score. Golden clusters are worth 8×. Bigger planets pull harder but move slower, and very large planets slowly lose mass, so an early lead doesn't snowball.
- **Attract** pulls planets and orbs toward you and **Repel** blasts them away. Both drain energy, which regenerates while idle and refills from orbs.
- **Dash** gives a burst of speed with a 1.8s cooldown. Collisions while dashing hit 40% harder.
- You're eliminated by black holes, by leaving the arena edge, by staying outside the shrinking safe zone, or by being **consumed** by a planet with 30% more mass. Whoever touched you in the last 5 seconds gets the elimination.
- Escalation: the safe zone shrinks from ~35s in, new black holes appear over time, and random space events fire (energy storms, temporary giant black holes, gravity surges).
- The last planet standing gets +1000. Matches last about 3–5 minutes.

## Architecture

```
shared/   simulation used by both server and client
  sim.ts        physics, abilities, hazards, zone, events, scoring
  ai.ts         bot brains (solo only)
  protocol.ts   compact snapshot / delta encoding
  cosmetics.ts  catalog, unlock rules, XP formula
server/   Express + Socket.IO + node:sqlite
  rooms.ts      private rooms, 60 Hz authoritative sim, 30 Hz snapshots, reconnect grace, host migration
  db.ts         users, sessions, results, friends, leaderboard queries
  index.ts      REST API, auth (scrypt), validation, rate limits, static hosting
client/   React UI + custom Canvas 2D renderer
  game/session.ts   LocalSession (solo) / NetSession (interpolation + client-side prediction & reconciliation)
  game/renderer.ts  camera, warped spacetime grid, black holes, trails, particles, minimap
  audio.ts          Web Audio synth SFX + ambient music
```

Netcode: clients send only inputs (movement vector, aim, buttons, sequence number). The server simulates everything and broadcasts snapshots: all players and black holes every tick, with orbs sent as add/remove/move deltas. Remote planets are rendered ~100 ms in the past with interpolation. Your own planet is predicted locally and reconciled against acknowledged inputs, so controls feel instant. Disconnected players keep their seat for 45 s, and refreshing the page rejoins automatically. Match results are computed by the server, never reported by clients.

Solo results come from the browser simulation (so solo works offline). They're accepted with plausibility checks and shown on a separate **Solo** leaderboard, so they can't pollute the online rankings.
