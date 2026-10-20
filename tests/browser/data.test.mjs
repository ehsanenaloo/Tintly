import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServers, launch, waitState } from './harness.mjs';
import { pageStatus } from '../helpers/gate.mjs';
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
  // The shipped data folder is put back exactly as it was.
  writeFileSync(join(dataDir, 'dark-sites.json'), originalDark);
  if (existsSync(shardFile)) rmSync(shardFile);
  await servers?.close();
});

// The worker reads the shipped data once and keeps it, so each test starts its own browser.
async function open(path, storage = { settings: { enabled: true } }) {
  await browser?.close();
  browser = await launch();
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  return page;
}

test('a shipped fix reaches the page, and a fix the person wrote replaces it', { timeout: 60000 }, async () => {
  writeFileSync(shardFile, JSON.stringify({ [host]: { note: 'shipped', verified: { date: '2026-10-15', browsers: ['chromium'], test: 'data.test' }, dynamic: { css: 'h1 { outline: 3px solid rgb(7, 8, 9) !important; }' } } }));
  const page = await open('/basic.html');
  await waitState(page, 'ready');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('h1')).outlineColor === 'rgb(7, 8, 9)', undefined, { timeout: 15000 });
  await browser.setStorage({ userFixes: { [host]: { dynamic: { css: 'h1 { outline: 3px solid rgb(9, 8, 7) !important; }' } } } });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('h1')).outlineColor === 'rgb(9, 8, 7)', undefined, { timeout: 15000 });
  await page.close();
  rmSync(shardFile);
});

test('a site on the shipped dark list is left alone, and the person can take it off the list', { timeout: 60000 }, async () => {
  writeFileSync(join(dataDir, 'dark-sites.json'), JSON.stringify([host]));
  const page = await open('/detect/light-white.html');
  await pageStatus(browser, page.url(), { want: ['dark-detected'] });
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk]').length), 0);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-dk-state')), false);
  await browser.setStorage({ darkSites: { add: [], remove: [host] } });
  await waitState(page, 'ready');
  await page.close();
});

test('a site that is not in the data costs the page nothing visible', { timeout: 60000 }, async () => {
  writeFileSync(join(dataDir, 'dark-sites.json'), '[]\n');
  const page = await open('/basic.html');
  await waitState(page, 'ready');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-dk-state')), 'ready');
  await page.close();
});
