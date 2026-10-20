// The parts of the engine that most pages never run are loaded on demand: the E-ink palette, the verdict on the page's
// own dark theme, and the work for shadow roots and adopted sheets. A page that needs none of them loads none; a page that needs one
// loads exactly that one, shows its theme, and the loader has the time the module took to arrive.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, imageStore, SLOW } from './harness.mjs';
import { corpus, encodePng } from '../helpers/png.mjs';

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

const PARTS = ['einkpalette', 'sitetheme', 'shadowroots'];

/** The names in the namespace and the load times of the loader, for the top frame of the tab that shows `url`. */
const state = (url) =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => JSON.stringify({ keys: Object.keys(globalThis.__dk ?? {}), stats: globalThis.__dk?.optional?.stats() ?? null, hasEink: globalThis.__dk?.color?.hasEink() ?? null }),
    });
    return JSON.parse(r.result);
  }, url);

async function open(path, settings) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, ...settings } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready', 30000 * SLOW);
  // The modules that start after the engine is ready (pictures, the net) have arrived by now too.
  await page.waitForTimeout(300 * SLOW);
  return { page, url: `${servers.origin}${path}` };
}

const lightness = (css) => {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  const [r, g, b] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

test('a plain page in the dark mode asks for the theme module at the start, as it asked for the probe, and not for the roots or the palette', { timeout: 60000 * SLOW }, async () => {
  const { page, url } = await open('/dynamic.html', { theme: { mode: 'dark' } });
  const s = await state(url);
  assert.ok(s.keys.includes('sitetheme') && s.keys.includes('detect'));
  for (const name of ['einkpalette', 'shadowroots']) assert.ok(!s.keys.includes(name), name);
  assert.equal(s.hasEink, false);
  assert.equal(s.stats.failed, 0);
  await page.close();
});

test('with the page\'s own dark theme switched off the theme module is not asked for', { timeout: 60000 * SLOW }, async () => {
  const { page, url } = await open('/dynamic.html', { theme: { mode: 'dark', useSiteDark: false } });
  const s = await state(url);
  for (const name of PARTS) assert.ok(!s.keys.includes(name), name);
  await page.close();
});

test('a page with a dark theme of its own has the verdict module and the probe module, and keeps or drops the theme', { timeout: 60000 * SLOW }, async () => {
  const { page, url } = await open('/site-dark-media.html', { theme: { mode: 'dark' } });
  const s = await state(url);
  assert.ok(s.keys.includes('sitetheme') && s.keys.includes('detect'));
  for (const name of ['einkpalette', 'shadowroots']) assert.ok(!s.keys.includes(name), name);
  assert.ok(Number.isFinite(s.stats.ms.sitetheme) && s.stats.ms.sitetheme >= 0);
  assert.ok(lightness(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) < 0.2);
  await page.close();
});

test('a page with a repaired site theme asks for the module once and repairs', { timeout: 60000 * SLOW }, async () => {
  const { page, url } = await open('/site-repair-media.html', { theme: { mode: 'dark' } });
  const stats = await browser.stats(url);
  assert.equal(stats.siteDark.state, 'on');
  const s = await state(url);
  assert.ok(s.keys.includes('sitetheme'));
  assert.equal(s.stats.failed, 0);
  await page.close();
});

test('a page with shadow roots and adopted sheets loads the module for the roots and themes them', { timeout: 60000 * SLOW }, async () => {
  const { page, url } = await open('/shadow.html', { theme: { mode: 'dark' } });
  const s = await state(url);
  assert.ok(s.keys.includes('shadowroots'));
  assert.ok(Number.isFinite(s.stats.ms.shadowroots) && s.stats.ms.shadowroots >= 0);
  const stats = await browser.stats(url);
  assert.ok(stats.roots > 0 || stats.adoptedSheets > 0);
  assert.equal(stats.faults, 0);
  await page.close();
});

test('the E-ink and Paper mode loads the palette before the engine starts, and the page is paper', { timeout: 60000 * SLOW }, async () => {
  const { page, url } = await open('/eink-book.html', { theme: { mode: 'eink', einkPreset: 'paper' } });
  const s = await state(url);
  assert.ok(s.keys.includes('einkpalette') && s.keys.includes('calm'));
  assert.equal(s.hasEink, true);
  assert.ok(Number.isFinite(s.stats.ms.einkpalette) && s.stats.ms.einkpalette >= 0);
  const bg = lightness(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
  assert.ok(bg > 0.7, `paper, not dark: ${bg}`);
  await page.close();
});

test('a page in the dark mode that has the E-ink palette missing is not touched by it, and the mode falls back to light when the palette cannot load', { timeout: 60000 * SLOW }, async () => {
  // The worker refuses the module: the mode still shows a light page and nothing breaks.
  const { page, url } = await open('/dynamic.html', { theme: { mode: 'dark' } });
  const probe = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => {
        const c = globalThis.__dk.color;
        const theme = c.createTheme({ mode: 'eink', einkPreset: 'eink' });
        return JSON.stringify({ has: c.hasEink(), dark: theme.dark, eink: theme.eink });
      },
    });
    return JSON.parse(r.result);
  }, url);
  assert.equal(probe.has, false);
  assert.equal(probe.dark, false, 'the mode without its palette is a light theme, not a dark one');
  assert.equal(probe.eink, null);
  await page.close();
});

