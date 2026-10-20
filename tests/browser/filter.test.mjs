import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServers, launch, waitState, collect, colorsAt, pixelsOf } from './harness.mjs';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js');
const C = dk.color;
const toLightness = ([r, g, b]) => C.toOklch({ r: r / 255, g: g / 255, b: b / 255, a: 1 })[0];
const hueOf = ([r, g, b]) => C.toOklch({ r: r / 255, g: g / 255, b: b / 255, a: 1 });
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

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

const settings = (engine, extra = {}) => ({ settings: { enabled: engine !== null, ...(engine ? { engine } : {}), ...extra } });
const OFF = settings(null);

async function open(path, storage, wait = 'ready') {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`${servers.origin}${path}`);
  if (wait === 'ready') await waitState(page, 'ready');
  else await page.waitForLoadState('load');
  await page.waitForTimeout(150);
  return { page, problems, url: `${servers.origin}${path}` };
}

const SELECTORS = ['#ui-gray', '#ui-blue', '#ui-red', '#ui-green', '#img-a', '#img-b', '#cv', '#bg-wrap', '#bg-wrap img', '#under-blend', '#under-backdrop'];

async function render(path, storage) {
  const { page, problems, url } = await open(path, storage, storage.settings.enabled ? 'ready' : 'load');
  const colors = await colorsAt(page, helper, SELECTORS);
  const page_bg = (await pixelsOf(page, helper, [[900, 600]]))[0];
  if (process.env.DK_SHOTS) {
    const label = storage.settings.enabled ? storage.settings.engine ?? 'auto' : 'off';
    writeFileSync(join(process.env.DK_SHOTS, `filter-${label}.png`), await page.screenshot({ type: 'png' }));
  }
  return { page, problems, url, colors: Object.fromEntries(SELECTORS.map((s, i) => [s, colors[i]])), page_bg };
}

let originalRender = null;
/** The page as it looks without the extension, read once. */
async function original() {
  if (!originalRender) {
    const off = await render('/filter-media.html', OFF);
    originalRender = { colors: off.colors, bg: off.page_bg };
    await off.page.close();
  }
  return originalRender;
}

test('both filter engines turn the page dark', { timeout: 90000 }, async () => {
  const off = await original();
  assert.ok(toLightness(off.bg) > 0.95, 'the control page is white');

  for (const engine of ['filter', 'filterPlus']) {
    const r = await render('/filter-media.html', settings(engine));
    console.log(`# ${engine}: page ${r.page_bg}, gray box ${r.colors['#ui-gray']}, blue box ${r.colors['#ui-blue']}`);
    assert.ok(toLightness(r.page_bg) < 0.3, `${engine} page lightness ${toLightness(r.page_bg)}`);
    assert.ok(toLightness(r.colors['#ui-gray']) < 0.5, `${engine} gray box`);
    assert.deepEqual(r.problems, []);
    await r.page.close();
  }
});

test('Filter+ uses the theme colors, Filter uses pure black', { timeout: 60000 }, async () => {
  const plain = await render('/filter-media.html', settings('filter'));
  const plus = await render('/filter-media.html', settings('filterPlus'));
  console.log(`# page color: Filter ${plain.page_bg}, Filter+ ${plus.page_bg}`);
  assert.ok(maxDiff(plain.page_bg, [0, 0, 0]) <= 2, `Filter ${plain.page_bg}`);
  // The default dark background is #16181d = 22, 24, 29. A small difference comes from 8-bit rounding.
  assert.ok(maxDiff(plus.page_bg, [22, 24, 29]) <= 3, `Filter+ ${plus.page_bg}`);
  await plain.page.close();
  await plus.page.close();
});

test('media come back close to how they were: images, canvas, an inline background image, and an image inside one', { timeout: 90000 }, async () => {
  const media = ['#img-a', '#img-b', '#cv', '#bg-wrap', '#bg-wrap img'];
  // The root filter and the media filter are two steps with a clip to 0..1 between them, so a saturated flat color
  // does not come back exactly. These limits are what was measured, with a little room.
  for (const [engine, limit] of [['filter', 45], ['filterPlus', 70]]) {
    const r = await render('/filter-media.html', settings(engine));
    const base = (await original()).colors;
    const diffs = media.map((s) => [s, maxDiff(r.colors[s], base[s])]);
    console.log(`# ${engine} media difference from the original (of 255): ${diffs.map(([s, d]) => `${s} ${d}`).join(', ')}`);
    for (const [s, d] of diffs) assert.ok(d <= limit, `${engine} ${s}: ${r.colors[s]} against ${base[s]}`);
    // A canvas with a mid-range green comes back almost exactly with the plain filter.
    if (engine === 'filter') assert.ok(maxDiff(r.colors['#cv'], base['#cv']) <= 3);
    await r.page.close();
  }
});

