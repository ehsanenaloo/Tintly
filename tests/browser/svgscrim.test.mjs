// A black translucent fill on a shape with an area is a scrim or a shadow and stays a dark veil; paths and opaque shapes do not.
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

const fillOf = (page, id) =>
  page.evaluate((i) => {
    const nums = getComputedStyle(document.getElementById(i)).fill.match(/[\d.]+/g).map(Number);
    const scale = /^color\(/.test(getComputedStyle(document.getElementById(i)).fill) ? 1 : 255;
    return { y: (0.2126 * nums[0] + 0.7152 * nums[1] + 0.0722 * nums[2]) / scale, a: nums.length > 3 ? nums[3] : 1 };
  }, id);

async function check(options) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/svg-scrim.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000);
  if (options) await browser.restartEngine(url, options);
  for (const id of ['scrim', 'circle', 'ellipse', 'polygon']) {
    const f = await fillOf(page, id);
    assert.ok(f.y < 0.25, `${id} lost its dark: ${JSON.stringify(f)}`);
    assert.ok(f.a > 0 && f.a < 1, `${id} lost its transparency: ${JSON.stringify(f)}`);
  }
  assert.ok((await fillOf(page, 'path')).y > 0.5, 'a path keeps the foreground rule');
  assert.ok((await fillOf(page, 'solid')).y > 0.5, 'an opaque black shape is as before');
  // A colored translucent fill is not a scrim.
  assert.ok((await fillOf(page, 'bluish')).y > 0.05);
  await page.close();
}

test('black translucent fills on rect, circle, ellipse and polygon stay dark veils (text path)', { timeout: 60000 }, async () => {
  await check(null);
});

test('the same through the CSSOM path', { timeout: 60000 }, async () => {
  await check({ textPath: false });
});
