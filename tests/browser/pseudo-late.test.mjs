// An icon drawn on a pseudo-element whose host element comes to the page late (a single-page app) is sorted like the others,
// and a selector with many hosts is not decided on a sample of them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServers, launch } from './harness.mjs';

let servers;
let browser;
let pageServer;

const origin = (s) => `http://127.0.0.1:${s.address().port}`;

before(async () => {
  servers = await startServers();
  pageServer = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const icon = `${servers.origin}/img/black-icon.svg`;
      const css = `body{margin:12px;background:#fff;color:#222}.ic::before{content:"";display:block;width:32px;height:32px;background:url(${icon}) center/contain no-repeat}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (url.pathname === '/late.html') {
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Late host</title><style>${css}</style></head><body><p>Page</p><script>setTimeout(() => { const d = document.createElement('div'); d.className = 'ic'; document.body.append(d); }, 7000);</script></body></html>`);
        return;
      }
      const many = Number(url.searchParams.get('n') ?? 120);
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Many hosts</title><style>${css}</style></head><body>${'<div class="ic"></div>'.repeat(many)}</body></html>`);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await servers?.close();
  await new Promise((r) => pageServer?.close(r));
});

const rules = (page) => page.evaluate(() => [...document.querySelectorAll('style[data-dk="images"]')].map((s) => s.textContent).join('\n'));

async function open(path) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  await page.goto(`${origin(pageServer)}${path}`);
  return page;
}

test('a host of a pseudo-element icon that comes late is found', { timeout: 60000 }, async () => {
  const page = await open('/late.html');
  await page.waitForFunction(() => [...document.querySelectorAll('style[data-dk="images"]')].some((s) => /\.ic::before\{filter/.test(s.textContent)), null, { timeout: 40000 });
  assert.match(await rules(page), /\.ic::before\{filter/);
  await page.close();
});

test('an icon with a few hosts gets its rule, one with more hosts than were looked at gets none', { timeout: 60000 }, async () => {
  const few = await open('/many.html?n=30');
  await few.waitForFunction(() => [...document.querySelectorAll('style[data-dk="images"]')].some((s) => /\.ic::before\{filter/.test(s.textContent)), null, { timeout: 30000 });
  await few.close();
  const many = await open('/many.html?n=150');
  await many.waitForTimeout(8000);
  assert.doesNotMatch(await rules(many), /\.ic::before\{filter/);
  await many.close();
});
