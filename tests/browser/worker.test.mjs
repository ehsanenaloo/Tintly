import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';
import { pageStatus } from '../helpers/gate.mjs';

let servers;
let browser;
let extensionPage;

before(async () => {
  servers = await startServers();
  browser = await launch();
  const id = new URL(browser.worker.url()).host;
  extensionPage = await browser.context.newPage();
  await extensionPage.goto(`chrome-extension://${id}/pages/popup/popup.html`);
});

after(async () => {
  await browser?.close();
  await servers?.close();
});

/** Send a message the way the popup does: from an extension page. */
const fromPage = (message) => extensionPage.evaluate((m) => chrome.runtime.sendMessage(m), message);

/** Send a message the way a content script does: from the isolated world of the tab that shows `url`. */
const fromContent = (url, message) =>
  browser.worker.evaluate(
    async ({ u, m }) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: (msg) => chrome.runtime.sendMessage(msg),
        args: [m],
      });
      return r.result;
    },
    { u: url, m: message },
  );

const stored = (key) => browser.worker.evaluate((k) => chrome.storage.local.get(k), key);

async function open(path, storage) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  const url = `${servers.origin}${path}`;
  await page.goto(url);
  if (storage.settings?.enabled !== false) await waitState(page, 'ready');
  return { page, url };
}

const ON = { settings: { enabled: true } };

test('the popup reads and changes the settings through the worker, and an open page follows', { timeout: 60000 }, async () => {
  const { page, url } = await open('/basic.html', ON);
  const state = await fromPage({ type: 'dk.state.get', url });
  assert.equal(state.ok, true);
  assert.equal(state.site.enabled, true);
  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal((await fromPage({ type: 'dk.settings.patch', patch: { theme: { brightness: 60 } } })).ok, true);
  assert.equal((await stored('settings')).settings.theme.brightness, 60);
  await page.waitForFunction((b) => getComputedStyle(document.body).backgroundColor !== b, before, { timeout: 15000 });
  await page.close();
});

test('a content script may not change or read anything private', { timeout: 60000 }, async () => {
  const { page, url } = await open('/basic.html', ON);
  const snapshot = await browser.worker.evaluate(() => chrome.storage.local.get(null));
  for (const message of [
    { type: 'dk.settings.patch', patch: { enabled: false } },
    { type: 'dk.site.set', pattern: 'a.com', rule: null },
    { type: 'dk.preset.delete', id: 'x' },
    { type: 'dk.import', text: '{}', confirmed: true },
    { type: 'dk.export' },
    { type: 'dk.state.get' },
  ]) {
    assert.deepEqual(await fromContent(url, message), { ok: false, code: 'denied' }, message.type);
  }
  assert.deepEqual(await browser.worker.evaluate(() => chrome.storage.local.get(null)), snapshot);
  await page.close();
});

test('the worker fetches a stylesheet and an image that the page uses, and nothing else', { timeout: 60000 }, async () => {
  const { page, url } = await open('/net-probe.html', { settings: { enabled: false } });
  const css = await fromContent(url, { type: 'dk.net.text', url: `${servers.origin}/css/linked.css` });
  assert.equal(css.ok, true, JSON.stringify(css));
  assert.match(css.text, /\.[a-z-]+/);
  const image = await fromContent(url, { type: 'dk.net.image', url: `${servers.origin}/img/dot.svg` });
  assert.equal(image.ok, true, JSON.stringify(image));

  const unused = await fromContent(url, { type: 'dk.net.text', url: `${servers.origin}/late.css` });
  assert.equal(unused.ok, false);
  const wrongKind = await fromContent(url, { type: 'dk.net.text', url: `${servers.origin}/img/dot.svg` });
  assert.equal(wrongKind.ok, false);
  for (const bad of ['file:///c:/windows/win.ini', 'data:text/css,a{}', 'https://user:pw@example.com/a.css', 'javascript:1', 'ftp://example.com/a.css']) {
    assert.equal((await fromContent(url, { type: 'dk.net.text', url: bad })).ok, false, bad);
  }
  await page.close();
});

test('a sheet from another origin is fetched by the worker and themed', { timeout: 60000 }, async () => {
  const { page, url } = await open('/dynamic.html', ON);
  await page.evaluate((u) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = `${u}/css/linked.css`;
    document.head.append(l);
  }, servers.other);
  const start = Date.now();
  for (;;) {
    const s = await browser.stats(url);
    if (s.fetched >= 1) {
      assert.equal(s.faults, 0);
      break;
    }
    assert.ok(Date.now() - start < 15000, 'the sheet was not fetched');
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="inert"]').length), 0);
  await page.close();
});

test('the top frame reports its state, and the worker keeps it for the toolbar', { timeout: 60000 }, async () => {
  const { page, url } = await open('/basic.html', ON);
  // The report reaches the worker after the page is themed; on a busy machine the wait is long, the condition is the same.
  assert.equal(await pageStatus(browser, url, { want: ['on'], timeout: 40000 }), 'on');
  await page.close();
});

