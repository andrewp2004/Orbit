// Browser end-to-end test: solo game + two separate browsers sharing a private room.
const { chromium } = require('playwright');
const OUT = process.argv[2] || '.';
const URL = process.env.URL || 'http://localhost:3000';
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${name} console: ${m.text()}`));
    return page;
  };
  const a = await mk('A');
  await a.goto(URL);
  await a.getByText('Play Solo').waitFor();
  await a.waitForTimeout(800);
  await a.screenshot({ path: `${OUT}/01-menu.png` });

  // ---- Solo
  await a.getByText('Play Solo').click();
  await a.getByText('Hard').click();
  await a.getByText('Launch').click();
  await a.waitForTimeout(3600);
  await a.mouse.move(900, 300);
  await a.keyboard.down('d');
  await a.mouse.down();
  await a.waitForTimeout(1500);
  await a.mouse.up();
  await a.keyboard.press('Space');
  await a.waitForTimeout(400);
  await a.mouse.down({ button: 'right' });
  await a.waitForTimeout(300);
  await a.screenshot({ path: `${OUT}/02-solo.png` });
  await a.mouse.up({ button: 'right' });
  await a.keyboard.up('d');
  const hud = await a.locator('.stats').innerText();
  console.log('solo HUD:', hud.replace(/\n/g, ' '));
  await a.keyboard.press('Escape');
  await a.getByText('Quit to menu').click();

  // ---- Multiplayer: A hosts, B joins from a separate browser context
  await a.getByText('Play With Friends').click();
  await a.getByText('Create Room').click();
  const code = (await a.getByTestId('room-code').innerText()).trim();
  console.log('room code', code);
  const b = await mk('B');
  await b.goto(`${URL}/?room=${code}`);
  await b.getByText('Join Room').click();
  await a.getByText(/Start Match \(2 players\)/).waitFor();
  await a.screenshot({ path: `${OUT}/03-lobby.png` });
  await a.getByText(/Start Match/).click();
  await b.locator('.game-canvas').waitFor();
  await a.waitForTimeout(3500);
  await a.keyboard.down('w');
  await b.keyboard.down('s');
  await a.waitForTimeout(1200);
  await a.keyboard.up('w');
  await b.keyboard.up('s');
  await b.mouse.move(700, 400);
  await b.mouse.down();
  await a.waitForTimeout(600);
  await a.screenshot({ path: `${OUT}/04-online-A.png` });
  await b.screenshot({ path: `${OUT}/05-online-B.png` });
  await b.mouse.up();
  const ta = await a.locator('.alive').innerText(), tb = await b.locator('.alive').innerText();
  console.log('alive A:', ta, '| B:', tb);

  // ---- B drops connection and comes back (page reload restores the seat)
  await b.reload();
  await b.locator('.game-canvas').waitFor({ timeout: 10000 });
  console.log('B rejoined match after reload');
  // ---- B leaves: A is last planet standing
  await b.keyboard.press('Escape');
  await b.getByText('Leave room').click();
  await a.getByText('VICTORY').waitFor({ timeout: 10000 });
  await a.waitForTimeout(500);
  await a.screenshot({ path: `${OUT}/06-results.png` });

  // ---- Leaderboard + profile
  await a.getByText('Leave room').click();
  await a.getByText('Leaderboards').click();
  await a.getByText('Daily').click();
  await a.getByRole('button', { name: 'Wins' }).click();
  await a.waitForTimeout(500);
  await a.screenshot({ path: `${OUT}/07-leaderboard.png` });
  await a.locator('.back').click();
  await a.locator('.profile-card').click();
  await a.getByRole('button', { name: 'Skin' }).click();
  await a.waitForTimeout(500);
  await a.screenshot({ path: `${OUT}/08-profile.png` });
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no browser errors');
  await browser.close();
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
