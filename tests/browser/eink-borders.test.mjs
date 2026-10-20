import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

let servers;
let browser;

before(async () => {
  servers = await startServers();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await servers?.close();
});

test('thicker lines in E-ink thicken borders that exist and never draw a border a control does not have', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'eink', einkBorders: true } } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/eink-borders.html`);
  await waitState(page, 'ready', 30000);
  const width = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).borderTopWidth + ' ' + getComputedStyle(document.getElementById(i)).borderTopStyle, id);
  assert.equal(await width('plain'), '0px none', 'the borderless input inside a pill got a border');
  assert.equal(await width('framed'), '2px solid', 'a border that exists was not thickened');
  await page.close();
});
