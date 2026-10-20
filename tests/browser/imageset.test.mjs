// A background given with image-set() is sorted by the candidate the browser shows, also when the rule is read through
// the style object, and a rule with only a mask picture is told to the Images module there too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, imageStore } from './harness.mjs';
import { corpus, encodePng } from '../helpers/png.mjs';

let servers;
let browser;

before(async () => {
  for (const i of corpus()) imageStore.set(i.name, encodePng(i.w, i.h, i.px));
  servers = await startServers();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

async function open(path, ratio) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: ratio, mobile: false });
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready');
  return page;
}

const marks = (page, ids) => page.evaluate((list) => Object.fromEntries(list.map((id) => [id, document.getElementById(id).getAttribute('data-dk-bg') ?? 'none'])), ids);

async function settle(page, ids, want) {
  const until = Date.now() + 20000;
  let got;
  do {
    await page.waitForTimeout(300);
    got = await marks(page, ids);
  } while (Date.now() < until && JSON.stringify(got) !== JSON.stringify(want));
  return got;
}

const SETS = ['set-class', 'set-string', 'set-webkit', 'set-type', 'set-only3', 'set-layers', 'set-inline'];

test('image-set: the 1x picture is sorted on a screen of ratio 1, a type the browser cannot show is passed over', { timeout: 60000 }, async (t) => {
  const page = await open('/bg-image-set.html', 1);
  t.after(() => page.close());
  const want = { 'set-class': 'invert', 'set-string': 'invert', 'set-webkit': 'invert', 'set-type': 'invert', 'set-only3': 'invert', 'set-layers': 'none', 'set-inline': 'invert' };
  assert.deepEqual(await settle(page, SETS, want), want);
});

test('image-set: the 2x picture is sorted on a screen of ratio 2', { timeout: 60000 }, async (t) => {
  const page = await open('/bg-image-set.html', 2);
  t.after(() => page.close());
  const want = { 'set-class': 'none', 'set-string': 'none', 'set-webkit': 'none', 'set-type': 'invert', 'set-only3': 'invert', 'set-layers': 'none', 'set-inline': 'none' };
  assert.deepEqual(await settle(page, SETS, want), want);
});

test('rules read through the style object: a mask picture with a dark color and an image-set() are told to the module', { timeout: 60000 }, async (t) => {
  const page = await open('/bg-cssom.html', 1);
  t.after(() => page.close());
  const ids = ['mask-css', 'set-css', 'plain-css'];
  const want = { 'mask-css': 'invert', 'set-css': 'invert', 'plain-css': 'none' };
  assert.deepEqual(await settle(page, ids, want), want);
  assert.equal((await browser.stats(page.url())).cssomSheets >= 1, true);
});
