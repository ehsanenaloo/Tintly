// a page whose own dark theme is a set of variables (root, media query, state of the root) and a theme switch. In the dark mode
// the page shows its own theme and Tintly adds nothing: not a canvas color, not a recolored accent, in every load.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, pixelsOf } from './harness.mjs';

let servers;
let browser;
let helper;
let extId;
let host;

before(async () => {
  servers = await startServers();
  browser = await launch();
  helper = await browser.context.newPage();
  await helper.goto('about:blank');
  extId = new URL(browser.worker.url()).host;
  host = new URL(servers.origin).host;
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const PATH = '/site-dark-toggle.html';
const SELECTORS = ['body', 'header', '#brand', '.theme-switch label', '#title', '#lead', '#panel', '#text', '#muted', '#link', '#btn', '#foot', '.skip'];
const PROPS = ['color', 'backgroundColor', 'backgroundImage', 'borderTopColor', 'borderBottomColor', 'boxShadow'];
const SITE_BG = 'rgb(10, 12, 15)';

const status = () =>
  browser.worker.evaluate(async () =>
    Object.entries(await chrome.storage.session.get(null))
      .filter(([k]) => k.startsWith('tab:'))
      .map(([, v]) => v?.status)[0],
  );

async function open(storage, { scheme = 'light', path = PATH, wait = true } = {}) {
  await browser.clearStorage();
  await browser.worker.evaluate(() => chrome.storage.session.clear());
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`${servers.origin}${path}`);
  if (wait) await waitState(page, 'ready', 30000);
  return page;
}

const read = (page) =>
  page.evaluate(
    ([selectors, props]) => Object.fromEntries(selectors.map((s) => [s, Object.fromEntries(props.map((p) => [p, getComputedStyle(document.querySelector(s))[p]]))])),
    [SELECTORS, PROPS],
  );

test('the dark mode shows the page as its own theme draws it, nothing recolored, and the notice says that nothing was repaired', { timeout: 90000 }, async () => {
  const native = await open({ settings: { enabled: false } }, { scheme: 'dark', wait: false });
  const expected = await read(native);
  assert.equal(expected.body.backgroundColor, SITE_BG, 'the reference page is the dark theme');
  await native.close();

  const page = await open({ settings: { enabled: true } });
  // The verdict and the repair finish a little after the first pass.
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready');
  for (let i = 0; i < 100 && !['site-theme', 'site-theme-repaired'].includes(await status()); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1800));
  assert.deepEqual(await read(page), expected);
  assert.equal(await status(), 'site-theme');
  const stats = await browser.stats(`${servers.origin}${PATH}`);
  assert.equal(stats.siteDark.state, 'on', JSON.stringify(stats.siteDark));
  assert.equal(stats.siteDark.repairNeeded, false);
  // The repair copy holds no rule: every color of the page is one of its own.
  const moved = await page.evaluate(() => [...document.querySelectorAll('style[data-dk="sheet"]')].map((s) => s.textContent).join('\n'));
  assert.doesNotMatch(moved, /oklch\(from|\.btn|\.skip|--dk-/);
  await page.close();
});

test('the canvas is the color of the page body, also below a short page', { timeout: 90000 }, async () => {
  const page = await open({ settings: { enabled: true } });
  await new Promise((r) => setTimeout(r, 600));
  const geometry = await page.evaluate(() => ({ html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor, height: document.body.getBoundingClientRect().height, win: innerHeight }));
  assert.ok(geometry.height < geometry.win - 40, `the page is shorter than the window: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.body, SITE_BG);
  assert.equal(geometry.html, 'rgba(0, 0, 0, 0)', 'the root keeps no color of ours');
  const [below] = await pixelsOf(page, helper, [[500, geometry.win - 10]]);
  assert.deepEqual(below, [10, 12, 15]);
  await page.close();
});

test('a page whose body paints no color keeps the canvas color of the theme', { timeout: 90000 }, async () => {
  // Without a color on the body or the root the dark scheme alone would paint the canvas; the base style stays.
  const page = await open({ settings: { enabled: true } }, { path: '/site-dark-state.html' });
  const html = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  assert.notEqual(html, 'rgba(0, 0, 0, 0)');
  await page.close();
});

test('page after page in one tab: every load gets the page\'s own theme and every module it asked for', { timeout: 180000 }, async () => {
  await browser.clearStorage();
  await browser.worker.evaluate(() => chrome.storage.session.clear());
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}${PATH}`;
  for (let load = 0; load < 7; load++) {
    await page.goto(load % 2 ? `${url}?n=${load}` : url);
    await waitState(page, 'ready', 30000);
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(10, 12, 15)', undefined, { timeout: 15000 });
    const optional = await browser.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://*/*' });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify({ o: globalThis.__dk.optional.stats(), s: globalThis.__dk.dynamic.stats().siteDark.state }) });
      return JSON.parse(r.result);
    });
    assert.equal(optional.o.failed, 0, `load ${load}: ${JSON.stringify(optional)}`);
    assert.equal(optional.s, 'on', `load ${load}`);
  }
  await page.close();
});

test('the extension theme can be chosen for the site, and the site theme comes back', { timeout: 180000 }, async () => {
  await browser.clearStorage();
  const popup = await browser.context.newPage();
  const web = await open({ settings: { enabled: true } });
  for (let i = 0; i < 100 && (await status()) !== 'site-theme'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await status(), 'site-theme');
  await web.bringToFront();
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  await popup.waitForFunction(() => document.getElementById('status').textContent === "Tintly is using this site's own dark theme.", undefined, { timeout: 30000 });
  await popup.waitForSelector('#stheme:not([hidden])');
  assert.equal(await popup.textContent('#stheme-text'), 'This site has its own dark theme.');
  assert.equal(await popup.textContent('#stheme-btn'), "Use Tintly's theme instead");
  await popup.click('#stheme-btn');
  await web.waitForFunction(() => getComputedStyle(document.body).backgroundColor !== 'rgb(10, 12, 15)', undefined, { timeout: 15000 });
  assert.equal(await web.evaluate(() => getComputedStyle(document.getElementById('btn')).backgroundColor !== 'rgb(94, 230, 176)'), true, 'the accent is the theme of the extension');
  await popup.waitForFunction(() => document.getElementById('stheme-btn').textContent === "Use the site's theme", undefined, { timeout: 30000 });
  assert.equal(await popup.textContent('#stheme-text'), "The site's own dark theme is off here.");
  for (let i = 0; i < 50 && (await status()) !== 'on'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await status(), 'on', 'the notice follows the page');
  await popup.click('#stheme-btn');
  await web.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(10, 12, 15)', undefined, { timeout: 15000 });
  assert.equal(await web.evaluate(() => getComputedStyle(document.getElementById('btn')).backgroundColor), 'rgb(94, 230, 176)');
  const rules = (await browser.worker.evaluate(() => chrome.storage.local.get('siteRules'))).siteRules ?? {};
  assert.equal(host in rules, false, JSON.stringify(rules));
  for (let i = 0; i < 50 && (await status()) !== 'site-theme'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await status(), 'site-theme', 'the notice follows the page');
  await popup.close();
  await web.close();
});
