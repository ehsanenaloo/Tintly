// Named palettes: the picker in Appearance writes the color fields, the page follows, a hand edit gives Custom, and the
// palettes work in site rules and presets. AMOLED black is a true black page and the quality gates still behave.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

let servers;
let browser;
let extId;

before(async () => {
  servers = await startServers();
  browser = await launch();
  extId = new URL(browser.worker.url()).host;
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const ON = { settings: { enabled: true } };
const stored = (key) => browser.worker.evaluate((k) => chrome.storage.local.get(k), key);

async function openOptions(storage) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/options/options.html#appearance`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return page;
}
async function openWeb(path = '/basic.html') {
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}${path}`);
  await waitState(web, 'ready', 30000);
  return web;
}
const bodyBg = (web) => web.evaluate(() => getComputedStyle(document.body).backgroundColor);
const checked = (page, group) => page.evaluate((g) => document.querySelector(`#${g} [aria-checked="true"]`)?.dataset.id, group);
const settleTheme = async (web, expected) => {
  await web.waitForFunction((e) => getComputedStyle(document.body).backgroundColor === e, expected, { timeout: 10000 });
};

test('the picker lists the planned palettes with swatches and shows the one in force', { timeout: 60000 }, async () => {
  const page = await openOptions(ON);
  const dark = await page.evaluate(() => [...document.querySelectorAll('#paletteDark .palette:not([hidden])')].map((b) => b.dataset.id));
  const light = await page.evaluate(() => [...document.querySelectorAll('#paletteLight .palette:not([hidden])')].map((b) => b.dataset.id));
  assert.deepEqual(dark, ['Default', 'Graphite', 'AMOLED', 'Midnight', 'Solarized', 'Nord', 'Gruvbox']);
  assert.deepEqual(light, ['Default', 'WarmPaper', 'CoolGray', 'HighContrast']);
  assert.equal(await checked(page, 'paletteDark'), 'Default');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.palette-swatch').length > 10), true);
  const names = await page.evaluate(() => [...document.querySelectorAll('#paletteDark .palette-name')].map((n) => n.textContent));
  assert.ok(names.includes('Nord') && names.includes('Gruvbox') && names.includes('AMOLED black'), names.join());
  await page.close();
});

test('choosing a palette writes the fields and the open page follows', { timeout: 90000 }, async () => {
  const web = await openWeb();
  const before = await bodyBg(web);
  const page = await openOptions(ON);
  await page.click('#paletteDark [data-id="Nord"]');
  await page.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.theme.colorSchemeDark === 'Nord');
  const theme = (await stored('settings')).settings.theme;
  assert.equal(theme.darkBackground, '#2e3440');
  assert.equal(theme.darkText, '#d8dee9');
  assert.equal(await page.inputValue('#darkBackground'), '#2e3440');
  assert.equal(await checked(page, 'paletteDark'), 'Nord');
  await web.waitForFunction((b) => getComputedStyle(document.body).backgroundColor !== b, before, { timeout: 10000 });
  const nord = await bodyBg(web);
  assert.notEqual(nord, before);
  await page.click('#paletteDark [data-id="Gruvbox"]');
  await web.waitForFunction((b) => getComputedStyle(document.body).backgroundColor !== b, nord, { timeout: 10000 });
  await page.close();
  await web.close();
});

test('AMOLED black gives a true black page, and the page text stays readable', { timeout: 90000 }, async () => {
  const web = await openWeb();
  const page = await openOptions(ON);
  await page.click('#paletteDark [data-id="AMOLED"]');
  await settleTheme(web, 'rgb(0, 0, 0)');
  const colors = await web.evaluate(() => {
    const s = getComputedStyle(document.querySelector('p, h1, a') ?? document.body);
    return [s.color, getComputedStyle(document.body).backgroundColor];
  });
  const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (css) => {
    const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
  };
  const [a, b] = [lum(colors[0]), lum(colors[1])];
  assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 7, JSON.stringify(colors));
  await page.close();
  await web.close();
});

