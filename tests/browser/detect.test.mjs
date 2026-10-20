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
  await helper.goto(`${servers.origin}/basic.html`);
});

after(async () => {
  await browser?.close();
  await servers?.close();
});

const DARK = ['dark-css', 'dark-meta', 'dark-root', 'dark-gray'];
const LIGHT = ['light-white', 'light-gray', 'light-header', 'light-both', 'light-plain', 'light-sepia', 'light-blue'];
const settings = (extra = {}) => ({ settings: { enabled: true, ...extra } });

async function open(name, storage, { scheme } = {}) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  if (scheme) await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`${servers.origin}/detect/${name}.html`);
  return page;
}

const untouched = (page) => page.evaluate(() => !document.documentElement.hasAttribute('data-dk-state') && document.querySelectorAll('[data-dk]').length === 0);

async function verdict(name, storage = settings(), options) {
  const page = await open(name, storage, options);
  // The verdict comes at load; give the page time to settle either way.
  await page.waitForLoadState('load');
  await page.waitForTimeout(700);
  const dark = await untouched(page);
  await page.close();
  return dark;
}

test('dark pages are left alone and light pages are themed (the fixture corpus)', { timeout: 180000 }, async () => {
  let right = 0;
  const wrong = [];
  for (const name of DARK) (await verdict(name)) ? right++ : wrong.push(`${name} was themed`);
  (await verdict('dark-media', settings(), { scheme: 'dark' })) ? right++ : wrong.push('dark-media (system dark) was themed');
  for (const name of LIGHT) (!(await verdict(name))) ? right++ : wrong.push(`${name} was left alone`);
  (!(await verdict('dark-media', settings(), { scheme: 'light' }))) ? right++ : wrong.push('dark-media (system light) was left alone');
  const total = DARK.length + 1 + LIGHT.length + 1;
  console.log(`# detection: ${right} of ${total} fixtures judged right`);
  assert.deepEqual(wrong, []);
});

test('the toolbar status says the page was found dark', { timeout: 60000 }, async () => {
  const page = await open('dark-css', settings());
  const start = Date.now();
  for (;;) {
    const all = await browser.worker.evaluate(() => chrome.storage.session.get(null));
    if (Object.values(all).some((v) => v?.status === 'dark-detected')) break;
    assert.ok(Date.now() - start < 8000, JSON.stringify(all));
    await page.waitForTimeout(100);
  }
  await page.close();
});

test('the user decides: detection off, a forced site, a site on the list, a site taken off the list, and the light mode', { timeout: 120000 }, async () => {
  const host = new URL(servers.origin).host;
  // Detection off: a dark page is themed.
  assert.equal(await verdict('dark-css', settings({ detectDark: false })), false);
  // Forced on: an explicit rule for the site.
  assert.equal(await verdict('dark-css', { ...settings(), siteRules: { [host]: { enabled: true } } }), false);
  // A light page on the dark list is left alone from the start.
  assert.equal(await verdict('light-white', { ...settings(), darkSites: { add: [host], remove: [] } }), true);
  // Taken off the list again: it is judged by its colors.
  assert.equal(await verdict('light-white', { ...settings(), darkSites: { add: [host], remove: [host] } }), false);
  // A dark page in light mode is turned light.
  assert.equal(await verdict('dark-css', settings({ theme: { mode: 'light' } })), false);
});

test('a dark page never shows a light frame', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(settings());
  const page = await browser.context.newPage();
  await page.goto('about:blank');
  const frames = await paintedLightness(page, helper, async () => {
    await page.goto(`${servers.origin}/detect/dark-css.html`);
    await page.waitForTimeout(800);
  });
  const loaded = frames.filter((f) => f > 0.5);
  console.log(`# dark page: ${frames.length} frames, ${loaded.length} light`);
  // The blank page before the load can be light; after the dark page arrives nothing may be.
  const firstDark = frames.findIndex((f) => f < 0.3);
  assert.ok(firstDark >= 0, 'the dark page was painted');
  assert.equal(frames.slice(firstDark).filter((f) => f > 0.5).length, 0);
  await page.close();
});

const bodyLightness = (page) =>
  page.evaluate(() => {
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(document.body).backgroundColor);
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
  });

test('a page found dark that turns light later is themed again (its own theme button)', { timeout: 60000 }, async () => {
  const page = await open('dark-then-light', settings());
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);
  assert.equal(await untouched(page), true, 'the dark page is left alone first');
  // The page adds its light class at 1.5 s. Within a few seconds the engine must have taken over.
  await waitState(page, 'ready', 10000);
  assert.ok((await bodyLightness(page)) < 0.3, 'the light page is dark again');
  await page.close();
});

test('a page found dark by a media rule is themed again when the system turns light', { timeout: 60000 }, async () => {
  const page = await open('dark-media', settings(), { scheme: 'dark' });
  await page.waitForLoadState('load');
  await page.waitForTimeout(600);
  assert.equal(await untouched(page), true);
  await page.emulateMedia({ colorScheme: 'light' });
  await waitState(page, 'ready', 10000);
  assert.ok((await bodyLightness(page)) < 0.3);
  await page.close();
});

const probeCount = (url) =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => globalThis.__dk?.detect?.stats().probes ?? -1 });
    return r.result;
  }, url);

test('a light page is looked at once: no second forced restyle at load when nothing changed', { timeout: 60000 }, async () => {
  const page = await open('light-white', settings());
  await waitState(page, 'ready');
  await page.waitForLoadState('load');
  await page.waitForTimeout(600);
  assert.equal(await probeCount(page.url()), 1);
  await page.close();
});

test('a page that changes its root after the first look is looked at again at load', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(settings());
  const page = await browser.context.newPage();
  // The image holds the load event back until the test has changed the root, so the order of the first look, the change
  // and the load does not depend on the speed of the machine.
  /** @type {(() => void) | undefined} */
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route(/\/img\/dot\.svg\?hold/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${servers.origin}/detect/late-load.html`, { waitUntil: 'domcontentloaded' });
  const url = page.url();
  const deadline = Date.now() + 40000 * SLOW;
  while ((await probeCount(url)) < 1 && Date.now() < deadline) await page.waitForTimeout(100);
  assert.equal(await probeCount(url), 1);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'x'));
  // The root watcher reports in a microtask; a task of the page later it has seen the change.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  release?.();
  await page.waitForLoadState('load');
  while ((await probeCount(url)) < 2 && Date.now() < deadline) await page.waitForTimeout(100);
  assert.equal(await probeCount(url), 2);
  await page.close();
});

test('a page that turns out dark after the first probe is let go at load',{ timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(settings());
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/detect/light-white.html`);
  await waitState(page, 'ready');
  await page.evaluate(() => {
    document.body.style.background = '#000';
    document.body.style.color = '#fff';
  });
  // The page was themed because it was light. The verdict is taken once, at load, so it stays themed.
  assert.equal(await untouched(page), false);
  await page.close();
});
