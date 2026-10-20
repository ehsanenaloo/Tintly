// The popup and the settings page take the footer text from one place: the same catalogs through the same component.
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

const EN = {
  about: ['Copyright (c) 2026 Ehsan Enaloo. Released under the MIT License.', 'Open Website'],
  github: ['Source code, releases, and project details.', 'Open GitHub'],
  rate: ['Enjoying the extension? A good rating helps the extension build trust faster.', 'Rate on Store'],
  support: ['Easier on your eyes? Support the project with a small coffee.', null],
};

/** The message and the button of each footer tab. */
async function readFooter(page) {
  const out = {};
  for (const id of Object.keys(EN)) {
    await page.click(`#footer-tab-${id}`);
    await page.waitForTimeout(150);
    out[id] = await page.evaluate(() => [document.querySelector('.footer-message').textContent, document.querySelector('.footer-cta').textContent]);
  }
  return out;
}

test('the popup and the settings page show the same footer text, in every language', { timeout: 120000 }, async () => {
  for (const locale of ['en', 'fa', 'ar', 'he']) {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true }, ui: { locale, uiTheme: 'light' } });
    const popup = await browser.context.newPage();
    await popup.setViewportSize({ width: 360, height: 600 });
    await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
    await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${extId}/pages/options/options.html#general`);
    await options.waitForSelector('#footer-tab-about');
    const a = await readFooter(popup);
    const b = await readFooter(options);
    assert.deepEqual(b, a, `${locale}: the two pages differ`);
    if (locale === 'en') {
      for (const [id, [message, cta]] of Object.entries(EN)) {
        assert.equal(a[id][0], message, `${id} message`);
        if (cta) assert.equal(a[id][1], cta, `${id} button`);
      }
    }
    await popup.close();
    await options.close();
  }
});
