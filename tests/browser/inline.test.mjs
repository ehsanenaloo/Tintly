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

const ON = { settings: { enabled: true } };

async function open(path, storage = ON) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready', 30000);
  return page;
}

const luminance = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};

test('thousands of icons share a few inline rules and every one is themed (no cap)', { timeout: 90000 }, async () => {
  const page = await open('/gen/icons.html?count=7000');
  await page.waitForTimeout(500);
  const stats = await browser.stats(page.url());
  assert.equal(stats.inlineCapped, false, JSON.stringify({ inline: stats.inline, elements: stats.inlineElements }));
  assert.ok(stats.inline <= 64, `distinct rules ${stats.inline}`);
  assert.ok(stats.inlineElements >= 14000, `marked elements ${stats.inlineElements}`);
  const fills = await page.evaluate(() => {
    const svgs = document.querySelectorAll('svg');
    return [0, 2, 6, svgs.length - 1].map((i) => getComputedStyle(svgs[i].querySelector('path')).fill);
  });
  // The page has fills #222, #0a6, #333 and one more near the end: all were dark or mid on a white page.
  assert.ok(luminance(fills[0]) > 0.4, fills[0]);
  assert.ok(luminance(fills[2]) > 0.4, fills[2]);
  assert.ok(luminance(fills[3]) > 0.3, fills[3]);
  // The last icon (the one past the old cap) must be themed too.
  const last = await page.evaluate(() => document.querySelectorAll('svg')[6999].querySelector('path').hasAttribute('data-dk-i') || document.querySelectorAll('svg')[6999].querySelector('path').getAttribute('data-dk-i') !== null);
  assert.equal(last, true);
  await page.close();
});

test('elements with the same inline style share one rule, and a changed style moves to another', { timeout: 60000 }, async () => {
  const page = await open('/basic.html');
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) {
      const p = document.createElement('p');
      p.id = `s${i}`;
      p.setAttribute('style', 'background:#fff;color:#111');
      p.textContent = 'x';
      document.body.append(p);
    }
  });
  await page.waitForFunction(() => document.getElementById('s19').hasAttribute('data-dk-i'));
  const ids = await page.evaluate(() => new Set([...document.querySelectorAll('p[id^="s"]')].map((p) => p.getAttribute('data-dk-i'))).size);
  assert.equal(ids, 1);
  await page.evaluate(() => document.getElementById('s0').setAttribute('style', 'background:#eee;color:#222'));
  await page.waitForFunction(() => document.getElementById('s0').getAttribute('data-dk-i') !== document.getElementById('s1').getAttribute('data-dk-i'));
  const bg = await page.evaluate(() => [getComputedStyle(document.getElementById('s0')).backgroundColor, getComputedStyle(document.getElementById('s1')).backgroundColor]);
  assert.ok(luminance(bg[0]) < 0.3 && luminance(bg[1]) < 0.3, bg.join(' '));
  await page.close();
});

test('the inline observer comes back after a burst and themes a color set later', { timeout: 90000 }, async () => {
  const page = await open('/inline-burst.html');
  // The animation changes 400 styles every frame for 2.2 s. The observer pauses at least once.
  await page.waitForTimeout(2600);
  const mid = await browser.stats(page.url());
  assert.ok(mid.inlinePauses >= 1, `pauses ${mid.inlinePauses}`);
  // A color set after the burst (3.2 s) and one set again later (5.2 s) must both be themed.
  await page.waitForFunction(() => document.getElementById('late-target').hasAttribute('data-dk-i'), undefined, { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('late-add').hasAttribute('data-dk-i'), undefined, { timeout: 15000 });
  const bg = await page.evaluate(() => [getComputedStyle(document.getElementById('late-target')).backgroundColor, getComputedStyle(document.getElementById('late-add')).backgroundColor]);
  assert.ok(luminance(bg[0]) < 0.3 && luminance(bg[1]) < 0.3, bg.join(' '));
  const end = await browser.stats(page.url());
  assert.equal(end.inlineObserverOff, false);
  await page.close();
});
