// Mode changes that follow each other quickly must not restart the picture modules for every step: the page would sort all its
// pictures and look at all its backgrounds again each time. They start once for the mode that stays.
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

const MODES = {
  dark: { mode: 'dark' },
  paper: { mode: 'eink', einkPreset: 'paper' },
  eink: { mode: 'eink', einkPreset: 'eink' },
  light: { mode: 'light' },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inTab = (url, func, args = []) =>
  browser.worker.evaluate(
    async ({ u, a, f }) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: f === 'count' ? () => globalThis.__imageStarts : f === 'watch' ? () => {
        globalThis.__imageStarts = 0;
        new MutationObserver((records) => {
          for (const rec of records) for (const n of rec.addedNodes) if (n.nodeType === 1 && n.matches('style[data-dk="images"]')) globalThis.__imageStarts += 1;
        }).observe(document.documentElement, { childList: true, subtree: true });
      } : () => ({ images: globalThis.__dk.images.isActive(), backdrop: globalThis.__dk.backdrop.isActive(), since: globalThis.__dk.backdrop.stats()?.since, state: document.documentElement.getAttribute('data-dk-state') }), args: a });
      return r.result;
    },
    { u: url, a: args, f: func },
  );

test('a burst of mode changes starts the picture modules once, and they run for the last mode', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme: MODES.dark } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/dynamic.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000);
  for (let i = 0; i < 100 && !(await inTab(url, 'state')).images; i++) await sleep(100);
  await inTab(url, 'watch');
  const first = (await inTab(url, 'state')).since;
  // Dark -> Paper -> E-ink -> Paper -> E-ink -> Dark, 120 ms apart.
  for (const name of ['paper', 'eink', 'paper', 'eink', 'dark']) {
    await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme: MODES[name] } });
    await sleep(120);
  }
  await sleep(4000);
  const starts = await inTab(url, 'count');
  const state = await inTab(url, 'state');
  assert.ok(starts <= 2, `the picture module started ${starts} times`);
  assert.deepEqual([state.images, state.backdrop], [true, true]);
  assert.equal(state.since, first, 'the sweep of text on pictures was restarted by a change of mode');
  await page.close();
});
