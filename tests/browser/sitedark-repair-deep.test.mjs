// A light section that sits deeper than two wrappers below the body is found and darkened by the repair of the page's own dark theme.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

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

test('a white section inside four wrappers is darkened and the page keeps its own theme', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/site-repair-deep.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000 * SLOW);
  for (let i = 0; i < 200; i++) {
    const s = await browser.stats(url);
    if (s && s.siteDark.state === 'on' && s.siteDark.repair.state === 'done') break;
    await page.waitForTimeout(50);
  }
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  assert.equal(s.siteDark.repair.state, 'done');
  const bg = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = getComputedStyle(document.getElementById('white')).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
  });
  assert.ok(Math.max(...bg) < 90, `white section is ${bg}`);
  await page.close();
});
