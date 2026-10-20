// when a site rule, a fix or a schedule fixes the mode of a page, the popup says so and offers to use the person's own mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

let servers;
let browser;
let extId;
let host;

before(async () => {
  servers = await startServers();
  browser = await launch();
  extId = new URL(browser.worker.url()).host;
  host = new URL(servers.origin).host;
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const stored = (key) => browser.worker.evaluate((k) => chrome.storage.local.get(k), key);
const ON = { settings: { enabled: true } };
const lum = (css) => {
  const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

async function openPopup(storage, size = null) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const popup = await browser.context.newPage();
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/basic.html`);
  await waitState(web, 'ready');
  await web.bringToFront();
  if (size) await popup.setViewportSize(size);
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  // A site with its own rule opens in its own scope; the notice is about the scope of all sites.
  if (await popup.isVisible('#scope-all')) await popup.click('#scope-all');
  return { popup, web };
}

const pageBg = (web) => web.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('no site rule, fix or schedule: no notice', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  assert.equal(await popup.isHidden('#pin'), true);
  await popup.close();
  await web.close();
});

test('a site rule with a mode: the notice names the mode, and the button gives the choice back to the popup', { timeout: 90000 }, async () => {
  const { popup, web } = await openPopup({ settings: { enabled: true, theme: { mode: 'dark' } }, siteRules: { [host]: { theme: { mode: 'light' }, css: '' } } });
  await popup.waitForSelector('#pin:not([hidden])');
  assert.equal(await popup.textContent('#pin-text'), 'This site uses its own mode: Light');
  assert.equal(await popup.isVisible('#pin-use'), true);
  assert.equal(await popup.isHidden('#pin-schedule'), true);
  await web.waitForFunction(() => getComputedStyle(document.body).backgroundColor !== 'rgb(22, 24, 29)');
  assert.ok(lum(await pageBg(web)) > 0.8, 'the rule keeps the page light');
  // The mode control would change nothing here, so the notice takes its place.
  assert.equal(await popup.isHidden('#mode'), true);
  await popup.click('#pin-use');
  await popup.waitForSelector('#pin', { state: 'hidden' });
  assert.equal(await popup.isVisible('#mode'), true);
  const rules = (await stored('siteRules')).siteRules ?? {};
  assert.equal(rules[host]?.theme?.mode, undefined, JSON.stringify(rules));
  assert.equal(rules[host]?.css, '', 'the rest of the rule stays');
  // The popup's mode applies now: the page is dark again, and a new choice works.
  await web.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(22, 24, 29)', undefined, { timeout: 15000 });
  await popup.click('#mode-paper');
  await web.waitForFunction(() => getComputedStyle(document.body).backgroundColor !== 'rgb(22, 24, 29)', undefined, { timeout: 15000 });
  assert.equal((await stored('settings')).settings.theme.mode, 'eink');
  await popup.close();
  await web.close();
});

test('a rule that holds only the mode is removed by the button', { timeout: 90000 }, async () => {
  const { popup, web } = await openPopup({ settings: { enabled: true }, siteRules: { [host]: { theme: { mode: 'light' } } } });
  await popup.waitForSelector('#pin:not([hidden])');
  await popup.click('#pin-use');
  await popup.waitForSelector('#pin', { state: 'hidden' });
  const rules = (await stored('siteRules')).siteRules ?? {};
  assert.equal(host in rules, false, JSON.stringify(rules));
  await web.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(22, 24, 29)', undefined, { timeout: 15000 });
  await popup.close();
  await web.close();
});

test('a fix with a mode: the notice shows, and the button takes the mode out of the fix and keeps the rest', { timeout: 90000 }, async () => {
  const fix = { dynamic: { theme: { mode: 'light' }, css: 'a { color: red }' } };
  const { popup, web } = await openPopup({ settings: { enabled: true }, userFixes: { [host]: fix } });
  await popup.waitForSelector('#pin:not([hidden])');
  assert.equal(await popup.textContent('#pin-text'), 'This site uses its own mode: Light');
  await popup.click('#pin-use');
  await popup.waitForSelector('#pin', { state: 'hidden' });
  const fixes = (await stored('userFixes')).userFixes ?? {};
  assert.equal(fixes[host]?.dynamic?.theme?.mode, undefined, JSON.stringify(fixes));
  assert.equal(fixes[host]?.dynamic?.css, 'a { color: red }');
  await web.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(22, 24, 29)', undefined, { timeout: 15000 });
  await popup.close();
  await web.close();
});

test('the rule beats the fix: the notice shows the mode of the rule', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup({
    settings: { enabled: true },
    siteRules: { [host]: { theme: { mode: 'eink', einkPreset: 'eink' } } },
    userFixes: { [host]: { dynamic: { theme: { mode: 'light' } } } },
  });
  await popup.waitForSelector('#pin:not([hidden])');
  assert.equal(await popup.textContent('#pin-text'), 'This site uses its own mode: E-ink');
  await popup.close();
  await web.close();
});

test('a schedule that switches between two modes decides: the notice says so and opens the schedule settings, with no button to clear', { timeout: 60000 }, async () => {
  const automation = { mode: 'time', behavior: 'scheme', activeMode: 'dark', idleMode: 'light', time: { from: '00:00', to: '23:59' } };
  const { popup, web } = await openPopup({ settings: { enabled: true, automation } });
  await popup.waitForSelector('#pin:not([hidden])');
  assert.equal(await popup.textContent('#pin-text'), 'The schedule sets the mode on this page.');
  assert.equal(await popup.isHidden('#pin-use'), true);
  assert.equal(await popup.isVisible('#pin-schedule'), true);
  assert.match(await popup.getAttribute('#pin-schedule', 'href'), /options\.html#schedule$/);
  // The on and off schedule does not fix the mode.
  await popup.close();
  await web.close();
  const off = await openPopup({ settings: { enabled: true, automation: { ...automation, behavior: 'onOff' } } });
  assert.equal(await off.popup.isHidden('#pin'), true);
  await off.popup.close();
  await off.web.close();
});

test('the notice fits the fixed window in every language, with a site rule, a fix and a schedule, and many presets', { timeout: 300000 }, async () => {
  const presets = Array.from({ length: 12 }, (_, i) => ({
    id: `p-t${i}`,
    name: `A rather long preset name number ${i}`,
    theme: { mode: 'dark', brightness: 90, contrast: 100, sepia: 20, grayscale: 0, darkBackground: '#16181d', darkText: '#e6e8eb', lightBackground: '#eeece8', lightText: '#1a1c20', colorSchemeDark: 'Default', colorSchemeLight: 'Default', fontEnabled: false, fontFamily: 'system-ui', textStroke: 0, scrollbar: 'auto', selection: 'auto', systemControls: true, fade: true },
  }));
  const automation = { mode: 'time', behavior: 'scheme', activeMode: 'dark', idleMode: 'light', time: { from: '00:00', to: '23:59' } };
  const cases = {
    rule: { siteRules: { [host]: { theme: { mode: 'eink', einkPreset: 'eink' } } } },
    fix: { userFixes: { [host]: { dynamic: { theme: { mode: 'eink', einkPreset: 'paper' } } } } },
    schedule: {},
  };
  const shots = process.env.DK_SHOTS;
  for (const locale of ['en', 'fa', 'ar', 'he']) {
    for (const [name, extra] of Object.entries(cases)) {
      const settings = name === 'schedule' ? { enabled: true, automation } : { enabled: true };
      const { popup, web } = await openPopup({ settings, ui: { locale, uiTheme: locale === 'fa' || locale === 'he' ? 'dark' : 'light' }, presets, ...extra }, { width: 360, height: 600 });
      await popup.waitForSelector('#pin:not([hidden])');
      const m = await popup.evaluate(() => {
        const box = (sel) => document.querySelector(sel).getBoundingClientRect();
        const card = box('.card.theme');
        const parts = ['#pin-text', '#pin-use', '#pin-schedule', '#pin-use:not([hidden])', '#pin-schedule:not([hidden])'].map((s) => document.querySelector(s)).filter(Boolean);
        const inside = parts.filter((el) => !el.hidden).every((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= card.left - 0.5 && r.right <= card.right + 0.5 && r.top >= card.top - 0.5 && r.bottom <= card.bottom + 0.5;
        });
        const text = document.getElementById('pin-text');
        const button = document.querySelector('#pin .btn:not([hidden])');
        return {
          page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
          mainY: document.querySelector('.main').scrollHeight - document.querySelector('.main').clientHeight,
          mainX: document.querySelector('.main').scrollWidth - document.querySelector('.main').clientWidth,
          inside,
          textClipped: text.scrollHeight - text.clientHeight,
          buttonClipped: button.scrollWidth - button.clientWidth,
          buttonHeight: Math.round(button.getBoundingClientRect().height),
          footer: Math.round(document.querySelector('.dock').getBoundingClientRect().bottom),
        };
      });
      const label = `${locale} ${name} ${JSON.stringify(m)}`;
      assert.deepEqual(m.page, [360, 600], label);
      assert.equal(m.mainY, 0, `the main view scrolls: ${label}`);
      assert.equal(m.mainX, 0, label);
      assert.equal(m.inside, true, label);
      assert.ok(m.textClipped <= 0, `the notice text is cut: ${label}`);
      assert.ok(m.buttonClipped <= 0, `the button label is cut: ${label}`);
      if (shots) await popup.screenshot({ path: `${shots}/popup-pin-${locale}-${name}.png` });
      await popup.close();
      await web.close();
    }
  }
});
