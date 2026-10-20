// A linked sheet of this origin is read as text from the browser cache only when that text is UTF-8; any other charset goes
// through the CSSOM, which the browser decoded by the header.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServers, launch, waitState } from './harness.mjs';

let servers;
let browser;
let site;
let origin;

// More rules than the engine needs to take the text path.
const CSS_BODY = '.café{color:#112233}body{background:#fff}' + Array.from({ length: 150 }, (_, i) => `.p${i}{color:#${(i * 997 + 0x101010).toString(16).slice(-6)}}`).join('');

before(async () => {
  servers = await startServers();
  browser = await launch();
  site = createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname;
    const page = (href) => `<!doctype html><html><head><meta charset="utf-8"><title>Charset</title><link rel="stylesheet" href="${href}"></head><body><p id="t" class="café">Text</p></body></html>`;
    if (name === '/latin.html' || name === '/utf8.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(name === '/latin.html' ? '/latin.css' : '/utf8.css'));
    } else if (name === '/latin.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=windows-1252', 'cache-control': 'max-age=600' });
      res.end(Buffer.from(CSS_BODY, 'latin1'));
    } else if (name === '/utf8.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'max-age=600' });
      res.end(Buffer.from(CSS_BODY, 'utf8'));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${site.address().port}`;
});
after(async () => {
  await browser?.close();
  await servers?.close();
  await new Promise((r) => site?.close(r));
});

async function secondLoad(path) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${origin}${path}`;
  await page.goto(url);
  await waitState(page, 'ready');
  await page.goto(url);
  await waitState(page, 'ready');
  for (let i = 0; i < 100; i++) {
    const s = await browser.stats(url);
    if (!s.waiting.pending && !s.waiting.pumping && !s.waiting.fetching) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { page, stats: await browser.stats(url) };
}

test('a UTF-8 sheet of this origin is read from the cache as text', { timeout: 60000 }, async () => {
  const { page, stats } = await secondLoad('/utf8.html');
  assert.equal(stats.textSheets, 1, JSON.stringify({ text: stats.textSheets, cssom: stats.cssomSheets, misses: stats.cacheMisses }));
  await page.close();
});

test('a sheet in another charset is read through the CSSOM, so a non-ASCII class name still matches', { timeout: 60000 }, async () => {
  const { page, stats } = await secondLoad('/latin.html');
  assert.equal(stats.textSheets, 0, JSON.stringify({ text: stats.textSheets, cssom: stats.cssomSheets }));
  assert.ok(stats.cssomSheets >= 1);
  const color = await page.evaluate(() => getComputedStyle(document.getElementById('t')).color);
  assert.notEqual(color, 'rgb(17, 34, 51)', 'the rule was seen and its color adapted to the dark page');
  await page.close();
});
