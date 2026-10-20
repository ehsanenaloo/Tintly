// The picture of a pseudo-element that changes with a class after the first look is looked at again, a bounded number of times.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServers, launch, imageStore } from './harness.mjs';
import { corpus, encodePng } from '../helpers/png.mjs';

let servers;
let browser;
let pageServer;

const origin = (s) => `http://127.0.0.1:${s.address().port}`;

before(async () => {
  for (const i of corpus()) imageStore.set(i.name, encodePng(i.w, i.h, i.px));
  servers = await startServers();
  pageServer = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const dark = `${servers.origin}/img/black-icon.svg`;
      const photo = `${servers.origin}/gen/img/photo-3.png`;
      const css = `body{margin:12px;background:#fff;color:#222}.ic::before{content:"";display:block;width:32px;height:32px;background:url(${dark}) center/contain no-repeat}.ic.alt::before{background-image:url(${photo})}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Relook</title><style>${css}</style></head><body><div class="ic" id="a"></div><script>setTimeout(() => document.getElementById('a').classList.add('alt'), 3000);</script></body></html>`);
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

test('a rule for a pseudo-element picture is taken away when the host shows another picture later', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  await page.goto(`${origin(pageServer)}/`);
  await page.waitForFunction(() => [...document.querySelectorAll('style[data-dk="images"]')].some((s) => /\.ic::before\{filter/.test(s.textContent)), null, { timeout: 20000 });
  // The class comes at 3 s; the look after it is at about 9 s after the first.
  await page.waitForFunction(() => ![...document.querySelectorAll('style[data-dk="images"]')].some((s) => /\.ic::before\{filter/.test(s.textContent)), null, { timeout: 40000 });
  assert.doesNotMatch(await rules(page), /\.ic::before\{filter/);
  await page.close();
});
