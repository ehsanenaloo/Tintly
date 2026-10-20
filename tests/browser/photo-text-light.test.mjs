// White text over a dark photo (image, CSS picture, pseudo-element picture) in the Light look: the pictures module starts for
// surfaces, and the text sweep of the backdrop module keeps the text readable.
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

const CASES = ['img', 'bg', 'pseudo'];

/** For each case: the mean lightness of the photo (0 dark, 1 light) and the contrast of the text against it. */
async function measure(page) {
  const boxes = await page.evaluate((cases) => cases.map((c) => {
    const b = document.getElementById(`b-${c}`).getBoundingClientRect();
    const t = document.getElementById(`t-${c}`).getBoundingClientRect();
    return { c, b: [b.x, b.y, b.width, b.height].map(Math.round), t: [t.x, t.y, t.width, t.height].map(Math.round) };
  }), CASES);
  const png = (await page.screenshot({ type: 'png' })).toString('base64');
  return helper.evaluate(async ({ data, boxes }) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const lin = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
    return boxes.map(({ c, b, t }) => {
      const top = ctx.getImageData(b[0] + 10, b[1] + 6, b[2] - 20, 30).data;
      let sum = 0;
      for (let i = 0; i < top.length; i += 4) sum += lum([top[i], top[i + 1], top[i + 2]]);
      const px = ctx.getImageData(t[0], t[1], Math.max(1, t[2]), Math.max(1, t[3])).data;
      const ls = [];
      for (let i = 0; i < px.length; i += 4) ls.push(lum([px[i], px[i + 1], px[i + 2]]));
      ls.sort((x, y) => x - y);
      const median = ls[ls.length >> 1];
      const ratio = (x, y) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      return { c, photo: sum / (top.length / 4), contrast: Math.max(ratio(ls[0], median), ratio(ls[ls.length - 1], median)) };
    });
  }, { data: png, boxes });
}

async function open() {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'light' } } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/photo-text-dark.html`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 15000 * SLOW });
  return page;
}

test('light: white text over a dark photo stays readable and the photo stays dark', { timeout: 120000 * SLOW }, async () => {
  const page = await open();
  let bad = [];
  const until = Date.now() + 20000 * SLOW;
  for (;;) {
    const got = await measure(page);
    bad = got.filter((g) => g.photo > 0.2 || g.contrast < 4.5).map((g) => `${g.c}: photo ${g.photo.toFixed(2)}, text contrast ${g.contrast.toFixed(1)}`);
    if (bad.length === 0 || Date.now() > until) break;
    await page.waitForTimeout(250);
  }
  assert.deepEqual(bad, []);
  await page.close();
});
