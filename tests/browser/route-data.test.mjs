// Shipped fixes and dark-list entries that name a path follow the route of a page that changes its address without a load.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServers, launch, waitState } from './harness.mjs';
import { REPO } from '../helpers/tree.mjs';

const dataDir = join(REPO, 'extension', 'data');
const { shardOf } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'data.js')).href);

let servers;
let browser = null;
let host;
let originalDark;
let shardFile;

before(async () => {
  servers = await startServers();
  host = new URL(servers.origin).host;
  originalDark = readFileSync(join(dataDir, 'dark-sites.json'), 'utf8');
  mkdirSync(join(dataDir, 'fixes'), { recursive: true });
  shardFile = join(dataDir, 'fixes', `${shardOf(host)}.json`);
});

after(async () => {
  await browser?.close();
  writeFileSync(join(dataDir, 'dark-sites.json'), originalDark);
  if (existsSync(shardFile)) rmSync(shardFile);
  await servers?.close();
});

const outline = (css) => `h1 { outline: 3px solid ${css} !important; }`;
const fix = (color) => ({ dynamic: { css: outline(color) } });

// The worker keeps the shipped data once it has read it, so each test starts its own browser.
async function open(args) {
  await browser?.close();
  browser = await launch({ args });
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/basic.html`);
  await waitState(page, 'ready');
  return page;
}

const go = (page, path) => page.evaluate((p) => history.pushState({}, '', p), path);
const outlineIs = (page, rgb, timeout = 15000) =>
  page.waitForFunction((c) => getComputedStyle(document.querySelector('h1')).outlineColor === c, rgb, { timeout });
const noOutline = (page) => page.waitForFunction(() => getComputedStyle(document.querySelector('h1')).outlineStyle === 'none', undefined, { timeout: 15000 });

/** Make every read of the session state in the worker (the host mark, read by each ask) take this long, so the answers to the asks of the page arrive late. */
const lag = (ms) => browser.worker.evaluate((v) => {
  if (!globalThis.__realGet) {
    globalThis.__realGet = chrome.storage.session.get.bind(chrome.storage.session);
    chrome.storage.session.get = async (...a) => {
      await new Promise((r) => setTimeout(r, globalThis.__lag));
      return globalThis.__realGet(...a);
    };
  }
  globalThis.__lag = v;
}, ms);

{
  const args = [];
  test('built-in fixes follow /a, /b and a route with none, and a late answer for /a does not win', { timeout: 90000 }, async () => {
    writeFileSync(join(dataDir, 'dark-sites.json'), '[]');
    writeFileSync(shardFile, JSON.stringify({ [`${host}/a`]: fix('rgb(1, 2, 3)'), [`${host}/b`]: fix('rgb(4, 5, 6)') }));
    const page = await open(args);
    await go(page, '/a');
    await outlineIs(page, 'rgb(1, 2, 3)');
    await go(page, '/b');
    await outlineIs(page, 'rgb(4, 5, 6)');
    await go(page, '/c');
    await noOutline(page);
    // The answer for /a is held back while the one for /b comes at once.
    await lag(1500);
    await go(page, '/a');
    await page.waitForTimeout(150);
    await lag(0);
    await go(page, '/b');
    await outlineIs(page, 'rgb(4, 5, 6)');
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).outlineColor), 'rgb(4, 5, 6)');
    // And the empty answer replaces a fix too.
    await lag(1500);
    await go(page, '/a');
    await page.waitForTimeout(150);
    await lag(0);
    await go(page, '/c');
    await noOutline(page);
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).outlineStyle), 'none');
    await page.close();
    rmSync(shardFile);
  });
}

test('a dark-list entry with a path applies to its route only', { timeout: 60000 }, async () => {
  if (existsSync(shardFile)) rmSync(shardFile);
  writeFileSync(join(dataDir, 'dark-sites.json'), JSON.stringify([`${host}/night`]));
  const page = await open([]);
  await go(page, '/night');
  await waitState(page, null);
  await go(page, '/day');
  await waitState(page, 'ready');
  await go(page, '/night/x');
  await waitState(page, null);
  await page.close();
});

test('a host with no rule that has a path asks the worker once and never again on route changes', { timeout: 60000 }, async () => {
  writeFileSync(join(dataDir, 'dark-sites.json'), '[]');
  writeFileSync(shardFile, JSON.stringify({ [host]: { note: 'whole host' } }));
  const page = await open([]);
  await browser.worker.evaluate(() => {
    globalThis.__asks = 0;
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.type === 'dk.fix.forHost') globalThis.__asks += 1;
    });
  });
  for (const p of ['/a', '/b', '/c', '/a']) {
    await go(page, p);
    await page.waitForTimeout(200);
  }
  assert.equal(await browser.worker.evaluate(() => globalThis.__asks), 0);
  await page.close();
  rmSync(shardFile);
});

test('a failed ask for the shipped data is made again by the next decision', { timeout: 60000 }, async () => {
  writeFileSync(join(dataDir, 'dark-sites.json'), '[]');
  writeFileSync(shardFile, JSON.stringify({ [host]: fix('rgb(1, 2, 3)') }));
  await browser?.close();
  browser = await launch();
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  await browser.worker.evaluate(() => {
    globalThis.__real = chrome.storage.session.get.bind(chrome.storage.session);
    chrome.storage.session.get = async () => {
      throw new Error('down');
    };
  });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/basic.html`);
  await waitState(page, 'ready');
  await page.waitForTimeout(800);
  await noOutline(page);
  await browser.worker.evaluate(() => {
    chrome.storage.session.get = globalThis.__real;
  });
  await browser.setStorage({ settings: { enabled: true, theme: { brightness: 95 } } });
  await outlineIs(page, 'rgb(1, 2, 3)');
  await page.close();
  rmSync(shardFile);
});
