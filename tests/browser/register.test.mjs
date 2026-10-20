// The engine files are registered from the worker for the pages where the extension can be on (and the records after it).
// A page that is off by a rule gets nothing: no hook in the page world, no isolated world script, no attribute.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { startServers, launch, waitState, paintedLightness, SLOW } from './harness.mjs';

let servers;
let browser;
let helper;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  servers = await startServers();
  browser = await launch();
  helper = await browser.context.newPage();
  await helper.goto('about:blank');
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const PORT = () => new URL(servers.origin).port;
/** The same server under two host names: a rule for one does not touch the other. */
const onUrl = (path = '/dynamic.html') => `http://127.0.0.1:${PORT()}${path}`;
const offUrl = (path = '/dynamic.html') => `http://localhost:${PORT()}${path}`;

const registered = () => browser.worker.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((list) => list.filter((s) => s.id === 'dk-hook' || s.id === 'dk-engine').sort((a, b) => a.id.localeCompare(b.id)).map((s) => ({ id: s.id, matches: s.matches, excludeMatches: s.excludeMatches ?? [], world: s.world }))));

/** Does the page-world hook run here? A wrapped method answers the probe value of `this` (hook.js), the browser's own one throws. */
const hookRuns = () => {
  try {
    return Reflect.apply(Element.prototype.attachShadow, 'dk:hook?', []) === true;
  } catch {
    return false;
  }
};

/** What ran in the page: the page-world hook, the isolated-world namespace, and any attribute of ours on the root. */
async function traces(page) {
  const hook = await page.evaluate(hookRuns);
  const attributes = await page.evaluate(() => [...document.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-dk')));
  const isolated = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    if (!tab?.id) return null;
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => typeof globalThis.__dk !== 'undefined' });
    return r.result;
  }, page.url());
  return { hook, isolated, attributes };
}

/** Write settings and wait until the worker has brought the registration to them. */
async function setStore(items) {
  await browser.clearStorage();
  await browser.setStorage(items);
}

const ON = { settings: { enabled: true } };

test('with the extension off, a page gets no script of ours', { timeout: 60000 }, async () => {
  await setStore({ settings: { enabled: false } });
  assert.deepEqual(await registered(), []);
  const page = await browser.context.newPage();
  await page.goto(onUrl());
  await page.waitForLoadState('load');
  await sleep(300);
  assert.deepEqual(await traces(page), { hook: false, isolated: false, attributes: [] });
  await page.close();
});

test('a site that is off by its rule gets nothing, its neighbor is themed', { timeout: 60000 }, async () => {
  await setStore({ settings: { enabled: true }, siteRules: { localhost: { enabled: false } } });
  const plan = await registered();
  assert.deepEqual(plan.map((s) => [s.id, s.world]), [['dk-engine', 'ISOLATED'], ['dk-hook', 'MAIN']]);
  assert.deepEqual(plan[0].excludeMatches, ['*://localhost/*']);
  const off = await browser.context.newPage();
  await off.goto(offUrl());
  await off.waitForLoadState('load');
  await sleep(300);
  assert.deepEqual(await traces(off), { hook: false, isolated: false, attributes: [] });
  const on = await browser.context.newPage();
  await on.goto(onUrl());
  await waitState(on, 'ready');
  const t = await traces(on);
  assert.equal(t.hook, true);
  assert.equal(t.isolated, true);
  await off.close();
  await on.close();
});

test('only listed sites: the page that is not listed gets nothing', { timeout: 60000 }, async () => {
  await setStore({ settings: { enabled: true, listMode: 'onlyListed' }, siteRules: { '127.0.0.1': { enabled: true } } });
  const off = await browser.context.newPage();
  await off.goto(offUrl());
  await off.waitForLoadState('load');
  await sleep(300);
  assert.deepEqual(await traces(off), { hook: false, isolated: false, attributes: [] });
  const on = await browser.context.newPage();
  await on.goto(onUrl());
  await waitState(on, 'ready');
  assert.equal((await traces(on)).isolated, true);
  await off.close();
  await on.close();
});

