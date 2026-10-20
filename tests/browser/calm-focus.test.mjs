// Removing shadows (E-ink and Paper) must not remove a focus ring that the page draws with a shadow (WCAG 2.4.7), also when the
// thicker lines are off.
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

test('shadows go, the focus ring made of a shadow stays', { timeout: 90000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'paper', noShadow: true, einkBorders: false } } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/focus-ring.html`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="calm"]'), undefined, { timeout: 15000 * SLOW });
  const shadow = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).boxShadow, id);
  assert.equal(await shadow('card'), 'none', 'the drop shadow stayed');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'b');
  assert.notEqual(await shadow('b'), 'none', 'the focus ring was removed');
  await page.close();
});

test('the filter of the page on a picture can be read when the calm filter replaces it', { timeout: 90000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'paper' } } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/filtered-icons.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="calm"]'), undefined, { timeout: 15000 * SLOW });
  const got = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => {
        const ids = ['invert', 'bright', 'shadow'];
        const els = ids.map((i) => document.getElementById(i));
        return JSON.stringify({ own: els.map((e) => getComputedStyle(e).filter), page: globalThis.__dk.calm.pageFilters(els), after: els.map((e) => getComputedStyle(e).filter), disabled: document.querySelectorAll('style[data-dk]:disabled').length });
      },
    });
    return JSON.parse(r.result);
  }, url);
  assert.deepEqual(got.page, ['invert(1)', 'brightness(0)', 'drop-shadow(rgb(136, 136, 136) 0px 0px 1px)']);
  assert.deepEqual(got.after, got.own, 'the read left a trace');
  assert.ok(got.own.every((f) => f !== 'none' && !f.startsWith('invert(1)')), `the calm filter is not in force: ${got.own}`);
  await page.close();
});
