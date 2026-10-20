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

const ON = { settings: { enabled: true, theme: { mode: 'dark' } } };

async function open(path = '/basic.html') {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready', 30000 * SLOW);
  return page;
}

const lightness = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};

test('a style attribute without a themed property is not parsed and gets no rule', { timeout: 60000 }, async () => {
  const page = await open();
  const before = await browser.stats(page.url());
  await page.evaluate(() => {
    for (let i = 0; i < 30; i++) {
      const d = document.createElement('div');
      d.id = `m${i}`;
      d.textContent = 'x';
      d.setAttribute('style', 'width: 10px');
      document.body.append(d);
    }
    // A page that moves things every frame.
    window.__tick = 0;
    const move = () => {
      window.__tick++;
      for (let i = 0; i < 30; i++) document.getElementById(`m${i}`).style.transform = `translateX(${(window.__tick + i) % 50}px)`;
      if (window.__tick < 40) requestAnimationFrame(move);
    };
    requestAnimationFrame(move);
  });
  await page.waitForFunction(() => window.__tick >= 40, null, { timeout: 15000 * SLOW });
  await page.waitForTimeout(200);
  const after = await browser.stats(page.url());
  assert.ok(after.inlinePlain - before.inlinePlain >= 30, `plain ${before.inlinePlain} to ${after.inlinePlain}`);
  assert.equal(after.inline, before.inline, 'no rule was added for motion');
  assert.equal(await page.evaluate(() => document.getElementById('m0').hasAttribute('data-dk-i')), false);
  await page.close();
});

test('the same style value on many elements is answered from memory, and the result is the same as the first time', { timeout: 60000 }, async () => {
  const page = await open();
  const before = await browser.stats(page.url());
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) {
      const d = document.createElement('div');
      d.id = `c${i}`;
      d.textContent = 'x';
      d.setAttribute('style', 'background: #ffffff; color: #111111; width: 10px');
      document.body.append(d);
      // Added one by one, so each is looked at in its own pass.
    }
  });
  await page.waitForFunction(() => document.getElementById('c19').hasAttribute('data-dk-i'), null, { timeout: 15000 * SLOW });
  const colors = await page.evaluate(() => [0, 7, 19].map((i) => [getComputedStyle(document.getElementById(`c${i}`)).backgroundColor, getComputedStyle(document.getElementById(`c${i}`)).color]));
  assert.equal(new Set(colors.map((c) => c.join('|'))).size, 1);
  assert.ok(lightness(colors[0][0]) < 0.3, colors[0][0]);
  assert.ok(lightness(colors[0][1]) > 0.5, colors[0][1]);
  // A second round of the same value, on elements whose style changes between two values every time.
  await page.evaluate(() => {
    window.__flip = 0;
    const flip = () => {
      window.__flip++;
      for (let i = 0; i < 20; i++) document.getElementById(`c${i}`).setAttribute('style', window.__flip % 2 ? 'background: #eeeeff; color: #222222; width: 10px' : 'background: #ffffff; color: #111111; width: 10px');
      if (window.__flip < 20) requestAnimationFrame(flip);
    };
    requestAnimationFrame(flip);
  });
  await page.waitForFunction(() => window.__flip >= 20, null, { timeout: 15000 * SLOW });
  await page.waitForTimeout(200);
  const after = await browser.stats(page.url());
  assert.ok(after.inlineMemoHits - before.inlineMemoHits >= 200, `memory hits ${before.inlineMemoHits} to ${after.inlineMemoHits}`);
  const final = await page.evaluate(() => [getComputedStyle(document.getElementById('c0')).backgroundColor, getComputedStyle(document.getElementById('c0')).color]);
  assert.deepEqual(final, colors[0], 'the last value is the first one again, themed the same');
  await page.close();
});

test('an escaped property name, a comment and a custom property are still read', { timeout: 60000 }, async () => {
  const page = await open();
  await page.evaluate(() => {
    const make = (id, style) => {
      const d = document.createElement('div');
      d.id = id;
      d.textContent = 'x';
      d.setAttribute('style', style);
      document.body.append(d);
    };
    make('e1', 'b\\61 ckground: #ffffff');
    make('e2', '/* note */ background: #ffffff');
    make('e3', '--tile: #ffffff; background: var(--tile)');
  });
  await page.waitForFunction(() => ['e1', 'e2', 'e3'].every((id) => document.getElementById(id).hasAttribute('data-dk-i')), null, { timeout: 15000 * SLOW });
  const backs = await page.evaluate(() => ['e1', 'e2', 'e3'].map((id) => getComputedStyle(document.getElementById(id)).backgroundColor));
  for (const b of backs) assert.ok(lightness(b) < 0.3, b);
  await page.close();
});

test('a color marked important in a style attribute also themes the text fill, as before', { timeout: 60000 }, async () => {
  const page = await open();
  await page.evaluate(() => {
    const d = document.createElement('p');
    d.id = 'imp';
    d.textContent = 'x';
    d.setAttribute('style', 'color: #111111 !important');
    document.body.append(d);
  });
  await page.waitForFunction(() => document.getElementById('imp').hasAttribute('data-dk-i'), null, { timeout: 15000 * SLOW });
  // The color itself stays the page's (the attribute beats every rule); the text is drawn with the fill color, which is themed.
  const c = await page.evaluate(() => getComputedStyle(document.getElementById('imp')).webkitTextFillColor);
  assert.ok(lightness(c) > 0.5, c);
  await page.close();
});
