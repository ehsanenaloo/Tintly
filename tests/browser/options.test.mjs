import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const stored = (key) => browser.worker.evaluate((k) => chrome.storage.local.get(k), key);

async function openOptions(storage = { settings: { enabled: true } }) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/options/options.html`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return page;
}

async function openWeb(path = '/basic.html') {
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}${path}`);
  await waitState(web, 'ready');
  return web;
}

const settle = (page) => page.waitForTimeout(500);
const show = (page, name) => page.click(`#tab-${name}`);

test('every setting shows its stored value, and a change reaches storage and an open tab', { timeout: 90000 }, async () => {
  const web = await openWeb();
  const page = await openOptions({ settings: { enabled: true, theme: { brightness: 90 } } });
  assert.equal(await page.inputValue('#brightness'), '90');
  const bg = () => web.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = await bg();

  await show(page, 'general');
  await page.selectOption('#listMode', 'onlyListed');
  await page.selectOption('#engine', 'dynamic');
  await page.uncheck('[data-setting="detectDark"]');
  await page.uncheck('[data-setting="holdPaint"]');
  await show(page, 'appearance');
  await page.fill('#brightness', '65');
  await page.fill('#darkBackground', '#102030');
  await page.check('[data-setting="theme.fontEnabled"]');
  await page.fill('#fontFamily', 'Verdana');
  await page.fill('#textStroke', '4');
  await page.check('#scrollbar-auto');
  await settle(page);
  const s = (await stored('settings')).settings;
  assert.equal(s.theme.brightness, 65);
  assert.equal(s.listMode, 'onlyListed');
  assert.equal(s.detectDark, false);
  assert.equal(s.holdPaint, false);
  assert.equal(s.theme.darkBackground.toLowerCase(), '#102030');
  assert.equal(s.theme.fontFamily, 'Verdana');
  assert.equal(s.theme.fontEnabled, true);
  assert.equal(s.theme.textStroke, 4);
  assert.equal(s.theme.scrollbar, 'auto');
  await settle(page);
  assert.notEqual(await bg(), before);
  await page.close();
  await web.close();
});

test('a change made in the popup shows on the settings page', { timeout: 60000 }, async () => {
  const page = await openOptions();
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'dk.settings.patch', patch: { theme: { contrast: 77 } } }));
  await page.waitForFunction(() => document.getElementById('contrast').value === '77');
  await page.close();
});

test('custom CSS is saved, and a broken one is reported and not saved', { timeout: 60000 }, async () => {
  const page = await openOptions();
  await show(page, 'advanced');
  await page.fill('#css', 'p { color: red; }');
  await settle(page);
  assert.equal((await stored('settings')).settings.theme.css, 'p { color: red; }');
  assert.equal(await page.isHidden('#css-error'), true);
  await page.fill('#css', 'p { color: red; ');
  await settle(page);
  assert.equal(await page.isVisible('#css-error'), true);
  assert.equal((await stored('settings')).settings.theme.css, 'p { color: red; }');
  await page.close();
});

test('site rules can be added, changed and removed', { timeout: 60000 }, async () => {
  const web = await openWeb();
  const host = new URL(servers.origin).host;
  const page = await openOptions();
  await show(page, 'sites');
  await page.fill('#site-pattern', host);
  await page.click('#site-add');
  await page.waitForSelector('#site-list li');
  assert.equal((await stored('siteRules')).siteRules[host].enabled, true);

  await page.selectOption('#site-list [data-f="enabled"]', 'off');
  await waitState(web, null);
  assert.equal((await stored('siteRules')).siteRules[host].enabled, false);
  await page.selectOption('#site-list [data-f="enabled"]', 'on');
  await waitState(web, 'ready');
  await page.selectOption('#site-list [data-f="mode"]', 'light');
  await page.fill('#site-list [data-f="brightness"]', '80');
  await page.fill('#site-list [data-f="css"]', 'body { margin: 0; }');
  await settle(page);
  const rule = (await stored('siteRules')).siteRules[host];
  assert.deepEqual([rule.theme.mode, rule.theme.brightness, rule.css], ['light', 80, 'body { margin: 0; }']);

  await page.fill('#site-pattern', 'not a site!!');
  await page.click('#site-add');
  await settle(page);
  assert.equal(Object.keys((await stored('siteRules')).siteRules).length, 1);

  await page.click('#site-list .site-remove');
  await page.click('#site-list .site-remove');
  await settle(page);
  assert.deepEqual((await stored('siteRules')).siteRules, {});
  assert.equal(await page.isVisible('#site-none'), true);
  await page.close();
  await web.close();
});

