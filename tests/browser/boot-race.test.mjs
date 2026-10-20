// A storage write that lands while the first decision of a loading page waits must not take the first-paint hold away. The wait here is
// the schedule module, which the worker injects on request; the worker writes the settings and answers late, the way a sync pull or a
// popup slider can land during a slow first decision.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, cpuThrottle, SLOW } from './harness.mjs';

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

test('a settings write during the first decision keeps the page held and themed early', { timeout: 60000 * SLOW }, async () => {
  const automation = { mode: 'time', behavior: 'scheme', time: { from: '00:00', to: '00:00' }, activeMode: 'dark', idleMode: 'dark' };
  await browser.setStorage({ settings: { enabled: true, automation } });
  await browser.worker.evaluate(() => {
    const scripting = chrome.scripting;
    const original = scripting.executeScript.bind(scripting);
    globalThis.__dkRestore = () => (scripting.executeScript = original);
    scripting.executeScript = async (injection) => {
      if ((injection.files ?? []).includes('content/core/schedule.js')) {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, theme: { ...(settings.theme ?? {}), contrast: 105 } } });
        await new Promise((r) => setTimeout(r, 600));
      }
      return original(injection);
    };
  });
  try {
    const page = await browser.context.newPage();
    await cpuThrottle(page, SLOW);
    // What the gate puts in the page, seen from the page from its first moment.
    await page.addInitScript(() => {
      window.__dkSeen = [];
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && n.hasAttribute('data-dk')) window.__dkSeen.push(n.getAttribute('data-dk'));
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${servers.origin}/basic.html`);
    await waitState(page, 'ready');
    const seen = await page.evaluate(() => window.__dkSeen);
    assert.ok(seen.includes('early'), `the decision that landed was the first load (saw ${seen.join(', ')})`);
    const injected = await page.evaluate(() => document.documentElement.getAttribute('data-dk-go') !== null);
    assert.equal(injected, true);
    await page.close();
  } finally {
    await browser.worker.evaluate(() => globalThis.__dkRestore?.());
  }
});
