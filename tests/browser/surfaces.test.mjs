// Flat pictures that act as a surface: a faint light tile over white and a dark wallpaper of light line art,
// in Dark, Light, Paper and E-ink. The page is a tiled picture, a vector tile, an inline pattern and a canvas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServers, launch, waitState, imageStore, pixelsOf } from './harness.mjs';
import { hexTile, lineArtTile, png } from '../helpers/tiles.mjs';
import { REPO } from '../helpers/tree.mjs';

let servers;
let browser;
let helper;

before(async () => {
  imageStore.set('hex-white', png(hexTile(60, [255, 255, 255, 255], [232, 232, 240, 255])));
  imageStore.set('hex-clear', png(hexTile(60, [0, 0, 0, 0], [200, 200, 215, 255])));
  imageStore.set('flat-lav', png(hexTile(48, [218, 222, 242, 255], [210, 214, 236, 255])));
  imageStore.set('flat-mauve', png(hexTile(48, [214, 172, 192, 255], [206, 164, 184, 255])));
  imageStore.set('wall-dark', png(lineArtTile(64, [11, 20, 26, 255], [233, 237, 239, 255])));
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

// The Light look sorts pictures only when the gate starts the module for it.
const bootSource = readFileSync(join(process.env.DK_EXTENSION ?? join(REPO, 'extension'), 'content/core/boot.js'), 'utf8');
const lightSorts = /imageKey[^\n]*'light'/.test(bootSource) || /light:\$\{JSON/.test(bootSource);

async function open(path, theme) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.setViewportSize({ width: 800, height: 1800 });
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready');
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="base"]') || !!document.querySelector('style[data-dk="filter"]'), null, { timeout: 15000 });
  await page.waitForTimeout(3000);
  return page;
}

/** Mean and extremes of the painted channel average over a grid inside an element, away from its text. */
async function painted(page, id) {
  const pts = await page.evaluate((i) => {
    const r = document.getElementById(i).getBoundingClientRect();
    const out = [];
    for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) out.push([Math.round(r.x + 420 + a * 17 + 3), Math.round(r.y + 8 + b * 7 + 3)]);
    return out;
  }, id);
  const cols = (await pixelsOf(page, helper, pts)).map((c) => (c[0] + c[1] + c[2]) / 3);
  return { mean: cols.reduce((s, v) => s + v, 0) / cols.length, min: Math.min(...cols), max: Math.max(...cols) };
}

const bodyColor = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor.match(/\d+/g).slice(0, 3).map(Number));
const channelMean = (c) => (c[0] + c[1] + c[2]) / 3;

for (const [name, theme] of Object.entries(MODES)) {
  test(`${name}: a light tile or a flat light picture over white is the themed surface`, { timeout: 90000 }, async () => {
    const page = await open('/paper-surfaces.html', theme);
    try {
      const ground = channelMean(await bodyColor(page));
      const ids = ['hex-short', 'hex-long', 'hex-bare', 'hex-svg', 'hex-clear', 'pic-lav', 'pic-mauve', 'band', 'band-var', 'band-long', 'footer'];
      const seen = {};
      for (const id of ids) seen[id] = await painted(page, id);
      for (const id of ids) {
        const got = seen[id].mean;
        // A tile line can touch a sample, so the check is on the mean and a margin.
        // A picture of one tone is a surface in every look, stretched or not.
        if (name === 'dark') assert.ok(got < 70, `${id} ${got}`);
        else if (name === 'light') assert.ok(got > 180, `${id} ${got}`);
        else if (id.startsWith('hex') || id.startsWith('pic')) assert.ok(Math.abs(got - ground) <= 14, `${id} ${got} against ${ground}`);
        else assert.ok(Math.abs(got - ground) <= 24, `${id} ${got} against ${ground}`);
      }
    } finally {
      await page.close();
    }
  });
}

for (const [name, theme] of Object.entries(MODES)) {
  const skip = name === 'light' && !lightSorts ? 'the Light look does not start the pictures module (core/boot.js)' : false;
  test(`${name}: a dark wallpaper of light line art ${name === 'dark' ? 'stays dark' : 'becomes the themed ground with dark lines'}`, { timeout: 90000, skip }, async () => {
    const page = await open('/wallpaper.html', theme);
    try {
      for (const id of ['w-color', 'w-bare', 'w-svg', 'w-alone', 'w-canvas', 'w-pattern']) {
        const got = await painted(page, id);
        if (name === 'dark') {
          assert.ok(got.mean < 90, `${id} ${got.mean}`);
          continue;
        }
        assert.ok(got.mean > 150, `${id} mean ${got.mean}`);
        // The lines are kept, as dark marks.
        assert.ok(got.min < 130, `${id} lines ${got.min}`);
      }
    } finally {
      await page.close();
    }
  });
}

for (const name of ['paper', 'eink']) {
  test(`${name}: light chromatic sections drawn as colors, gradients or variables are the paper tone`, { timeout: 90000 }, async () => {
    const page = await open('/paper-bands.html', MODES[name]);
    try {
      const ground = channelMean(await bodyColor(page));
      for (const id of 'abcdefghijklmn') {
        const got = (await painted(page, id)).mean;
        assert.ok(Math.abs(got - ground) <= 24, `${id} ${got} against ${ground}`);
      }
    } finally {
      await page.close();
    }
  });
}