test('presets can be saved, renamed, applied, exported and deleted', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, theme: { sepia: 30 } } });
  await show(page, 'appearance');
  await page.fill('#preset-name', 'Warm');
  await page.click('#preset-save');
  await page.waitForSelector('#preset-list li');
  let presets = (await stored('presets')).presets;
  assert.equal(presets.length, 1);
  assert.equal(presets[0].theme.sepia, 30);
  assert.equal(presets[0].theme.css, undefined);

  await page.fill('#preset-list input[type="text"]', 'Warmer');
  await page.click('#preset-list button:has-text("Rename")');
  await settle(page);
  presets = (await stored('presets')).presets;
  assert.deepEqual([presets.length, presets[0].name], [1, 'Warmer']);

  await page.fill('#sepia', '0');
  await settle(page);
  await page.click('#preset-list button:has-text("Apply")');
  await settle(page);
  assert.equal((await stored('settings')).settings.theme.sepia, 30);
  assert.equal(await page.inputValue('#sepia'), '30');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#preset-list button:has-text("Export")')]);
  assert.match(download.suggestedFilename(), /^tintly-preset-.+\.json$/);

  await page.click('#preset-list button:has-text("Delete")');
  await page.click('#preset-list button:has-text("Press again")');
  await settle(page);
  assert.deepEqual((await stored('presets')).presets, []);
  await page.close();
});

test('export, import with a confirmation, and reset', { timeout: 90000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, theme: { brightness: 88 } } });
  await show(page, 'data');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const dir = mkdtempSync(join(tmpdir(), 'dk-opt-'));
  const file = join(dir, 'out.json');
  await download.saveAs(file);
  const exported = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8'));
  assert.equal(exported.app, 'tintly');
  assert.equal(exported.settings.theme.brightness, 88);

  exported.settings.theme.brightness = 61;
  const changed = join(dir, 'in.json');
  writeFileSync(changed, JSON.stringify(exported));
  await page.setInputFiles('#import', changed);
  await page.waitForSelector('#import-box:not([hidden])');
  assert.equal((await stored('settings')).settings.theme.brightness, 88);
  await page.click('#import-apply');
  await page.waitForFunction(() => document.getElementById('brightness').value === '61');
  assert.equal((await stored('settings')).settings.theme.brightness, 61);

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{"app":"other"}');
  await page.setInputFiles('#import', bad);
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('cannot be used'));
  assert.equal(await page.isHidden('#import-box'), true);

  await page.click('#reset');
  assert.equal((await stored('settings')).settings.theme.brightness, 61);
  await page.click('#reset');
  await page.waitForFunction(() => document.getElementById('brightness').value === '100');
  assert.equal((await stored('settings')).settings.theme.brightness, 100);
  await page.close();
});

test('the language and look are kept for this device and apply at once', { timeout: 60000 }, async () => {
  const page = await openOptions();
  await show(page, 'general');
  await Promise.all([page.waitForNavigation(), page.selectOption('#locale', 'fa')]);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  await show(page, 'general');
  assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
  assert.equal((await stored('ui')).ui.locale, 'fa');
  await Promise.all([page.waitForNavigation(), page.selectOption('#uiTheme', 'dark')]);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.close();
});

test('search keeps only matching settings and sections', { timeout: 60000 }, async () => {
  const page = await openOptions();
  const visible = () => page.evaluate(() => [...document.querySelectorAll('[data-section]')].filter((s) => !s.hidden).length);
  const total = await visible();
  await page.fill('#search', 'brightness');
  assert.equal(await visible(), 1);
  assert.equal(await page.isVisible('#brightness'), true);
  assert.equal(await page.isHidden('#fontFamily'), true);
  await page.fill('#search', 'zzzzzz');
  assert.equal(await visible(), 0);
  await page.fill('#search', '');
  assert.equal(await visible(), total);
  await page.close();
});