test('a site that is on is themed before its first light frame', { timeout: 60000 * SLOW }, async () => {
  await setStore(ON);
  const page = await browser.context.newPage();
  await page.goto(onUrl('/dark.html'));
  const lightness = await paintedLightness(page, helper, async () => {
    await page.goto(onUrl('/slow.html'));
    await waitState(page, 'ready');
  });
  assert.deepEqual(lightness.filter((v) => v > 0.5), [], `frames ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
  assert.ok(lightness.length >= 1);
  await page.close();
});

test('a site switched on while its tab is open is themed without a reload, and off again', { timeout: 60000 * SLOW }, async () => {
  await setStore({ settings: { enabled: false } });
  const page = await browser.context.newPage();
  await page.goto(onUrl('/basic.html'));
  await page.waitForLoadState('load');
  assert.equal((await traces(page)).isolated, false);
  await browser.setStorage({ settings: { enabled: true } });
  await waitState(page, 'ready', 20000 * SLOW);
  assert.equal((await traces(page)).hook, true);
  const dark = () => page.evaluate(() => { const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.35; });
  assert.equal(await dark(), true);
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 10000 * SLOW });
  assert.equal(await dark(), false);
  assert.deepEqual(await registered(), []);
  // The next load has nothing.
  await page.reload();
  await page.waitForLoadState('load');
  assert.deepEqual(await traces(page), { hook: false, isolated: false, attributes: [] });
  await page.close();
});

test('a site rule switched on live in a tab with only-listed mode', { timeout: 60000 * SLOW }, async () => {
  await setStore({ settings: { enabled: true, listMode: 'onlyListed' } });
  const page = await browser.context.newPage();
  await page.goto(onUrl('/basic.html'));
  await page.waitForLoadState('load');
  assert.equal((await traces(page)).isolated, false);
  await browser.setStorage({ settings: { enabled: true, listMode: 'onlyListed' }, siteRules: { '127.0.0.1': { enabled: true } } });
  await waitState(page, 'ready', 20000 * SLOW);
  await page.close();
});

test('frames that inherit the origin are covered like the page', { timeout: 60000 * SLOW }, async () => {
  await setStore(ON);
  const page = await browser.context.newPage();
  await page.goto(onUrl('/basic.html'));
  await waitState(page, 'ready');
  const ok = await page.evaluate(async () => {
    const f = document.createElement('iframe');
    f.srcdoc = '<body><p>frame</p></body>';
    document.body.append(f);
    await new Promise((r) => (f.onload = r));
    try {
      return Reflect.apply(f.contentWindow.Element.prototype.attachShadow, 'dk:hook?', []) === true;
    } catch {
      return false;
    }
  });
  assert.equal(ok, true, 'the hook runs in a srcdoc frame');
  await page.close();
});

test('the quiet page tells the toolbar why: off, and site off', { timeout: 60000 }, async () => {
  const status = async (url) => browser.worker.evaluate(async (u) => {
    for (let i = 0; i < 50; i++) {
      const [tab] = await chrome.tabs.query({ url: u });
      const key = `tab:${tab?.id}`;
      const got = (await chrome.storage.session.get(key))[key];
      if (got) return got.status;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }, url);
  await setStore({ settings: { enabled: false } });
  const a = await browser.context.newPage();
  await a.goto(onUrl('/basic.html'));
  assert.equal(await status(onUrl('/basic.html')), 'off');
  await a.close();
  await setStore({ settings: { enabled: true }, siteRules: { localhost: { enabled: false } } });
  const b = await browser.context.newPage();
  await b.goto(offUrl('/basic.html'));
  assert.equal(await status(offUrl('/basic.html')), 'site-off');
  await b.close();
});

test('the registration survives a stopped worker and is not doubled', { timeout: 90000 * SLOW }, async () => {
  const own = await launch();
  try {
    await own.clearStorage();
    await own.setStorage({ settings: { enabled: true }, siteRules: { localhost: { enabled: false } } });
    const id = new URL(own.worker.url()).host;
    const probe = await own.context.newPage();
    const cdp = await own.context.newCDPSession(probe);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await sleep(800);
    // A change from an extension page wakes a new worker, which must find the scripts in place.
    await probe.goto(`chrome-extension://${id}/pages/options/options.html`);
    await probe.evaluate(() => chrome.storage.local.set({ settings: { enabled: true, engine: 'dynamic' }, siteRules: {} }));
    const worker = own.worker;
    let list = [];
    for (let i = 0; i < 40 && list.length !== 2; i++) {
      await sleep(250);
      list = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((l) => l.filter((s) => s.id === 'dk-hook' || s.id === 'dk-engine').map((s) => [s.id, s.excludeMatches ?? []])));
    }
    assert.equal(list.length, 2, JSON.stringify(list));
    // The new settings have no rule: the exclusion is gone from the same two scripts.
    for (let i = 0; i < 40 && list.some((s) => s[1].length > 0); i++) {
      await sleep(250);
      list = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((l) => l.filter((s) => s.id === 'dk-hook' || s.id === 'dk-engine').map((s) => [s.id, s.excludeMatches ?? []])));
    }
    assert.deepEqual(list.map((s) => s[1]), [[], []]);
    assert.equal(list.length, 2);
    await probe.close();
  } finally {
    await own.close();
  }
});

