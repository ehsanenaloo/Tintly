// a faint white veil on a dark section stays a veil in the Dark mode, a fuller one is a surface that turns dark.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, pixelsOf } from './harness.mjs';

let servers;
let browser;
let helper;
before(async () => {
  servers = await startServers();
  browser = await launch();
  helper = await browser.context.newPage();
  await helper.goto('about:blank');
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const mean = (c) => (c[0] + c[1] + c[2]) / 3;

test('the glass card and its border are lighter than the section under them; the frosted panel turns dark', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${servers.origin}/veil.html`);
  await waitState(page, 'ready');
  await page.waitForTimeout(500);
  const box = async (id) => page.evaluate((i) => {
    const r = document.getElementById(i).getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, id);
  const [plain, glass, panel] = await Promise.all([box('plain'), box('glass'), box('panel')]);
  const point = (b, dx, dy) => [Math.round(b.x + dx), Math.round(b.y + dy)];
  const px = await pixelsOf(page, helper, [
    point(plain, 150, 60), // the section
    point(glass, 150, 60), // the card
    point(glass, 1, 40), // its border
    point(panel, 150, 70), // the panel
  ]);
  const [section, card, border, frosted] = px.map(mean);
  assert.ok(card > section + 8, `card ${card} against section ${section}`);
  assert.ok(border > section + 8, `border ${border} against section ${section}`);
  assert.ok(frosted < 80, `frosted panel ${frosted}`);
  await page.close();
});