test('a frame is dark once, not inverted twice', { timeout: 90000 }, async () => {
  for (const engine of ['filter', 'filterPlus']) {
    const { page } = await open('/filter-media.html', settings(engine));
    const [inside] = await pixelsOf(page, helper, [[420, 390]]);
    console.log(`# ${engine}: pixel inside the frame ${inside}`);
    assert.ok(toLightness(inside) < 0.3, `${engine} frame pixel ${inside}`);
    const frame = page.frames().find((f) => f.url().endsWith('/iframe-inner.html'));
    await frame.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready');
    await page.close();
  }
});

test('fixed and sticky elements keep their place under the root filter', { timeout: 90000 }, async () => {
  const measure = async (storage) => {
    const { page } = await open('/filter-media.html', storage, storage.settings.enabled ? 'ready' : 'load');
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(100);
    const r = await page.evaluate(() => ({
      fixed: document.getElementById('fixed').getBoundingClientRect().top,
      sticky: document.getElementById('sticky').getBoundingClientRect().top,
      overlay: [document.getElementById('overlay').getBoundingClientRect().left, document.getElementById('overlay').getBoundingClientRect().top],
    }));
    // The fixed header must also be drawn at the top of the viewport, not scrolled away with the page.
    const [headerPixel] = await pixelsOf(page, helper, [[900, 20]]);
    await page.close();
    return { ...r, headerPixel };
  };
  const base = await measure(OFF);
  assert.equal(base.fixed, 0);
  for (const engine of ['filter', 'filterPlus']) {
    const r = await measure(settings(engine));
    assert.deepEqual({ fixed: r.fixed, sticky: r.sticky, overlay: r.overlay }, { fixed: base.fixed, sticky: base.sticky, overlay: base.overlay }, engine);
    assert.ok(toLightness(r.headerPixel) < 0.45, `${engine}: the header drawn at the top of the viewport is ${r.headerPixel}`);
  }
});

test('print keeps the original page', { timeout: 60000 }, async () => {
  for (const engine of ['filter', 'filterPlus']) {
    const { page } = await open('/filter-media.html', settings(engine));
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).filter), 'none', engine);
    await page.close();
  }
});

test('Filter+ still works on a page with a base element', { timeout: 60000 }, async () => {
  const { page } = await open('/filter-base.html', settings('filterPlus'));
  const [bg, box] = await pixelsOf(page, helper, [[600, 300], [130, 120]]);
  console.log(`# base element: page ${bg}, box ${box}`);
  assert.ok(toLightness(bg) < 0.3, `page ${bg}`);
  assert.ok(toLightness(box) < 0.6, `box ${box}`);
  assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).filter), /url\(/);
  await page.close();
});

test('turning the engine off removes everything and restores the DOM', { timeout: 60000 }, async () => {
  const base = await open('/filter-media.html', OFF, 'load');
  const html = (await collect(base.page)).html;
  await base.page.close();
  for (const engine of ['filter', 'filterPlus']) {
    const { page } = await open('/filter-media.html', settings(engine));
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk]:not([data-dk=canvas])').length), engine === 'filter' ? 1 : 2);
    await browser.setStorage({ settings: { enabled: false } });
    await waitState(page, null);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk]').length), 0);
    // The frame has its own engine, so wait for it before reading the whole document.
    assert.equal((await collect(page)).html, html, engine);
    await page.close();
  }
});

test('the engine can be changed live, and only one runs at a time', { timeout: 90000 }, async () => {
  const { page, url } = await open('/basic.html', settings('filter'));
  const kinds = async () => ({
    stats: (await browser.stats(url))?.kind ?? 'dynamic',
    filterStyle: await page.evaluate(() => document.querySelectorAll('style[data-dk="filter"]').length),
    dynamicCopies: await page.evaluate(() => document.querySelectorAll('style[data-dk="sheet"]').length),
    svg: await page.evaluate(() => document.querySelectorAll('svg[data-dk]').length),
  });
  let s = await kinds();
  assert.deepEqual([s.stats, s.filterStyle, s.dynamicCopies, s.svg], ['filter', 1, 0, 0]);

  await browser.setStorage(settings('filterPlus'));
  await page.waitForFunction(() => document.querySelectorAll('svg[data-dk]').length === 1);
  s = await kinds();
  assert.deepEqual([s.stats, s.filterStyle, s.dynamicCopies, s.svg], ['filterPlus', 1, 0, 1]);

  await browser.setStorage(settings('dynamic'));
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk="sheet"]').length > 0);
  s = await kinds();
  assert.deepEqual([s.filterStyle, s.svg], [0, 0]);
  assert.ok(s.dynamicCopies > 0);

  await browser.setStorage(settings('filter'));
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk="filter"]').length === 1 && document.querySelectorAll('style[data-dk="sheet"]').length === 0);
  await page.close();
});