test('shortcuts are listed, and the version and privacy text show', { timeout: 60000 }, async () => {
  const page = await openOptions();
  await show(page, 'general');
  await page.waitForSelector('#shortcut-list li');
  const text = await page.textContent('#shortcut-list');
  assert.match(text, /Alt\+Shift\+D/);
  await show(page, 'about');
  assert.match(await page.textContent('#version'), /^Version \d/);
  assert.match(await page.textContent('#panel-about'), /does not collect data/);
  await page.close();
});

test('every control has a name, and the page fits in each language, both color schemes and a narrow window', { timeout: 180000 }, async () => {
  for (const locale of ['en', 'fa', 'ar', 'he']) {
    for (const scheme of ['light', 'dark']) {
      const page = await openOptions({ settings: { enabled: true }, ui: { locale } });
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [1000, 360]) {
        await page.setViewportSize({ width, height: 800 });
        const fit = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
        assert.ok(fit.w <= fit.c, `${locale} ${scheme} ${width}: sideways scroll ${JSON.stringify(fit)}`);
      }
      const text = await page.evaluate(() => document.body.innerText);
      assert.doesNotMatch(text, /\b(opt|popup|theme|mode|engine|options)\.[a-zA-Z]+/, `${locale}: a key shows`);
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll('input, select, textarea, button')].filter((el) => !(el.labels?.length || el.getAttribute('aria-label') || el.textContent.trim())).map((el) => el.id || el.outerHTML.slice(0, 60)),
      );
      assert.deepEqual(unnamed, [], `${locale}`);
      await page.close();
    }
  }
});

test('tabs: the address hash picks a tab, arrow keys move between tabs, and only one tab is in the tab order', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/options/options.html#schedule`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  assert.equal(await page.getAttribute('#tab-schedule', 'aria-selected'), 'true');
  assert.equal(await page.isVisible('#autoMode'), true);
  assert.equal(await page.isHidden('#brightness'), true);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#tabs [role="tab"][tabindex="0"]').length), 1);

  await page.focus('#tab-schedule');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getAttribute('#tab-advanced', 'aria-selected'), 'true');
  assert.equal(await page.evaluate(() => location.hash), '#advanced');
  assert.equal(await page.isVisible('#css'), true);
  await page.keyboard.press('End');
  assert.equal(await page.getAttribute('#tab-about', 'aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await page.getAttribute('#tab-general', 'aria-selected'), 'true');
  for (const tab of await page.$$('#tabs [role="tab"]')) {
    const panel = await tab.getAttribute('aria-controls');
    assert.ok(await page.$(`#${panel}[role="tabpanel"]`), panel);
  }
  await page.close();
});

test('the schedule rows follow the chosen mode', { timeout: 60000 }, async () => {
  const page = await openOptions();
  await show(page, 'schedule');
  assert.equal(await page.isHidden('#timeFrom'), true);
  await page.selectOption('#autoMode', 'time');
  assert.equal(await page.isVisible('#timeFrom'), true);
  assert.equal(await page.isHidden('#lat'), true);
  await page.selectOption('#autoMode', 'location');
  assert.equal(await page.isVisible('#lat'), true);
  await page.close();
});

test('the support reminder can be turned off and on from the settings', { timeout: 60000 }, async () => {
  const page = await openOptions();
  await show(page, 'general');
  assert.equal(await page.isChecked('#supportNudge'), true);
  await page.uncheck('#supportNudge');
  await settle(page);
  assert.equal((await stored('ui')).ui.support.optOut, true);
  await page.check('#supportNudge');
  await settle(page);
  assert.equal((await stored('ui')).ui.support.optOut, false);
  await page.close();
});

test('the header switch changes the look of the pages, and the menu opens the About tab', { timeout: 60000 }, async () => {
  const page = await openOptions();
  await page.click('#theme-dark');
  await page.click('#overflowBtn');
  assert.equal(await page.isVisible('#overflowMenu'), true);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await settle(page);
  assert.equal((await stored('ui')).ui.uiTheme, 'dark');
  await page.keyboard.press('Escape');
  assert.equal(await page.isHidden('#overflowMenu'), true);
  await page.click('#overflowBtn');
  await page.click('#menu-about');
  assert.equal(await page.getAttribute('#tab-about', 'aria-selected'), 'true');
  await page.close();
});

