import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, imageStore, SLOW } from './harness.mjs';
import { corpus, encodePng } from '../helpers/png.mjs';

let servers;
let browser;

before(async () => {
  for (const i of corpus()) imageStore.set(i.name, encodePng(i.w, i.h, i.px));
  servers = await startServers();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const ON = { settings: { enabled: true } };
const luminance = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};

async function open(path, storage = ON, expect = 'ready') {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  if (expect === 'ready') await waitState(page, 'ready');
  else await page.waitForLoadState('load');
  return page;
}

const marks = (page) =>
  page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#row > *')].map((e) => [e.id, e.getAttribute('data-dk-bg') ?? 'none'])));
const imageStats = (page, url) =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify(globalThis.__dk.images.stats()) });
    return JSON.parse(r.result);
  }, page.url().split('#')[0]);

test('a dark icon set as a CSS background is inverted, photos and colored art are left alone', { timeout: 60000 }, async (t) => {
  const page = await open(`/bg-images.html#${servers.other}`);
  t.after(() => page.close());
  await page.waitForFunction(() => document.querySelectorAll('[data-dk-bg]').length >= 6, null, { timeout: 20000 });
  const got = await marks(page);
  assert.deepEqual(got, {
    logo: 'invert',
    navy: 'invert',
    chart: 'dim',
    photo: 'none',
    color: 'none',
    svg: 'invert',
    inline: 'invert',
    cross: 'invert',
    // A box with a color of its own, a gradient layer over the picture and a link with a label are not touched: a filter
    // would change all of that too.
    plated: 'none',
    layered: 'none',
    late: 'none',
    labeled: 'none',
  });
  const filter = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).filter, id);
  assert.match(await filter('logo'), /invert/);
  assert.match(await filter('chart'), /brightness/);
  assert.equal(await filter('photo'), 'none');
  assert.equal(await filter('plated'), 'none');
  const stats = await imageStats(page);
  console.log(`# background pictures: ${JSON.stringify(stats)}`);
  assert.ok(stats.bgInvert >= 5);
  assert.ok(stats.bgSkipped >= 2);
  // The picture from another origin was read in the page: its server allows it. Without that, the worker is asked.
  assert.equal(stats.fetched, 0);
});

test('an element that gets its picture later is sorted too, and one that loses it is let go', { timeout: 60000 }, async () => {
  const page = await open('/bg-images.html');
  await page.waitForFunction(() => document.querySelectorAll('[data-dk-bg]').length >= 5, null, { timeout: 20000 });
  assert.equal((await marks(page)).late, 'none');
  await page.evaluate(() => {
    document.getElementById('late').style.backgroundImage = 'url(/gen/img/dark-logo-7.png)';
    document.getElementById('logo').style.backgroundImage = 'none';
    window.dispatchEvent(new Event('scroll'));
  });
  await page.waitForFunction(() => document.getElementById('late').getAttribute('data-dk-bg') === 'invert' && !document.getElementById('logo').hasAttribute('data-dk-bg'), null, { timeout: 15000 });
  await page.close();
});

test('text on a picture keeps the page\'s color, text on a card on the picture is themed with the card', { timeout: 60000 }, async () => {
  const page = await open('/bg-images.html');
  await page.waitForFunction(() => document.querySelectorAll('[data-dk-k]').length >= 1, null, { timeout: 20000 });
  const color = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).color, id);
  assert.ok(luminance(await color('over-photo')) < 0.2, await color('over-photo'));
  assert.ok(luminance(await color('on-card')) > 0.6, await color('on-card'));
  await page.close();
});

test('light mode, a site that is off and teardown leave no mark behind', { timeout: 90000 }, async () => {
  const host = new URL(servers.origin).host;
  const light = await open('/bg-images.html', { settings: { enabled: true, theme: { mode: 'light' } } });
  await light.waitForTimeout(2500);
  assert.deepEqual(await light.evaluate(() => document.querySelectorAll('[data-dk-bg]').length), 0);
  await light.close();
  const off = await open('/bg-images.html', { settings: { enabled: true }, siteRules: { [host]: { enabled: false } } }, 'load');
  await off.waitForTimeout(2500);
  assert.deepEqual(await off.evaluate(() => document.querySelectorAll('[data-dk-bg], style[data-dk]').length), 0);
  await off.close();
  const page = await open('/bg-images.html');
  await page.waitForFunction(() => document.querySelectorAll('[data-dk-bg]').length >= 5, null, { timeout: 20000 });
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk-bg], [data-dk-k], style[data-dk]').length), 0);
  await page.close();
});

test('a page with very many background icons is capped and the sweeps stay short', { timeout: 90000 }, async () => {
  const page = await open('/bg-images.html');
  await page.waitForFunction(() => document.querySelectorAll('[data-dk-bg]').length >= 5, null, { timeout: 20000 });
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => window.__long.push(...list.getEntries().map((e) => e.duration))).observe({ entryTypes: ['longtask'] });
    const style = document.createElement('style');
    style.textContent = '.many{display:block;position:absolute;width:16px;height:16px;background:url(/gen/img/dark-logo-8.png) no-repeat}';
    document.head.append(style);
    for (let i = 0; i < 1200; i++) {
      const el = document.createElement('i');
      el.className = 'many';
      el.style.left = `${(i % 40) * 18}px`;
      el.style.top = `${300 + Math.floor(i / 40) * 18}px`;
      el.style.backgroundImage = `url(/gen/img/dark-logo-8.png?n=${i})`;
      document.body.append(el);
    }
  });
  await page.waitForTimeout(6000);
  const stats = await imageStats(page);
  const long = await page.evaluate(() => window.__long);
  console.log(`# 1200 background icons: ${JSON.stringify(stats)}; long tasks ${JSON.stringify(long.map((d) => Math.round(d)))}`);
  assert.ok(stats.bgInvert + stats.bgSkipped + stats.bgCapped > 0);
  assert.ok(stats.bgInvert <= 400 + 12, `${stats.bgInvert} elements were marked`);
  assert.ok(stats.analyzed <= 150 + 40, `${stats.analyzed} pictures were analyzed`);
  // Times scale with the speed of the thread. The one long task that is left is the style read of the page (scheme.cascade); before the
  // sweep marked only what hit testing needs, every slice restyled the page twice and 8 or 9 tasks passed 50 ms.
  assert.ok(Math.max(0, ...long) < 250 * SLOW, `a task of ${Math.max(0, ...long)} ms`);
  assert.ok(long.filter((d) => d > 50 * SLOW).length <= 2, `${long.filter((d) => d > 50 * SLOW).length} tasks over ${50 * SLOW} ms: ${JSON.stringify(long.map(Math.round))}`);
  await page.close();
});
