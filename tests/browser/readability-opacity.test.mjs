// The readability net counts the opacity of the element and of what holds it, and the alpha of the text color.
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

const url = () => `${servers.origin}/readability-opacity.html`;

async function open(theme = {}) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.goto(url());
  await waitState(page, 'ready', 30000);
  return page;
}

const netStats = () =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => JSON.stringify(globalThis.__dk.readability?.stats() ?? null),
    });
    return JSON.parse(r.result);
  }, url());

/** The contrast a person gets for the text of an element: color with its alpha, opacity of the element and of its parents. */
const effective = (page, id) =>
  page.evaluate((i) => {
    const el = document.getElementById(i);
    const parse = (s) => {
      const p = /rgba?\(([^)]+)\)/.exec(s)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    };
    let opacity = 1;
    let bg = null;
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const c = parse(cs.backgroundColor);
      if (bg === null && c.a >= 0.98) {
        bg = c;
        break;
      }
      opacity *= Number(cs.opacity);
    }
    bg ??= { r: 255, g: 255, b: 255, a: 1 };
    const t = parse(getComputedStyle(el).color);
    const a = t.a * opacity;
    const fg = { r: bg.r + (t.r - bg.r) * a, g: bg.g + (t.g - bg.g) * a, b: bg.b + (t.b - bg.b) * a };
    const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const [x, y] = [lum(fg), lum(bg)];
    return { ratio: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05), opacity: Number(getComputedStyle(el).opacity) };
  }, id);

const marked = (page, id) => page.evaluate((i) => document.getElementById(i).hasAttribute('data-dk-r'), id);

test('text that is faint through opacity, through a color with alpha, or through both, is brought to the floor', { timeout: 120000 }, async () => {
  const page = await open();
  await page.waitForFunction(() => document.getElementById('faintOp').hasAttribute('data-dk-r'), null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('faintAlpha').hasAttribute('data-dk-r') && document.getElementById('faintBoth').hasAttribute('data-dk-r'), null, { timeout: 20000 });
  for (const id of ['faintOp', 'faintAlpha', 'faintBoth']) {
    const e = await effective(page, id);
    assert.ok(e.ratio >= 3, `${id}: ${e.ratio.toFixed(2)}`);
  }
  // The opacity was the cause for the first, so the opacity was raised; the color was the cause for the second.
  const op = await effective(page, 'faintOp');
  assert.ok(op.opacity > 0.12 && op.opacity <= 1, `opacity ${op.opacity}`);
  const s = await netStats();
  assert.ok(s.faint >= 1, JSON.stringify(s));
  await page.close();
});

test('readable text, a fading animation and text hidden from assistive tools are not touched', { timeout: 120000 }, async () => {
  const page = await open();
  await page.waitForFunction(() => document.getElementById('faintOp').hasAttribute('data-dk-r'), null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  for (const id of ['fine', 'anim', 'hidden']) assert.equal(await marked(page, id), false, id);
  assert.ok((await netStats()).animated >= 1);
  // The animation still runs with its own opacity.
  const anim = await page.evaluate(() => Number(getComputedStyle(document.getElementById('anim')).opacity));
  assert.ok(anim >= 0.09 && anim <= 0.21, `animated opacity ${anim}`);
  await page.close();
});

test('faint text through the opacity of a parent does not get worse, and the page does not move', { timeout: 120000 }, async () => {
  const page = await open();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.waitForFunction(() => document.getElementById('faintOp').hasAttribute('data-dk-r'), null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  const child = await effective(page, 'child');
  assert.ok(child.ratio >= 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), height);
  await page.close();
});

test('the E-ink mode uses its own floor for faint text', { timeout: 120000 }, async () => {
  const page = await open({ mode: 'eink', einkPreset: 'eink' });
  await page.waitForFunction(() => document.getElementById('faintOp').hasAttribute('data-dk-r'), null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('faintAlpha').hasAttribute('data-dk-r'), null, { timeout: 20000 });
  // The mode runs transitions for 0.01 ms, so the old color shows for a frame.
  await page.waitForTimeout(400);
  for (const id of ['faintOp', 'faintAlpha']) {
    const e = await effective(page, id);
    assert.ok(e.ratio >= 6.5, `${id}: ${e.ratio.toFixed(2)}`);
  }
  await page.close();
});
