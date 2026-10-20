// the popup says when the page uses the site's own dark theme, and a button turns that off, or on again, for the site.
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

const USING = "Tintly is using this site's own dark theme.";
const REPAIRED = "Tintly is using the site's dark theme and fixing its gaps.";
const SITE = ['site-theme', 'site-theme-repaired'];
const WORKING = 'Tintly is working on this page.';

/** The popup reads the status of the tab once, so the page has to have reported before it opens. */
async function reported(want) {
  for (let i = 0; i < 300; i++) {
    const all = await browser.worker.evaluate(() => chrome.storage.session.get(null));
    if (Object.entries(all).some(([k, v]) => k.startsWith('tab:') && want.includes(v?.status))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the page did not report');
}

async function openPopup(path, storage = ON, size = null, want = SITE) {
  await browser.clearStorage();
  await browser.worker.evaluate(() => chrome.storage.session.clear());
  await browser.setStorage(storage);
  const popup = await browser.context.newPage();
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}${path}`);
  await waitState(web, 'ready', 30000);
  await reported(want);
  await web.bringToFront();
  if (size) await popup.setViewportSize(size);
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return { popup, web };
}

const statusIs = (popup, text) => popup.waitForFunction((s) => document.getElementById('status').textContent === s, text, { timeout: 30000 });
const bodyBg = (web) => web.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('a complete site theme: the status says so and the button offers the extension theme', { timeout: 120000 }, async () => {
  const { popup, web } = await openPopup('/site-repair-complete.html');
  await statusIs(popup, USING);
  await popup.waitForSelector('#stheme:not([hidden])');
  assert.equal(await popup.textContent('#stheme-btn'), "Use Tintly's theme instead");
  assert.equal(await popup.getAttribute('#status-dot', 'data-state'), 'info');
  await popup.close();
  await web.close();
});

test('a site theme that needs repair: the status says that parts are fixed', { timeout: 120000 }, async () => {
  const { popup, web } = await openPopup('/site-repair-media.html');
  await statusIs(popup, REPAIRED);
  await popup.waitForSelector('#stheme:not([hidden])');
  await popup.close();
  await web.close();
});

test('a page with no site theme shows no row', { timeout: 120000 }, async () => {
  const { popup, web } = await openPopup('/basic.html', ON, null, ['on']);
  await statusIs(popup, WORKING);
  assert.equal(await popup.isHidden('#stheme'), true);
  await popup.close();
  await web.close();
});

test('the row appears when the page reports its site theme after the window opened', { timeout: 180000 }, async () => {
  const { popup, web } = await openPopup('/site-repair-complete.html', ON, null, SITE);
  await statusIs(popup, USING);
  // The page's verdict can come seconds after the person opened the window: put the page back to its state before the verdict.
  const tabId = await browser.worker.evaluate(async () => (await chrome.tabs.query({ url: 'http://*/*' })).find((t) => t.url.endsWith('site-repair-complete.html')).id);
  await browser.worker.evaluate((id) => chrome.storage.session.set({ [`tab:${id}`]: { status: 'on', at: Date.now() } }), tabId);
  await statusIs(popup, WORKING);
  assert.equal(await popup.isHidden('#stheme'), true);
  await browser.worker.evaluate((id) => chrome.storage.session.set({ [`tab:${id}`]: { status: 'site-theme', at: Date.now() } }), tabId);
  await statusIs(popup, USING);
  await popup.waitForSelector('#stheme:not([hidden])');
  assert.equal(await popup.textContent('#stheme-btn'), "Use Tintly's theme instead");
  await popup.close();
  await web.close();
});

test('a slow verdict on a large page reaches an open window', { timeout: 180000 }, async () => {
  const { popup, web } = await openPopup('/gen/site-dark-large.html?rules=8000', ON, null, ['on', ...SITE]);
  await popup.waitForSelector('#stheme:not([hidden])', { timeout: 60000 });
  // The page has light rules the dark theme does not cover; the repair darkens them, so the notice may say that.
  await popup.waitForFunction(([u, r]) => [u, r].includes(document.getElementById('status').textContent), [USING, REPAIRED], { timeout: 30000 });
  await popup.close();
  await web.close();
});

// The verdict is told to the worker by the callback of the decision that started the engine. A later decision with the same
// engine settings (any write to the settings, the rules, the fixes or the dark list while the page is still judged) drops it.
test('a write to the stored data while the verdict is pending does not lose the notice', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  await browser.worker.evaluate(() => chrome.storage.session.clear());
  await browser.setStorage(ON);
  const web = await browser.context.newPage();
  const status = () => browser.worker.evaluate(async () => Object.entries(await chrome.storage.session.get(null)).filter(([k]) => k.startsWith('tab:')).map(([, v]) => v?.status)[0]);
  const loading = web.goto(`${servers.origin}/gen/site-dark-large.html?rules=8000`);
  for (let i = 0; i < 600 && (await status()) !== 'on'; i++) await new Promise((r) => setTimeout(r, 10));
  await browser.worker.evaluate(() => chrome.storage.local.set({ siteRules: { 'other.example': { enabled: true } } }));
  await loading;
  let last;
  for (let i = 0; i < 300 && !SITE.includes(last); i++) {
    await new Promise((r) => setTimeout(r, 100));
    last = await status();
  }
  assert.ok(SITE.includes(last), `the status stayed ${last}`);
  await web.close();
});

test('the button turns the site theme off for this site only, and the same button turns it on again', { timeout: 180000 }, async () => {
  const { popup, web } = await openPopup('/site-repair-media.html');
  await popup.waitForSelector('#stheme:not([hidden])');
  await statusIs(popup, REPAIRED);
  await popup.click('#stheme-btn');
  await statusIs(popup, WORKING);
  const rules = (await stored('siteRules')).siteRules ?? {};
  assert.equal(rules[host]?.theme?.useSiteDark, false, JSON.stringify(rules));
  assert.equal((await stored('settings')).settings?.theme?.useSiteDark ?? true, true, 'the global setting is not touched');
  await popup.waitForFunction(() => !document.getElementById('stheme').hidden && document.getElementById('stheme-btn').textContent === "Use the site's theme");
  assert.equal(await popup.textContent('#stheme-text'), "The site's own dark theme is off here.");
  await web.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(22, 24, 29)', undefined, { timeout: 15000 });
  assert.equal(await bodyBg(web), 'rgb(22, 24, 29)');
  await popup.click('#stheme-btn');
  await statusIs(popup, REPAIRED);
  const after = (await stored('siteRules')).siteRules ?? {};
  assert.equal(host in after, false, `the rule is removed when it holds nothing else: ${JSON.stringify(after)}`);
  await popup.close();
  await web.close();
});

test('the button keeps the other fields of the site rule', { timeout: 180000 }, async () => {
  const { popup, web } = await openPopup('/site-repair-complete.html', { settings: { enabled: true }, siteRules: { [host]: { css: 'a { color: red }', theme: { brightness: 90 } } } });
  await popup.waitForSelector('#stheme:not([hidden])');
  await popup.click('#stheme-btn');
  await statusIs(popup, WORKING);
  let rule = (await stored('siteRules')).siteRules[host];
  assert.deepEqual(rule, { css: 'a { color: red }', theme: { brightness: 90, useSiteDark: false } });
  await popup.click('#stheme-btn');
  await statusIs(popup, USING);
  rule = (await stored('siteRules')).siteRules[host];
  assert.deepEqual(rule, { css: 'a { color: red }', theme: { brightness: 90 } });
  await popup.close();
  await web.close();
});

test('a fix that turns the site theme off: the row offers it, and the rule beats the fix', { timeout: 180000 }, async () => {
  const fix = { dynamic: { theme: { useSiteDark: false } } };
  const { popup, web } = await openPopup('/site-repair-complete.html', { settings: { enabled: true }, userFixes: { [host]: fix } }, null, ['on']);
  await popup.waitForSelector('#stheme:not([hidden])');
  assert.equal(await popup.textContent('#stheme-btn'), "Use the site's theme");
  await popup.click('#stheme-btn');
  await statusIs(popup, USING);
  assert.equal((await stored('siteRules')).siteRules[host].theme.useSiteDark, true);
  await popup.close();
  await web.close();
});

test('the row fits the fixed window in every language, in both states', { timeout: 400000 }, async () => {
  const presets = Array.from({ length: 12 }, (_, i) => ({
    id: `p-t${i}`,
    name: `A rather long preset name number ${i}`,
    theme: { mode: 'dark', brightness: 90, contrast: 100, sepia: 20, grayscale: 0, darkBackground: '#16181d', darkText: '#e6e8eb', lightBackground: '#eeece8', lightText: '#1a1c20', colorSchemeDark: 'Default', colorSchemeLight: 'Default', fontEnabled: false, fontFamily: 'system-ui', textStroke: 0, scrollbar: 'auto', selection: 'auto', systemControls: true, fade: true },
  }));
  const shots = process.env.DK_SHOTS;
  for (const locale of ['en', 'fa', 'ar', 'he']) {
    for (const name of ['repaired', 'off']) {
      const path = name === 'repaired' ? '/site-repair-media.html' : '/site-repair-complete.html';
      const rules = name === 'off' ? { siteRules: { [host]: { theme: { useSiteDark: false } } } } : {};
      const { popup, web } = await openPopup(path, { settings: { enabled: true }, ui: { locale, uiTheme: locale === 'fa' || locale === 'he' ? 'dark' : 'light' }, presets, ...rules }, { width: 360, height: 600 }, name === 'off' ? ['on'] : SITE);
      await popup.waitForSelector('#stheme:not([hidden])', { timeout: 30000 });
      const m = await popup.evaluate(() => {
        const main = document.querySelector('.main');
        const text = document.getElementById('stheme-text');
        const button = document.getElementById('stheme-btn');
        const status = document.getElementById('status');
        const row = document.getElementById('stheme').getBoundingClientRect();
        const b = button.getBoundingClientRect();
        const tr = text.getBoundingClientRect();
        return {
          page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
          mainY: main.scrollHeight - main.clientHeight,
          mainX: main.scrollWidth - main.clientWidth,
          textClipped: text.scrollHeight - text.clientHeight,
          statusClipped: status.scrollHeight - status.clientHeight,
          buttonClipped: button.scrollWidth - button.clientWidth,
          inside: b.left >= row.left - 0.5 && b.right <= row.right + 0.5 && b.top >= row.top - 0.5 && b.bottom <= row.bottom + 0.5 && tr.left >= row.left - 0.5 && tr.right <= row.right + 0.5,
          overlap: tr.right > b.left + 0.5 && tr.left < b.right - 0.5,
        };
      });
      const label = `${locale} ${name} ${JSON.stringify(m)}`;
      assert.deepEqual(m.page, [360, 600], label);
      assert.equal(m.mainY, 0, `the main view scrolls: ${label}`);
      assert.equal(m.mainX, 0, label);
      assert.ok(m.textClipped <= 0, `the row text is cut: ${label}`);
      assert.ok(m.statusClipped <= 0, `the status is cut: ${label}`);
      assert.ok(m.buttonClipped <= 0, `the button label is cut: ${label}`);
      assert.equal(m.inside, true, label);
      assert.equal(m.overlap, false, label);
      if (shots) await popup.screenshot({ path: `${shots}/popup-sitetheme-${locale}-${name}.png` });
      await popup.close();
      await web.close();
    }
  }
});
