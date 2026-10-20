// A picture that reaches the element through a custom property (a vector pattern under two fade layers) and deep chromatic
// sections, in an inline sheet and in a sheet from another origin.
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

const MODES = {
  dark: { mode: 'dark' },
  light: { mode: 'light' },
  paper: { mode: 'eink', einkPreset: 'paper' },
  eink: { mode: 'eink', einkPreset: 'eink' },
};

async function open(theme) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.setViewportSize({ width: 800, height: 1400 });
  await page.goto(`${servers.origin}/hero-var.html#${servers.other}`);
  await waitState(page, 'ready');
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="base"]') || !!document.querySelector('style[data-dk="filter"]'), null, { timeout: 15000 });
  await page.waitForTimeout(3500);
  return page;
}

async function painted(page, id) {
  const pts = await page.evaluate((i) => {
    const r = document.getElementById(i).getBoundingClientRect();
    const out = [];
    for (let a = 0; a < 12; a++) for (let b = 0; b < 8; b++) out.push([Math.round(r.x + 420 + a * 17 + 3), Math.round(r.y + 20 + b * 12 + 3)]);
    return out;
  }, id);
  const cols = (await pixelsOf(page, helper, pts)).map((c) => (c[0] + c[1] + c[2]) / 3);
  return cols.reduce((s, v) => s + v, 0) / cols.length;
}

const channelMean = (c) => (c[0] + c[1] + c[2]) / 3;

for (const [name, theme] of Object.entries(MODES)) {
  test(`${name}: a pattern from a custom property and deep sections follow the look`, { timeout: 90000 }, async () => {
    const page = await open(theme);
    try {
      const ground = channelMean(await page.evaluate(() => getComputedStyle(document.body).backgroundColor.match(/\d+/g).slice(0, 3).map(Number)));
      for (const kind of ['i', 'x']) {
        const hero = await painted(page, `hero-${kind}`);
        const band = await painted(page, `cta-${kind}`);
        const foot = await painted(page, `foot-${kind}`);
        if (name === 'dark') {
          assert.ok(hero < 70 && band < 90 && foot < 90, `${kind} ${hero} ${band} ${foot}`);
        } else if (name === 'light') {
          assert.ok(hero > 200 && band > 150 && foot > 150, `${kind} ${hero} ${band} ${foot}`);
        } else {
          // The paper tone, a little deeper at most for a section.
          assert.ok(Math.abs(hero - ground) <= 8, `${kind} hero ${hero} against ${ground}`);
          assert.ok(Math.abs(band - ground) <= 24, `${kind} band ${band} against ${ground}`);
          assert.ok(Math.abs(foot - ground) <= 24, `${kind} footer ${foot} against ${ground}`);
        }
      }
    } finally {
      await page.close();
    }
  });
}
