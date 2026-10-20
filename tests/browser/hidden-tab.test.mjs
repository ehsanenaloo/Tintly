// A settings change reaches a tab that nobody can see only when the tab is shown, once, with the newest settings. The tab shows
// the right theme from its first frame after it is shown. Headless Chromium keeps every tab visible, so the visibility of the page is
// set in the isolated world of the page (where the gate reads it) and the event is sent from there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, paintedLightness, SLOW } from './harness.mjs';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DARK = { mode: 'dark' };
const LIGHT = { mode: 'light' };

/** Run a function in the isolated world of the tab that shows `url`. */
const isolated = (url, name) =>
  browser.worker.evaluate(
    async ({ u, name }) => {
      const table = {
        hide: () => {
          Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        },
        show: () => {
          delete (/** @type {any} */ (document)).visibilityState;
          document.dispatchEvent(new Event('visibilitychange'));
        },
        look: () => {
          const engine = globalThis.__dk?.dynamic?.stats?.();
          return { startedAt: engine?.startedAt ?? null, ready: engine?.ready ?? null, state: document.documentElement.getAttribute('data-dk-state') };
        },
      };
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: table[name] });
      return r.result;
    },
    { u: url, name },
  );

const bodyLightness = (page) =>
  page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });

async function open(path, theme = DARK) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}${path}`;
  await page.goto(url);
  await waitState(page, 'ready', 30000 * SLOW);
  return { page, url };
}

test('a hidden tab does not rebuild for a change of the look; a visible tab does at once', { timeout: 120000 * SLOW }, async () => {
  const hiddenTab = await open('/dynamic.html');
  const visible = await browser.context.newPage();
  const visibleUrl = `${servers.origin}/dark.html`;
  await visible.goto(visibleUrl);
  await waitState(visible, 'ready', 30000 * SLOW);
  await isolated(hiddenTab.url, 'hide');
  const before = await isolated(hiddenTab.url, 'look');
  assert.equal(before.ready, true);
  await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme: LIGHT } });
  // The tab that is seen follows.
  await visible.waitForFunction(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
  }, undefined, { timeout: 15000 * SLOW });
  await sleep(1500 * SLOW);
  const after = await isolated(hiddenTab.url, 'look');
  assert.equal(after.startedAt, before.startedAt, 'the hidden tab built nothing');
  assert.ok((await bodyLightness(hiddenTab.page)) < 0.3, 'it still shows the old look; nobody sees it');
  await hiddenTab.page.close();
  await visible.close();
});

test('changes in a hidden tab are taken together: one rebuild with the newest settings when the tab is shown', { timeout: 120000 * SLOW }, async () => {
  const { page, url } = await open('/dynamic.html');
  await isolated(url, 'hide');
  const before = await isolated(url, 'look');
  for (const theme of [LIGHT, { mode: 'dark', brightness: 80 }, { mode: 'eink', einkPreset: 'paper' }, LIGHT]) {
    await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme } });
    await sleep(250 * SLOW);
  }
  assert.equal((await isolated(url, 'look')).startedAt, before.startedAt);
  await isolated(url, 'show');
  await page.waitForFunction(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
  }, undefined, { timeout: 15000 * SLOW });
  await sleep(800 * SLOW);
  const done = await isolated(url, 'look');
  assert.notEqual(done.startedAt, before.startedAt, 'it rebuilt');
  // One rebuild: the engine that runs now was started once after the tab was shown.
  const again = await isolated(url, 'look');
  assert.equal(again.startedAt, done.startedAt);
  await page.close();
});

test('the tab shows the new look from its first frame after it is shown', { timeout: 120000 * SLOW }, async () => {
  const { page, url } = await open('/dynamic.html', DARK);
  await isolated(url, 'hide');
  await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme: LIGHT } });
  await sleep(600 * SLOW);
  const times = [];
  let shownAt = 0;
  const frames = await paintedLightness(
    page,
    helper,
    async () => {
      await sleep(200);
      shownAt = Date.now();
      await isolated(url, 'show');
      await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', undefined, { timeout: 15000 * SLOW });
    },
    { times },
  );
  // The first frame of a screencast is the screen as it is when the capture starts; the frames after the event are the ones that count.
  const later = frames.filter((_, i) => times[i] >= shownAt - 5);
  assert.ok(later.length >= 1, 'a frame was drawn after the tab was shown');
  assert.deepEqual(later.filter((v) => v < 0.3), [], `frames after the tab was shown: ${later.map((v) => v.toFixed(2)).join(' ')}`);
  await page.close();
});

test('a site switched off while its tab is hidden is left as the page wrote it when the tab is shown', { timeout: 120000 * SLOW }, async () => {
  const { page, url } = await open('/dynamic.html');
  await isolated(url, 'hide');
  await browser.setStorage({ settings: { enabled: false } });
  await sleep(600 * SLOW);
  await isolated(url, 'show');
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 15000 * SLOW });
  assert.ok((await bodyLightness(page)) > 0.6);
  await page.close();
});