test('the footer shows the owner links and hides items that have no address', { timeout: 60000 }, async () => {
  const page = await openOptions();
  const ids = await page.evaluate(() => [...document.querySelectorAll('.footer-tab')].map((el) => el.id));
  assert.ok(ids.includes('footer-tab-about') && ids.includes('footer-tab-support'), String(ids));
  assert.ok(ids.includes('footer-tab-rate'), String(ids));
  await page.click('#footer-tab-support');
  assert.equal(await page.getAttribute('#footer-tab-support', 'aria-selected'), 'true');
  await page.close();
});

/** Let a test see and hold the messages a page sends: `window.__hook.before` and `.after` may wait, `window.__log` lists the sends. */
const tapMessages = (page) =>
  page.evaluate(() => {
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__log = [];
    window.__hook = {};
    chrome.runtime.sendMessage = async (msg) => {
      window.__log.push({ type: msg.type, at: performance.now() });
      if (window.__hook.before) await window.__hook.before(msg);
      const reply = await orig(msg);
      if (window.__hook.after) await window.__hook.after(msg, reply);
      return reply;
    };
  });

test('an older answer of the worker does not replace a newer one', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, theme: { brightness: 90 } } });
  await tapMessages(page);
  await page.evaluate(() => {
    let n = 0;
    window.__hook.after = async (msg) => {
      if (msg.type === 'dk.state.get' && (n += 1) === 1) await new Promise((resolve) => (window.__release = resolve));
    };
  });
  await browser.setStorage({ settings: { enabled: true, theme: { brightness: 70 } } });
  await page.waitForFunction(() => window.__log.some((m) => m.type === 'dk.state.get'));
  await browser.setStorage({ settings: { enabled: true, theme: { brightness: 60 } } });
  await page.waitForFunction(() => document.getElementById('brightness').value === '60');
  await page.evaluate(() => window.__release());
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#brightness'), '60');
  await page.close();
});

test('a change reported while a save runs is shown after the save, and does not undo it', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, theme: { brightness: 90 } } });
  await tapMessages(page);
  await page.evaluate(() => {
    window.__hook.before = async (msg) => {
      if (msg.type === 'dk.settings.patch') await new Promise((resolve) => (window.__release = resolve));
    };
    const el = document.getElementById('brightness');
    el.value = '80';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => window.__log.some((m) => m.type === 'dk.settings.patch'));
  await browser.setStorage({ settings: { enabled: true, theme: { brightness: 55 } } });
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#brightness'), '80');
  await page.evaluate(() => window.__release());
  await page.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.theme.brightness === 80);
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#brightness'), '80');
  await page.close();
});

test('a reset drops the change that was waiting to be saved', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, theme: { brightness: 90 } } });
  await page.evaluate(() => {
    const el = document.getElementById('brightness');
    el.value = '65';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const reset = document.getElementById('reset');
    reset.click();
    reset.click();
  });
  await page.waitForTimeout(800);
  assert.equal((await stored('settings')).settings.theme.brightness, 100);
  assert.equal(await page.inputValue('#brightness'), '100');
  await page.close();
});

test('adding a site that has a rule keeps the rule', { timeout: 60000 }, async () => {
  const rule = { enabled: false, engine: 'filter', css: 'a { color: red; }' };
  const page = await openOptions({ settings: { enabled: true }, siteRules: { 'example.com': rule } });
  await show(page, 'sites');
  await page.fill('#site-pattern', 'EXAMPLE.COM');
  await page.click('#site-add');
  await settle(page);
  assert.deepEqual((await stored('siteRules')).siteRules, { 'example.com': rule });
  await page.fill('#site-pattern', 'Other.Example.org');
  await page.click('#site-add');
  await page.waitForFunction(async () => 'other.example.org' in (await chrome.storage.local.get('siteRules')).siteRules);
  assert.deepEqual((await stored('siteRules')).siteRules['other.example.org'], { enabled: true });
  await page.close();
});