test('a rule with a path leaves the host in the set and the gate decides by the path', { timeout: 60000 * SLOW }, async () => {
  await setStore({ settings: { enabled: true }, siteRules: { 'localhost/private': { enabled: false } } });
  assert.deepEqual((await registered())[0].excludeMatches, []);
  const a = await browser.context.newPage();
  await a.goto(offUrl('/basic.html'));
  await waitState(a, 'ready');
  await a.close();
});

test('a refused registration: the page still gets the files, the retry brings the registration back, and a total failure is shown', { timeout: 90000 * SLOW }, async () => {
  await setStore({ settings: { enabled: false } });
  assert.deepEqual(await registered(), []);
  // The browser refuses to register for a while.
  await browser.worker.evaluate(() => {
    globalThis.__real = { register: chrome.scripting.registerContentScripts };
    chrome.scripting.registerContentScripts = async () => {
      throw new Error('refused for the test');
    };
  });
  await browser.setStorage({ settings: { enabled: true } });
  const failed = await browser.worker.evaluate(() => globalThis.tintlyRegister.failed);
  assert.equal(failed, true);
  assert.deepEqual(await registered(), []);
  const page = await browser.context.newPage();
  await page.goto(onUrl('/basic.html'));
  await waitState(page, 'ready', 20000 * SLOW);
  // The retry works once the browser agrees again.
  await browser.worker.evaluate(() => {
    chrome.scripting.registerContentScripts = globalThis.__real.register;
  });
  for (let i = 0; i < 40 && (await registered()).length < 2; i++) await sleep(500);
  assert.equal((await registered()).length, 2);
  assert.equal(await browser.worker.evaluate(() => globalThis.tintlyRegister.failed), false);
  await page.close();
});

test('a refused registration and a refused injection: the toolbar says the page did not start', { timeout: 90000 * SLOW }, async () => {
  await setStore({ settings: { enabled: false } });
  await browser.worker.evaluate(() => {
    globalThis.__real = { register: chrome.scripting.registerContentScripts, execute: chrome.scripting.executeScript };
    chrome.scripting.registerContentScripts = async () => {
      throw new Error('refused for the test');
    };
    chrome.scripting.executeScript = async () => {
      throw new Error('refused for the test');
    };
  });
  try {
    await browser.setStorage({ settings: { enabled: true } });
    const page = await browser.context.newPage();
    await page.goto(onUrl('/basic.html'));
    const status = await browser.worker.evaluate(async (u) => {
      for (let i = 0; i < 60; i++) {
        const [tab] = await chrome.tabs.query({ url: u });
        const key = `tab:${tab?.id}`;
        const got = (await chrome.storage.session.get(key))[key];
        if (got) return got.status;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    }, onUrl('/basic.html'));
    assert.equal(status, 'start-failed');
    await page.close();
  } finally {
    await browser.worker.evaluate(() => {
      chrome.scripting.registerContentScripts = globalThis.__real.register;
      chrome.scripting.executeScript = globalThis.__real.execute;
    });
  }
});

test('a page opened before the registration existed is themed by the injection of install and update, once', { timeout: 90000 * SLOW }, async () => {
  const own = await launch();
  try {
    await own.clearStorage();
    await own.setStorage(ON);
    await own.worker.evaluate(() => chrome.scripting.unregisterContentScripts());
    const page = await own.context.newPage();
    await page.goto(onUrl('/basic.html'));
    await page.waitForLoadState('load');
    const has = () => own.worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => typeof globalThis.__dk?.bootStarted });
      return r.result;
    }, onUrl('/basic.html'));
    assert.equal(await has(), 'undefined');
    await own.worker.evaluate(() => globalThis.tintlyRegister.injectOpenTabs());
    await waitState(page, 'ready', 20000 * SLOW);
    const copies = await page.evaluate(() => document.querySelectorAll('style[data-dk="sheet"]').length);
    // A second pass finds the files in place and adds nothing.
    await own.worker.evaluate(() => globalThis.tintlyRegister.injectOpenTabs());
    await sleep(500);
    assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="sheet"]').length), copies);
    assert.equal(await has(), 'boolean');
    await page.close();
  } finally {
    await own.close();
  }
});

