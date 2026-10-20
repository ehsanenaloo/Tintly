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

const luminance = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};

async function open() {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/markup-colors.html`);
  await waitState(page, 'ready', 30000);
  return page;
}

const read = (page, id, prop) => page.evaluate(([i, p]) => getComputedStyle(document.getElementById(i)).getPropertyValue(p), [id, prop]);

test('an inline color marked important is beaten through the text fill color', { timeout: 60000 }, async () => {
  const page = await open();
  // The color itself stays as the page wrote it; the text paints with the fill color.
  assert.ok(luminance(await read(page, 'imp', '-webkit-text-fill-color')) > 0.6, await read(page, 'imp', '-webkit-text-fill-color'));
  // An element that sets its own fill color keeps what it set (the keyed rule still themes that value as a text color).
  assert.ok(luminance(await read(page, 'imp-fill', '-webkit-text-fill-color')) > 0.6);
  // A plain inline color is themed through `color`, with no fill color added.
  assert.ok(luminance(await read(page, 'plain', 'color')) > 0.6);
  assert.equal(await page.evaluate(() => document.getElementById('plain').style.getPropertyValue('-webkit-text-fill-color')), '');
  await page.close();
});

test('legacy color attributes are read like the browser reads them', { timeout: 60000 }, async () => {
  const page = await open();
  // Each odd value must give the same result as the color the browser reads it as.
  for (const [odd, plain] of [['l-ffff', 'r-ffff'], ['l-name', 'r-name'], ['l-bad', 'r-bad']]) {
    const was = await read(page, odd, 'background-color');
    assert.equal(was, await read(page, plain, 'background-color'), odd);
    assert.notEqual(was, 'rgba(0, 0, 0, 0)');
  }
  assert.ok(luminance(await read(page, 'l-short', 'background-color')) < 0.4);
  assert.ok(luminance(await read(page, 'l-name', 'background-color')) < 0.4);
  // `transparent` is not a legacy color: no rule, the cell stays clear.
  assert.equal(await read(page, 'l-none', 'background-color'), 'rgba(0, 0, 0, 0)');
  // Text: `ff0` is near black for the browser (#0f0f00); on the dark page it must be light.
  assert.ok(luminance(await read(page, 'f-short', 'color')) > 0.5, await read(page, 'f-short', 'color'));
  assert.ok(luminance(await read(page, 'f-dark', 'color')) > 0.5);
  assert.ok(luminance(await read(page, 'f-bad', 'color')) > 0.5);
  await page.close();
});
