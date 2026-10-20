// Light line art drawn as a transparent picture over a dark color (a layer on a child or a pseudo-element, or on the box
// itself) is not lost when the color becomes the paper tone. A layer over a photo is left alone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, imageStore, pixelsOf } from './harness.mjs';
import { lineArtTile, png } from '../helpers/tiles.mjs';

let servers;
let browser;
let helper;

before(async () => {
  imageStore.set('wall-lines', png(lineArtTile(64, [0, 0, 0, 0], [233, 237, 239, 255])));
  const photo = { w: 32, h: 32, px: Uint8ClampedArray.from({ length: 32 * 32 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 37 + ((i >> 2) % 32) * 11) % 200 + 20)) };
  imageStore.set('wall-photo', png(photo));
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
const LINES = ['l-after', 'l-child', 'l-own', 'l-set'];

async function open(theme) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto(`${servers.origin}/wallpaper-lines.html`);
  await waitState(page, 'ready');
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="base"]') || !!document.querySelector('style[data-dk="filter"]'), null, { timeout: 15000 });
  await page.waitForTimeout(3500);
  return page;
}

/** Mean and darkest value of the painted channel average over a grid inside an element, right of its bubble. */
async function painted(page, id) {
  const pts = await page.evaluate((i) => {
    const r = document.getElementById(i).getBoundingClientRect();
    const out = [];
    for (let a = 0; a < 40; a++) for (let b = 0; b < 12; b++) out.push([Math.round(r.x + 250 + a * 8 + 3), Math.round(r.y + 6 + b * 6 + 3)]);
    return out;
  }, id);
  const cols = (await pixelsOf(page, helper, pts)).map((c) => (c[0] + c[1] + c[2]) / 3);
  return { mean: cols.reduce((s, v) => s + v, 0) / cols.length, min: Math.min(...cols), max: Math.max(...cols) };
}

for (const [name, theme] of Object.entries(MODES)) {
  test(`${name}: light lines on a transparent picture ${name === 'dark' ? 'stay light on the dark color' : 'are dark lines on the paper tone'}`, { timeout: 90000 }, async () => {
    const page = await open(theme);
    try {
      const bad = [];
      const seen = {};
      for (const id of LINES) {
        const got = await painted(page, id);
        seen[id] = `${got.mean.toFixed(0)}/${got.min}/${got.max}`;
        if (name === 'dark') {
          if (got.mean > 90 || got.max < 100) bad.push(`${id} ${JSON.stringify(got)}`);
        } else if (!(got.mean > 150) || !(got.min < got.max - 30 && got.min < 215)) bad.push(`${id} mean ${got.mean.toFixed(0)} darkest ${got.min} lightest ${got.max}`);
      }
      console.log(name, JSON.stringify(seen));
      assert.deepEqual(bad, []);
      // A layer over a photo is not blended: the lines stay light there.
      if (name !== 'dark') assert.ok(!['overlay', 'lines'].includes(await page.evaluate(() => document.querySelector('#l-photo > i').getAttribute('data-dk-bg'))));
    } finally {
      await page.close();
    }
  });
}
