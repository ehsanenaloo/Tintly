// Many web components that adopt one constructed sheet: the sheet is rewritten once for all of them, the page is ready quickly and the
// engine's memory stays small. Roots that the page throws away are released (R1-4).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, cpuThrottle, SLOW } from './harness.mjs';

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

const ROOTS = 200;

async function heap(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  return metrics.find((m) => m.name === 'JSHeapUsedSize').value;
}

async function load(enabled) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled } });
  const page = await browser.context.newPage();
  await cpuThrottle(page, 4);
  const url = `${servers.origin}/shadow-many.html#${ROOTS}`;
  await page.goto(url);
  await page.waitForFunction(() => window.__done === true);
  if (enabled) await waitState(page, 'ready', 60000 * SLOW);
  return { page, url };
}

test(`${ROOTS} roots with one 300-rule sheet: rewritten once, ready quickly, small heap`, { timeout: 240000 * SLOW }, async () => {
  const off = await load(false);
  const heapOff = await heap(off.page);
  await off.page.close();
  const on = await load(true);
  const stats = await browser.stats(on.url.split("#")[0]);
  const heapOn = await heap(on.page);
  console.log(`# ${ROOTS} roots: builds ${stats.adoptedBuilds}, rules ${stats.adoptedRules}, ready ${Math.round(stats.readyAt)} ms, heap +${((heapOn - heapOff) / 1048576).toFixed(1)} MB`);
  assert.ok(stats.adoptedRules <= 600, `${stats.adoptedRules} rules rewritten`);
  assert.ok(stats.adoptedBuilds <= 2, `${stats.adoptedBuilds} builds`);
  assert.ok(stats.readyAt < 1000 * Math.max(1, SLOW / 4) + 1500, `ready after ${Math.round(stats.readyAt)} ms`);
  assert.ok(heapOn - heapOff < 10 * 1048576, `heap +${((heapOn - heapOff) / 1048576).toFixed(1)} MB`);
  const themed = await on.page.evaluate(() => {
    const roots = [...document.querySelectorAll('x-card')].map((h) => h.shadowRoot);
    const bg = (r) => getComputedStyle(r.querySelector('.r1')).backgroundColor;
    return { first: bg(roots[0]), last: bg(roots[roots.length - 1]) };
  });
  assert.equal(themed.first, themed.last);
  assert.notEqual(themed.first, 'rgb(255, 255, 255)');
  await on.page.close();
});

test('roots the page throws away are released', { timeout: 180000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/shadow-many.html#10`;
  await page.goto(url);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.evaluate(async () => {
    const host = document.getElementById('host');
    for (let round = 0; round < 60; round++) {
      const batch = [];
      for (let i = 0; i < 100; i++) batch.push(document.createElement('x-card'));
      host.append(...batch);
      await new Promise((r) => setTimeout(r, 20));
      for (const el of batch) el.remove();
    }
  });
  await page.waitForTimeout(1500 * SLOW);
  // A page that adds one more root lets the engine settle its books.
  await page.evaluate(() => document.getElementById('host').append(document.createElement('x-card')));
  await page.waitForTimeout(500 * SLOW);
  const stats = await browser.stats(url.split("#")[0]);
  console.log(`# 6000 roots made and removed: roots ${stats.roots}`);
  assert.ok(stats.roots <= 64 + 11, `${stats.roots} roots still held`);
  await page.close();
});
