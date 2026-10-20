// The readability net: text that stays unreadable after theming gets a color that reaches the floor.
// The unreadable color comes from a style injected with the scripting API, which is not in the CSSOM, the way a style that
// another extension adds is. Without the net the text is dark on a dark box (the first test proves that).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, paintedLightness } from './harness.mjs';

let servers;
let browser;
let helper;

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

afterEach(async () => {
  // A failed test must not leave its page behind: the next test looks the tab up by address.
  for (const page of browser.context.pages()) if (page !== helper) await page.close().catch(() => {});
});

const ON = { settings: { enabled: true } };
const DARK_TEXT = '#bubble,#editor,#pm,#photo,#later{color:#222222}#host-open::part(label),#host-closed::part(label){color:#222222}';

/** Call one thing of the net in the isolated world of the tab that shows `url`. */
function net(url, what) {
  return browser.worker.evaluate(
    async ({ u, w }) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: /** @type {number} */ (tab.id) },
        world: 'ISOLATED',
        func: (what) => JSON.stringify(what === 'stop' ? (globalThis.__dk.readability.stop(), null) : globalThis.__dk.readability.stats()),
        args: [w],
      });
      return JSON.parse(r.result);
    },
    { u: url, w: what },
  );
}

const insertCss = (url, css) =>
  browser.worker.evaluate(async ({ u, c }) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await chrome.scripting.insertCSS({ target: { tabId: /** @type {number} */ (tab.id) }, css: c });
  }, { u: url, c: css });

const netStats = (url) => net(url, 'stats');

