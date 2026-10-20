// The scheme and motion hints keep the page's view of a media query consistent with the native changes around them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch } from './harness.mjs';

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

async function openOff(media) {
  await browser.clearStorage();
  // The hook is registered only for pages where the extension can be on. The Light mode sends no hint of its own, so the test drives the hook alone.
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'light' } } });
  const page = await browser.context.newPage();
  await page.emulateMedia(media);
  await page.goto(`${servers.origin}/basic.html`);
  return page;
}

const track = (page, query) =>
  page.evaluate((q) => {
    const mql = matchMedia(q);
    window.__seen = { events: [], legacy: [], onchange: [] };
    mql.addEventListener('change', (e) => window.__seen.events.push(e.matches));
    mql.addListener((e) => window.__seen.legacy.push(e.matches));
    mql.onchange = (e) => window.__seen.onchange.push(e.matches);
    window.__mql = mql;
  }, query);
const word = (page, name) => page.evaluate((n) => document.dispatchEvent(new Event(n)), name);
// The browser sends media query changes in its next rendering update.
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));
const read = (page) => page.evaluate(() => ({ matches: window.__mql.matches, ...window.__seen }));

test('a native scheme change before, during and after the hint gives one consistent run of values', { timeout: 60000 }, async () => {
  const page = await openOff({ colorScheme: 'dark' });
  await track(page, '(prefers-color-scheme: dark)');
  await page.emulateMedia({ colorScheme: 'light' });
  await settle(page);
  assert.deepEqual((await read(page)).events, [false]);
  await word(page, 'dk:scheme-dark');
  await settle(page);
  let r = await read(page);
  assert.equal(r.matches, true);
  assert.deepEqual(r.events, [false, true]);
  await page.emulateMedia({ colorScheme: 'dark' });
  await settle(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await settle(page);
  r = await read(page);
  assert.equal(r.matches, true);
  assert.deepEqual(r.events, [false, true], 'native changes during the hint are not shown');
  await word(page, 'dk:scheme-off');
  await settle(page);
  r = await read(page);
  assert.equal(r.matches, false);
  assert.deepEqual(r.events, [false, true, false]);
  await page.emulateMedia({ colorScheme: 'dark' });
  await settle(page);
  r = await read(page);
  assert.equal(r.matches, true);
  assert.deepEqual(r.events, [false, true, false, true]);
  assert.deepEqual(r.legacy, r.events);
  assert.deepEqual(r.onchange, r.events);
  await page.close();
});

test('a hint that is turned off while the browser answers the same as the hint sends no event', { timeout: 60000 }, async () => {
  const page = await openOff({ colorScheme: 'dark' });
  await track(page, '(prefers-color-scheme: dark)');
  await word(page, 'dk:scheme-dark');
  await word(page, 'dk:scheme-off');
  await settle(page);
  assert.deepEqual((await read(page)).events, []);
  await page.close();
});

test('the light query and the reduced motion query follow native changes the same way', { timeout: 60000 }, async () => {
  const page = await openOff({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await track(page, '(prefers-reduced-motion: reduce)');
  await word(page, 'dk:motion-reduce');
  await settle(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settle(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settle(page);
  await word(page, 'dk:motion-off');
  await settle(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settle(page);
  const r = await read(page);
  assert.deepEqual(r.events, [true, false, true]);
  assert.equal(r.matches, true);
  await page.close();
});
