// A big page must never show a part of itself in its own light colors, also when the machine is slow or busy: the main thread is
// slowed down 4 and 6 times (CDP), and the frames the screen gets are captured. The quick dark version stays while the theme is built.
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

/** Load a page from a dark page; report the share of light pixels in every painted frame. */
async function load(path, rate) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await cpuThrottle(page, rate);
  await page.goto(`${servers.origin}/dark.html`);
  const lightShare = await paintedLightness(
    page,
    helper,
    async () => {
      await page.goto(`${servers.origin}${path}`);
      await waitState(page, 'ready', 120000);
    },
    { share: 0.7 },
  );
  return { page, lightShare, url: `${servers.origin}${path}` };
}

// 30 000 rules with nearly all colors different, the rows of the window use rules from the whole sheet; and about 72 000 elements.
const PAGES = [
  ['/gen/big-light.html?rules=30000', [1, 4, 6]],
  ['/gen/code.html', [1, 6]],
];

for (const [path, rates] of PAGES) {
  for (const rate of rates) {
    test(`${path} shows no light part while it is themed, main thread ${rate} times slower`, { timeout: 240000 }, async () => {
      const { page, lightShare, url } = await load(path, rate);
      const stats = await browser.stats(url);
      console.log(`# ${path} x${rate}: ${lightShare.length} frames, most light ${Math.max(...lightShare).toFixed(2)}; held ${stats.holdMs?.toFixed(0)} ms, released by ${stats.released}, ready ${stats.readyAt?.toFixed(0)} ms, longest slice ${stats.slices?.maxMs?.toFixed(0)} ms`);
      assert.ok(lightShare.length > 0, 'no frame was painted');
      assert.ok(Math.max(...lightShare) < 0.05, `a frame was light: ${lightShare.map((v) => v.toFixed(2)).join(' ')}`);
      assert.equal(stats.released, 'settled', 'the quick version ends when the page is themed, not by a cap');
      await page.close();
    });
  }
}