test('AMOLED black with the readability net and the site dark theme gates', { timeout: 120000 }, async () => {
  const amoled = { darkBackground: '#000000', darkText: '#e8e8e8', colorSchemeDark: 'AMOLED' };
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: amoled } });
  const net = await browser.context.newPage();
  const url = `${servers.origin}/readability.html`;
  await net.goto(url);
  await waitState(net, 'ready', 30000);
  await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, css: '#bubble{color:#222222}' });
  }, url);
  await net.waitForFunction(() => document.getElementById('bubble').hasAttribute('data-dk-r'), null, { timeout: 15000 });
  assert.equal(await bodyBg(net), 'rgb(0, 0, 0)');
  await net.close();
  // A page with its own dark theme keeps it (the verdict does not depend on our background).
  const own = await browser.context.newPage();
  await own.goto(`${servers.origin}/site-dark-class.html`);
  await waitState(own, 'ready', 30000);
  const s = await browser.stats(`${servers.origin}/site-dark-class.html`);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  await own.close();
});

test('a color edited by hand switches the picker to Custom; choosing a palette again brings the id back', { timeout: 90000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, theme: { darkBackground: '#2e3440', darkText: '#d8dee9', colorSchemeDark: 'Nord' } } });
  assert.equal(await checked(page, 'paletteDark'), 'Nord');
  await page.fill('#darkText', '#fafafa');
  await page.waitForFunction(() => document.querySelector('#paletteDark [data-id="Custom"]:not([hidden])'));
  assert.equal(await checked(page, 'paletteDark'), 'Custom');
  await page.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.theme.colorSchemeDark === 'Custom');
  await page.click('#paletteDark [data-id="Nord"]');
  assert.equal(await checked(page, 'paletteDark'), 'Nord');
  assert.equal(await page.evaluate(() => document.querySelector('#paletteDark [data-id="Custom"]').hidden), true);
  await page.close();
});

test('the picker works with the keyboard in both directions of writing', { timeout: 90000 }, async () => {
  for (const locale of ['en', 'fa']) {
    const page = await openOptions({ settings: { enabled: true }, ui: { locale, uiTheme: 'light' } });
    await page.focus('#paletteDark [aria-checked="true"]');
    const rtl = locale === 'fa';
    await page.keyboard.press(rtl ? 'ArrowLeft' : 'ArrowRight');
    await page.waitForFunction(() => document.querySelector('#paletteDark [aria-checked="true"]')?.dataset.id === 'Graphite');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('#paletteDark [aria-checked="true"]')?.dataset.id === 'Gruvbox');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('#paletteDark [aria-checked="true"]')?.dataset.id === 'Default');
    const faName = await page.evaluate(() => document.querySelector('#paletteDark [data-id="Nord"] .palette-name').textContent);
    assert.equal(faName, 'Nord');
    await page.close();
  }
});

test('light palettes change the light mode page', { timeout: 90000 }, async () => {
  const web = await openWeb();
  const page = await openOptions({ settings: { enabled: true, theme: { mode: 'light' } } });
  await page.click('#paletteLight [data-id="HighContrast"]');
  await settleTheme(web, 'rgb(255, 255, 255)');
  assert.equal(await checked(page, 'paletteLight'), 'HighContrast');
  await page.close();
  await web.close();
});

test('palettes work in site rules and presets', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const host = new URL(servers.origin).host;
  await browser.setStorage({
    siteRules: { [host]: { theme: { mode: 'dark', darkBackground: '#000000', darkText: '#e8e8e8' } } },
    presets: [{ id: 'p-amoled', name: 'Night', theme: { ...(await stored('settings')).settings.theme, darkBackground: '#0b1426', darkText: '#dbe5f4' } }],
  });
  const web = await openWeb();
  assert.equal(await bodyBg(web), 'rgb(0, 0, 0)');
  // The stored forms are read back with their ids by the settings page.
  const page = await openOptions({
    settings: { enabled: true },
    siteRules: { [host]: { theme: { mode: 'dark', darkBackground: '#000000', darkText: '#e8e8e8' } } },
    presets: [{ id: 'p-amoled', name: 'Night', theme: { ...(await stored('settings')).settings.theme, darkBackground: '#0b1426', darkText: '#dbe5f4' } }],
  });
  const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'dk.state.get' }));
  assert.equal(state.siteRules[host].theme.colorSchemeDark, 'AMOLED');
  assert.equal(state.presets[0].theme.colorSchemeDark, 'Midnight');
  await page.close();
  await web.close();
});
