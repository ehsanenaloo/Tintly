// A dark wallpaper of light line art painted in other ways: sized, covering, fixed, repeated in one direction,
// under a clear fade layer, on a pseudo-element, as a vector without a size, as a canvas drawn late.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, imageStore, pixelsOf } from './harness.mjs';
import { lineArtTile, png } from '../helpers/tiles.mjs';

let servers;
let browser;
let helper;

before(async () => {
  imageStore.set('wall-dark', png(lineArtTile(64, [11, 20, 26, 255], [233, 237, 239, 255])));
  imageStore.set('wall-big', png(lineArtTile(256, [11, 20, 26, 255], [233, 237, 239, 255])));
  imageStore.set('wall-lines', png(lineArtTile(64, [0, 0, 0, 0], [233, 237, 239, 255])));
  servers = await startServers();
  browser = await launch();
  helper = await browser.context.newPage();
  await helper.goto('about:blank');
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const MODES = {
  dark: { mode: 'dark' },
  light: { mode: 'light' },
  paper: { mode: 'eink', einkPreset: 'paper' },
  eink: { mode: 'eink', einkPreset: 'eink' },
};
const IDS = ['v-size', 'v-cover', 'v-contain', 'v-full', 'v-repeatx', 'v-round', 'v-fixed', 'v-fade', 'v-before', 'v-lines', 'v-svgsize', 'v-svgfree', 'v-opacity', 'v-canvas', 'v-late', 'v-patt'];
// Where the line art is drawn inside the box; a picture that is not repeated is only under part of it.
const NOT_REPEATED = new Set(['v-cover', 'v-contain', 'v-full', 'v-repeatx', 'v-opacity', 'v-lines']);

async function open(theme) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.setViewportSize({ width: 800, height: 1800 });
  await page.goto(`${servers.origin}/wallpaper-variants.html`);
  await waitState(page, 'ready');
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="base"]') || !!document.querySelector('style[data-dk="filter"]'), null, { timeout: 15000 });
  await page.waitForTimeout(6000);
  return page;
}

/** Mean and darkest value of the painted channel average over a grid inside an element, left of its bubble. */
async function painted(page, id) {
  const pts = await page.evaluate((i) => {
    const r = document.getElementById(i).getBoundingClientRect();
    const out = [];
    for (let a = 0; a < 40; a++) for (let b = 0; b < 12; b++) out.push([Math.round(r.x + 200 + a * 9 + 3), Math.round(r.y + 6 + b * 6 + 3)]);
    return out;
  }, id);
  const cols = (await pixelsOf(page, helper, pts)).map((c) => (c[0] + c[1] + c[2]) / 3);
  return { mean: cols.reduce((s, v) => s + v, 0) / cols.length, min: Math.min(...cols) };
}

for (const [name, theme] of Object.entries(MODES)) {
  test(`${name}: dark wallpapers painted in other ways`, { timeout: 120000 }, async () => {
    const page = await open(theme);
    try {
      const bad = [];
      const seen = {};
      for (const id of IDS) {
        const got = await painted(page, id);
        seen[id] = `${got.mean.toFixed(0)}/${got.min}`;
        if (name === 'dark') {
          if (got.mean > 90) bad.push(`${id} ${got.mean}`);
        } else if (!(got.mean > 150) || (!NOT_REPEATED.has(id) && !(got.min < 140))) bad.push(`${id} mean ${got.mean.toFixed(0)} darkest ${got.min}`);
      }
      console.log(name, JSON.stringify(seen));
      assert.deepEqual(bad, []);
    } finally {
      await page.close();
    }
  });
}