const ratioOf = ([fg, bg]) => {
  const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (css) => {
    const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
  };
  const [a, b] = [lum(fg), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
/** The contrast between the text of an element and its own background. */
const ratio = async (page, id) =>
  ratioOf(await page.evaluate((i) => {
    const s = getComputedStyle(document.getElementById(i));
    return [s.color, s.backgroundColor];
  }, id));
const shadowRatio = async (page, which) =>
  ratioOf(await page.evaluate((w) => {
    const s = getComputedStyle(window[w].getElementById('label'));
    return [s.color, s.backgroundColor];
  }, which));

async function open(settings = ON, css = DARK_TEXT) {
  await browser.clearStorage();
  await browser.setStorage(settings);
  const page = await browser.context.newPage();
  const url = `${servers.origin}/readability.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000);
  await insertCss(url, css);
  return { page, url };
}

const fixedCount = (page) => page.evaluate(() => document.querySelectorAll('[data-dk-r]').length);
const waitFixed = (page, id, timeout = 15000) =>
  page.waitForFunction((i) => document.getElementById(i).hasAttribute('data-dk-r'), id, { timeout });

test('dark text on a dark box from a style the engine cannot read is fixed; without the net it is unreadable', { timeout: 90000 }, async () => {
  const { page, url } = await open();
  await waitFixed(page, 'bubble');
  const after = await ratio(page, 'bubble');
  assert.ok(after >= 4.5, `contrast after the net ${after}`);
  // Stop the net: the page is as it was, and the text is unreadable. That is the proof the repro is real.
  await net(url, 'stop');
  const before = await ratio(page, 'bubble');
  assert.ok(before < 3, `contrast without the net ${before}`);
  assert.equal(await fixedCount(page), 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk=read]').length), 0);
  await page.close();
});

test('readable text is not changed; a gradient, an editor and a typed area are left alone', { timeout: 90000 }, async () => {
  const { page, url } = await open();
  await waitFixed(page, 'bubble');
  assert.equal(await page.evaluate(() => document.getElementById('fine').hasAttribute('data-dk-r')), false);
  // The unreadable ones that the net must not touch: a gradient has an unknown background, an editor holds typed content.
  assert.equal(await page.evaluate(() => document.getElementById('photo').hasAttribute('data-dk-r')), false);
  assert.equal(await page.evaluate(() => document.getElementById('editor').hasAttribute('data-dk-r')), false);
  assert.equal(await page.evaluate(() => document.getElementById('pm').hasAttribute('data-dk-r')), false);
  const s = await netStats(url);
  assert.ok(s.unknown >= 1, `unknown backgrounds: ${s.unknown}`);
  assert.ok(s.fixed >= 1 && s.fixed <= 6, `fixed: ${s.fixed}`);
  await page.close();
});

test('text added later is fixed', { timeout: 90000 }, async () => {
  const { page } = await open();
  await waitFixed(page, 'bubble');
  await page.evaluate(() => window.addLater());
  await waitFixed(page, 'later', 15000);
  assert.ok((await ratio(page, 'later')) >= 4.5);
  await page.close();
});

for (const which of ['__open', '__closed']) {
  test(`text in a ${which === '__open' ? 'open' : 'closed'} shadow root is fixed`, { timeout: 90000 }, async () => {
    const { page } = await open();
    await page.waitForFunction((w) => window[w].getElementById('label').hasAttribute('data-dk-r'), which, { timeout: 20000 });
    assert.ok((await shadowRatio(page, which)) >= 4.5);
    // The rule lives in the root, not in the document.
    assert.equal(await page.evaluate((w) => window[w].querySelectorAll('style[data-dk=read]').length, which), 1);
    await page.close();
  });
}

test('the net uses the floor of the E-ink mode (7 to 1)', { timeout: 90000 }, async () => {
  const { page } = await open({ settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'eink' } } }, '#bubble{color:#d8d8d8}');
  await waitFixed(page, 'bubble');
  // The mode runs transitions for 0.01 ms, so the old color shows for a frame.
  let r = 0;
  for (let i = 0; i < 20 && r < 7; i++) {
    await new Promise((res) => setTimeout(res, 100));
    r = await ratio(page, 'bubble');
  }
  assert.ok(r >= 7, `E-ink contrast ${r}`);
  await page.close();
});

test('the engine ending removes the rules and the marks', { timeout: 90000 }, async () => {
  const { page } = await open();
  await waitFixed(page, 'bubble');
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 10000 });
  const left = await page.evaluate(() => [window.__open, window.__closed].map((r) => r.querySelectorAll('style[data-dk], [data-dk-r]').length).concat(document.querySelectorAll('style[data-dk], [data-dk-r]').length));
  assert.deepEqual(left, [0, 0, 0]);
  await page.close();
});

test('the net keeps its work small: slices stay short and the rule count is capped', { timeout: 90000 }, async () => {
  const { page, url } = await open();
  await waitFixed(page, 'bubble');
  const s = await netStats(url);
  assert.ok(s.slices >= 1);
  assert.ok(s.maxSliceMs < 30, `longest slice ${s.maxSliceMs} ms`);
  assert.ok(s.rules <= 400);
  await page.close();
});

test('no light frame while a page with an unreadable bubble loads', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/dark.html`);
  const url = `${servers.origin}/readability.html`;
  const lightness = await paintedLightness(page, helper, async () => {
    await page.goto(url);
    await waitState(page, 'ready', 30000);
    await insertCss(url, DARK_TEXT);
    await waitFixed(page, 'bubble');
    await page.evaluate(() => window.addLater());
  });
  console.log(`# readability: ${lightness.length} frames, ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
  assert.deepEqual(lightness.filter((v) => v > 0.5), []);
  await page.close();
});

test('a big page: no slice of the net is longer than 50 ms', { timeout: 240000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  const url = `${servers.origin}/gen/code.html?blocks=300`;
  await page.addInitScript(() => {
    window.__long = [];
    window.__readyAt = null;
    new MutationObserver(() => {
      if (window.__readyAt === null && document.documentElement.getAttribute('data-dk-state') === 'ready') window.__readyAt = performance.now();
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-dk-state'] });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__long.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  const began = Date.now();
  await page.goto(url);
  await waitState(page, 'ready', 120000);
  const readyMs = Date.now() - began;
  const readyAt = await page.evaluate(() => window.__readyAt);
  // Let the net run several passes.
  await new Promise((r) => setTimeout(r, 9000));
  const s = await netStats(url);
  const late = await page.evaluate((at) => window.__long.filter((e) => e.start > at), readyAt);
  console.log(`# readability big page: ready after ${readyMs} ms, passes ${s.passes}, examined ${s.examined}, longest slice ${s.maxSliceMs} ms, long tasks after ready ${late.length} ${late.map((e) => Math.round(e.duration)).join(',')}`);
  assert.ok(s.passes >= 1, 'the net ran');
  // The long tasks that remain come from the engine's other work on a page of this size (the same count without the net).
  // The net's own slices are measured in the content script.
  assert.ok(s.maxSliceMs <= 50, `the longest slice of the net was ${s.maxSliceMs} ms`);
  assert.ok(s.examined > 0);
  await page.close();
});

test('text colored by a sheet that a fix tells the engine to skip is fixed', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  const host = new URL(servers.origin).host;
  await browser.setStorage({ ...ON, userFixes: { [host]: { dynamic: { ignoreCssUrl: ['*/readability-text.css'] } } } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/readability-skip.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000);
  await waitFixed(page, 'bubble');
  assert.ok((await ratio(page, 'bubble')) >= 4.5);
  await net(url, 'stop');
  assert.ok((await ratio(page, 'bubble')) < 3, 'unreadable without the net');
});

test('a short page, with nothing under the seed points of the window, is looked at from its top', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  const host = new URL(servers.origin).host;
  await browser.setStorage({ ...ON, userFixes: { [host]: { dynamic: { ignoreCssUrl: ['*/readability-text.css'] } } } });
  const page = await browser.context.newPage();
  await page.setViewportSize({ width: 1000, height: 300 });
  await page.goto(`${servers.origin}/readability-skip.html`);
  await waitState(page, 'ready', 30000);
  // The points the net asks about (the top, middle and bottom of the window) all fall on the empty page below the text.
  const hits = await page.evaluate(() => [0.02, 0.5, 0.98].map((y) => document.elementFromPoint(500, 300 * y)?.tagName));
  assert.ok(hits.every((t) => t === 'HTML' || t === 'BODY'), hits.join());
  await waitFixed(page, 'bubble');
});
