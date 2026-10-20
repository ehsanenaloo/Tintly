// A style sheet that arrives late must never be painted in the page's own light colors, not at the end of the hold either,
// and the hold must not outlast the sheet by more than the engine needs to theme it. The same on a slow main thread.
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

const light = (list) => list.filter((v) => v > 0.5);

/** Load a page from a dark page with a throttled main thread; report every painted frame. */
async function load(path, rate) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await cpuThrottle(page, rate);
  await page.goto(`${servers.origin}/dark.html`);
  const t0 = Date.now();
  const lightness = await paintedLightness(page, helper, async () => {
    await page.goto(`${servers.origin}${path}`);
    await waitState(page, 'ready', 40000);
  });
  return { page, lightness, readyAfter: Date.now() - t0, url: `${servers.origin}${path}` };
}

// Sheets that arrive early (1.5 s), after the old hold cap of a body link (9 s) and, for a head link, just before the 10 s limit of the worker.
const CASES = [
  ['head', 1500, [1, 4, 6]],
  ['body', 1500, [1, 4, 6]],
  ['body', 9000, [1, 6]],
  ['head', 9000, [1, 6]],
];

for (const [place, ms, rates] of CASES) {
  for (const rate of rates) {
    test(`a cross-origin sheet in the ${place} that takes ${ms} ms shows no light frame, main thread ${rate} times slower`, { timeout: 150000 }, async () => {
      const { page, lightness, url } = await load(`/gen/slow-cross.html?ms=${ms}&place=${place}&other=${servers.other}`, rate);
      const stats = await browser.stats(url);
      console.log(`# ${place} ${ms} ms x${rate}: ${lightness.length} frames, lightness ${lightness.map((v) => v.toFixed(2)).join(' ')}; held ${stats.holdMs?.toFixed(0)} ms, released by ${stats.released}`);
      assert.deepEqual(light(lightness), [], 'no painted frame may be light');
      assert.equal(stats.released, 'settled', 'the hold ends when the page is themed, not by the cap');
      // The page waited once for the sheet (the text is fetched while the browser loads it), then needed time to theme it.
      assert.ok(stats.holdMs < ms + 2500 * Math.sqrt(rate), `held ${stats.holdMs} ms for a sheet that takes ${ms} ms`);
      await page.close();
    });
  }
}

for (const rate of [1, 6]) {
  test(`an alternate sheet and a print sheet are not waited for, main thread ${rate} times slower`, { timeout: 90000 }, async () => {
    const { page, lightness, url } = await load('/alternate-sheet.html', rate);
    const stats = await browser.stats(url);
    console.log(`# alternate and print x${rate}: held ${stats.holdMs?.toFixed(0)} ms, released by ${stats.released}`);
    assert.deepEqual(light(lightness), [], 'no painted frame may be light');
    assert.equal(stats.released, 'settled');
    assert.ok(stats.holdMs < 1500 * Math.sqrt(rate) + 500, `held ${stats.holdMs} ms`);
    await page.close();
  });
}