test('markup with custom elements that are not defined yet starts the load of the roots module before the roots exist', { timeout: 60000 * SLOW }, async () => {
  const { page, url } = await open('/shadow-late.html?manual', { theme: { mode: 'dark' } });
  const before = await state(url);
  assert.ok(before.keys.includes('shadowroots'), 'the module is in the page before any root is made');
  assert.equal((await browser.stats(url)).roots, 0);
  await page.evaluate(() => window.defineCards());
  await page.waitForFunction(() => {
    const el = document.querySelector('late-card')?.shadowRoot?.querySelector('.t');
    return el && Number(getComputedStyle(el).backgroundColor.match(/\d+/)[0]) < 100;
  }, null, { timeout: 5000 * SLOW });
  assert.equal((await state(url)).stats.failed, 0);
  await page.close();
});

test('a page whose custom elements are defined and have no roots, or that has none, does not load the roots module twice', { timeout: 60000 * SLOW }, async () => {
  const { page, url } = await open('/dynamic.html', { theme: { mode: 'dark' } });
  assert.ok(!(await state(url)).keys.includes('shadowroots'));
  await page.close();
});

/* ----- the module for CSS pictures (imagebg) joins the run of the picture module when the page shows one ----- */

const route = (page, path, html) => page.route(`${servers.origin}${path}`, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
const PIXEL = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2740%27 height=%2740%27%3E%3Crect width=%2740%27 height=%2740%27 fill=%27%23000%27/%3E%3C/svg%3E';

test('a page with no CSS picture, canvas or inline picture loads the picture module and not the one for backgrounds', { timeout: 60000 * SLOW }, async () => {
  const { page, url } = await open('/dynamic.html', { theme: { mode: 'dark' } });
  const s = await state(url);
  assert.ok(s.keys.includes('images'), 'the picture module is there');
  assert.ok(!s.keys.includes('imagebg'), 'the module for backgrounds is not');
  assert.equal(s.stats.failed, 0);
  await page.close();
});

test('a page whose sheet gives an element a picture loads the module for backgrounds, which sorts it', { timeout: 60000 * SLOW }, async () => {
  for (const i of corpus()) imageStore.set(i.name, encodePng(i.w, i.h, i.px));
  const { page, url } = await open('/bg-images.html', { theme: { mode: 'dark' } });
  const s = await state(url);
  assert.ok(s.keys.includes('images') && s.keys.includes('imagebg'));
  assert.ok(Number.isFinite(s.stats.ms.imagebg) && s.stats.ms.imagebg >= 0);
  await page.waitForTimeout(1500 * SLOW);
  const stats = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify(globalThis.__dk.images.stats()) });
    return JSON.parse(r.result);
  }, url);
  assert.ok(stats.bgSelectors > 0 && stats.bgInvert > 0, JSON.stringify(stats));
  await page.close();
});

test('a canvas, or a picture in a style attribute, loads the module for backgrounds without any sheet noting it', { timeout: 60000 * SLOW }, async () => {
  for (const [name, body] of [
    ['canvas', '<canvas id="c" width="64" height="64"></canvas>'],
    ['inline', `<div id="d" style="width:60px;height:60px;background-image:url('${PIXEL}')"></div>`],
  ]) {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
    const page = await browser.context.newPage();
    const path = `/gen/${name}-only.html`;
    await route(page, path, `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{background:#fff;color:#222}</style></head><body><p>Text</p>${body}</body></html>`);
    await page.goto(`${servers.origin}${path}`);
    await waitState(page, 'ready', 30000 * SLOW);
    let keys = [];
    for (let i = 0; i < 40 && !keys.includes('imagebg'); i++) {
      await page.waitForTimeout(250);
      keys = (await state(`${servers.origin}${path}`)).keys;
    }
    assert.ok(keys.includes('imagebg'), `${name}: the module arrived`);
    await page.close();
  }
});

test('the module for backgrounds leaves with the picture module: the site goes off and nothing of it stays on the page', { timeout: 60000 * SLOW }, async () => {
  const { page, url } = await open('/bg-images.html', { theme: { mode: 'dark' } });
  assert.ok((await state(url)).keys.includes('imagebg'));
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 15000 * SLOW });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk-bg],[data-dk-img],style[data-dk]').length), 0);
  await page.close();
});

test('the module of the readability net is not asked for before the engine is ready, and is there after', { timeout: 60000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/slow.html`;
  const seen = [];
  await page.goto(url, { waitUntil: 'commit' });
  for (let i = 0; i < 400; i++) {
    let sample;
    try {
      sample = await browser.worker.evaluate(async (u) => {
        const [tab] = await chrome.tabs.query({ url: u });
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', injectImmediately: true, func: () => ({ net: !!globalThis.__dk?.readability, ready: document.documentElement.getAttribute('data-dk-state') === 'ready' }) });
        return r.result;
      }, url);
    } catch {
      continue;
    }
    seen.push(sample);
    if (sample.net) break;
    await page.waitForTimeout(10);
  }
  assert.ok(seen.some((s) => !s.ready), 'sampled the load before the engine was ready');
  assert.deepEqual(seen.filter((s) => s.net && !s.ready), [], 'the net was loaded before the engine was ready');
  assert.ok(seen.at(-1).net, 'the net arrived after');
  await page.close();
});
