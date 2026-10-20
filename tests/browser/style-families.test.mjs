// Text and icons written with the less common ways of setting a color stay visible on their own surface in every mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

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

// Cases with a known gap (: an icon turned over with a filter, in the E-ink and Paper mode).
const KNOWN_OPEN = {
  dark: [],
  light: [],
  paper: ['invert-icon'],
  eink: ['invert-icon'],
};
const FLOOR = 3;

/** The contrast between the surface at the corner of each case and the most different pixel in its box. */
async function contrasts(page) {
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.case')].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }));
  const png = (await page.screenshot({ type: 'png', fullPage: true })).toString('base64');
  return helper.evaluate(async ({ data, boxes }) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const lum = (p) => {
      const f = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
    };
    return boxes.map((b) => {
      const corner = ctx.getImageData(b.x + 1, b.y + 1, 1, 1).data;
      const surface = lum(corner);
      const px = ctx.getImageData(b.x, b.y, b.w, b.h).data;
      let best = 1;
      for (let i = 0; i < px.length; i += 4) {
        const l = lum([px[i], px[i + 1], px[i + 2]]);
        const c = (Math.max(l, surface) + 0.05) / (Math.min(l, surface) + 0.05);
        if (c > best) best = c;
      }
      return { id: b.id, contrast: best };
    });
  }, { data: png, boxes });
}

for (const mode of Object.keys(MODES)) {
  test(`${mode}: every case keeps its ink visible on its surface`, { timeout: 120000 * SLOW }, async () => {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, theme: { ...MODES[mode] } } });
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/style-families.html`);
    await waitState(page, 'ready', 30000 * SLOW);
    await page.waitForSelector('#late', { timeout: 5000 * SLOW });
    let weak = [];
    const until = Date.now() + 15000 * SLOW;
    for (;;) {
      await page.waitForTimeout(300);
      weak = (await contrasts(page)).filter((c) => c.contrast < FLOOR && !KNOWN_OPEN[mode].includes(c.id)).map((c) => `${c.id} ${c.contrast.toFixed(2)}`);
      if (weak.length === 0 || Date.now() > until) break;
    }
    if (process.env.DK_REPORT) console.log(mode, JSON.stringify(weak));
    assert.deepEqual(weak, []);
    await page.close();
  });
}
