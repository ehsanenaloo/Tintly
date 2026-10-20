import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, imageStore, pixelsOf } from './harness.mjs';
import { encodePng, scanCode, glyph } from '../helpers/png.mjs';

let servers;
let browser;
let helper;

before(async () => {
  imageStore.set('qr', encodePng(64, 64, scanCode(29, { side: 64 })));
  imageStore.set('glyph', encodePng(64, 64, glyph(64)));
  servers = await startServers();
  browser = await launch();
  helper = await browser.context.newPage();
  await helper.goto(`${servers.origin}/basic.html`);
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

async function open(path, storage = ON, state = 'ready') {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  if (state) await waitState(page, state, 30000);
  return page;
}

const read = (page, id, prop) => page.evaluate(([i, p]) => getComputedStyle(document.getElementById(i)).getPropertyValue(p), [id, prop]);

/* ---------- scan codes ---------- */

test('an inline SVG scan code keeps its black and white; other drawings are themed', { timeout: 60000 }, async () => {
  const page = await open('/qr-svg.html');
  await page.waitForTimeout(500);
  assert.equal(await read(page, 'qr-bg', 'fill'), 'rgb(255, 255, 255)');
  assert.equal(await read(page, 'qr-dark', 'fill'), 'rgb(0, 0, 0)');
  // The same drawing without crisp edges is art, and a code with a colored mark is not a code.
  assert.ok(luminance(await read(page, 'art-bg', 'fill')) < 0.3, await read(page, 'art-bg', 'fill'));
  assert.ok(luminance(await read(page, 'art-dark', 'fill')) > 0.5, await read(page, 'art-dark', 'fill'));
  assert.ok(luminance(await read(page, 'mixed-bg', 'fill')) < 0.3, await read(page, 'mixed-bg', 'fill'));
  await page.close();
});

test('a scan code in a PNG with a clear background gets a white plate; an icon is still inverted', { timeout: 60000 }, async () => {
  const page = await open('/gen/images.html?names=qr,glyph');
  await page.waitForFunction(() => document.querySelectorAll('img[data-dk-img]').length >= 2, undefined, { timeout: 15000 });
  const marks = await page.evaluate(() => Object.fromEntries([...document.images].map((i) => [i.id, i.getAttribute('data-dk-img')])));
  assert.deepEqual(marks, { qr: 'plate', glyph: 'invert' });
  assert.equal(await read(page, 'qr', 'background-color'), 'rgb(255, 255, 255)');
  assert.equal(await read(page, 'qr', 'filter'), 'none');
  await page.close();
});

/* ---------- relative color syntax ---------- */

test('relative colors are resolved by the browser and then themed', { timeout: 60000 }, async () => {
  const page = await open('/relative-color.html');
  if (!(await page.evaluate(() => CSS.supports('color', 'rgb(from #fff r g b)')))) {
    console.log('# relative colors are not supported by this browser; skipped');
    await page.close();
    return;
  }
  await page.waitForTimeout(500);
  const bg = (id) => read(page, id, 'background-color');
  assert.ok(luminance(await bg('rgb')) < 0.3, await bg('rgb'));
  assert.ok(luminance(await read(page, 'rgb', 'color')) > 0.6, await read(page, 'rgb', 'color'));
  assert.ok(luminance(await bg('okl')) < 0.3, await bg('okl'));
  assert.ok(luminance(await read(page, 'okl', 'color')) > 0.6, await read(page, 'okl', 'color'));
  // The alpha of the original is kept.
  const alpha = await bg('alpha');
  assert.ok(luminance(alpha) < 0.3, alpha);
  assert.match(alpha, /0\.9|rgba/);
  assert.ok(luminance(await read(page, 'mix', 'border-top-color')) < 0.5, await read(page, 'mix', 'border-top-color'));
  assert.doesNotMatch(await read(page, 'grad', 'background-image'), /rgb\(255, 255, 255\)/);
  // A plain color on the same page behaves as before.
  assert.ok(luminance(await bg('plain')) < 0.3);
  // The helper element is ours: gone when the engine stops.
  assert.ok((await page.evaluate(() => document.querySelectorAll('[data-dk="probe"]').length)) >= 1);
  await browser.setStorage({ settings: { enabled: false } });
  await waitState(page, null);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk]').length), 0);
  await page.close();
});

/* ---------- routes ---------- */

test('a rule for a path follows the page when it changes its route', { timeout: 60000 }, async () => {
  const host = new URL(servers.origin).host;
  const page = await open('/basic.html', { settings: { enabled: true }, siteRules: { [`${host}/off`]: { enabled: false } } });
  const stopped = () => waitState(page, null, 10000);
  await page.evaluate(() => history.pushState({}, '', '/off'));
  await stopped();
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk]').length), 0);
  // A route back to a page without the rule themes it again.
  await page.evaluate(() => history.pushState({}, '', '/basic.html'));
  await waitState(page, 'ready', 15000);
  // The back button is a popstate.
  await page.evaluate(() => history.pushState({}, '', '/off/deeper'));
  await stopped();
  await page.evaluate(() => history.back());
  await waitState(page, 'ready', 15000);
  await page.close();
});

