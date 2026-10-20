// Black marks (icons, logos, drawings) on a light page must stay visible when the page is made dark.
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

const IDS = ['inline', 'current', 'sprite', 'same', 'data', 'picture', 'mask-split', 'bg-svg', 'pseudo', 'list', 'canvas'];

const luma = ([r, g, b]) => {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The contrast between the page and the most different pixel in the box of each element. */
async function contrasts(page) {
  const boxes = await page.evaluate((ids) => ids.map((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }), IDS);
  const png = (await page.screenshot({ type: 'png' })).toString('base64');
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
      const around = ctx.getImageData(Math.max(0, b.x - 3), b.y + 4, 1, 1).data;
      const page = lum(around);
      const px = ctx.getImageData(b.x, b.y, b.w, b.h).data;
      let best = 1;
      for (let i = 0; i < px.length; i += 4) {
        const l = lum([px[i], px[i + 1], px[i + 2]]);
        const c = (Math.max(l, page) + 0.05) / (Math.min(l, page) + 0.05);
        if (c > best) best = c;
      }
      return { id: b.id, contrast: best };
    });
  }, { data: png, boxes });
}

test('a black mark is visible on a dark page, in every form that a page uses', { timeout: 90000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/black-marks.html`);
  await waitState(page, 'ready', 30000 * SLOW);
  // Pictures are sorted when they have loaded; wait until every image has been judged.
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 15000 * SLOW });
  // Backgrounds and pseudo-elements are sorted by a sweep that waits for the load: look until every mark is visible or the time is up.
  let weak = [];
  const until = Date.now() + 20000 * SLOW;
  for (;;) {
    weak = (await contrasts(page)).filter((c) => c.contrast < 3).map((c) => `${c.id} ${c.contrast.toFixed(2)}`);
    if (weak.length === 0 || Date.now() > until) break;
    await page.waitForTimeout(250);
  }
  assert.deepEqual(weak, []);
  // A canvas with colored content is not touched.
  assert.equal(await page.evaluate(() => document.getElementById('canvas-color').getAttribute('data-dk-img')), null);
  await page.close();
});
