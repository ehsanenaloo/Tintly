// A page the browser loaded ahead of time (speculation rules) tells its status once it is shown in the tab: the popup and the icon
// know the page is themed. Chrome keeps a frame id other than 0 for that main frame after activation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SLOW } from './harness.mjs';
import { pageStatus } from '../helpers/gate.mjs';

let browser;
let server;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url.startsWith('/target.html')) return void res.end('<!doctype html><html><head><title>Target</title><style>body{background:#fff;color:#222}</style></head><body><p>Target</p></body></html>');
      res.end('<!doctype html><html><head><title>Start</title><script type="speculationrules">{"prerender":[{"source":"list","urls":["/target.html"]}]}</script></head><body><a id="go" href="/target.html">Go</a></body></html>');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

test('a prerendered page reports its status after it is shown', { timeout: 60000 * SLOW }, async (t) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.context.newPage();
  await page.goto(`${origin}/start.html`);
  // Give the browser time to load the target ahead of time.
  await sleep(2500 * SLOW);
  await page.click('#go');
  await page.waitForURL(`${origin}/target.html`);
  const prerendered = await page.evaluate(() => (performance.getEntriesByType('navigation')[0]?.activationStart ?? 0) > 0);
  // The driver's DevTools session turns prerendering off in Chromium (PrerenderingDisabledByDevTools); the test runs where a browser does prerender.
  if (!prerendered) return t.skip('this browser did not prerender the page');
  assert.equal(await pageStatus(browser, `${origin}/target.html`, { want: ['on'], timeout: 10000 * SLOW }), 'on');
  await page.close();
});