/* ---------- a dark frame around a light page ---------- */

async function themed(name) {
  const page = await open(`/detect/${name}.html`, ON, null);
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  const themedNow = await page.evaluate(() => document.documentElement.hasAttribute('data-dk-state'));
  return { page, themedNow };
}

test('a dark frame around a large light box is themed; a dark page with a dark card is left alone', { timeout: 90000 }, async () => {
  const frame = await themed('dark-frame');
  assert.equal(frame.themedNow, true, 'the light box in a dark frame must be themed');
  const bg = await frame.page.evaluate(() => getComputedStyle(document.querySelector('.wrap')).backgroundColor);
  assert.ok(luminance(bg) < 0.3, bg);
  await frame.page.close();

  const card = await themed('dark-card');
  assert.equal(card.themedNow, false, 'a dark page with a dark card is already dark');
  // What the extra look costs: one hit test and one style read at the middle of the window.
  const cost = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => {
        const began = performance.now();
        for (let i = 0; i < 100; i++) {
          const el = document.elementsFromPoint(innerWidth / 2, innerHeight / 2)[0];
          getComputedStyle(el).backgroundColor;
          el.getBoundingClientRect();
        }
        return (performance.now() - began) / 100;
      },
    });
    return r.result;
  }, `${servers.origin}/detect/dark-card.html`);
  console.log(`# detection: the middle-of-window look costs ${cost.toFixed(3)} ms per probe`);
  assert.ok(cost < 5, String(cost));
  await card.page.close();
});

/* ---------- bare SVG documents ---------- */

test('a bare SVG file opened in a tab gets a dark canvas and a readable drawing, and nothing stays when it is switched off', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/doc.svg`);
  await page.waitForFunction(() => document.querySelector('style[data-dk="svg"]') !== null, undefined, { timeout: 15000 });
  await page.waitForTimeout(300);
  // Far from the drawing: the canvas.
  const [canvas] = await pixelsOf(page, helper, [[700, 500]]);
  assert.ok(Math.max(...canvas) < 80, `canvas ${canvas}`);
  // The drawing is not black on that canvas: the text pixels include light ones.
  const shot = await pixelsOf(page, helper, Array.from({ length: 40 }, (_, i) => [10 + i, 35 + (i % 10)]));
  assert.ok(shot.some((p) => Math.max(...p) > 150), 'the drawing is still readable');
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => document.querySelector('style[data-dk]') === null, undefined, { timeout: 10000 });
  const [plain] = await pixelsOf(page, helper, [[700, 500]]);
  assert.ok(Math.min(...plain) > 200, `canvas ${plain}`);
  // The light mode leaves a light file alone.
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'light' } } });
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk]').length), 0);
  await page.close();
});
