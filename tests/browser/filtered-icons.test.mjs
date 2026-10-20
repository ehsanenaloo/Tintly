// A picture that the page turns with a filter (a white icon made black) is judged by how it looks, not by its file.
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

const IDS = ['invert', 'bright', 'on-dark', 'shadow'];

/** The contrast between the surface left of each picture and its most different pixel. */
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
      const surface = lum(ctx.getImageData(b.x + 1, b.y + 1, 1, 1).data);
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

async function open(settings) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, ...settings } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/filtered-icons.html`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 15000 * SLOW });
  return page;
}

test('dark: a white icon that the page turns black stays visible, and a filter the module cannot read is left alone', { timeout: 90000 * SLOW }, async () => {
  const page = await open({});
  let weak = [];
  const until = Date.now() + 15000 * SLOW;
  for (;;) {
    weak = (await contrasts(page)).filter((c) => c.contrast < 3).map((c) => `${c.id} ${c.contrast.toFixed(2)}`);
    if (weak.length === 0 || Date.now() > until) break;
    await page.waitForTimeout(250);
  }
  assert.deepEqual(weak, []);
  // The icon that is already light on its dark panel is not touched; the filter of the page stays.
  assert.equal(await page.evaluate(() => document.getElementById('on-dark').getAttribute('data-dk-img')), null);
  assert.match(await page.evaluate(() => getComputedStyle(document.getElementById('on-dark')).filter), /invert\(1\)$/);
  await page.close();
});

test('light: nothing is marked and the page filters show', { timeout: 90000 * SLOW }, async () => {
  const page = await open({ theme: { mode: 'light' } });
  await page.waitForTimeout(1500 * SLOW);
  assert.deepEqual(await page.evaluate(() => [...document.images].map((i) => i.getAttribute('data-dk-img'))), [null, null, null, null]);
  assert.deepEqual((await contrasts(page)).filter((c) => c.contrast < 3 && c.id !== 'on-dark'), []);
  await page.close();
});

for (const [name, theme] of Object.entries({ paper: { mode: 'eink', einkPreset: 'paper' }, eink: { mode: 'eink', einkPreset: 'eink' } })) {
  test(`${name}: a white icon that the page turns black stays black, the others are as the picture filter leaves them`, { timeout: 90000 * SLOW }, async () => {
    const page = await open({ theme });
    let weak = [];
    const until = Date.now() + 15000 * SLOW;
    for (;;) {
      weak = (await contrasts(page)).filter((c) => c.contrast < 3).map((c) => `${c.id} ${c.contrast.toFixed(2)}`);
      if (weak.length === 0 || Date.now() > until) break;
      await page.waitForTimeout(250);
    }
    assert.deepEqual(weak, []);
    // Only the two white icons are marked; the black icon on its dark panel and the drop shadow are not.
    assert.deepEqual(await page.evaluate(() => [...document.images].map((i) => i.getAttribute('data-dk-img'))), ['flip', 'flip', null, null]);
    await page.close();
  });
}
