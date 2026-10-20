// A bulk insert of tens of thousands of elements must not make a long task for the engine: the engine's longest task on added
// nodes stays short, and the longest gap of the main thread (which holds the page's own rendering of the new rules) stays within 20% and 50 ms of the same page without the extension.
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

async function worstGap(enabled) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/bulk-insert.html`;
  await page.goto(url);
  await page.waitForFunction(() => window.__done === true);
  if (enabled) await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForTimeout(500);
  const worst = await page.evaluate(() => window.run());
  const stats = enabled ? await browser.stats(url) : null;
  await page.close();
  return { worst, longest: stats?.longestAddMs ?? 0 };
}

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

test('a bulk insert costs no long task of the engine', { timeout: 300000 * SLOW }, async () => {
  const off = [];
  const on = [];
  const longest = [];
  for (let i = 0; i < 3; i++) {
    off.push((await worstGap(false)).worst);
    const run = await worstGap(true);
    on.push(run.worst);
    longest.push(run.longest);
  }
  console.log(`# longest gap: off ${median(off).toFixed(0)} ms, on ${median(on).toFixed(0)} ms; longest task on added nodes ${median(longest).toFixed(0)} ms`);
  assert.ok(median(longest) <= 30 * SLOW, `the engine's longest task on added nodes was ${median(longest).toFixed(0)} ms`);
  assert.ok(median(on) <= median(off) * 1.2 + 50 * SLOW, `on ${median(on).toFixed(0)} ms, off ${median(off).toFixed(0)} ms`);
});