test('the injection of install and update leaves out a frame of a site that is off inside a page that is on', { timeout: 90000 * SLOW }, async () => {
  const own = await launch();
  try {
    await own.clearStorage();
    await own.setStorage({ settings: { enabled: true }, siteRules: { localhost: { enabled: false } } });
    await own.worker.evaluate(() => chrome.scripting.unregisterContentScripts());
    const page = await own.context.newPage();
    await page.goto(onUrl('/basic.html'));
    await page.waitForLoadState('load');
    await page.evaluate(async (src) => {
      const f = document.createElement('iframe');
      f.src = src;
      document.body.append(f);
      await new Promise((r) => (f.onload = r));
    }, offUrl('/basic.html'));
    await own.worker.evaluate(() => globalThis.tintlyRegister.injectOpenTabs());
    await waitState(page, 'ready', 20000 * SLOW);
    const off = page.frames().find((f) => f.url().startsWith(offUrl('/')));
    assert.ok(off, 'the frame of the site that is off is there');
    await sleep(500);
    const hook = await off.evaluate(() => {
      if (Reflect.getOwnPropertyDescriptor(globalThis, Symbol.for('tintly.hook'))) return true;
      try {
        return Reflect.apply(Element.prototype.attachShadow, 'dk:hook?', []) === true;
      } catch {
        return false;
      }
    });
    const isolated = await own.worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const found = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'ISOLATED', func: () => [location.host, typeof globalThis.__dk] });
      return found.map((r) => r.result);
    }, onUrl('/basic.html'));
    const attributes = await off.evaluate(() => [...document.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-dk')));
    assert.deepEqual({ hook, attributes, isolated: isolated.find(([host]) => host.startsWith('localhost'))?.[1] }, { hook: false, attributes: [], isolated: 'undefined' });
    assert.equal(isolated.find(([host]) => host.startsWith('127.0.0.1'))?.[1], 'object', 'the page that is on got the engine');
    await page.close();
  } finally {
    await own.close();
  }
});

