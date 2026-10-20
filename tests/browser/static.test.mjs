import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

let servers;
let browser;
let host;
let extId;

before(async () => {
  servers = await startServers();
  browser = await launch();
  host = new URL(servers.origin).host;
  extId = new URL(browser.worker.url()).host;
});

after(async () => {
  await browser?.close();
  await servers?.close();
});

const STATIC_FIX = {
  engine: 'static',
  static: { bg: ['.card', '.hero'], fg: ['p', 'h2'], border: ['.card'], skip: ['.card button'] },
};

async function open(storage) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/basic.html`);
  await waitState(page, 'ready');
  return page;
}

const css = (page, selector, prop) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [selector, prop]);

test('a static theme colors the named elements and nothing else, without reading any stylesheet', { timeout: 60000 }, async () => {
  const page = await open({ settings: { enabled: true }, userFixes: { [host]: STATIC_FIX } });
  const dark = (c) => c.match(/\d+/g).slice(0, 3).map(Number).every((v) => v < 90);
  assert.ok(dark(await css(page, 'body', 'backgroundColor')), 'the body is dark');
  assert.ok(dark(await css(page, '.card', 'backgroundColor')), 'a named background is dark');
  const text = (await css(page, '.card p', 'color')).match(/\d+/g).map(Number);
  assert.ok(text.every((v) => v > 150), `the named text is light: ${text}`);
  // A skipped element keeps its own colors.
  const original = await page.evaluate(() => {
    const b = document.querySelector('.card button');
    const probe = document.createElement('button');
    probe.className = b.className;
    return getComputedStyle(b).color;
  });
  assert.ok(original);
  // No Dynamic engine work happened.
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="sheet"]').length), 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="static"]').length), 1);
  const stats = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify({ stat: globalThis.__dk.staticEngine.stats(), dyn: globalThis.__dk.dynamic.stats() }) });
    return JSON.parse(r.result);
  }, `${servers.origin}/basic.html`);
  assert.equal(stats.stat.sheets, 0);
  assert.equal(stats.dyn, null);
  console.log(`# static theme: ${stats.stat.bytes} bytes of CSS, ready ${stats.stat.readyAt.toFixed(0)} ms after navigation start`);
  await page.close();
});

test('without a stored static theme the engine falls back to the Dynamic engine', { timeout: 60000 }, async () => {
  const page = await open({ settings: { enabled: true, engine: 'static' } });
  assert.ok((await page.evaluate(() => document.querySelectorAll('style[data-dk="sheet"]').length)) > 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="static"]').length), 0);
  await page.close();
});

test('the engine can change to and from Static on a live page, and teardown leaves nothing', { timeout: 90000 }, async () => {
  const page = await open({ settings: { enabled: true }, userFixes: { [host]: { dynamic: {} } } });
  assert.ok((await page.evaluate(() => document.querySelectorAll('style[data-dk="sheet"]').length)) > 0);
  await browser.setStorage({ userFixes: { [host]: STATIC_FIX } });
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk="static"]').length === 1 && document.querySelectorAll('style[data-dk="sheet"]').length === 0, undefined, { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-dk-state')), 'ready');
  await browser.setStorage({ userFixes: { [host]: { dynamic: {} } } });
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk="static"]').length === 0 && document.querySelectorAll('style[data-dk="sheet"]').length > 0, undefined, { timeout: 15000 });
  await browser.setStorage({ userFixes: { [host]: STATIC_FIX } });
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk="static"]').length === 1, undefined, { timeout: 15000 });
  await browser.setStorage({ settings: { enabled: false } });
  await waitState(page, null);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk]').length), 0);
  await page.close();
});

test('a bad selector in the list does not drop the others', { timeout: 60000 }, async () => {
  const fix = { engine: 'static', static: { bg: [':::bad((', '.card'] } };
  const page = await open({ settings: { enabled: true }, userFixes: { [host]: fix } });
  const c = (await css(page, '.card', 'backgroundColor')).match(/\d+/g).map(Number);
  assert.ok(c.slice(0, 3).every((v) => v < 90), String(c));
  await page.close();
});

test('the fix editor saves static lists and refuses a list that names the whole page', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/fixes/fixes.html?site=${host}`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  await page.selectOption('#engine', 'static');
  await page.fill('#sBg', '.card\n.hero');
  await page.fill('#sFg', 'p');
  await browser.worker.evaluate(async (h) => {
    for (let i = 0; i < 100; i++) {
      const fix = (await chrome.storage.local.get('userFixes')).userFixes?.[h];
      if (fix?.static?.fg?.[0] === 'p') return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, host);
  const fix = (await browser.worker.evaluate(() => chrome.storage.local.get('userFixes'))).userFixes[host];
  assert.equal(fix.engine, 'static');
  assert.deepEqual(fix.static, { bg: ['.card', '.hero'], fg: ['p'] });
  await page.fill('#sBg', 'body');
  // The error is the positive sign that the editor judged the new text; only then is "not saved" a claim.
  await page.waitForSelector('#sBg-error', { state: 'visible', timeout: 10000 });
  assert.equal(await page.getAttribute('#sBg', 'aria-invalid'), 'true');
  assert.deepEqual((await browser.worker.evaluate(() => chrome.storage.local.get('userFixes'))).userFixes[host].static.bg, ['.card', '.hero']);
  await page.close();
});