test('export and import go through the worker, and an import waits for confirmation', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await fromPage({ type: 'dk.settings.patch', patch: {} });
  const out = await fromPage({ type: 'dk.export' });
  assert.equal(out.ok, true, JSON.stringify(out));
  const file = JSON.parse(out.text);
  assert.equal(file.app, 'tintly');
  file.settings.theme.brightness = 66;
  const text = JSON.stringify(file);
  const preview = await fromPage({ type: 'dk.import', text });
  assert.deepEqual([preview.ok, preview.applied], [true, false]);
  assert.notEqual((await stored('settings')).settings?.theme?.brightness, 66);
  const applied = await fromPage({ type: 'dk.import', text, confirmed: true });
  assert.equal(applied.applied, true, JSON.stringify(applied));
  assert.equal((await stored('settings')).settings.theme.brightness, 66);
  assert.equal((await fromPage({ type: 'dk.import', text: '{"app":"other"}', confirmed: true })).ok, false);
});

test('a site rule from the popup reaches the open page', { timeout: 60000 }, async () => {
  const { page, url } = await open('/basic.html', ON);
  const host = new URL(url).host;
  assert.equal((await fromPage({ type: 'dk.site.set', pattern: host, rule: { enabled: false } })).ok, true);
  await waitState(page, null);
  assert.equal((await fromPage({ type: 'dk.site.set', pattern: host, rule: null })).ok, true);
  await waitState(page, 'ready');
  await page.close();
});

test('settings are copied to the sync area after a short pause when sync is on', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.worker.evaluate(() => chrome.storage.sync.clear());
  assert.equal((await fromPage({ type: 'dk.settings.patch', patch: { syncEnabled: true } })).ok, true);
  const start = Date.now();
  for (;;) {
    const keys = Object.keys(await browser.worker.evaluate(() => chrome.storage.sync.get(null)));
    if (keys.some((k) => k.startsWith('dk.sync.'))) break;
    assert.ok(Date.now() - start < 8000, 'nothing was pushed');
    await new Promise((r) => setTimeout(r, 200));
  }
  await fromPage({ type: 'dk.settings.patch', patch: { syncEnabled: false } });
});

test('many changes at once run in order', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => fromPage({ type: 'dk.settings.patch', patch: { theme: { brightness: 60 + i } } })));
  assert.ok(replies.every((r) => r.ok));
  assert.equal((await stored('settings')).settings.theme.brightness, 79);
});

test('the first-paint stylesheet is registered for the sites that are on, and for no others', { timeout: 60000 }, async () => {
  const registered = () => browser.worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).filter((s) => s.id === 'dk-early'));
  const settle = () => new Promise((r) => setTimeout(r, 600));
  const patch = async (p) => assert.equal((await fromPage({ type: 'dk.settings.patch', patch: p })).ok, true);

  await browser.clearStorage();
  await fromPage({ type: 'dk.settings.patch', patch: { enabled: true } });
  await settle();
  let [s] = await registered();
  assert.deepEqual(s.matches, ['http://*/*', 'https://*/*']);
  assert.equal(s.js[0], 'content/early/hold.js');
  assert.equal(s.runAt, 'document_start');

  await fromPage({ type: 'dk.site.set', pattern: 'shop.example/cart', rule: { enabled: false } });
  await settle();
  [s] = await registered();
  // A rule with a path cannot be said by a match pattern exactly, so the whole host gets no hold and the gate decides.
  assert.deepEqual(s.excludeMatches, ['*://*.shop.example/*']);

  await patch({ holdPaint: false });
  await settle();
  [s] = await registered();
  assert.equal(s.js[0], 'content/early/canvas.js');
  await patch({ holdPaint: true });

  await patch({ automation: { mode: 'time' } });
  await settle();
  assert.equal((await registered()).length, 0, 'a schedule is decided in the page');
  await patch({ automation: { mode: 'none' } });

  await patch({ theme: { mode: 'light' } });
  await settle();
  assert.equal((await registered()).length, 0, 'light mode has no dark flash to prevent');
  await patch({ theme: { mode: 'dark' } });

  await patch({ listMode: 'onlyListed' });
  await fromPage({ type: 'dk.site.set', pattern: 'news.example', rule: { enabled: true } });
  await settle();
  [s] = await registered();
  assert.deepEqual([...s.matches].sort(), ['*://*.news.example/*']);

  await patch({ enabled: false });
  await settle();
  assert.equal((await registered()).length, 0);
});

test('the first-paint stylesheet keeps the canvas dark and shows the body at the latest after 8 s', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  await new Promise((r) => setTimeout(r, 600));
  // A page where the page script of the extension never runs: the extension is off for it by a rule, so the
  // stylesheet is excluded. Use a frame that the script cannot reach instead: a sandboxed frame without scripts.
  const page = await browser.context.newPage();
  await page.route('**/sandboxed.html', (route) => route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': 'sandbox' }, body: '<!doctype html><html><body style="margin:0"><p id="t" style="background:#fff;color:#000">text</p></body></html>' }));
  await page.goto(`${servers.origin}/sandboxed.html`);
  const early = await page.evaluate(() => ({ canvas: getComputedStyle(document.documentElement).backgroundColor, opacity: getComputedStyle(document.body).opacity }));
  assert.equal(early.canvas, 'rgb(22, 24, 29)');
  await page.waitForFunction(() => getComputedStyle(document.body).opacity === '1', undefined, { timeout: 12000 });
  await page.close();
});
