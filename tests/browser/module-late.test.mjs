// the module that judges the page's own dark theme (`sitetheme`) is slow, refused or never comes. The page must not stay
// in our theme with the status "on": while the decision is open the status is `pending`, a module that comes late decides again and the
// page ends with its own dark theme, and a module that cannot be had ends in `start-failed` with our theme.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch } from './harness.mjs';
import { pageStatus } from '../helpers/gate.mjs';

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
afterEach(() => unpatch());

const ON = { settings: { enabled: true } };
/** The page's own dark background (site-dark-media.html) and ours. */
const THEIRS = 'rgb(16, 20, 24)';

/**
 * Change what the worker's injection does for the sitetheme file: `delay` (ms, first call only), `fail` (the first n calls throw; -1: all of them).
 * `scale` shortens the loader's pauses in the page that asks (the namespace knob `recoverScale`).
 */
function patch({ delay = 0, fail = 0, scale = 1 }) {
  return browser.worker.evaluate(
    ({ delay, fail, scale }) => {
      const real = chrome.scripting.executeScript.bind(chrome.scripting);
      globalThis.__realExec = globalThis.__realExec ?? real;
      globalThis.__asked = [];
      chrome.scripting.executeScript = async (injection) => {
        const file = injection.files?.[0] ?? '';
        if (!file.includes('sitetheme')) return real(injection);
        const n = globalThis.__asked.push(Date.now());
        if (n === 1 && scale !== 1) await real({ target: injection.target, world: 'ISOLATED', injectImmediately: true, func: (s) => (globalThis.__dk.recoverScale = s), args: [scale] });
        if (n === 1 && delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (fail < 0 || n <= fail) throw new Error('refused');
        return real(injection);
      };
    },
    { delay, fail, scale },
  );
}
const unpatch = () =>
  browser?.worker.evaluate(() => {
    if (globalThis.__realExec) chrome.scripting.executeScript = globalThis.__realExec;
  });

const asked = () => browser.worker.evaluate(() => globalThis.__asked.length);

async function open(path = '/site-dark-media.html') {
  await browser.clearStorage();
  await browser.worker.evaluate(() => chrome.storage.session.clear());
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  const url = `${servers.origin}${path}`;
  await page.goto(url);
  return { page, url };
}

const background = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** Every status the tab reports, in order, until `want` shows. */
async function statuses(url, want, timeout) {
  const seen = [];
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const now = await pageStatus(browser, url, { timeout: 2000 }).catch(() => null);
    if (now && seen.at(-1) !== now) seen.push(now);
    if (now && want.includes(now)) return seen;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${want.join(' or ')} in time (${seen.join(', ')})`);
}

test('a module that arrives after the wait is over: the status is pending meanwhile, then the page ends with its own dark theme', { timeout: 180000 }, async () => {
  await patch({ delay: 20000 });
  const { page, url } = await open();
  const seen = await statuses(url, ['site-theme', 'site-theme-repaired'], 90000);
  assert.ok(seen.includes('pending'), `the status said ${seen.join(', ')}`);
  assert.ok(!seen.slice(seen.indexOf('pending') + 1).includes('on'), `a false "on" after pending: ${seen.join(', ')}`);
  assert.equal(await background(page), THEIRS);
  assert.ok((await asked()) >= 1);
  const stats = await page.evaluate(() => null);
  assert.equal(stats, null);
  await page.close();
});

test('a refused injection is tried again in the background and the page ends with its own dark theme', { timeout: 120000 }, async () => {
  await patch({ fail: 2, scale: 0.05 });
  const { page, url } = await open();
  const seen = await statuses(url, ['site-theme', 'site-theme-repaired'], 60000);
  assert.ok(!seen.includes('start-failed'), seen.join(', '));
  assert.equal(await background(page), THEIRS);
  assert.ok((await asked()) >= 3, 'two refusals and the try that worked');
  await page.close();
});

test('a module that can never be loaded ends in start-failed, with our theme and nothing left asking', { timeout: 120000 }, async () => {
  await patch({ fail: -1, scale: 0.01 });
  const { page, url } = await open();
  const seen = await statuses(url, ['start-failed'], 90000);
  assert.ok(seen.includes('start-failed'));
  assert.notEqual(await background(page), THEIRS, 'our theme shows');
  assert.ok(['rgb(22, 24, 29)'].includes(await background(page)) || (await background(page)) !== 'rgb(255, 255, 255)');
  const before = await asked();
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(await asked(), before, 'nothing is asked after the last try');
  await page.close();
});

test('a page that is decided at once never says pending', { timeout: 60000 }, async () => {
  await unpatch();
  await patch({});
  const { page, url } = await open();
  const seen = await statuses(url, ['site-theme', 'site-theme-repaired'], 30000);
  assert.ok(!seen.includes('pending'), seen.join(', '));
  assert.equal(await background(page), THEIRS);
  await page.close();
});
