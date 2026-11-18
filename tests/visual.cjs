// Visual smoke test: late-match solo frame + phone layout.
const { chromium, devices } = require('playwright');
const OUT = process.argv[2] || '.';
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 860 } })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://localhost:3000');
  await page.getByText('Play Solo').click();
  await page.getByText('Normal').click();
  await page.getByText('Small').click();
  await page.getByText('Launch').click();
  // Wander in circles collecting orbs for ~45s so the zone starts shrinking.
  const keys = ['w', 'd', 's', 'a'];
  for (let i = 0; i < 30; i++) {
    const k = keys[i % 4];
    await page.keyboard.down(k);
    await page.mouse.move(720 + Math.cos(i) * 300, 430 + Math.sin(i) * 300);
    if (i % 3 === 0) await page.mouse.down();
    await page.waitForTimeout(1500);
    await page.mouse.up();
    await page.keyboard.up(k);
    if (await page.locator('.modal.death').count()) break;
  }
  await page.screenshot({ path: `${OUT}/09-late.png` });
  console.log('state:', await page.locator('.hud-top').innerText().catch(() => '?'), '| death modal:', await page.locator('.modal.death').count());
  const phone = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
  phone.on('pageerror', (e) => errs.push('phone: ' + e.message));
  await phone.goto('http://localhost:3000');
  await phone.getByText('Play Solo').waitFor();
  await phone.screenshot({ path: `${OUT}/10-phone-menu.png` });
  await phone.getByText('Play Solo').click();
  await phone.getByText('Launch').click();
  await phone.waitForTimeout(4500);
  await phone.screenshot({ path: `${OUT}/11-phone-game.png` });
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await browser.close();
})();
