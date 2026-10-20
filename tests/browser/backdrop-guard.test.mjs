// A sweep of the text-on-picture module that throws on every pass must stop after three, and leave the engine's style
// elements enabled and no timer running.
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

test('a backdrop pass that keeps throwing is dropped after three', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/photo-text.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000);
  const result = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: async () => {
        const dk = globalThis.__dk;
        for (let i = 0; i < 100 && !dk.backdrop?.isActive(); i++) await new Promise((x) => setTimeout(x, 50));
        const real = globalThis.getComputedStyle;
        let calls = 0;
        globalThis.getComputedStyle = function (...args) {
          if (new Error().stack.includes('backdrop.js')) {
            calls += 1;
            throw new Error('page broke');
          }
          return real.apply(this, args);
        };
        const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
        for (let i = 0; i < 12; i++) {
          window.dispatchEvent(new Event('scroll'));
          await sleep(500);
        }
        const mid = calls;
        for (let i = 0; i < 4; i++) {
          window.dispatchEvent(new Event('scroll'));
          await sleep(500);
        }
        globalThis.getComputedStyle = real;
        return JSON.stringify({ calls, grew: calls - mid, disabled: [...document.querySelectorAll('style[data-dk]')].filter((s) => s.disabled).length });
      },
    });
    return JSON.parse(r.result);
  }, url);
  assert.ok(result.calls >= 1, 'the backdrop pass never ran');
  assert.equal(result.grew, 0, 'the pass kept running after three failures');
  assert.equal(result.disabled, 0);
  await page.close();
});
