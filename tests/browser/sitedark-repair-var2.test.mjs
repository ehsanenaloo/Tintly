// Repair of the page's own dark theme: variables that hold a gradient, a variable of a variable and a border color.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

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

const lumaOf = ([r, g, b]) => {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

test('a gradient, a variable of a variable and a border color that the dark theme leaves light are dark where they are used', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/site-repair-var2.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000 * SLOW);
  for (let i = 0; i < 200; i++) {
    const s = await browser.stats(url);
    if (s && s.siteDark.state === 'on' && s.siteDark.repair.state === 'done') break;
    await page.waitForTimeout(50);
  }
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  // The pixel in the middle of the box, so a gradient is read where it is drawn.
  const shot = async (id, inset = 0) => {
    const box = await page.locator(`#${id}`).boundingBox();
    const png = await page.screenshot({ clip: { x: box.x + box.width / 2, y: box.y + box.height - 20 - inset, width: 1, height: 1 } });
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    }, png.toString('base64'));
  };
  for (const id of ['a', 'b', 'c', 'e', 'f']) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    const px = await shot(id);
    assert.ok(lumaOf(px) < 0.08, `${id} pixel ${px}`);
  }
  await page.locator('#d').scrollIntoViewIfNeeded();
  const edge = await page.evaluate(() => getComputedStyle(document.getElementById('d')).borderTopColor);
  const rgb = await page.evaluate((c) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, edge);
  assert.ok(lumaOf(rgb) < 0.3, `border ${edge}`);
  // The dark gradient of the theme is kept as the page wrote it.
  const dark = await page.evaluate(() => getComputedStyle(document.getElementById('e')).backgroundImage);
  assert.ok(dark.includes('12, 16, 20'), dark);
  await page.close();
});