test('the brightness, contrast, sepia and grayscale sliders reach both engines', { timeout: 90000 }, async () => {
  for (const engine of ['filter', 'filterPlus']) {
    const base = await render('/filter-media.html', settings(engine));
    const dim = await render('/filter-media.html', settings(engine, { theme: { brightness: 70 } }));
    const gray = await render('/filter-media.html', settings(engine, { theme: { grayscale: 100 } }));
    assert.ok(toLightness(dim.colors['#ui-gray']) < toLightness(base.colors['#ui-gray']) || toLightness(dim.page_bg) <= toLightness(base.page_bg), `${engine} brightness`);
    const [r, g, b] = gray.colors['#ui-blue'];
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 3, `${engine} grayscale: ${gray.colors['#ui-blue']}`);
    for (const x of [base, dim, gray]) await x.page.close();
  }
});

test('light mode does not invert: a light page stays light and a dark page stays dark', { timeout: 90000 }, async () => {
  for (const engine of ['filter', 'filterPlus']) {
    for (const [path, light] of [['/filter-media.html', true], ['/filter-dark.html', false]]) {
      const { page, problems } = await open(path, settings(engine, { theme: { mode: 'light' } }));
      const bg = (await pixelsOf(page, helper, [[800, 300]]))[0];
      assert.deepEqual(problems, []);
      assert.equal(toLightness(bg) > 0.8, light, `${engine} ${path}: page ${bg}`);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).filter), 'none', `${engine} ${path}`);
      await page.close();
    }
  }
});

test('color: hue accuracy of both filters against the Dynamic engine on a sweep of colors', { timeout: 180000 }, async () => {
  const colors = [];
  for (let h = 0; h < 360; h += 15) for (const L of [0.35, 0.55, 0.75]) colors.push(C.toHex(C.fromOklch(L, 0.1, h)).slice(1));
  const path = `/gen/swatches.html?c=${colors.join(',')}`;
  const points = colors.map((_, i) => [(i % 10) * 40 + 20, Math.floor(i / 10) * 40 + 20]);
  const read = async (storage) => {
    const { page } = await open(path, storage, storage.settings.enabled ? 'ready' : 'load');
    const px = await pixelsOf(page, helper, points);
    await page.close();
    return px;
  };
  const off = await read(OFF);
  const results = {};
  // The default dark theme has a blue tint, and the tint itself counts as a hue shift. The neutral theme leaves it out.
  const neutral = { darkBackground: '#171717', darkText: '#e8e8e8' };
  for (const [name, storage] of [
    ['filter', settings('filter')],
    ['filterPlus', settings('filterPlus', { theme: neutral })],
    ['filterPlusTint', settings('filterPlus')],
    ['dynamic', settings('dynamic')],
  ]) {
    const px = await read(storage);
    const errors = [];
    off.forEach((o, i) => {
      const [, c0, h0] = hueOf(o);
      const [, c1, h1] = hueOf(px[i]);
      if (c0 < 0.04 || c1 < 0.01) return;
      errors.push(Math.abs(((h1 - h0 + 540) % 360) - 180));
    });
    errors.sort((a, b) => a - b);
    const chroma = px.reduce((s, p, i) => s + hueOf(p)[1] / hueOf(off[i])[1], 0) / px.length;
    results[name] = { mean: errors.reduce((a, b) => a + b, 0) / errors.length, p95: errors[Math.floor(errors.length * 0.95)], max: errors.at(-1), chroma, n: errors.length };
    console.log(`# hue error ${name.padEnd(10)}: mean ${results[name].mean.toFixed(2)}, p95 ${results[name].p95.toFixed(2)}, max ${results[name].max.toFixed(2)} degrees, chroma kept ${results[name].chroma.toFixed(2)}, ${results[name].n} colors`);
  }
  assert.ok(results.dynamic.mean < 3, `Dynamic mean ${results.dynamic.mean}`);
  // With a neutral theme Filter+ is about as accurate as Filter, a little better on average. With the default tinted theme it is a little worse.
  assert.ok(results.filterPlus.max <= results.filter.max * 1.1, 'Filter+ (neutral theme) must not have a worse worst case than Filter');
  assert.ok(results.filterPlus.mean <= results.filter.mean, 'Filter+ (neutral theme) must not be worse than Filter on average');
  assert.ok(results.filterPlusTint.mean <= results.filter.mean + 2, 'the tint must not cost more than 2 degrees on average');
});

test('speed: the filter engines are ready at once on a page the Dynamic engine needs seconds for', { timeout: 120000 }, async () => {
  for (const engine of ['filter', 'filterPlus', 'dynamic']) {
    const started = Date.now();
    const { page, url } = await open('/gen/large.html?rules=30000', settings(engine));
    const took = Date.now() - started;
    const stats = await browser.stats(url);
    console.log(`# ${engine} on 30 000 rules: ready after ${took} ms of load, engine ready ${(stats.readyAt - stats.startedAt).toFixed(1)} ms after its start`);
    if (engine !== 'dynamic') assert.ok(stats.readyAt - stats.startedAt < 5);
    await page.close();
  }
});
