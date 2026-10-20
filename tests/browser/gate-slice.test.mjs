// The gate of a page reads the slice of the site data for its host, which the worker keeps in keys of its own. The decision is the
// same as from the whole data; a copy that is missing or made for another revision is not used; a change of another host's rule does not
// move the tab; a big set of rules costs a page what a small one does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = () => new URL(servers.origin).port;
const url = (path = '/dynamic.html') => `http://127.0.0.1:${PORT()}${path}`;

const dark = (page) =>
  page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.35;
  });
const keysOfCopy = () => browser.worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('gb')).sort());
const settled = () => browser.worker.evaluate(() => globalThis.tintlyGate.settled());
const startedAt = (page) => browser.stats(page.url()).then((s) => s.startedAt);

async function set(items) {
  await browser.clearStorage();
  await browser.setStorage(items);
  await settled();
}

test('the worker keeps one bucket for each host family, with the revision', async () => {
  await set({ settings: { enabled: true }, siteRules: { '127.0.0.1/x': { enabled: false }, 'a.example.com': { enabled: false }, 'b.example.com/p': { enabled: true } }, userFixes: { 'example.com': { engine: 'filter' } }, darkSites: { add: ['news.org'], remove: [] } });
  assert.deepEqual(await keysOfCopy(), ['gb.list', 'gb.meta', 'gb:127.0.0.1'.replace('127.0.0.1', '0.1'), 'gb:example.com', 'gb:news.org'].sort());
  const meta = await browser.worker.evaluate(async () => (await chrome.storage.local.get(['gb.meta', 'updatedAt']))['gb.meta']);
  const rev = await browser.worker.evaluate(async () => (await chrome.storage.local.get('updatedAt')).updatedAt);
  assert.deepEqual(meta, { v: 1, rev: rev ?? null });
});

test('a rule with a path for this page and a fix for its parent domain decide the page as from the whole data', async () => {
  await set({ settings: { enabled: true }, siteRules: { '127.0.0.1/dynamic.html': { enabled: false } } });
  const off = await browser.context.newPage();
  await off.goto(url('/dynamic.html'));
  await off.waitForLoadState('load');
  await sleep(600 * SLOW);
  assert.equal(await off.evaluate(() => document.documentElement.hasAttribute('data-dk-state')), false);
  assert.equal(await dark(off), false);
  const on = await browser.context.newPage();
  await on.goto(url('/basic.html'));
  await waitState(on, 'ready', 20000 * SLOW);
  assert.equal(await dark(on), true);
  await off.close();
  await on.close();
});

test('a rule for another host does not move the tab; a rule for its own host does', async () => {
  await set({ settings: { enabled: true }, siteRules: { 'other.example.org': { enabled: false } } });
  const page = await browser.context.newPage();
  await page.goto(url('/dynamic.html'));
  await waitState(page, 'ready', 20000 * SLOW);
  const first = await startedAt(page);
  await browser.setStorage({ siteRules: { 'other.example.org': { enabled: false }, 'third.example.net': { enabled: false } } });
  await settled();
  await sleep(2500 * SLOW);
  assert.equal(await startedAt(page), first, 'the engine was not started again');
  await browser.setStorage({ siteRules: { '127.0.0.1/dynamic.html': { enabled: false } } });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 15000 * SLOW });
  assert.equal(await dark(page), false);
  await browser.setStorage({ siteRules: {} });
  await waitState(page, 'ready', 15000 * SLOW);
  await page.close();
});

test('a copy that is missing or behind is not used: the page reads the sections and decides right', async () => {
  await set({ settings: { enabled: true }, siteRules: { '127.0.0.1/dynamic.html': { enabled: false } } });
  // The copy goes: a page decides from the sections.
  await browser.worker.evaluate(() => chrome.storage.local.remove(['gb.meta']));
  const a = await browser.context.newPage();
  await a.goto(url('/dynamic.html'));
  await a.waitForLoadState('load');
  await sleep(600 * SLOW);
  assert.equal(await dark(a), false, 'the rule was found without the copy');
  // A copy made for an older revision is behind: the page does not use it.
  await browser.worker.evaluate(() => chrome.storage.local.set({ 'gb.meta': { v: 1, rev: -1 } }));
  const b = await browser.context.newPage();
  await b.goto(url('/dynamic.html'));
  await b.waitForLoadState('load');
  await sleep(600 * SLOW);
  assert.equal(await dark(b), false);
  // Made right again, the same page is decided the same.
  await browser.worker.evaluate(async () => {
    await chrome.storage.local.remove(['gb.meta', 'gb.list']);
    await globalThis.tintlyGate.start();
  });
  await settled();
  assert.deepEqual((await keysOfCopy()).slice(0, 2), ['gb.list', 'gb.meta']);
  await a.close();
  await b.close();
});

test('a large set of rules and fixes costs a page its own slice only', { timeout: 300000 * SLOW }, async () => {
  const rules = {};
  const fixes = {};
  for (let i = 0; i < 2000; i++) rules[`site${i}.example.com`] = { enabled: i % 7 !== 0, theme: { mode: 'dark', brightness: 90 } };
  for (let i = 0; i < 2000; i++) fixes[`fix${i}.example.org`] = { engine: 'dynamic', dynamic: { css: `.a${i}{color:red}`.repeat(100), invert: ['img.logo'] } };
  rules['127.0.0.1/dynamic.html'] = { enabled: false };
  await set({ settings: { enabled: true }, siteRules: rules, userFixes: fixes });
  const page = await browser.context.newPage();
  await page.goto(url('/dynamic.html'));
  await page.waitForLoadState('load');
  await sleep(800 * SLOW);
  assert.equal(await dark(page), false, 'the rule of the page is found among 4 000');
  const read = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: async () => {
        const key = `gb:${location.hostname.split('.').slice(-2).join('.')}`;
        const t = performance.now();
        const got = await chrome.storage.local.get(['settings', 'updatedAt', 'gb.meta', key]);
        return JSON.stringify({ ms: performance.now() - t, keys: Object.keys(got) });
      },
    });
    return JSON.parse(r.result);
  }, page.url());
  console.log(`# slice read among 4 000 rules and fixes: ${read.ms.toFixed(1)} ms`);
  assert.ok(read.ms < 25 * SLOW, `${read.ms} ms`);
  await page.close();
});
