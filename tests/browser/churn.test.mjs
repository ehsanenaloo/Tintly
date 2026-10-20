// A sheet whose text is rewritten many times in a short while is built once after it settles.
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

const lum = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};

/** Rewrite the style element 50 times in about a second and report the engine's work. */
async function burst(options) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/churn.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000);
  await browser.restartEngine(url, options);
  const before = await browser.stats(url);
  await page.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      window.rewrite(i, i === 49);
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  const during = await browser.stats(url);
  // Wait for the engine to go quiet.
  for (let i = 0; i < 100; i++) {
    const s = await browser.stats(url);
    if (!s.waiting.pending && !s.waiting.pumping && s.churnDeferred >= 0 && i > 15) break;
    await page.waitForTimeout(50);
  }
  const after = await browser.stats(url);
  const bg = await page.evaluate(() => getComputedStyle(document.getElementById('box')).backgroundColor);
  await page.close();
  return {
    rebuilds: after.processed - before.processed,
    sliceMs: after.slices.totalMs - before.slices.totalMs,
    deferred: after.churnDeferred,
    bg,
    during: during.processed - before.processed,
  };
}

test('50 rewrites of a style element in a second are built a few times, and the final colors are themed', { timeout: 120000 }, async () => {
  const each = await burst({ coalesce: false });
  const settled = await burst({});
  console.log(`# churn, rebuild at every change: ${each.rebuilds} rebuilds, ${each.sliceMs.toFixed(1)} ms of slices; coalesced: ${settled.rebuilds} rebuilds, ${settled.sliceMs.toFixed(1)} ms, ${settled.deferred} changes deferred`);
  assert.ok(each.rebuilds >= 20, `without the rule the sheet is built often (${each.rebuilds})`);
  assert.ok(settled.rebuilds <= 12, `rebuilds: ${settled.rebuilds}`);
  assert.ok(settled.deferred > 0);
  assert.ok(settled.sliceMs < each.sliceMs, `${settled.sliceMs} against ${each.sliceMs}`);
  // The last text sets a white box: it must be themed dark once the engine has settled.
  assert.ok(lum(settled.bg) < 0.25, settled.bg);
});

test('the first build of a new sheet is never delayed', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/churn.html`);
  await waitState(page, 'ready', 30000);
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '#late{background:#ffffff;color:#111}';
    document.head.append(s);
    const d = document.createElement('div');
    d.id = 'late';
    d.textContent = 'late';
    document.body.append(d);
  });
  await page.waitForFunction(() => {
    const m = /\d+/g;
    const c = getComputedStyle(document.getElementById('late')).backgroundColor.match(m).map(Number);
    return c[0] < 90;
  }, undefined, { timeout: 2000 });
  await page.close();
});
