// In Paper and E-ink the page's own filter of a white icon is read in batches, and only for pictures that can need it:
// 60 filtered white icons take a few batches (24 each), a page of photos takes none.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, imageStore, SLOW } from './harness.mjs';
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

const stats = (url) =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify(globalThis.__dk.images.stats()) });
    return JSON.parse(r.result);
  }, url);

async function open(path, theme) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 20000 * SLOW });
  return page;
}

for (const [name, theme] of Object.entries({ paper: { mode: 'eink', einkPreset: 'paper' }, eink: { mode: 'eink', einkPreset: 'eink' } })) {
  test(`${name}: 60 filtered white icons are shown black in batches of at most 24`, { timeout: 120000 * SLOW }, async () => {
    const page = await open('/filtered-icons-many.html', theme);
    // The module may start again once while the page loads (the E-ink palette arrives): wait for the run that holds all marks.
    const until = Date.now() + 40000 * SLOW;
    let s;
    do {
      await page.waitForTimeout(200);
      s = await stats(page.url());
    } while ((s.flip !== 60 || (await page.evaluate(() => document.querySelectorAll('img[data-dk-img="flip"]').length)) !== 60) && Date.now() < until);
    s = await stats(page.url());
    assert.ok(s.batches >= 3 && s.batches <= 10, `${s.batches} batches`);
    assert.equal(s.flip, 60);
    await page.close();
  });
}

test('paper: photos and dark icons start no read of the page filters', { timeout: 90000 * SLOW }, async () => {
  const names = Array.from({ length: 20 }, (_, i) => `photo-${i % 10}`).concat(['dark-logo-0', 'dark-logo-1', 'color-logo-0', 'chart-0']);
  const page = await open(`/gen/images.html?names=${[...new Set(names)].join(',')}`, { mode: 'eink', einkPreset: 'paper' });
  await page.waitForTimeout(4000 * SLOW);
  const s = await stats(page.url());
  assert.ok(s.analyzed >= 10, `${s.analyzed} pictures analyzed`);
  assert.equal(s.batches, 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk-img]').length), 0);
  await page.close();
});
