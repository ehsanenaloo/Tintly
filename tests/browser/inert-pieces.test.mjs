// While the quick dark version covers the page nobody sees the themed copy, so the pieces of the copy are inserted inert
// (`media="not all"`) and switched on together when the page is released. A live insertion makes the browser restyle the page,
// which costs seconds on a big page with a slow main thread.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, paintedLightness, cpuThrottle } from './harness.mjs';

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

async function load(path, rate, storage = { settings: { enabled: true } }) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await cpuThrottle(page, rate);
  // Watch the pieces from the page's own world: in every sample, are they inert while the first paint is held?
  await page.addInitScript(() => {
    const samples = [];
    globalThis.__pieceSamples = samples;
    const look = () => {
      if (!document.documentElement) return void setTimeout(look, 5);
      const pieces = [...document.querySelectorAll('style[data-dk="sheet"], style[data-dk="site"]')];
      const held = !document.documentElement.hasAttribute('data-dk-go');
      samples.push({ held, pieces: pieces.length, live: pieces.filter((p) => p.media !== 'not all' && p.getAttribute('media') !== 'not all').length });
      setTimeout(look, 15);
    };
    look();
  });
  await page.goto(`${servers.origin}/dark.html`);
  const url = `${servers.origin}${path}`;
  const lightness = await paintedLightness(page, helper, async () => {
    await page.goto(url);
    await waitState(page, 'ready', 120000);
  });
  const samples = await page.evaluate(() => globalThis.__pieceSamples);
  const stats = await browser.stats(url);
  return { page, lightness, samples, stats, url };
}

for (const rate of [1, 4]) {
  test(`the pieces are inert while the page is held and live after, no light frame, main thread ${rate} times slower`, { timeout: 240000 }, async () => {
    const { page, lightness, samples, stats } = await load('/gen/big-light.html?rules=30000&elements=600', rate);
    assert.deepEqual(lightness.filter((v) => v > 0.5), [], 'no painted frame may be light');
    assert.equal(stats.released, 'settled');
    assert.ok(stats.pieces > 5, `the copy is made of ${stats.pieces} pieces`);
    const during = samples.filter((s) => s.held && s.pieces > 0);
    assert.ok(during.length > 0, 'the pieces were seen while the page was held');
    assert.deepEqual(during.filter((s) => s.live > 0), [], 'no piece is live while the first paint is held');
    const last = samples[samples.length - 1];
    assert.equal(last.held, false);
    assert.equal(last.live, last.pieces, 'every piece is live after the release');
    assert.ok(await page.evaluate(() => getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)'), 'the page is themed');
    await page.close();
  });
}

test('a page with a dark theme of its own: the check of that theme sees the pieces live', { timeout: 120000 }, async () => {
  const { page, stats } = await load('/gen/site-dark-large.html?rules=800&uncovered=10', 1);
  assert.equal(stats.released, 'settled');
  assert.equal(stats.siteDark.state, 'on', JSON.stringify(stats.siteDark));
  await page.close();
});

test('without the hold the pieces are live at once, because the page is visible while it is themed', { timeout: 120000 }, async () => {
  const { page, samples, stats } = await load('/gen/big-light.html?rules=6000&elements=300', 1, { settings: { enabled: true, holdPaint: false } });
  assert.ok(stats.pieces > 1);
  const seen = samples.filter((s) => s.pieces > 0);
  assert.ok(seen.length > 0);
  assert.deepEqual(seen.filter((s) => s.live !== s.pieces), [], 'every piece is live when it is inserted');
  await page.close();
});
