// the popup saves its changes for all sites or for the site of the tab only, so one site can keep its own mode.
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

const stored = () => browser.worker.evaluate(() => chrome.storage.local.get(['settings', 'siteRules']));

// The window asks for the active tab, so the page is brought to the front after the window's own tab is made.
async function openPopup(web) {
  const popup = await browser.context.newPage();
  await web.bringToFront();
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return popup;
}

const checked = (popup, id) => popup.evaluate((i) => document.getElementById(i).getAttribute('aria-checked'), id);

test('a change for this site goes into the rule of the site and leaves the settings of all sites as they are', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/cvd.html`);
  await waitState(web, 'ready', 30000);
  let popup = await openPopup(web);
  assert.equal(await checked(popup, 'scope-all'), 'true', 'a site without a rule starts with all sites');
  await popup.click('#scope-site');
  await popup.click('#mode-paper');
  // The plain filters work in Original only.
  assert.equal(await popup.evaluate(() => document.querySelector('#cvd option[value="grayscale"]').disabled), true);
  await popup.selectOption('#cvd', 'deutan');
  await popup.close();
  let s;
  for (let i = 0; i < 50; i++) {
    s = await stored();
    if (s.siteRules?.[host]?.theme?.cvdType === 'deutan') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(s.siteRules[host].theme.mode, 'eink', JSON.stringify(s.siteRules));
  assert.equal(s.siteRules[host].theme.einkPreset, 'paper');
  assert.equal(s.siteRules[host].theme.cvdType, 'deutan');
  assert.equal(s.settings.theme.mode, 'dark', 'all sites keep their mode');
  assert.equal(s.settings.theme.cvdType ?? 'none', 'none');
  assert.equal(s.siteRules[host].enabled, undefined, 'the rule does not switch the site');
  // The page follows the rule: a light paper page.
  await web.waitForFunction(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return r > 180 && g > 180 && b > 150;
  }, undefined, { timeout: 15000 });
  // The window opens in the scope of this site again and shows the site's mode; all sites show their own.
  popup = await openPopup(web);
  assert.equal(await checked(popup, 'scope-site'), 'true');
  assert.equal(await checked(popup, 'mode-paper'), 'true');
  assert.equal(await popup.evaluate(() => document.getElementById('cvd').value), 'deutan');
  await popup.click('#scope-all');
  assert.equal(await checked(popup, 'mode-dark'), 'true');
  assert.equal(await popup.evaluate(() => document.getElementById('pin').hidden), false, 'the rule of the site is named');
  await popup.close();
  await web.close();
});

test('the window can set Tintly to work only on the sites turned on, and the site in front stays on', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/cvd.html`);
  await waitState(web, 'ready', 30000);
  const popup = await openPopup(web);
  assert.equal(await popup.evaluate(() => document.getElementById('listMode').value), 'allExcept');
  await popup.selectOption('#listMode', 'onlyListed');
  let s;
  for (let i = 0; i < 50; i++) {
    s = await stored();
    if (s.settings?.listMode === 'onlyListed' && s.siteRules?.[host]?.enabled === true) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(s.settings.listMode, 'onlyListed');
  assert.equal(s.siteRules[host].enabled, true, 'the site in front is turned on');
  assert.equal(await popup.evaluate(() => document.getElementById('site').checked), true);
  // Turned off, the site is outside the list and the page gets nothing.
  await popup.click('#site');
  await web.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)', undefined, { timeout: 15000 });
  await popup.close();
  await web.close();
});

test('the site switch acts on the rule that decides for the page, also a path rule, and the page follows', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } }, siteRules: { [`${host}/cvd.html`]: { enabled: false, engine: 'dynamic' } } });
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/cvd.html`);
  const popup = await openPopup(web);
  assert.equal(await popup.isChecked('#site'), false, 'the path rule keeps the page off');
  await popup.click('#site');
  await waitState(web, 'ready', 30000);
  assert.equal(await popup.isChecked('#site'), true);
  const s = await stored();
  assert.deepEqual(s.siteRules[`${host}/cvd.html`], { enabled: true, engine: 'dynamic' });
  assert.equal(s.siteRules[host], undefined, 'the rule of the site is not touched');
  await popup.close();
  await web.close();
});

test('a change in the window keeps a change another window made to other fields of the same site', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } }, siteRules: { [host]: { engine: 'auto', theme: { mode: 'dark' } } } });
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/cvd.html`);
  await waitState(web, 'ready', 30000);
  const popup = await openPopup(web);
  // The settings page changes the engine of the site after the window read the rule.
  assert.equal((await popup.evaluate((h) => chrome.runtime.sendMessage({ type: 'dk.site.patch', pattern: h, patch: { engine: 'filter' } }), host)).ok, true);
  if ((await checked(popup, 'scope-site')) !== 'true') await popup.click('#scope-site');
  await popup.click('#mode-light');
  await popup.close();
  let s;
  for (let i = 0; i < 50; i++) {
    s = await stored();
    if (s.siteRules?.[host]?.theme?.mode === 'light') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(s.siteRules[host].theme.mode, 'light', JSON.stringify(s.siteRules));
  assert.equal(s.siteRules[host].engine, 'filter', 'the other change stays');
  await web.close();
});

test('a site change that failed for a passing reason is sent again with the next change, under it', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } }, siteRules: { [host]: { engine: 'auto', theme: { mode: 'dark' } } } });
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/cvd.html`);
  await waitState(web, 'ready', 30000);
  const popup = await openPopup(web);
  // The worker does not answer the site saves for a while, as when it restarts.
  await popup.evaluate(() => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.siteDown = true;
    chrome.runtime.sendMessage = (m, ...rest) => (globalThis.siteDown && m?.type === 'dk.site.patch' ? Promise.resolve({ ok: false, code: 'error' }) : real(m, ...rest));
  });
  if ((await checked(popup, 'scope-site')) !== 'true') await popup.click('#scope-site');
  await popup.click('#mode-light');
  await popup.waitForSelector('#notice:not([hidden])', { timeout: 15000 });
  assert.equal((await stored()).siteRules[host].theme.mode, 'dark', 'not saved yet');
  await popup.evaluate(() => (globalThis.siteDown = false));
  await popup.selectOption('#engine', 'filter');
  let s;
  for (let i = 0; i < 50; i++) {
    s = await stored();
    if (s.siteRules?.[host]?.engine === 'filter') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(s.siteRules[host], { engine: 'filter', theme: { mode: 'light' } }, 'the failed change came with the next one');
  await popup.close();
  await web.close();
});
