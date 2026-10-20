import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';
import { loadContent } from '../helpers/content.mjs';
import { pageStatus } from '../helpers/gate.mjs';

const dk = await loadContent('core/schedule.js');

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

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const plus = (minutes) => new Date(Date.now() + minutes * 60000);

async function open(automation, extra = {}) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, automation, ...extra } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/basic.html`);
  return page;
}

const lightness = (page) =>
  page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });

test('hours: the page is themed inside the window and left alone outside it', { timeout: 60000 }, async () => {
  const inside = await open({ mode: 'time', behavior: 'onOff', time: { from: hhmm(plus(-120)), to: hhmm(plus(120)) } });
  await waitState(inside, 'ready');
  await inside.close();
  const outside = await open({ mode: 'time', behavior: 'onOff', time: { from: hhmm(plus(60)), to: hhmm(plus(120)) } });
  await pageStatus(browser, outside.url(), { want: ['off'] });
  assert.equal(await outside.evaluate(() => document.documentElement.hasAttribute('data-dk-state')), false);
  assert.equal(await outside.evaluate(() => document.querySelectorAll('[data-dk]').length), 0);
  assert.ok((await lightness(outside)) > 0.9, 'the original page');
  await outside.close();
});

test('hours: the page follows the clock at the minute boundary', { timeout: 120000 }, async () => {
  const page = await open({ mode: 'time', behavior: 'onOff', time: { from: hhmm(plus(1)), to: hhmm(plus(3)) } });
  await pageStatus(browser, page.url(), { want: ['off'] });
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-dk-state')), false);
  const start = Date.now();
  await waitState(page, 'ready', 75000);
  console.log(`# hours: turned on ${Math.round((Date.now() - start) / 1000)} s after loading; the minute boundary is within the next 60 s`);
  await page.close();
});

test('scheme: the extension stays on and the page switches between dark and light', { timeout: 60000 }, async () => {
  const active = await open({ mode: 'time', behavior: 'scheme', time: { from: hhmm(plus(-120)), to: hhmm(plus(120)) } });
  await waitState(active, 'ready');
  assert.ok((await lightness(active)) < 0.4, 'dark side');
  await active.close();
  const idle = await open({ mode: 'time', behavior: 'scheme', time: { from: hhmm(plus(60)), to: hhmm(plus(120)) } });
  await waitState(idle, 'ready');
  assert.ok((await lightness(idle)) > 0.6, 'light side');
  await idle.close();
});

test('system: the page follows the system scheme without a reload', { timeout: 60000 }, async () => {
  const page = await open({ mode: 'system', behavior: 'onOff' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-dk-state')), false);
  await page.emulateMedia({ colorScheme: 'dark' });
  await waitState(page, 'ready');
  await page.emulateMedia({ colorScheme: 'light' });
  await waitState(page, null);
  await page.close();
});

test('place: the page follows sunset and sunrise at the stored location', { timeout: 60000 }, async () => {
  const lat = 35.69;
  const lon = 51.39;
  const night = dk.schedule.nightAt(Date.now(), lat, lon).night;
  const page = await open({ mode: 'location', behavior: 'onOff', location: { lat, lon } });
  if (night) await waitState(page, 'ready');
  else {
    await pageStatus(browser, page.url(), { want: ['off'] });
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-dk-state')), false);
  }
  console.log(`# place: it is ${night ? 'night' : 'day'} at ${lat}, ${lon}; the page is ${night ? 'themed' : 'left alone'}`);
  await page.close();
});

test('a place without coordinates and no automation both leave the master switch in charge', { timeout: 60000 }, async () => {
  const a = await open({ mode: 'location', behavior: 'onOff', location: { lat: null, lon: null } });
  await waitState(a, 'ready');
  await a.close();
  const b = await open({ mode: 'none' });
  await waitState(b, 'ready');
  await b.close();
});
