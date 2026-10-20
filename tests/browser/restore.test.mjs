import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

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

async function open(path = '/basic.html') {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready', 30000);
  return page;
}

const owned = (page) => page.evaluate(() => [...document.querySelectorAll('style[data-dk]')].map((s) => s.getAttribute('data-dk')).sort());

test('our style nodes come back after the page replaces its head', { timeout: 60000 }, async () => {
  const page = await open();
  const before = await owned(page);
  assert.ok(before.includes('base'), before.join());
  await page.evaluate(() => {
    document.head.replaceChildren();
    const s = document.createElement('style');
    s.textContent = 'body{background:#eee;color:#111}';
    document.head.append(s);
  });
  await page.waitForFunction(() => document.querySelector('style[data-dk="base"]') !== null, undefined, { timeout: 10000 });
  await page.waitForTimeout(500);
  // The new sheet is themed and the canvas is dark again.
  const bg = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
  assert.ok(luminance(bg[0]) < 0.3, bg[0]);
  assert.ok(luminance(bg[1]) < 0.4, bg[1]);
  assert.ok((await browser.stats(page.url())).restored >= 1);
  await page.close();
});

test('a page that clears the whole head and adds nothing still has a dark canvas', { timeout: 60000 }, async () => {
  const page = await open();
  await page.evaluate(() => document.head.replaceChildren());
  await page.waitForFunction(() => document.querySelector('style[data-dk="base"]') !== null, undefined, { timeout: 10000 });
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  assert.ok(luminance(bg) < 0.3, bg);
  await page.close();
});

test('a page that keeps removing our nodes is given up on, and a later single removal is restored again', { timeout: 90000 }, async () => {
  const page = await open();
  await page.evaluate(() => {
    window.__fight = setInterval(() => document.querySelectorAll('style[data-dk]').forEach((n) => n.remove()), 40);
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => clearInterval(window.__fight));
  const fought = await browser.stats(page.url());
  assert.ok(fought.restoreGaveUp >= 1, `gave up ${fought.restoreGaveUp}`);
  // 4 kinds of nodes at most, 3 times each in the first 2 s window, and a few more in the next one.
  assert.ok(fought.restored <= 40, `restored ${fought.restored}`);
  assert.equal(fought.faults, 0);
  // The page is quiet now: the nodes come back by themselves once the window has passed, with no removal to ask for it.
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk]').length > 0, undefined, { timeout: 25000 });
  // Then one removal is put back.
  await page.evaluate(() => document.querySelector('style[data-dk="base"]')?.remove());
  await page.waitForFunction(() => document.querySelector('style[data-dk="base"]') !== null, undefined, { timeout: 5000 });
  await page.close();
});

test('a component that clears its shadow root and fills it again is themed', { timeout: 60000 }, async () => {
  const page = await open();
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'host';
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>.box{background:#fff;color:#111;padding:8px}</style><div class="box" id="one">one</div>';
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const root = document.getElementById('host').shadowRoot;
    root.innerHTML = '';
    root.innerHTML = '<style>.box{background:#fff;color:#111;padding:8px}</style><div class="box" id="two">two</div>';
  });
  await page.waitForTimeout(800);
  const bg = await page.evaluate(() => getComputedStyle(document.getElementById('host').shadowRoot.getElementById('two')).backgroundColor);
  assert.ok(luminance(bg) < 0.3, bg);
  await page.close();
});

test('the keeper of a single node gives up on a fight, puts the node back when the page goes quiet, and answers a later removal', { timeout: 60000 }, async () => {
  // The extension is off here, so nothing but the page touches the head.
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: false } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/basic.html`);
  const source = readFileSync(join(process.env.DK_EXTENSION ?? join(REPO, 'extension'), 'content/engine/keep.js'), 'utf8');
  await page.evaluate((code) => {
    const w = /** @type {any} */ (window);
    w.__dk = {};
    (0, eval)(code);
    const node = document.createElement('style');
    node.id = 'kept';
    document.head.append(node);
    w.__keeper = w.__dk.keep.create();
    w.__keeper.track(node, () => document.head.append(node));
    w.__fight = setInterval(() => document.getElementById('kept')?.remove(), 40);
  }, source);
  await page.waitForTimeout(2500);
  await page.evaluate(() => clearInterval(/** @type {any} */ (window).__fight));
  const stats = await page.evaluate(() => /** @type {any} */ (window).__keeper.stats());
  assert.ok(stats.gaveUp >= 1, `gave up ${stats.gaveUp}`);
  assert.ok(stats.restored <= 12, `restored ${stats.restored}`);
  await page.waitForFunction(() => document.getElementById('kept') !== null, undefined, { timeout: 25000 });
  await page.evaluate(() => document.getElementById('kept')?.remove());
  await page.waitForFunction(() => document.getElementById('kept') !== null, undefined, { timeout: 5000 });
  await page.close();
});
