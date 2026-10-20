// a push that waits survives a stop of the service worker. The worker is stopped by the browser's own call (not a fake timer)
// before the short delay has passed; a new worker, started by an ordinary event (an extension page opens and asks for data), sends it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './harness.mjs';

let browser;
let extId;

before(async () => {
  browser = await launch();
  extId = new URL(browser.worker.url()).host;
});
after(async () => {
  await browser?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stopWorker() {
  const probe = await browser.context.newPage();
  const cdp = await browser.context.newCDPSession(probe);
  const status = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
    for (const v of e.versions) status.set(v.versionId, v.runningStatus);
  });
  await cdp.send('ServiceWorker.enable');
  await sleep(100);
  await cdp.send('ServiceWorker.stopAllWorkers');
  let stopped = false;
  for (let i = 0; i < 200 && !stopped; i++) {
    stopped = status.size > 0 && [...status.values()].every((v) => v === 'stopped');
    await sleep(25);
  }
  await cdp.detach();
  await probe.close();
  assert.ok(stopped, 'the worker did not stop');
}

/** Read the account and the local record from an extension page, which also wakes the worker. */
async function readFrom(page) {
  return page.evaluate(async () => {
    const sync = await chrome.storage.sync.get(null);
    const meta = sync['dk.sync.meta'];
    let brightness = null;
    if (meta) {
      let text = '';
      for (let i = 0; i < meta.n; i++) text += sync[`dk.sync.${i}`];
      brightness = JSON.parse(text).settings?.theme?.brightness ?? null;
    }
    const local = await chrome.storage.local.get('syncPending');
    return { has: Boolean(meta), brightness, pending: local.syncPending ?? null };
  });
}

test('a change that was not sent when the worker stopped is sent by the next worker, without another change', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  await browser.worker.evaluate(() => chrome.storage.sync.clear());
  // Sync on: the account receives this device's data.
  await browser.setStorage({ settings: { enabled: true, syncEnabled: true, theme: { brightness: 100 } } });
  const reader = await browser.context.newPage();
  await reader.goto(`chrome-extension://${extId}/pages/options/options.html`);
  let seen = null;
  for (let i = 0; i < 100 && !seen?.has; i++) {
    await sleep(100);
    seen = await readFrom(reader);
  }
  assert.ok(seen?.has, 'the first push reached the account');
  assert.equal(seen.brightness, 100);
  await reader.close();

  // A change, then the stop of the worker before the delay of the push has passed.
  await browser.worker.evaluate(() => chrome.storage.local.set({ settings: { enabled: true, syncEnabled: true, theme: { brightness: 61 } } }));
  await stopWorker();
  // The delay (2 s) passes with no worker alive; nothing can send.
  await sleep(3000);

  // An ordinary event starts a new worker: a page of the extension opens and asks for data.
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/options/options.html`);
  let after = null;
  for (let i = 0; i < 150 && after?.brightness !== 61; i++) {
    await sleep(100);
    after = await readFrom(page);
  }
  assert.equal(after?.brightness, 61, `the account holds the change: ${JSON.stringify(after)}`);
  // The record is removed once the push is done.
  for (let i = 0; i < 50 && after.pending; i++) {
    await sleep(100);
    after = await readFrom(page);
  }
  assert.equal(after.pending, null);
  await page.close();
});
