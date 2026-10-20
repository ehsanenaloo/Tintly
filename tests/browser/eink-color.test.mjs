// The amount of color of the E-ink and Paper mode and the filter on the root: emoji, pictures, a canvas and a vector image
// follow the amount; a fixed bar still sticks and nothing moves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

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

const EINK = { mode: 'eink', einkPreset: 'eink' };
const PAPER = { mode: 'eink', einkPreset: 'paper' };

async function open(theme, path = '/eink-emoji.html') {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready', 30000);
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="calm"]'), null, { timeout: 10000 });
  await page.waitForTimeout(400);
  return page;
}

/** The largest difference between two color channels among the pixels of an element, read from a screenshot. */
async function spread(page, selector) {
  const box = await page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }, selector);
  const png = await page.screenshot({ type: 'png', clip: box });
  return helper.evaluate(async (data) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let max = 0;
    for (let i = 0; i < px.length; i += 4) max = Math.max(max, Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]));
    return max;
  }, png.toString('base64'));
}

const BOXES = ['#emoji', '#svgimg', '#cv', '#svginline'];
const spreads = async (page) => Object.fromEntries(await Promise.all(BOXES.map(async (b) => [b, await spread(page, b)])));

test('E-ink, color 0 on everything: emoji, a vector image, a canvas and an inline graphic have no color left', { timeout: 90000 }, async () => {
  const page = await open(EINK);
  const s = await spreads(page);
  for (const [box, value] of Object.entries(s)) assert.ok(value <= 6, `${box} spreads ${value}`);
  // The root carries the filter; it is the one rule of the mode that does this.
  assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).filter), /grayscale\(1\)/);
  await page.close();
});

test('with the switch off the emoji and the canvas keep their colors', { timeout: 90000 }, async () => {
  const page = await open({ ...EINK, einkGrayAll: false, einkImages: 'off' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).filter), 'none');
  const s = await spreads(page);
  assert.ok(s['#emoji'] > 60, `emoji ${s['#emoji']}`);
  assert.ok(s['#cv'] > 150, `canvas ${s['#cv']}`);
  await page.close();
  // With the switch on and the pictures left as they are, the root filter alone makes both gray.
  const gray = await open({ ...EINK, einkImages: 'off' });
  const g = await spreads(gray);
  assert.ok(g['#emoji'] <= 6 && g['#cv'] <= 6, JSON.stringify(g));
  await gray.close();
});

test('the amount of color is followed by emoji and canvas: more color, more spread', { timeout: 120000 }, async () => {
  const seen = [];
  for (const amount of [0, 35, 100]) {
    const page = await open({ ...EINK, einkColorAmount: amount, einkImages: 'follow' });
    const s = await spreads(page);
    seen.push([amount, s['#emoji'], s['#cv']]);
    await page.close();
  }
  const [zero, some, full] = seen;
  assert.ok(zero[1] <= 6 && zero[2] <= 6, JSON.stringify(seen));
  assert.ok(some[1] > zero[1] + 10 && some[2] > zero[2] + 30, JSON.stringify(seen));
  assert.ok(full[1] > some[1] && full[2] > some[2], JSON.stringify(seen));
  assert.ok(full[2] > 150, 'at 100 the canvas is red and green again');
});

test('Paper keeps a little color by default: the palette gives soft accents and the paper tone stays', { timeout: 90000 }, async () => {
  const page = await open(PAPER);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).filter), 'none');
  const box = await page.evaluate(() => getComputedStyle(document.getElementById('tint')).backgroundColor);
  const [r, g, b] = /rgba?\(([^)]+)\)/.exec(box)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) >= 6, `the red box is ${box}`);
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 120, `the red box is ${box}`);
  const canvas = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  assert.ok(canvas !== 'rgb(255, 255, 255)', canvas);
  await page.close();
});

test('with the filter on, Paper keeps the saturation step on the root and the full color in the palette', { timeout: 90000 }, async () => {
  const page = await open({ ...PAPER, einkGrayAll: true });
  assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).filter), /saturate\(0\.35\)/);
  await page.close();
});

test('a fixed bar and a sticky bar still stick, and the page does not move or grow', { timeout: 120000 }, async () => {
  const plain = await open({ ...EINK, einkGrayAll: false });
  const before = await plain.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth }));
  await plain.close();
  const page = await open(EINK);
  const after = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth }));
  assert.deepEqual(after, before);
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(200);
  const rects = await page.evaluate(() => ({ bar: document.getElementById('bar').getBoundingClientRect().top, sticky: document.getElementById('sticky').getBoundingClientRect().top, y: window.scrollY }));
  assert.equal(rects.y, 600);
  assert.equal(rects.bar, 0, 'the fixed header stays at the top of the window');
  assert.equal(rects.sticky, 40, 'the sticky bar sticks below it');
  await page.close();
});

/** The mean colorfulness (0 to 1) of the pixels of an element: how far the channels are apart, relative to the brightest. */
async function colorfulness(page, selector) {
  const box = await page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }, selector);
  const png = await page.screenshot({ type: 'png', clip: box });
  return helper.evaluate(async (data) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      sum += mx === 0 ? 0 : (mx - Math.min(d[i], d[i + 1], d[i + 2])) / mx;
    }
    return sum / (d.length / 4);
  }, png.toString('base64'));
}

test('a hero with a CSS background photo loses its color in Paper and E-ink, and keeps it with the extension off', { timeout: 120000 }, async () => {
  const measure = async (settings) => {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, ...settings } });
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/hero-button.html`);
    if (settings.enabled !== false) await waitState(page, 'ready', 30000);
    await page.waitForTimeout(3500);
    const value = await colorfulness(page, '#hero');
    await page.close();
    return value;
  };
  const off = await measure({ enabled: false });
  const paper = await measure({ theme: PAPER });
  const paperAll = await measure({ theme: { ...PAPER, einkGrayAll: true } });
  const eink = await measure({ theme: EINK });
  assert.ok(off > 0.2, `the photo has color: ${off}`);
  assert.ok(paper < off * 0.7, `Paper ${paper} against ${off}`);
  assert.ok(paperAll < off * 0.7, `Paper with the filter ${paperAll} against ${off}`);
  assert.ok(eink < 0.05, `E-ink ${eink}`);
});
