// An inline value that is not important loses to a page rule with `!important`, as in the page; an important inline value wins.
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

test('the order of important page rules and inline values is kept', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/inline-important.html`);
  await waitState(page, 'ready', 30000 * SLOW);
  const color = (id, prop = 'color') => page.evaluate(([i, p]) => getComputedStyle(document.getElementById(i))[p].match(/[\d.]+/g).slice(0, 3).map(Number), [id, prop]);
  const [r, g, b] = await color('page-wins');
  assert.ok(r > g + 60 && r > b + 60, `the important page rule lost: ${[r, g, b]}`);
  const [r2, g2, b2] = await color('inline-wins', 'webkitTextFillColor');
  assert.ok(Math.max(r2, g2, b2) - Math.min(r2, g2, b2) < 20 && Math.min(r2, g2, b2) > 150, `the important inline value lost: ${[r2, g2, b2]}`);
  const [r3, g3, b3] = await color('plain');
  assert.ok(Math.min(r3, g3, b3) > 150, `a plain inline value is not themed: ${[r3, g3, b3]}`);
  await page.close();
});
