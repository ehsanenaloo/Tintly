// Dark and Light must differ in every engine: Dark makes a light page dark, Light leaves it light and applies the sliders only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, pixelsOf } from './harness.mjs';

let servers;
let browser;
let helper;
let host;

before(async () => {
  servers = await startServers();
  browser = await launch();
  host = new URL(servers.origin).host;
  helper = await browser.context.newPage();
  await helper.goto('about:blank');
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const STATIC = { static: { bg: ['body', '.card', 'header'], fg: ['body', 'p'], border: ['.card'] } };

async function read(engine, theme) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, engine, theme }, ...(engine === 'static' ? { userFixes: { [host]: STATIC } } : {}) });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/basic.html`);
  await waitState(page, 'ready', 30000);
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      filter: root.filter,
      scheme: root.colorScheme,
      body: getComputedStyle(document.body).backgroundColor,
      own: [...document.querySelectorAll('style[data-dk="filter"], svg[data-dk="filter-defs"]')].map((e) => (e.nodeName === 'svg' ? 'svg' : e.textContent)).join('|'),
    };
  });
  const [px] = await pixelsOf(page, helper, [[900, 700]]);
  await page.close();
  return { ...state, px };
}

const lightness = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

test('the plain Filter engine: Dark inverts, Light leaves the page and writes no filter', { timeout: 60000 }, async () => {
  const dark = await read('filter', { mode: 'dark' });
  const light = await read('filter', { mode: 'light' });
  assert.match(dark.filter, /invert\(1\)/);
  assert.ok(lightness(dark.px) < 0.3, `dark ${dark.px}`);
  assert.equal(light.filter, 'none');
  assert.ok(lightness(light.px) > 0.8, `light ${light.px}`);
  assert.doesNotMatch(light.own, /invert|hue-rotate/);
  assert.notEqual(dark.own, light.own);
});

test('the plain Filter engine in Light mode applies the sliders and nothing else', { timeout: 60000 }, async () => {
  const dim = await read('filter', { mode: 'light', brightness: 80, grayscale: 40 });
  assert.match(dim.filter, /brightness\(0\.8\)/);
  assert.match(dim.filter, /grayscale\(0\.4\)/);
  assert.doesNotMatch(dim.filter, /invert/);
  assert.ok(lightness(dim.px) > 0.6 && lightness(dim.px) < 0.95, `dim ${dim.px}`);
});

test('Filter+: Dark maps white to the dark page, Light has no matrix without a slider and one slider matrix with it', { timeout: 60000 }, async () => {
  const dark = await read('filterPlus', { mode: 'dark' });
  const light = await read('filterPlus', { mode: 'light' });
  assert.match(dark.filter, /url\(/);
  assert.ok(lightness(dark.px) < 0.3, `dark ${dark.px}`);
  assert.equal(light.filter, 'none');
  assert.ok(lightness(light.px) > 0.8, `light ${light.px}`);
  assert.doesNotMatch(light.own, /svg/);
  const dim = await read('filterPlus', { mode: 'light', brightness: 70 });
  assert.match(dim.filter, /url\(/);
  assert.ok(lightness(dim.px) > 0.55 && lightness(dim.px) < 0.8, `dim ${dim.px}`);
});

test('the Static engine: Dark colors the named elements dark, Light keeps them light', { timeout: 60000 }, async () => {
  const dark = await read('static', { mode: 'dark' });
  const light = await read('static', { mode: 'light' });
  assert.equal(dark.scheme, 'dark');
  assert.ok(lightness(dark.px) < 0.3, `dark ${dark.px}`);
  assert.equal(light.scheme, 'light');
  assert.ok(lightness(light.px) > 0.8, `light ${light.px}`);
  assert.notEqual(dark.body, light.body);
});

test('the Dynamic engine for comparison: Dark and Light differ', { timeout: 60000 }, async () => {
  const dark = await read('dynamic', { mode: 'dark' });
  const light = await read('dynamic', { mode: 'light' });
  assert.ok(lightness(dark.px) < 0.3 && lightness(light.px) > 0.8, `${dark.px} ${light.px}`);
});
