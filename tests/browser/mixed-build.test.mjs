// A frame that keeps an older core (its `dk.scheme` has no `holdOff`) while the worker injects a newer module into it, as
// happens when the files of an unpacked extension change under open tabs. The modules must not throw and must leave the
// engine's style elements enabled.
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

test('modules called with an older core do not throw and leave no style element disabled', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/dynamic.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000);
  await page.waitForFunction(() => !!document.querySelector('style[data-dk]'));
  const result = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: async () => {
    const dk = globalThis.__dk;
    for (let i = 0; i < 100 && !(dk.backdrop?.isActive() && dk.detect && dk.sitetheme); i++) await new Promise((r) => setTimeout(r, 50));
    if (!(dk.backdrop?.isActive() && dk.detect && dk.sitetheme)) return { error: 'modules missing' };
    const { holdOff, ...older } = dk.scheme;
    dk.scheme = Object.freeze(older);
    const errors = [];
    const run = (name, f) => {
      try {
        f();
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    };
    const p = document.body.appendChild(document.createElement('span'));
    p.textContent = 'x';
    const before = dk.backdrop.stats()?.kept ?? -1;
    run('backdrop', () => dk.backdrop.adopt([p]));
    const kept = (dk.backdrop.stats()?.kept ?? -1) - before;
    run('detect', () => dk.detect.probe());
    run('sitetheme', () => dk.sitetheme.assess({ keep: () => false, scheme: false, minContrast: 3 }));
    const disabled = [...document.querySelectorAll('style[data-dk]')].filter((s) => s.disabled).length;
    return JSON.stringify({ errors, disabled, kept });
    } });
    return JSON.parse(r.result);
  }, url);
  assert.deepEqual(result, { errors: [], disabled: 0, kept: 1 });
  await page.close();
});