test('the font name is disabled while "Change the font" is off, says why, and keeps its value', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, theme: { fontEnabled: false, fontFamily: 'Georgia', textStroke: 3 } } });
  await show(page, 'appearance');
  assert.equal(await page.isDisabled('#fontFamily'), true);
  assert.equal(await page.isVisible('#fontFamilyHint'), true);
  assert.equal(await page.getAttribute('#fontFamily', 'aria-describedby'), 'fontFamilyHint');
  assert.equal(await page.inputValue('#fontFamily'), 'Georgia');
  // The stroke works without the font switch (extras.js), so it stays open.
  assert.equal(await page.isDisabled('#textStroke'), false);
  await page.check('[data-setting="theme.fontEnabled"]');
  assert.equal(await page.isDisabled('#fontFamily'), false);
  assert.equal(await page.isHidden('#fontFamilyHint'), true);
  await page.fill('#fontFamily', 'Verdana');
  await page.uncheck('[data-setting="theme.fontEnabled"]');
  assert.equal(await page.isDisabled('#fontFamily'), true);
  await settle(page);
  const theme = (await stored('settings')).settings.theme;
  assert.deepEqual([theme.fontEnabled, theme.fontFamily], [false, 'Verdana']);
  await page.reload();
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  await show(page, 'appearance');
  assert.equal(await page.isDisabled('#fontFamily'), true);
  assert.equal(await page.inputValue('#fontFamily'), 'Verdana');
  await page.close();
});

const SITE_RULE = { enabled: false, theme: { mode: 'light', brightness: 80 }, css: 'body { margin: 0; }' };

test('a deleted site rule comes back with Undo, and Undo does not overwrite a rule added meanwhile', { timeout: 60000 }, async () => {
  const host = new URL(servers.origin).host;
  const page = await openOptions({ settings: { enabled: true }, siteRules: { [host]: SITE_RULE } });
  await show(page, 'sites');
  await page.click('#site-list .site-remove');
  await page.click('#site-list .site-remove');
  await page.waitForSelector('#message .say-action');
  assert.deepEqual((await stored('siteRules')).siteRules, {});
  assert.ok((await page.textContent('#message')).includes(`Rule for ${host} deleted`));
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('say-action')), true, 'Undo has the focus');
  await page.click('#message .say-action');
  await page.waitForSelector('#site-list li');
  assert.deepEqual((await stored('siteRules')).siteRules[host], SITE_RULE);
  assert.equal(await page.textContent('#message'), 'Restored.');
  assert.equal(await page.locator('#message .say-action').count(), 0);

  // A rule for the same site that appears before Undo is pressed is kept.
  await page.click('#site-list .site-remove');
  await page.click('#site-list .site-remove');
  await page.waitForSelector('#message .say-action');
  await page.evaluate((h) => chrome.runtime.sendMessage({ type: 'dk.site.set', pattern: h, rule: { enabled: true } }), host);
  await page.click('#message .say-action');
  await page.waitForFunction(() => /exists again/.test(document.getElementById('message').textContent));
  assert.deepEqual((await stored('siteRules')).siteRules[host], { enabled: true });
  await page.close();
});

test('a site rule whose custom CSS is still held for review has no Undo', { timeout: 60000 }, async () => {
  const host = new URL(servers.origin).host;
  const page = await openOptions({ settings: { enabled: true }, siteRules: { [host]: { css: 'body { margin: 0; }', cssHeld: true } } });
  await show(page, 'sites');
  await page.click('#site-list .site-remove');
  await page.click('#site-list .site-remove');
  await page.waitForFunction(() => /deleted/.test(document.getElementById('message').textContent));
  assert.deepEqual((await stored('siteRules')).siteRules, {});
  assert.equal(await page.locator('#message .say-action').count(), 0);
  await page.close();
});

test('a deleted preset comes back with Undo under the same id', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, theme: { sepia: 30 } } });
  await show(page, 'appearance');
  await page.fill('#preset-name', 'Warm');
  await page.click('#preset-save');
  await page.waitForSelector('#preset-list li');
  const before = (await stored('presets')).presets;
  await page.click('#preset-list button:has-text("Delete")');
  await page.click('#preset-list button:has-text("Press again")');
  await page.waitForSelector('#message .say-action');
  assert.deepEqual((await stored('presets')).presets, []);
  assert.match(await page.textContent('#message'), /Preset Warm deleted/);
  await page.click('#message .say-action');
  await page.waitForSelector('#preset-list li');
  assert.deepEqual((await stored('presets')).presets, before);
  await page.close();
});

