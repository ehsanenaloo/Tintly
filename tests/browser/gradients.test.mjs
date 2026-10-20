// Gradients in the E-ink and Paper mode: glows and fades are dropped, an opaque gradient is one solid color, a scrim over a
// picture stays, gradient text becomes ink. In the dark mode gradient text is themed like text. Both read paths agree.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

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

const PAPER = { mode: 'eink', einkPreset: 'paper' };
const EINK = { mode: 'eink', einkPreset: 'eink' };

const rgbs = (css) => [...css.matchAll(/rgba?\(([^)]+)\)/g)].map((m) => m[1].split(/[,\s/]+/).filter(Boolean).map(Number));
const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

async function open(theme, path = '/gradients.html') {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready', 30000);
  return page;
}
const style = (page, selector, property) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [selector, property]);
const shadowStyle = (page, id, property) => page.evaluate(([i, p]) => getComputedStyle(window.__root.getElementById(i))[p], [id, property]);

/** Everything the tests look at, as one object, so two read paths can be compared. */
async function snapshot(page) {
  return page.evaluate(() => {
    const g = (s, p) => getComputedStyle(document.querySelector(s))[p];
    const sg = (i, p) => getComputedStyle(window.__root.getElementById(i))[p];
    return {
      body: g('body', 'backgroundImage'),
      banner: g('#banner', 'backgroundImage'),
      fade: g('#fade', 'backgroundImage'),
      bar: g('#bar', 'backgroundImage'),
      hero: g('#hero', 'backgroundImage'),
      titleImage: g('#title', 'backgroundImage'),
      titleFill: g('#title', 'webkitTextFillColor'),
      inline: g('#inline', 'backgroundImage'),
      sglow: sg('sglow', 'backgroundImage'),
      ssolid: sg('ssolid', 'backgroundImage'),
    };
  });
}

for (const [name, theme] of [['Paper', PAPER], ['E-ink', EINK]]) {
  test(`${name}: a glow or a fade is dropped, an opaque gradient is one color, a veil over a picture stays`, { timeout: 90000 }, async () => {
    const page = await open(theme);
    const s = await snapshot(page);
    assert.match(s.body, /^none(, none)*$/, 'the soft glow behind the page');
    assert.equal(s.fade, 'none');
    assert.equal(s.inline, 'none', 'an inline style');
    assert.equal(s.sglow, 'none', 'a shadow root');
    for (const solid of [s.banner, s.ssolid]) {
      const stops = rgbs(solid);
      assert.equal(stops.length, 2, solid);
      assert.deepEqual(stops[0], stops[1], solid);
    }
    // The solid colors are paper tones, not the blue and the red.
    const [r, g, b] = rgbs(s.banner)[0];
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 60, s.banner);
    // A hard stop is a bar; it keeps its two parts. A veil over a picture keeps the gradient and the picture.
    assert.match(s.bar, /60%/);
    assert.match(s.hero, /gradient\(/);
    assert.match(s.hero, /url\(/);
    await page.close();
  });

  test(`${name}: gradient text is solid ink and reads`, { timeout: 90000 }, async () => {
    const page = await open(theme);
    const s = await snapshot(page);
    assert.equal(s.titleImage, 'none');
    const fill = rgbs(s.titleFill)[0];
    const bg = rgbs(await style(page, 'body', 'backgroundColor'))[0];
    assert.ok(ratio(fill, bg) >= (name === 'E-ink' ? 7 : 4.5), `${s.titleFill} on ${bg}`);
    await page.close();
  });
}

test('both read paths give the same result for every gradient', { timeout: 120000 }, async () => {
  const page = await open(PAPER);
  const text = await snapshot(page);
  const url = `${servers.origin}/gradients.html`;
  await browser.restartEngine(url, { early: false, hold: false, textPath: false }, PAPER);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready' && ![...document.querySelectorAll('style[data-dk]')].some((s) => s.media === 'not all'));
  await page.waitForTimeout(300);
  const cssom = await snapshot(page);
  assert.deepEqual(cssom, text);
  await page.close();
});

test('in the dark mode a gradient keeps its glow, and gradient text is themed like text so a pale one stays readable', { timeout: 90000 }, async () => {
  const page = await open({ mode: 'dark' });
  const s = await snapshot(page);
  // The glow is still a gradient (the page keeps its look), and not dropped.
  assert.match(s.body, /radial-gradient/);
  assert.match(s.inline, /radial-gradient/);
  // Pale letters on a mid gray box: the stops of the letters are lightened or darkened by the foreground rule and keep the floor.
  const stops = rgbs(await style(page, '#pale', 'backgroundImage'));
  const parent = rgbs(await page.evaluate(() => getComputedStyle(document.getElementById('pale').parentElement).backgroundColor))[0];
  assert.ok(stops.length >= 2);
  for (const c of stops) assert.ok(ratio(c, parent) >= 4.4, `stop ${c} on ${parent}`);
  // The letters are still painted by the gradient (the fill stays transparent).
  assert.match(await style(page, '#pale', 'webkitTextFillColor'), /rgba\(0, 0, 0, 0\)|transparent/);
  await page.close();
});

test('no light frame: the dropped glow does not show the page for a moment', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: PAPER } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/gradients.html`);
  await waitState(page, 'ready', 30000);
  // After the engine is ready the glow is gone and stays gone when the page changes its own style later.
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '#late{background:radial-gradient(circle,rgba(255,0,0,.5),rgba(255,255,255,0))}';
    document.head.append(s);
    const d = document.createElement('div');
    d.id = 'late';
    d.textContent = 'late glow';
    document.body.append(d);
  });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('late')).backgroundImage === 'none', null, { timeout: 10000 });
  await page.close();
});
