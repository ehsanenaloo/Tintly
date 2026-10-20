// the status `pending` ("Checking this page") in the popup, in four languages. The text is shown, it fits, and a change from one
// status to another moves nothing: the status line holds two lines for every text.
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
const KEY = { pending: 'status.pending', on: 'status.on', 'dark-detected': 'status.darkDetected', 'page-scheme': 'status.pageScheme', 'start-failed': 'status.startFailed' };

async function openPopup(locale) {
  await browser.clearStorage();
  await browser.worker.evaluate(() => chrome.storage.session.clear());
  await browser.setStorage({ ...ON, ui: { locale } });
  const popup = await browser.context.newPage();
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/basic.html`);
  await waitState(web, 'ready');
  await web.bringToFront();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return { popup, web };
}

const setStatus = (status) =>
  browser.worker.evaluate(
    async ({ u, status }) => {
      const [tab] = await chrome.tabs.query({ url: u });
      await chrome.storage.session.set({ [`tab:${tab.id}`]: { status, at: Date.now() } });
    },
    { u: `${servers.origin}/basic.html`, status },
  );

/** Where the status line and the controls under it are. */
const layout = (popup) =>
  popup.evaluate(() => {
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    };
    const status = document.getElementById('status');
    const rest = [...document.querySelectorAll('.hero ~ *, .main > *')].slice(0, 12).map(rect);
    return { status: rect(status), dot: document.getElementById('status-dot').dataset.state, text: status.textContent, over: status.scrollHeight - status.clientHeight, rest, page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
  });

for (const locale of ['en', 'fa', 'ar', 'he']) {
  test(`pending in ${locale}: the text is there, fits, and changing the status moves nothing`, { timeout: 90000 }, async () => {
    const catalog = (await import(`../../extension/shared/locales/${locale}.js`)).default;
    const { popup, web } = await openPopup(locale);
    const seen = [];
    for (const status of ['pending', 'on', 'dark-detected', 'page-scheme', 'start-failed', 'pending']) {
      await setStatus(status);
      await popup.waitForFunction((text) => document.getElementById('status').textContent === text, catalog[KEY[status]], { timeout: 20000 }).catch(async (error) => {
        throw new Error(`${locale} ${status}: the popup says "${await popup.textContent('#status')}", not "${catalog[KEY[status]]}" (${error.message})`);
      });
      const l = await layout(popup);
      seen.push([status, l]);
      if (status === 'pending') {
        assert.equal(l.dot, 'info');
        assert.ok(l.over <= 0, `${locale}: the pending text spills (${l.over})`);
      }
      assert.deepEqual(l.page, [360, 600], `${locale} ${status}: the window changed`);
    }
    const [, first] = seen[0];
    for (const [status, l] of seen) {
      // The width follows the text (and the left edge with it in a right-to-left language); what must stay is the height and the top.
      assert.deepEqual([l.status[1], l.status[3]], [first.status[1], first.status[3]], `${locale} ${status}: the status line moved or changed its height`);
      assert.deepEqual(l.rest, first.rest, `${locale} ${status}: something below the status moved`);
    }
    await popup.close();
    await web.close();
  });
}