test('the registration is still there after the browser restarted, and a page is themed at once', { timeout: 120000 * SLOW }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dk-persist-'));
  const ext = join(REPO, 'extension');
  const open = () => chromium.launchPersistentContext(dir, { channel: process.env.DK_CHANNEL || 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--disable-features=DisableLoadExtensionCommandLineSwitch'] });
  let context = await open();
  try {
    let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
    for (let i = 0; i < 100 && (await worker.evaluate(() => chrome.storage.local.get('schemaVersion'))).schemaVersion === undefined; i++) await sleep(100);
    await worker.evaluate(async () => (await chrome.storage.local.set({ settings: { enabled: true }, siteRules: { localhost: { enabled: false } } }), await globalThis.tintlyRegister.sync()));
    await context.close();
    context = await open();
    const page = await context.newPage();
    await page.goto(onUrl('/basic.html'));
    await waitState(page, 'ready', 30000 * SLOW);
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
    const list = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((l) => l.filter((s) => s.id === 'dk-hook' || s.id === 'dk-engine').map((s) => s.excludeMatches)));
    assert.deepEqual(list, [['*://localhost/*'], ['*://localhost/*']]);
  } finally {
    await context.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first-paint hold never stays on a document of another kind, and the off switch finds nothing to clear', { timeout: 90000 * SLOW }, async () => {
  await setStore(ON);
  const kinds = [
    ['/raw.txt', 'text/plain', 'plain words'],
    ['/raw.json', 'application/json', '{"a":1}'],
    ['/raw.xml', 'application/xml', '<a><b>x</b></a>'],
    ['/raw.css', 'text/css', 'body{color:red}'],
  ];
  await browser.context.route('**/raw.*', (route) => {
    const url = new URL(route.request().url());
    const kind = kinds.find(([path]) => path === url.pathname);
    return route.fulfill({ status: 200, contentType: kind[1], body: kind[2] });
  });
  try {
    for (const [path] of kinds) {
      const page = await browser.context.newPage();
      await page.goto(onUrl(path));
      await sleep(600);
      const seen = () => page.evaluate(() => ({ sheets: document.adoptedStyleSheets.length, go: document.documentElement.hasAttribute('data-dk-go'), bg: getComputedStyle(document.documentElement).backgroundColor, ours: document.querySelectorAll('style[data-dk]').length }));
      const first = await seen();
      assert.equal(first.sheets, 0, `${path}: no hold sheet`);
      assert.notEqual(first.bg, 'rgb(22, 24, 29)', `${path}: not dark`);
      assert.equal(first.ours, 0);
      await browser.setStorage({ settings: { enabled: false } });
      await sleep(400);
      assert.deepEqual(await seen(), { ...first, bg: first.bg });
      await browser.setStorage(ON);
      await page.close();
    }
  } finally {
    await browser.context.unroute('**/raw.*');
  }
});

test('a build that is not this one, or one whose extension is gone, is retired and replaced', { timeout: 90000 * SLOW }, async () => {
  await setStore(ON);
  const page = await browser.context.newPage();
  await page.goto(onUrl('/basic.html'));
  await waitState(page, 'ready', 20000 * SLOW);
  // The functions run in the isolated world of the tab; the worker holds the table because it cannot build a function from text.
  const isolated = (name) => browser.worker.evaluate(async ({ u, name }) => {
    const table = {
      build: () => globalThis.__dk.build,
      retired: () => globalThis.__retiredOld,
      alive: () => globalThis.__dk.alive(),
      older: () => {
        globalThis.__dk.build = 'old';
        const real = globalThis.__dk.retire;
        globalThis.__retiredOld = 0;
        globalThis.__dk.retire = () => {
          globalThis.__retiredOld += 1;
          real();
        };
      },
      gone: () => {
        const real = globalThis.__dk.retire;
        globalThis.__retiredOld = 0;
        globalThis.__dk.retire = () => {
          globalThis.__retiredOld += 1;
          real();
        };
        globalThis.__dk.alive = () => false;
      },
    };
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: table[name] });
    return r.result;
  }, { u: onUrl('/basic.html'), name });
  const version = await browser.worker.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(await isolated('build'), version);

  // An older build: its own retire(), then the injection of install and update.
  await isolated('older');
  await browser.worker.evaluate(() => globalThis.tintlyRegister.injectOpenTabs());
  await waitState(page, 'ready', 20000 * SLOW);
  assert.equal(await isolated('retired'), 1, 'the old build stopped its engines first');
  assert.equal(await isolated('build'), version);
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="sheet"]').length > 0), true);

  // A build whose extension context is gone answers false to alive().
  await isolated('gone');
  await browser.worker.evaluate(() => globalThis.tintlyRegister.injectOpenTabs());
  await waitState(page, 'ready', 20000 * SLOW);
  assert.equal(await isolated('retired'), 1);
  assert.equal(await isolated('alive'), true);
  // The new engine answers the switch: it is the live one.
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 10000 * SLOW });
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk]').length), 0);
  await page.close();
});

test('a tab whose site was switched off and on again is themed again without a reload (master switch and site rule), and the engine in the tab is stopped while it is off', { timeout: 120000 * SLOW }, async () => {
  await setStore(ON);
  const page = await browser.context.newPage();
  await page.goto(onUrl('/dynamic.html'));
  await waitState(page, 'ready', 20000 * SLOW);
  const namespace = () => browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => Object.keys(globalThis.__dk ?? {}).length });
    return r.result;
  }, page.url());
  const cases = [
    [{ settings: { enabled: false } }, ON],
    [{ settings: { enabled: true }, siteRules: { '127.0.0.1': { enabled: false } } }, ON],
  ];
  for (const [off, on] of cases) {
    for (let round = 0; round < 2; round++) {
      await browser.setStorage({ siteRules: {}, ...off });
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 10000 * SLOW });
      // The engine in the open tab is let go: nothing of it stays in the namespace.
      for (let i = 0; i < 80 && (await namespace()) > 0; i++) await sleep(100);
      assert.equal(await namespace(), 0, 'the namespace is empty while the site is off');
      await browser.setStorage({ siteRules: {}, ...on });
      await waitState(page, 'ready', 20000 * SLOW);
    }
  }
  await page.close();
});
