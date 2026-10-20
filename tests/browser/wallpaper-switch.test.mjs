// A mode switch must not show a dark wallpaper next to light panels, not even for a moment: the marks of the pictures
// module are made again in the same task that starts it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, imageStore, paintedLightness, SLOW } from './harness.mjs';
import { lineArtTile, png } from '../helpers/tiles.mjs';

let servers;
let browser;
let helper;
let extensionPage;

before(async () => {
  imageStore.set('wall-dark', png(lineArtTile(64, [11, 20, 26, 255], [233, 237, 239, 255])));
  servers = await startServers();
  browser = await launch();
  helper = await browser.context.newPage();
  await helper.goto('about:blank');
  extensionPage = await browser.context.newPage();
  await extensionPage.goto(`chrome-extension://${new URL(browser.worker.url()).host}/pages/options/options.html`);
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const fromPage = (message) => extensionPage.evaluate((m) => chrome.runtime.sendMessage(m), message);
const MODES = { dark: { mode: 'dark' }, light: { mode: 'light' }, paper: { mode: 'eink', einkPreset: 'paper' } };

async function open(first) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: MODES[first] } });
  const page = await browser.context.newPage();
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.goto(`${servers.origin}/wallpaper.html`);
  await waitState(page, 'ready', 30000 * SLOW);
  // The first look has marked the wallpapers (the Dark look marks none).
  if (first !== 'dark') await page.waitForFunction(() => document.querySelectorAll('[data-dk-bg="wall"]').length >= 4, null, { timeout: 30000 * SLOW });
  await page.waitForTimeout(1500 * SLOW);
  return page;
}

for (const [from, to] of [['light', 'paper'], ['paper', 'light']]) {
  test(`${from} to ${to}: no frame shows the wallpaper dark`, { timeout: 120000 * SLOW }, async () => {
    const page = await open(from);
    const share = await paintedLightness(page, helper, async () => {
      assert.equal((await fromPage({ type: 'dk.settings.patch', patch: { theme: MODES[to] } })).ok, true);
      await page.waitForTimeout(2500 * SLOW);
    }, { share: 0.5 });
    console.log(`# ${from} to ${to}: ${share.map((v) => v.toFixed(2)).join(' ')}`);
    assert.ok(Math.min(...share) >= 0.94, `a frame with a dark wallpaper: ${share.join(' ')}`);
    await page.close();
  });
}

for (const to of ['light', 'paper']) {
  test(`dark to ${to}: the wallpaper is marked in the task that changes the look`, { timeout: 120000 * SLOW }, async () => {
    const page = await open('dark');
    await page.evaluate(() => {
      window.__swap = 0;
      window.__marked = 0;
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.attributeName === 'media' && !window.__swap) window.__swap = performance.now();
          else if (r.attributeName === 'data-dk-bg' && r.target.hasAttribute('data-dk-bg') && !window.__marked) window.__marked = performance.now();
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['media', 'data-dk-bg'] });
    });
    assert.equal((await fromPage({ type: 'dk.settings.patch', patch: { theme: MODES[to] } })).ok, true);
    await page.waitForFunction(() => window.__marked > 0, null, { timeout: 20000 * SLOW });
    const { swap, marked } = await page.evaluate(() => ({ swap: window.__swap, marked: window.__marked }));
    console.log(`# dark to ${to}: swap at ${Math.round(swap)}, marks at ${Math.round(marked)}`);
    assert.ok(swap > 0 && marked - swap <= 60 * SLOW, `marks ${marked - swap} ms after the swap`);
    await page.close();
  });
}
