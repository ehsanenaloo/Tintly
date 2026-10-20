import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

// Eight bugs that other dark mode tools met, as fixtures.

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

const luminance = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};
/** The alpha of a computed color: rgba(), or color(srgb r g b / a). */
const alphaOf = (css) => {
  const m = /\/\s*([\d.]+%?)\s*\)/.exec(css) ?? /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(css);
  if (!m) return 1;
  return m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
};

async function open(path, storage = ON, state = 'ready') {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  if (state) await waitState(page, state, 30000);
  return page;
}

const read = (page, id, prop) => page.evaluate(([i, p]) => getComputedStyle(document.getElementById(i)).getPropertyValue(p), [id, prop]);

test('1. current color with a nested supports block keeps the half-transparent mix (opacity utilities)', { timeout: 60000 }, async () => {
  const page = await open('/edge-tailwind.html');
  await page.waitForTimeout(500);
  if (!(await page.evaluate(() => CSS.supports('color', 'color-mix(in oklab, red 50%, transparent)')))) {
    await page.close();
    return;
  }
  const bg = await read(page, 'half', 'background-color');
  assert.ok(alphaOf(bg) > 0.4 && alphaOf(bg) < 0.6, `background ${bg}`);
  const border = await read(page, 'edge', 'border-top-color');
  assert.ok(alphaOf(border) > 0.4 && alphaOf(border) < 0.6, `border ${border}`);
  // The text itself is themed (the blue gets lighter on a dark page).
  assert.ok(luminance(await read(page, 'half', 'color')) > 0.25, await read(page, 'half', 'color'));
  await page.close();
});

test('2. a style added to the head or the root before the body exists is themed', { timeout: 60000 }, async () => {
  const page = await open('/edge-head-style.html');
  await page.waitForTimeout(300);
  assert.ok(luminance(await read(page, 'box', 'background-color')) < 0.3, await read(page, 'box', 'background-color'));
  assert.ok(luminance(await read(page, 'rootbox', 'background-color')) < 0.3, await read(page, 'rootbox', 'background-color'));
  assert.ok(luminance(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) < 0.3);
  await page.close();
});

test('3. a rule with all: revert does not make text unreadable, and a color set after it is themed', { timeout: 60000 }, async () => {
  const page = await open('/edge-all-revert.html');
  await page.waitForTimeout(300);
  assert.ok(luminance(await read(page, 'reset', 'color')) > 0.6, await read(page, 'reset', 'color'));
  assert.ok(luminance(await read(page, 'reset-bg', 'background-color')) < 0.3, await read(page, 'reset-bg', 'background-color'));
  assert.ok(luminance(await read(page, 'reset-bg', 'color')) > 0.6, await read(page, 'reset-bg', 'color'));
  assert.equal((await browser.stats(page.url())).faults, 0);
  await page.close();
});

test('4. SVG images with characters above Latin-1 and quotes are read without a fault', { timeout: 60000 }, async () => {
  const page = await open('/edge-svg-text.html');
  await page.waitForFunction(() => true);
  const stats = async () =>
    browser.worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify(globalThis.__dk.images.stats()) });
      return JSON.parse(r.result);
    }, page.url());
  const start = Date.now();
  let s = await stats();
  while ((!s || s.analyzed + s.failed < 2) && Date.now() - start < 10000) {
    await page.waitForTimeout(200);
    s = await stats();
  }
  assert.equal(s.failed, 0, JSON.stringify(s));
  assert.ok(s.analyzed >= 2, JSON.stringify(s));
  assert.equal((await browser.stats(page.url())).faults, 0);
  await page.close();
});

test('5. several shadow hosts added in one insertion are all themed', { timeout: 60000 }, async () => {
  const page = await open('/edge-shadow.html');
  await page.evaluate(() => {
    const wrap = document.createElement('section');
    for (let i = 0; i < 3; i++) {
      const host = document.createElement('div');
      host.id = `h${i}`;
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>.b{background:#fff;color:#111;padding:8px}</style><div class="b" id="b${i}">box ${i}</div>`;
      wrap.append(host);
    }
    document.getElementById('mount').append(wrap);
  });
  await page.waitForTimeout(1000);
  const colors = await page.evaluate(() => [0, 1, 2].map((i) => getComputedStyle(document.getElementById(`h${i}`).shadowRoot.getElementById(`b${i}`)).backgroundColor));
  for (const c of colors) assert.ok(luminance(c) < 0.3, colors.join(' | '));
  await page.close();
});

test('6. a constructed sheet adopted by a shadow root long after it was made is themed', { timeout: 60000 }, async () => {
  const page = await open('/edge-shadow.html');
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'late-host';
    document.getElementById('mount').append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<div class="b" id="late">late</div>';
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.b{background:#fff;color:#111;padding:8px}');
    document.getElementById('late-host').shadowRoot.adoptedStyleSheets = [sheet];
  });
  await page.waitForTimeout(800);
  const bg = await page.evaluate(() => getComputedStyle(document.getElementById('late-host').shadowRoot.getElementById('late')).backgroundColor);
  assert.ok(luminance(bg) < 0.3, bg);
  await page.close();
});

test('7. an engine that starts after the load has finished themes the sheets of the body too', { timeout: 60000 }, async () => {
  const page = await open('/basic.html', { settings: { enabled: false } }, null);
  await page.waitForLoadState('load');
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<style>.late-box{background:#ffffff;color:#111;padding:4px}</style><div id="late" class="late-box">late</div>');
  });
  assert.equal(await page.evaluate(() => document.readyState), 'complete');
  await browser.setStorage({ settings: { enabled: true } });
  await waitState(page, 'ready', 20000);
  await page.waitForTimeout(300);
  assert.ok(luminance(await read(page, 'late', 'background-color')) < 0.3, await read(page, 'late', 'background-color'));
  assert.ok(luminance(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) < 0.3);
  await page.close();
});
