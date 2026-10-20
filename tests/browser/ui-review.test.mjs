import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch } from './harness.mjs';

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

const stored = (key) => browser.worker.evaluate((k) => chrome.storage.local.get(k), key);
const ON = { settings: { enabled: true } };

async function open(page, storage, { locale = 'en', width = 1000, hash = '', query = '' } = {}) {
  await browser.clearStorage();
  await browser.setStorage({ ...ON, ui: { locale, uiTheme: 'light' }, ...storage });
  const p = await browser.context.newPage();
  await p.setViewportSize({ width, height: 900 });
  await p.goto(`chrome-extension://${extId}/pages/${page}${query}${hash}`);
  await p.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return p;
}
const editor = (storage, opts = {}) => open('fixes/fixes.html', storage, { query: '?site=a.example.com', ...opts });
const settings = (storage, opts = {}) => open('options/options.html', storage, opts);
const wait = (p, ms = 900) => p.waitForTimeout(ms);
const invalid = (p, id) => p.getAttribute(`#${id}`, 'aria-invalid');

test('a fix the worker would refuse is marked on the page, and the editor never gets stuck', { timeout: 90000 }, async () => {
  const TWO = { userFixes: { 'a.example.com': { note: 'A' }, 'b.example.com': { note: 'B' } } };
  const page = await editor(TWO);
  // A closing brace inside a string passes the browser's own parser but not the saving rules.
  await page.fill('#invert', 'a[title="}"]');
  await wait(page);
  assert.equal(await invalid(page, 'invert'), 'true');
  assert.match(await page.textContent('#invert-error'), /a\[title="}"\]/);
  assert.equal(await page.getAttribute('#invert', 'aria-describedby'), 'invert-error');
  assert.equal((await stored('userFixes')).userFixes['a.example.com'].dynamic, undefined);

  // A number outside its range is marked on its own field.
  await page.fill('#invert', '.logo');
  await page.fill('#brightness', '900');
  await wait(page);
  assert.equal(await invalid(page, 'brightness'), 'true');
  assert.equal(await invalid(page, 'invert'), 'false');
  assert.match(await page.textContent('#brightness-error'), /50/);

  // Switching site is blocked and the cursor goes to the wrong field.
  await page.selectOption('#fix-site', 'b.example.com');
  await wait(page, 400);
  assert.equal(await page.inputValue('#fix-site'), 'a.example.com');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'brightness');

  // A correction clears the marks and the save goes through; then the move works.
  await page.fill('#brightness', '90');
  await wait(page);
  assert.equal(await invalid(page, 'brightness'), 'false');
  assert.equal((await stored('userFixes')).userFixes['a.example.com'].dynamic.theme.brightness, 90);
  await page.selectOption('#fix-site', 'b.example.com');
  await page.waitForFunction(() => document.getElementById('editor-title').textContent === 'b.example.com');
  await page.close();
});

test('Style shows only for the E-ink and Paper mode, and Night shift is a field of the editor', { timeout: 60000 }, async () => {
  const page = await editor({ userFixes: { 'a.example.com': {} } });
  assert.equal(await page.isVisible('#einkPreset'), false);
  await page.selectOption('#mode', 'eink');
  assert.equal(await page.isVisible('#einkPreset'), true);
  await page.selectOption('#einkPreset', 'paper');
  await wait(page);
  await page.fill('#warmth', '40');
  await wait(page);
  const theme = (await stored('userFixes')).userFixes['a.example.com'].dynamic.theme;
  assert.equal(theme.einkPreset, 'paper');
  assert.equal(theme.warmth, 40);
  await page.selectOption('#mode', 'dark');
  assert.equal(await page.isVisible('#einkPreset'), false);
  await wait(page);
  assert.equal((await stored('userFixes')).userFixes['a.example.com'].dynamic.theme.einkPreset, undefined);
  await page.close();
});

test('a pasted fix with a host that is not in normal form opens under the normal host', { timeout: 60000 }, async () => {
  const page = await editor({ userFixes: { 'a.example.com': {} } });
  await page.fill('#pasted', JSON.stringify({ host: 'HTTPS://Pasted.Example.COM/', fix: { note: 'pasted' } }));
  await page.click('#paste-apply');
  await page.waitForFunction(() => document.getElementById('editor-title').textContent === 'pasted.example.com');
  assert.equal(await page.inputValue('#note'), 'pasted');
  assert.equal(await page.inputValue('#fix-site'), 'pasted.example.com');
  await page.close();
});

test('settings search leaves the empty-list notes to their lists', { timeout: 60000 }, async () => {
  const page = await settings({ siteRules: { 'a.example.com': {} } }, { hash: '#appearance' });
  await page.fill('#search', 'site');
  assert.equal(await page.isHidden('#site-none'), true);
  assert.equal(await page.isHidden('#preset-none'), true, 'presets note');
  await page.fill('#search', '');
  await page.close();
});