test('the Undo message stays while the pointer or the focus is on it and goes after the window', { timeout: 60000 }, async () => {
  const host = new URL(servers.origin).host;
  const page = await openOptions({ settings: { enabled: true }, siteRules: { [host]: SITE_RULE } });
  await show(page, 'sites');
  await page.click('#site-list .site-remove');
  await page.click('#site-list .site-remove');
  await page.waitForSelector('#message .say-action');
  await page.hover('#message');
  await page.waitForTimeout(10500);
  assert.equal(await page.locator('#message .say-action').count(), 1, 'it waits for the pointer');
  // Undo has the focus, which also holds the message; a click elsewhere lets it go.
  await page.mouse.click(5, 400);
  await page.waitForFunction(() => document.getElementById('message').textContent === '', undefined, { timeout: 15000 });
  await page.close();
});

test('the number fields of a site rule say their range', { timeout: 60000 }, async () => {
  const host = new URL(servers.origin).host;
  const page = await openOptions({ settings: { enabled: true }, siteRules: { [host]: { enabled: true } } });
  await show(page, 'sites');
  await page.click('#site-list .site-toggle');
  const titles = await page.$$eval('#site-list input[type="number"]', (els) => els.map((el) => [el.dataset.f, el.title]));
  assert.deepEqual(titles, [['brightness', '50 to 150'], ['contrast', '50 to 150'], ['sepia', '0 to 100'], ['grayscale', '0 to 100'], ['warmth', '0 to 100']]);
  await page.close();
});

test('a change made while the settings page is still starting is shown when it has started', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { brightness: 90 } } });
  const page = await browser.context.newPage();
  // The first read of the worker is answered, and the answer reaches the page late: a change that lands in between must not be lost.
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => {
      const reply = send(message, ...rest);
      if (message?.type !== 'dk.state.get' || globalThis.__held) return reply;
      globalThis.__held = 1;
      return reply.then((value) => {
        globalThis.__held = 2;
        return new Promise((resolve) => setTimeout(() => resolve(value), 1200));
      });
    };
  });
  await page.goto(`chrome-extension://${extId}/pages/options/options.html`);
  await page.waitForFunction(() => globalThis.__held === 2);
  await browser.setStorage({ settings: { enabled: true, theme: { brightness: 70 } } });
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  await page.waitForFunction(() => document.getElementById('brightness').value === '70', null, { timeout: 5000 });
  await page.close();
});

