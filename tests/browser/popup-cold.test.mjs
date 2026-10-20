// the popup paints from the stored data at once and does not wait for the service worker, which may have to start first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

let servers;
let browser;
let extId;
let host;

before(async () => {
  servers = await startServers();
  browser = await launch();
  extId = new URL(browser.worker.url()).host;
  host = new URL(servers.origin).host;
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const ON = { settings: { enabled: true, theme: { brightness: 83 } } };
/** Time from the start of the page load to the first paint of the stored data, with the worker stopped. */
const PAINT_BUDGET_MS = 300;
const PAINT_CEILING_MS = 1500;

/** Stop the service worker and wait until the browser says it has stopped. */
async function stopWorker() {
  const probe = await browser.context.newPage();
  const cdp = await browser.context.newCDPSession(probe);
  const status = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
    for (const v of e.versions) status.set(v.versionId, v.runningStatus);
  });
  await cdp.send('ServiceWorker.enable');
  await new Promise((r) => setTimeout(r, 100));
  await cdp.send('ServiceWorker.stopAllWorkers');
  let stopped = false;
  for (let i = 0; i < 200 && !stopped; i++) {
    stopped = status.size > 0 && [...status.values()].every((v) => v === 'stopped');
    await new Promise((r) => setTimeout(r, 25));
  }
  await cdp.detach();
  await probe.close();
  assert.ok(stopped, 'the worker did not stop');
}

/** Open a web page, stop the worker, then open the popup as the toolbar would. The page records what it showed at the first paint. */
async function openCold(path = '/basic.html', storage = ON, want = null) {
  await browser.clearStorage();
  await browser.worker.evaluate(() => chrome.storage.session.clear());
  await browser.setStorage(storage);
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}${path}`);
  await waitState(web, 'ready', 30000 * SLOW);
  if (want) {
    for (let i = 0; i < 300; i++) {
      const all = await browser.worker.evaluate(() => chrome.storage.session.get(null));
      if (Object.entries(all).some(([k, v]) => k.startsWith('tab:') && want.includes(v?.status))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await stopWorker();
  const popup = await browser.context.newPage();
  await popup.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => {
      const p = send(...args);
      if (args[0]?.type === 'dk.state.get') Promise.resolve(p).then(() => (window.__stateAt ??= performance.now()), () => {});
      return p;
    };
    new MutationObserver((_, o) => {
      const b = document.body;
      if (!b || !b.hasAttribute('data-painted') || window.__first) return;
      const el = (id) => document.getElementById(id);
      window.__first = {
        at: performance.now(),
        visibility: getComputedStyle(b).visibility,
        host: el('host').textContent,
        master: el('master').checked,
        brightness: el('brightness').value,
        stateAt: window.__stateAt ?? null,
        stheme: !el('stheme').hidden,
        sthemeDisabled: el('stheme-btn').disabled,
        status: el('status').textContent,
      };
      o.disconnect();
    }).observe(document, { subtree: true, attributes: true, childList: true });
  });
  await web.bringToFront();
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => window.__first !== undefined, undefined, { timeout: 30000 * SLOW });
  const first = await popup.evaluate(() => window.__first);
  return { popup, web, first };
}

test('with a stopped worker the popup paints the stored state before the worker has answered', { timeout: 120000 * SLOW }, async () => {
  const { popup, web, first } = await openCold();
  assert.equal(first.visibility, 'visible');
  assert.equal(first.host, host);
  assert.equal(first.master, true);
  assert.equal(first.brightness, '83');
  assert.equal(first.stateAt, null, 'the worker had answered before the first paint');
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'), undefined, { timeout: 30000 * SLOW });
  assert.notEqual((await popup.textContent('#status')).trim(), '');
  await popup.close();
  await web.close();
});

test('the first paint of a popup with a stopped worker stays inside its budget', { timeout: 300000 * SLOW }, async () => {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const { popup, web, first } = await openCold();
    times.push(first.at);
    await popup.close();
    await web.close();
  }
  times.sort((a, b) => a - b);
  const median = times[2];
  console.log(`# popup first paint, stopped worker: median ${Math.round(median)} ms, worst ${Math.round(times[4])} ms, runs ${times.map(Math.round).join(' ')}`);
  assert.ok(median <= PAINT_BUDGET_MS * SLOW, `median ${median} ms is over the budget of ${PAINT_BUDGET_MS * SLOW} ms`);
  assert.ok(times[4] <= PAINT_CEILING_MS * SLOW, `worst ${times[4]} ms is over the ceiling of ${PAINT_CEILING_MS * SLOW} ms`);
});

test('the row for the site theme shows at the first paint from the status of the tab, and its button waits for the worker', { timeout: 180000 * SLOW }, async () => {
  const { popup, web, first } = await openCold('/site-repair-complete.html', { settings: { enabled: true } }, ['site-theme', 'site-theme-repaired']);
  assert.equal(first.stheme, true, JSON.stringify(first));
  assert.equal(first.sthemeDisabled, true);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading') && !document.getElementById('stheme-btn').disabled, undefined, { timeout: 30000 * SLOW });
  assert.equal(await popup.isHidden('#stheme'), false);
  await popup.close();
  await web.close();
});
