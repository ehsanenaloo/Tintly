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

test('a header whose background mixes a variable with transparent is themed dark', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/color-mix-var.html`);
  await waitState(page, 'ready', 30000);
  const bg = await page.evaluate(() => getComputedStyle(document.getElementById('head')).backgroundColor);
  const nums = /\(([^)]+)\)/.exec(bg)[1].split(/[\s,/]+/).filter((s) => s !== 'srgb').map(Number);
  // color(srgb r g b / a) uses 0 to 1, rgb() uses 0 to 255.
  const scale = /^color\(/.test(bg) ? 1 : 255;
  const y = (0.2126 * nums[0] + 0.7152 * nums[1] + 0.0722 * nums[2]) / scale;
  assert.ok(y < 0.25, `header background stayed light: ${bg}`);
  await page.close();
});

test('a stylesheet link that is added to the body first and given its rel and href afterwards is themed', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/late-link.html`);
  await waitState(page, 'ready', 30000);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('box')).backgroundColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(document.getElementById('box')).backgroundColor !== 'rgb(255, 255, 255)', undefined, { timeout: 10000 });
  const bg = await page.evaluate(() => getComputedStyle(document.getElementById('box')).backgroundColor);
  const nums = bg.match(/\d+/g).map(Number);
  assert.ok((0.2126 * nums[0] + 0.7152 * nums[1] + 0.0722 * nums[2]) / 255 < 0.25, `box stayed light: ${bg}`);
  await page.close();
});

test('an inline color that a page changes again and again is never drawn in the page value, not even for a frame', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/hover-inline.html`);
  await waitState(page, 'ready', 30000);
  for (const burst of [1, 20, 40]) {
    const result = await page.evaluate(async (n) => {
      let light = 0;
      for (let round = 0; round < 12; round++) {
        for (let i = 0; i < n; i++) window.paint(i, round % 2 ? '#ffffff' : '#fafafa');
        const colors = await window.sample();
        for (let i = 0; i < n; i++) {
          const m = colors[i].match(/[\d.]+/g).map(Number);
          if ((0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 > 0.5) light++;
        }
      }
      return light;
    }, burst);
    assert.equal(result, 0, `${burst} changed per frame: ${result} light frames`);
  }
  await page.close();
});

test('a white cover on an SVG shape follows the page color, a white icon path stays light', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/svg-veil.html`);
  await waitState(page, 'ready', 30000);
  const fill = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).fill, id);
  const lum = (css) => {
    const m = css.match(/[\d.]+/g).map(Number);
    return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
  };
  assert.ok(lum(await fill('veil')) < 0.25, `the cover stayed light: ${await fill('veil')}`);
  assert.ok(lum(await fill('plate')) < 0.25, `the plate stayed light: ${await fill('plate')}`);
  assert.ok(lum(await fill('icon')) > 0.6, `the icon turned dark: ${await fill('icon')}`);
  await page.close();
});
