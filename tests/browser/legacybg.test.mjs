// The legacy `background` attribute (a tiled picture on the body or a table) must not hide the themed color.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, imageStore, pixelsOf } from './harness.mjs';
import { encodePng, rng } from '../helpers/png.mjs';

let servers;
let browser;
let helper;

before(async () => {
  const flat = (w, h, base, dot) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const c = i % 17 === 0 ? dot : base;
      px.set([c[0], c[1], c[2], 255], i * 4);
    }
    return encodePng(w, h, px);
  };
  imageStore.set('legacy-light', flat(16, 16, [244, 240, 228], [236, 231, 217]));
  imageStore.set('legacy-dark', flat(16, 16, [32, 40, 48], [40, 50, 60]));
  const rand = rng(7);
  const photo = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) photo.set([Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256), 255], i * 4);
  imageStore.set('legacy-photo', encodePng(32, 32, photo));
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
  for (const page of browser.context.pages()) if (page !== helper) await page.close().catch(() => {});
});

const ON = { settings: { enabled: true } };
const PAPER = { settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'paper' } } };

async function open(settings = ON) {
  await browser.clearStorage();
  await browser.setStorage(settings);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/legacy-bg.html`);
  await waitState(page, 'ready', 30000);
  return page;
}

const image = (page, selector) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundImage, selector);
const mark = (page, selector) => page.evaluate((s) => document.querySelector(s).getAttribute('data-dk-bg'), selector);
const inRoot = (page, prop) => page.evaluate((p) => { const t = window.__root.getElementById('t-shadow'); return p === 'mark' ? t.getAttribute('data-dk-bg') : getComputedStyle(t).backgroundImage; }, prop);
const waitMark = (page, selector, value = 'tile') =>
  page.waitForFunction(([s, v]) => document.querySelector(s)?.getAttribute('data-dk-bg') === v, [selector, value], { timeout: 15000 });

test('a light tile on the body and on a table is switched off on a dark page; a dark tile and a photo stay', { timeout: 60000 }, async () => {
  const page = await open();
  await waitMark(page, 'body');
  await waitMark(page, '#t-light');
  assert.equal(await image(page, 'body'), 'none');
  assert.equal(await image(page, '#t-light'), 'none');
  // A dark tile is fine under the light text of a dark page; a photo is the page's own composition.
  assert.equal(await mark(page, '#t-dark'), null);
  assert.match(await image(page, '#t-dark'), /legacy-dark/);
  assert.equal(await mark(page, '#t-photo'), null);
  assert.match(await image(page, '#t-photo'), /legacy-photo/);
  await page.close();
});

test('the page behind the tile is dark in the picture, not white', { timeout: 60000 }, async () => {
  const page = await open();
  await waitMark(page, 'body');
  // The body has no text at the bottom right: the pixel there is the themed color.
  const [[r, g, b]] = await pixelsOf(page, helper, [[900, 560]]);
  assert.ok((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.3, `pixel ${r},${g},${b}`);
  await page.close();
});

test('a tile in a closed shadow root is switched off by a rule in that root', { timeout: 60000 }, async () => {
  const page = await open();
  await page.waitForFunction(() => window.__root.getElementById('t-shadow').getAttribute('data-dk-bg') === 'tile', undefined, { timeout: 15000 });
  assert.equal(await inRoot(page, 'image'), 'none');
  assert.equal(await page.evaluate(() => window.__root.querySelectorAll('style[data-dk=images]').length), 1);
  await page.close();
});

test('a table added later with the attribute is handled', { timeout: 60000 }, async () => {
  const page = await open();
  await waitMark(page, 'body');
  await page.evaluate(() => window.addLater());
  await waitMark(page, '#t-late');
  assert.equal(await image(page, '#t-late'), 'none');
  await page.close();
});

test('in the Paper mode every plain tile gives way to the paper', { timeout: 60000 }, async () => {
  const page = await open(PAPER);
  await waitMark(page, 'body');
  await waitMark(page, '#t-dark');
  assert.equal(await image(page, 'body'), 'none');
  assert.equal(await image(page, '#t-dark'), 'none');
  // A photo is not a plain tile.
  assert.equal(await mark(page, '#t-photo') === 'tile', false);
  await page.close();
});

test('ending the engine leaves no mark and no rule', { timeout: 60000 }, async () => {
  const page = await open();
  await waitMark(page, 'body');
  await page.waitForFunction(() => window.__root.getElementById('t-shadow').getAttribute('data-dk-bg') === 'tile', undefined, { timeout: 15000 });
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 10000 });
  const left = await page.evaluate(() => [document.querySelectorAll('[data-dk-bg], style[data-dk]').length, window.__root.querySelectorAll('[data-dk-bg], style[data-dk]').length]);
  assert.deepEqual(left, [0, 0]);
  assert.match(await image(page, 'body'), /legacy-light/);
  await page.close();
});
