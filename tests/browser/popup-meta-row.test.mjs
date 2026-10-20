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

const MODES = { dark: { mode: 'dark' }, light: { mode: 'light' }, paper: { mode: 'eink', einkPreset: 'paper' }, eink: { mode: 'eink', einkPreset: 'eink' } };

test('the schedule and links row keeps one place in every mode, language and look', { timeout: 300000 }, async () => {
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/basic.html`);
  await waitState(web, 'ready');
  await web.bringToFront();
  let base = null;
  for (const [locale, uiTheme] of [['en', 'light'], ['en', 'dark'], ['fa', 'light'], ['fa', 'dark'], ['ar', 'light'], ['he', 'dark']]) {
    let first = null;
    for (const [name, theme] of Object.entries(MODES)) {
      await browser.clearStorage();
      await browser.setStorage({ settings: { enabled: true, theme }, ui: { locale, uiTheme } });
      const popup = await browser.context.newPage();
      await popup.setViewportSize({ width: 360, height: 600 });
      await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
      await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
      const m = await popup.evaluate(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        const meta = r('.meta');
        const card = r('.theme');
        const main = document.querySelector('.main');
        return { top: meta.top, bottom: meta.bottom, left: meta.left, right: meta.right, cardBottom: card.bottom, scroll: main.scrollHeight - main.clientHeight, links: document.querySelectorAll('.links a').length };
      });
      const label = `${locale} ${uiTheme} ${name}`;
      assert.equal(m.links, 2, label);
      assert.equal(m.scroll, 0, `${label} main scrolls`);
      assert.ok(m.cardBottom <= m.top, `${label} mode box reaches the row: ${m.cardBottom} > ${m.top}`);
      first ??= m;
      for (const key of ['top', 'bottom', 'left', 'right']) assert.equal(m[key], first[key], `${label} row ${key} moved`);
      base ??= m;
      assert.equal(m.top, base.top, `${label} row differs from the first language`);
      await popup.close();
    }
  }
  await web.close();
});

test('the engine select has a name, one height in every mode and a hint that follows the choice', { timeout: 120000 }, async () => {
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/basic.html`);
  await waitState(web, 'ready');
  await web.bringToFront();
  for (const [name, theme] of Object.entries(MODES)) {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, engine: 'filter', theme }, ui: { locale: 'en', uiTheme: 'light' } });
    const popup = await browser.context.newPage();
    await popup.setViewportSize({ width: 360, height: 600 });
    await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
    await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
    assert.equal(await popup.locator('select#engine').evaluate((el) => el.labels[0]?.textContent), 'Engine', name);
    const h = await popup.locator('#engine').evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(h >= 24 && h <= 30, `${name} height ${h}`);
    const title = await popup.getAttribute('#engine', 'title');
    assert.match(title, /Inverts the whole page/, name);
    await popup.selectOption('#engine', 'dynamic');
    assert.match(await popup.getAttribute('#engine', 'title'), /Rewrites page colors/, name);
    await popup.close();
  }
  await web.close();
});