test('a long site list shows closed rows a page at a time, opens one on a click, and a search finds a site past the page', { timeout: 60000 }, async () => {
  const siteRules = {};
  for (let i = 0; i < 120; i++) siteRules[`site-${String(i).padStart(3, '0')}.example`] = i === 0 ? { enabled: false, theme: { mode: 'eink', einkPreset: 'paper', cvdType: 'protan' } } : { enabled: true };
  const page = await openOptions({ settings: { enabled: true }, siteRules });
  await show(page, 'sites');
  assert.equal(await page.locator('#site-list > li').count(), 50);
  assert.equal(await page.locator('#site-list select').count(), 0, 'closed rows have no fields yet');
  assert.equal(await page.textContent('#site-list > li:first-child .site-summary'), 'Off · Paper · Red weak (protan)');
  const first = page.locator('#site-list > li').first();
  assert.equal(await first.locator('.site-toggle').getAttribute('aria-expanded'), 'false');
  await first.locator('.site-toggle').click();
  assert.equal(await first.locator('.site-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await first.locator('[data-f="mode"]').inputValue(), 'eink');
  await page.click('#site-more');
  assert.equal(await page.locator('#site-list > li').count(), 100);
  assert.equal(await first.locator('[data-f="mode"]').isVisible(), true, 'an open row stays open');
  await page.fill('#search', 'site-115');
  await page.waitForFunction(() => [...document.querySelectorAll('#site-list > li')].some((li) => !li.hidden && li.getAttribute('aria-label') === 'site-115.example'));
  await page.fill('#search', '');
  await page.waitForFunction(() => document.querySelectorAll('#site-list > li').length === 100);
  await page.close();
});

test('the color vision intensity is disabled while the filter does nothing, says why, and keeps its value', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, theme: { mode: 'original', cvdType: 'grayscale', cvdSeverity: 40 } } });
  await show(page, 'appearance');
  const look = () =>
    page.evaluate(() => {
      const s = /** @type {HTMLInputElement} */ (document.getElementById('cvdSeverity'));
      return { disabled: s.disabled, value: s.value, describedBy: s.getAttribute('aria-describedby'), hint: !document.getElementById('cvdOriginalOnly').hidden };
    });
  assert.deepEqual(await look(), { disabled: false, value: '40', describedBy: null, hint: false }, 'a plain filter works in Original');
  await page.selectOption('#mode', 'dark');
  assert.deepEqual(await look(), { disabled: true, value: '40', describedBy: 'cvdOriginalOnly', hint: true }, 'the same filter in Dark does nothing');
  await page.selectOption('#mode', 'light');
  assert.equal((await look()).disabled, true, 'and in Light');
  await settle(page);
  assert.deepEqual([(await stored('settings')).settings.theme.cvdType, (await stored('settings')).settings.theme.cvdSeverity], ['grayscale', 40]);
  await page.selectOption('#mode', 'original');
  assert.deepEqual(await look(), { disabled: false, value: '40', describedBy: null, hint: false }, 'back in Original the filter is as it was');
  await page.selectOption('#mode', 'dark');
  await page.selectOption('#cvdType', 'deutan');
  assert.equal((await look()).disabled, false, 'a deficiency type works with a theme');
  await page.selectOption('#cvdType', 'none');
  assert.equal((await look()).disabled, true, 'no type');
  await page.close();
  const eink = await openOptions({ settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'eink', einkColorAmount: 0, cvdType: 'protan', cvdSeverity: 70 } } });
  await show(eink, 'appearance');
  const got = await eink.evaluate(() => {
    const s = /** @type {HTMLInputElement} */ (document.getElementById('cvdSeverity'));
    return { disabled: s.disabled, value: s.value, describedBy: s.getAttribute('aria-describedby') };
  });
  assert.deepEqual(got, { disabled: true, value: '70', describedBy: 'cvdNoColor' }, 'E-ink with no color has nothing to correct');
  await eink.close();
});

test('the site editor sends only the fields it changed: a change another window made to the same site stays', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true }, siteRules: { 'a.example': { enabled: true, engine: 'auto' } } });
  await show(page, 'sites');
  await page.click('#site-list .site-toggle');
  await page.waitForSelector('#site-list [data-f="brightness"]');
  // Another window (the toolbar window) turns the site off while the editor still shows it on.
  const other = await browser.context.newPage();
  await other.goto(`chrome-extension://${extId}/pages/options/options.html`);
  const reply = await other.evaluate(() => chrome.runtime.sendMessage({ type: 'dk.site.patch', pattern: 'a.example', patch: { enabled: false } }));
  assert.equal(reply.ok, true);
  await other.close();
  await page.selectOption('#site-list [data-f="engine"]', 'filter');
  await settle(page);
  assert.deepEqual((await stored('siteRules')).siteRules['a.example'], { enabled: false, engine: 'filter' });
  await page.close();
});

test('clearing the last shown theme field removes only that field: hidden theme fields and ones another window added stay', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true }, siteRules: { 'b.example': { engine: 'filter', theme: { mode: 'dark', cvdMedia: true } } } });
  await show(page, 'sites');
  await page.click('#site-list .site-toggle');
  await page.waitForSelector('#site-list [data-f="mode"]');
  // Another window adds a theme field that this editor does not show.
  const other = await browser.context.newPage();
  await other.goto(`chrome-extension://${extId}/pages/options/options.html`);
  assert.equal((await other.evaluate(() => chrome.runtime.sendMessage({ type: 'dk.site.patch', pattern: 'b.example', patch: { theme: { cvdSeverity: 40 } } }))).ok, true);
  await other.close();
  await page.selectOption('#site-list [data-f="mode"]', '');
  await settle(page);
  assert.deepEqual((await stored('siteRules')).siteRules['b.example'], { engine: 'filter', theme: { cvdMedia: true, cvdSeverity: 40 } });
  await page.close();
});
