import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, imageStore } from './harness.mjs';
import { corpus, encodePng } from '../helpers/png.mjs';

let servers;
let browser;
const images = corpus();

before(async () => {
  for (const i of images) imageStore.set(i.name, encodePng(i.w, i.h, i.px));
  servers = await startServers();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await servers?.close();
});

const ON = { settings: { enabled: true } };
// A sample of the corpus: some of each kind.
const SAMPLE = images.filter((i) => /-(0|1|2)$/.test(i.name));
const names = SAMPLE.map((i) => i.name);

async function open(storage, query) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/gen/images.html?${query}`);
  await waitState(page, 'ready');
  return page;
}

const marks = (page) => page.evaluate(() => Object.fromEntries([...document.images].map((i) => [i.id, i.getAttribute('data-dk-img') ?? 'keep'])));
const waitMarked = (page, count) =>
  page.waitForFunction((n) => document.querySelectorAll('img[data-dk-img]').length >= n, count, { timeout: 15000 });

test('images on the same origin are sorted: logos inverted, flat graphics on white softened, photos kept', { timeout: 60000 }, async () => {
  const wantMarked = SAMPLE.filter((i) => i.expect !== 'keep').length;
  const page = await open(ON, `names=${names.join(',')}`);
  await waitMarked(page, wantMarked);
  await page.waitForTimeout(500);
  const got = await marks(page);
  const wrong = SAMPLE.filter((i) => got[i.name] !== i.expect).map((i) => `${i.name}: ${got[i.name]} not ${i.expect}`);
  console.log(`# page images: ${SAMPLE.length - wrong.length} of ${SAMPLE.length} sorted as expected`);
  assert.deepEqual(wrong, []);
  // The filter is really applied.
  const logo = SAMPLE.find((i) => i.expect === 'invert').name;
  assert.match(await page.evaluate((id) => getComputedStyle(document.getElementById(id)).filter, logo), /invert/);
  const photo = SAMPLE.find((i) => i.expect === 'keep' && /^photo/.test(i.name)).name;
  assert.equal(await page.evaluate((id) => getComputedStyle(document.getElementById(id)).filter, photo), 'none');
  await page.close();
});

test('images from another origin are fetched by the worker and sorted the same way', { timeout: 60000 }, async () => {
  const some = names.filter((n) => /logo|chart|photo/.test(n)).slice(0, 8);
  const want = SAMPLE.filter((i) => some.includes(i.name) && i.expect !== 'keep').length;
  const page = await open(ON, `names=${some.join(',')}&base=${encodeURIComponent(servers.other)}`);
  await waitMarked(page, want);
  const got = await marks(page);
  for (const i of SAMPLE.filter((s) => some.includes(s.name))) assert.equal(got[i.name], i.expect, i.name);
  let stats = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify(globalThis.__dk.images.stats()) });
    return JSON.parse(r.result);
  }, `${servers.origin}/gen/images.html*`);
  // The count of fetched files can trail the marks on a busy machine.
  for (let i = 0; i < 50 && !(stats?.fetched >= 1); i++) {
    await page.waitForTimeout(100);
    stats = await browser.worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify(globalThis.__dk.images.stats()) });
      return JSON.parse(r.result);
    }, `${servers.origin}/gen/images.html*`);
  }
  assert.ok(stats.fetched >= 1, JSON.stringify(stats));
  await page.close();
});

test('light mode, a switched-off site and a fix that names the image leave images alone, and teardown removes every mark', { timeout: 90000 }, async () => {
  const host = new URL(servers.origin).host;
  const logo = SAMPLE.find((i) => i.expect === 'invert').name;
  const query = `names=${logo}`;

  const light = await open({ settings: { enabled: true, theme: { mode: 'light' } } }, query);
  await light.waitForTimeout(800);
  assert.deepEqual(await marks(light), { [logo]: 'keep' });
  await light.close();

  const fixed = await open({ ...ON, userFixes: { [host]: { dynamic: { ignoreImage: [`#${logo}`] } } } }, query);
  await fixed.waitForTimeout(800);
  assert.deepEqual(await marks(fixed), { [logo]: 'keep' });
  await fixed.close();

  const page = await open(ON, query);
  await waitMarked(page, 1);
  await browser.setStorage({ settings: { enabled: false } });
  await waitState(page, null);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk-img], style[data-dk]').length), 0);
  await page.close();
});

test('an image that arrives after load is sorted too', { timeout: 60000 }, async () => {
  const logo = SAMPLE.find((i) => i.expect === 'invert').name;
  const page = await open(ON, 'names=');
  await page.evaluate((n) => {
    const img = document.createElement('img');
    img.id = n;
    img.width = 48;
    img.height = 48;
    img.src = `/gen/img/${n}.png`;
    document.body.append(img);
  }, logo);
  await waitMarked(page, 1);
  assert.equal((await marks(page))[logo], 'invert');
  await page.close();
});
