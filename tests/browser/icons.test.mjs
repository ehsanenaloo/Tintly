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
  await page.goto(`${servers.origin}/mask-icons.html#${servers.other}`);
  await waitState(page, 'ready', 30000);
  return page;
}

const read = (page, id, prop) => page.evaluate(([i, p]) => getComputedStyle(document.getElementById(i)).getPropertyValue(p), [id, prop]);

test('a box that is only a mask shape is themed like text, a plain box like a background', { timeout: 60000 }, async () => {
  const page = await open();
  assert.ok(luminance(await read(page, 'mask', 'background-color')) > 0.5, await read(page, 'mask', 'background-color'));
  assert.ok(luminance(await read(page, 'mask-inline', 'background-color')) > 0.5, await read(page, 'mask-inline', 'background-color'));
  // The same black on a box with no mask is a surface and stays dark.
  assert.ok(luminance(await read(page, 'plain', 'background-color')) < 0.3);
  await page.close();
});

test('a black SVG image from another origin is sorted like one from the page itself', { timeout: 60000 }, async () => {
  const page = await open();
  await page.waitForFunction(() => document.getElementById('far').hasAttribute('data-dk-img') && document.getElementById('near').hasAttribute('data-dk-img'), undefined, { timeout: 15000 });
  assert.equal(await page.evaluate(() => document.getElementById('near').getAttribute('data-dk-img')), 'invert');
  assert.equal(await page.evaluate(() => document.getElementById('far').getAttribute('data-dk-img')), 'invert');
  await page.close();
});

test('a line or a dot drawn with a background color stays visible; a divider stays quiet; a real surface stays dark', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/thin-boxes.html`);
  await waitState(page, 'ready', 30000);
  const bg = (id) => read(page, id, 'background-color');
  for (const id of ['bar1', 'bar2', 'dot', 'tall']) assert.ok(luminance(await bg(id)) > 0.45, `${id} ${await bg(id)}`);
  // A light divider is not turned into a bright line: it is dimmer than a bar and different from the page.
  const rule = luminance(await bg('rule'));
  assert.ok(rule < 0.35 && rule > luminance(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)), `rule ${rule}`);
  assert.ok(luminance(await bg('card')) < 0.3);
  assert.ok(luminance(await bg('plain')) < 0.3);
  await page.close();
});
