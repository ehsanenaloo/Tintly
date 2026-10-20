// A large right-to-left shopping page (thousands of rules, hundreds of pictures, carousels moved by script) while the person
// switches modes. The main thread must not be blocked for long during a switch and must be quiet soon after the last
// one. Sizes can be raised with SHOP_RULES, SHOP_CAROUSELS, SHOP_CARDS, SHOP_DEPTH, SHOP_IMGDELAY and the engine chosen with
// SHOP_ENGINE, to look for the point where a page freezes; the defaults keep the test under a minute.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, waitState, SLOW } from './harness.mjs';
import { startShop } from './shop-page.mjs';

let shop;
let browser;
before(async () => {
  shop = await startShop({
    rules: Number(process.env.SHOP_RULES || 5000),
    carousels: Number(process.env.SHOP_CAROUSELS || 14),
    cards: Number(process.env.SHOP_CARDS || 30),
    depth: Number(process.env.SHOP_DEPTH || 12),
    imageDelay: Number(process.env.SHOP_IMGDELAY || 0),
  });
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await shop?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENGINE = process.env.SHOP_ENGINE || 'dynamic';
const MODES = {
  dark: { mode: 'dark' },
  light: { mode: 'light' },
  paper: { mode: 'eink', einkPreset: 'paper' },
  eink: { mode: 'eink', einkPreset: 'eink' },
};
const set = (enabled, name) => browser.setStorage({ settings: { enabled, engine: ENGINE, theme: MODES[name] } });

async function open(enabled) {
  await browser.clearStorage();
  await set(enabled, 'dark');
  const page = await browser.context.newPage();
  await page.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask', buffered: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(shop.origin, { waitUntil: process.env.SHOP_IMGDELAY ? 'commit' : 'load' });
  if (enabled) await waitState(page, 'ready', 60000 * SLOW).catch(() => {});
  await sleep(1500);
  return { page, cdp };
}

const busy = async (cdp) => (await cdp.send('Performance.getMetrics')).metrics.find((x) => x.name === 'TaskDuration').value * 1000;

/** Switch through `sequence`, `gap` ms apart. Main thread time of the switches, in a quiet 3 s later, and the long tasks. */
async function measure(enabled, sequence, gap) {
  const { page, cdp } = await open(enabled);
  await page.evaluate(() => (window.__long.length = 0));
  const t0 = await busy(cdp);
  for (const name of sequence) {
    await set(enabled, name);
    await sleep(gap);
  }
  const switched = (await busy(cdp)) - t0;
  // The engine's last build finishes (a busy machine takes long); the quiet window starts after that.
  if (enabled) {
    for (let i = 0; i < 400; i++) {
      const st = await browser.stats(`${shop.origin}/`).catch(() => null);
      if (st && st.ready && !st.waiting.fetching && !st.waiting.pending && !st.waiting.pumping) break;
      await sleep(250);
    }
  }
  await sleep(1500);
  const q0 = await busy(cdp);
  await sleep(3000);
  const quiet = (await busy(cdp)) - q0;
  const long = await page.evaluate(() => window.__long);
  const state = await page.evaluate(() => document.documentElement.getAttribute('data-dk-state'));
  await page.close();
  return { switched: Math.round(switched), quiet: Math.round(quiet), longCount: long.length, longMax: Math.round(Math.max(0, ...long)), state };
}

test('shop page: Dark, Paper, E-ink, Light, Dark at a calm pace', { timeout: 300000 }, async () => {
  const off = await measure(false, ['paper', 'eink', 'light', 'dark'], 1500);
  const on = await measure(true, ['paper', 'eink', 'light', 'dark'], 1500);
  console.log(`# off ${JSON.stringify(off)}\n# on  ${JSON.stringify(on)}`);
  assert.equal(on.state, 'ready');
  assert.ok(on.longMax < 450 * SLOW, `a task of ${on.longMax} ms`);
  assert.ok(on.switched < 3200 * SLOW, `${on.switched} ms of main thread work in four switches`);
  assert.ok(on.quiet < 250 * SLOW, `${on.quiet} ms of main thread work in 3 quiet seconds`);
});

test('shop page: rapid switching ends in the last mode and the thread is quiet afterwards', { timeout: 300000 }, async () => {
  const rapid = await measure(true, ['paper', 'eink', 'paper', 'light', 'eink', 'dark'], 100);
  console.log(`# rapid ${JSON.stringify(rapid)}`);
  assert.equal(rapid.state, 'ready');
  assert.ok(rapid.longMax < 450 * SLOW, `a task of ${rapid.longMax} ms`);
  assert.ok(rapid.quiet < 500 * SLOW, `${rapid.quiet} ms of main thread work in 3 quiet seconds`);
});