test('numbers out of range show a message and are not sent', { timeout: 60000 }, async () => {
  const page = await settings({ siteRules: { 'a.example.com': {} } }, { hash: '#schedule' });
  await page.selectOption('#autoMode', 'location');
  await page.fill('#lat', '200');
  assert.equal(await invalid(page, 'lat'), 'true');
  assert.match(await page.textContent('#lat-error'), /-90/);
  await wait(page);
  assert.notEqual((await stored('settings')).settings.automation.location.lat, 200);
  await page.fill('#lat', '45.5');
  assert.equal(await invalid(page, 'lat'), 'false');
  await wait(page);
  assert.equal((await stored('settings')).settings.automation.location.lat, 45.5);

  await page.click('#tab-sites');
  await page.click('#site-list .site-toggle');
  const field = page.locator('#site-list [data-f="brightness"]');
  await field.fill('900');
  assert.equal(await field.getAttribute('aria-invalid'), 'true');
  assert.match(await page.locator('#site-list .error:visible').first().textContent(), /50/);
  assert.equal(await page.locator('#site-list label.field .error').count(), 0, 'the message is not inside a label');
  await wait(page);
  assert.equal((await stored('siteRules')).siteRules['a.example.com'].theme, undefined);
  await field.fill('90');
  await wait(page);
  assert.equal((await stored('siteRules')).siteRules['a.example.com'].theme.brightness, 90);
  await page.close();
});

test('the copyright line is isolated in right-to-left languages', { timeout: 120000 }, async () => {
  for (const locale of ['fa', 'ar', 'he']) {
    const page = await settings({}, { locale, hash: '#general' });
    const footer = await page.evaluate(() => {
      const bdi = document.querySelector('.footer-message bdi');
      return bdi && { text: bdi.textContent, isolate: getComputedStyle(bdi).unicodeBidi };
    });
    assert.match(footer.text, /^Copyright/, locale);
    assert.equal(footer.isolate, 'isolate', locale);
    await page.click('#tab-about');
    const legal = await page.evaluate(() => getComputedStyle(document.querySelector('.about-legal bdi')).unicodeBidi);
    assert.equal(legal, 'isolate', locale);
    await page.close();
  }
});

test('Persian selects on the Sites tab show their text in full at 1000 px', { timeout: 60000 }, async () => {
  const page = await settings({ siteRules: { 'a.example.com': { theme: { mode: 'eink' } } } }, { locale: 'fa', hash: '#sites' });
  await page.click('#site-list .site-toggle');
  const cut = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    return [...document.querySelectorAll('#site-list select')].flatMap((s) => {
      const cs = getComputedStyle(s);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const text = s.selectedOptions[0].textContent;
      const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return ctx.measureText(text).width > room ? [`${text} ${room}`] : [];
    });
  });
  assert.deepEqual(cut, []);
  await page.close();
});

test('the shortcut list names the commands in the language of the page, and "Not set" is plain text', { timeout: 60000 }, async () => {
  const page = await settings({}, { locale: 'fa', hash: '#advanced' });
  await page.waitForFunction(() => document.querySelectorAll('#shortcut-list li').length > 0);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#shortcut-list li')].map((li) => ({ text: li.textContent, kbds: li.querySelectorAll('kbd').length, none: li.querySelector('.shortcut-none')?.tagName })));
  assert.ok(rows.some((r) => r.text.includes('تغییر موتور تم') && r.none === 'SPAN' && r.kbds === 0), JSON.stringify(rows));
  assert.ok(rows.every((r) => !/:/.test(r.text)), 'no colon');
  await page.close();
});

test('Persian pages use Latin digits everywhere', { timeout: 60000 }, async () => {
  const page = await editor({ userFixes: { 'a.example.com': { dynamic: { theme: { brightness: 90 } } } } }, { locale: 'fa' });
  assert.match(await page.textContent('#brightness-range'), /50.*150/);
  assert.doesNotMatch(await page.textContent('#brightness-range'), /[۰-۹]/);
  await page.close();
  const options = await settings({ siteRules: { 'a.example.com': {} } }, { locale: 'fa', hash: '#sites' });
  await options.click('#site-list .site-toggle');
  const hint = await options.getAttribute('#site-list [data-f="brightness"]', 'placeholder');
  assert.doesNotMatch(hint, /[۰-۹]/);
  await options.close();
});

test('settings details: preset tooltip, import reset, CSS label, font name, default placeholder', { timeout: 90000 }, async () => {
  const long = 'A very long name for a preset that cannot fit the box';
  const page = await settings({ siteRules: { 'a.example.com': {} }, presets: [{ id: 'p1', name: long, theme: (await stored('settings')).settings?.theme ?? undefined }].slice(0, 0) }, { hash: '#appearance' });
  await page.fill('#preset-name', long);
  await page.click('#preset-save');
  await page.waitForSelector('#preset-list input');
  assert.equal(await page.getAttribute('#preset-list input', 'title'), long);

  // The font name goes back to the default when it is emptied.
  await page.check('[data-setting="theme.fontEnabled"]');
  await page.fill('#fontFamily', 'Georgia');
  await wait(page);
  assert.equal((await stored('settings')).settings.theme.fontFamily, 'Georgia');
  await page.fill('#fontFamily', '');
  await page.press('#fontFamily', 'Tab');
  await wait(page);
  assert.equal((await stored('settings')).settings.theme.fontFamily, 'system-ui');
  assert.equal(await page.inputValue('#fontFamily'), 'system-ui');

  await page.click('#tab-sites');
  await page.click('#site-list .site-toggle');
  assert.match(await page.getAttribute('#site-list [data-f="brightness"]', 'placeholder'), /Default/);
  const label = await page.evaluate(() => {
    const css = document.querySelector('#site-list textarea');
    return document.querySelector(`label[for="${css.id}"]`)?.textContent;
  });
  assert.equal(label, 'CSS for this site');

  await page.click('#tab-data');
  await page.setInputFiles('#import', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await page.waitForFunction(() => document.getElementById('import').value === '');
  await page.close();
});
