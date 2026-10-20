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

test('the settings footer has the edges of the content cards, and the About tab does not repeat it', { timeout: 200000 }, async () => {
  for (const [locale, uiTheme, width] of [['en', 'light', 1000], ['fa', 'dark', 1000], ['en', 'dark', 360], ['ar', 'light', 360], ['he', 'light', 1000]]) {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true }, ui: { locale, uiTheme } });
    const page = await browser.context.newPage();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`chrome-extension://${extId}/pages/options/options.html#general`);
    await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
    const edges = () =>
      page.evaluate(() => {
        const card = document.querySelector('#panel-general .card').getBoundingClientRect();
        const footer = document.querySelector('.footer-mount .footer');
        const f = footer && footer.getBoundingClientRect();
        return { card: [card.left, card.right], footer: f && f.width > 0 ? [f.left, f.right] : null, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
    const m = await edges();
    const label = `${locale} ${uiTheme} ${width}`;
    assert.deepEqual(m.footer, m.card, `${label} footer edges`);
    assert.equal(m.page, 0, `${label} page scrolls sideways`);
    assert.ok((await page.locator('#engine-hint').textContent()).length > 0, `${label} engine hint`);
    await page.click('#tab-about');
    assert.equal(await page.locator('.footer-mount').isVisible(), false, `${label} footer on About`);
    await page.close();
  }
});
