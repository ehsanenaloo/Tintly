// Shadows keep an edge on a dark page: a white card on a white page shows a shadow in the dark mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, pixelsOf } from './harness.mjs';

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

async function open(settings) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, ...settings } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/shadow-card.html`);
  await waitState(page, 'ready', 30000);
  return page;
}

/** The colors just below each card's bottom edge and far from every card, from a screenshot. */
async function edges(page) {
  const boxes = await page.evaluate(() =>
    ['plain', 'glow', 'drop', 'var'].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [id, Math.round(r.left + r.width / 2), Math.round(r.bottom)];
    }),
  );
  const out = {};
  for (const [id, x, bottom] of boxes) {
    await page.evaluate((y) => window.scrollTo(0, y - 400), bottom);
    const top = await page.evaluate(() => window.scrollY);
    const [below, near, far] = await pixelsOf(page, helper, [[x, bottom - top + 6], [x, bottom - top + 14], [20, bottom - top + 14]]);
    out[id] = { below, near, far };
  }
  return out;
}

const sum = (c) => c[0] + c[1] + c[2];

test('in the dark mode a white card on a white page keeps a visible shadow edge', { timeout: 60000 }, async () => {
  const page = await open({});
  const e = await edges(page);
  for (const id of ['plain', 'drop', 'var']) {
    console.log(`# ${id}: below ${e[id].below} near ${e[id].near} page ${e[id].far}`);
    assert.ok(sum(e[id].far) - sum(e[id].below) >= 12, `${id}: the pixel under the card is not darker than the page (${e[id].below} against ${e[id].far})`);
  }
  // The glow keeps its hue: blue is stronger than red next to the card.
  assert.ok(e.glow.near[2] - e.glow.near[0] >= 12, `glow: ${e.glow.near}`);
  await page.close();
});

test('Paper leaves the shadow as the page wrote it and E-ink has none by default', { timeout: 90000 }, async () => {
  const paper = await open({ theme: { mode: 'eink', einkPreset: 'paper' } });
  const p = await edges(paper);
  assert.ok(sum(p.plain.far) - sum(p.plain.below) >= 12, `paper: ${p.plain.below} against ${p.plain.far}`);
  await paper.close();
  const ink = await open({ theme: { mode: 'eink', einkPreset: 'eink' } });
  await ink.waitForFunction(() => !!document.querySelector('style[data-dk="calm"]'), null, { timeout: 15000 });
  const k = await edges(ink);
  assert.ok(Math.abs(sum(k.plain.far) - sum(k.plain.below)) <= 6, `eink: ${k.plain.below} against ${k.plain.far}`);
  await ink.close();
});
