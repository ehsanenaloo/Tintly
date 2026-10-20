import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch } from './harness.mjs';
import { pageStatus } from '../helpers/gate.mjs';

let servers;
let browser;
let host;

before(async () => {
  servers = await startServers();
  browser = await launch();
  host = new URL(servers.origin).host;
});

after(async () => {
  await browser?.close();
  await servers?.close();
});

/** `expect`: the statuses the page may report. A test that claims "left alone" names one, so the claim follows a decision. */
async function open(storage, expect = null) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/frames-special.html`);
  await page.waitForLoadState('load');
  // The blob frame is set by a script, so it needs a moment to load.
  await page.waitForFunction(() => document.getElementById('blob').contentDocument?.body?.textContent.includes('blob frame') ?? true).catch(() => {});
  if (expect) await pageStatus(browser, page.url(), { want: expect });
  return page;
}

/** The frame element's content as Playwright sees it, by the id of its iframe. */
const frameOf = async (page, id) => (await page.$(`#${id}`)).contentFrame();
const state = (frame) => frame.evaluate(() => ({ state: document.documentElement.getAttribute('data-dk-state'), nodes: document.querySelectorAll('style[data-dk]').length, has: typeof globalThis.__dk }));

test('a frame with no address follows the rule of its parent page: off', { timeout: 60000 }, async () => {
  const page = await open({ settings: { enabled: true }, siteRules: { [host]: { enabled: false } } }, ['site-off']);
  const top = await page.evaluate(() => document.querySelectorAll('style[data-dk]').length);
  assert.equal(top, 0);
  const frame = await frameOf(page, 'srcdoc');
  const s = await state(frame);
  assert.equal(s.state, null, 'the srcdoc frame stays untouched when its parent is off');
  assert.equal(s.nodes, 0);
  await page.close();
});

test('a frame with no address follows the rule of its parent page: only listed sites', { timeout: 60000 }, async () => {
  const page = await open({ settings: { enabled: true, listMode: 'onlyListed' }, siteRules: { [host]: { enabled: true } } });
  const frame = await frameOf(page, 'srcdoc');
  await frame.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', undefined, { timeout: 15000 });
  const bg = await frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const p = /rgba?\(([^)]+)\)/.exec(bg)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  assert.ok((0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255 < 0.3, bg);
  await page.close();
});

test('a frame with no address is left alone when the page is not on the list', { timeout: 60000 }, async () => {
  const page = await open({ settings: { enabled: true, listMode: 'onlyListed' }, siteRules: {} }, ['site-off']);
  const frame = await frameOf(page, 'srcdoc');
  assert.equal((await state(frame)).state, null);
  await page.close();
});

test('srcdoc, sandboxed and blob frames run the engine by default', { timeout: 60000 }, async () => {
  const page = await open({ settings: { enabled: true } });
  for (const id of ['srcdoc', 'sandboxed', 'blob']) {
    const frame = await frameOf(page, id);
    await frame.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', undefined, { timeout: 15000 });
    assert.equal((await state(frame)).has, 'undefined', 'nothing leaks into the page world');
  }
  await page.close();
});

test('a switched-off setting reaches a sandboxed frame that already runs the engine', { timeout: 60000 }, async () => {
  const page = await open({ settings: { enabled: true } });
  const frame = await frameOf(page, 'sandboxed');
  await frame.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', undefined, { timeout: 15000 });
  await browser.setStorage({ settings: { enabled: false } });
  await frame.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 15000 });
  await page.close();
});
