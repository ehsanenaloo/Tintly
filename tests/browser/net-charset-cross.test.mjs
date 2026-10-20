// A sheet of another origin with no charset signal (no mark, no header charset, no @charset) is read by the browser in the
// encoding of the page that links it. The worker gets that encoding from the page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServers, launch, waitState } from './harness.mjs';

let servers;
let browser;
let pages;
let sheets;
let pageOrigin;
let sheetOrigin;

const CSS_BODY = '.café{color:#112233}body{background:#fff}' + Array.from({ length: 150 }, (_, i) => `.p${i}{color:#${(i * 997 + 0x101010).toString(16).slice(-6)}}`).join('');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  servers = await startServers();
  browser = await launch();
  sheets = createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname;
    const encoding = name.startsWith('/latin') ? 'latin1' : 'utf8';
    res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' });
    res.end(Buffer.from(CSS_BODY, encoding));
  });
  sheetOrigin = await listen(sheets);
  pages = createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname.slice(1);
    const latin = name.startsWith('latin');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      Buffer.from(
        `<!doctype html><html><head><meta charset="${latin ? 'windows-1252' : 'utf-8'}"><title>Cross</title><link rel="stylesheet" href="${sheetOrigin}/${name}.css"></head><body><p id="t" class="café">Text</p></body></html>`,
        latin ? 'latin1' : 'utf8',
      ),
    );
  });
  pageOrigin = await listen(pages);
});
after(async () => {
  await browser?.close();
  await servers?.close();
  await new Promise((r) => pages?.close(r));
  await new Promise((r) => sheets?.close(r));
});

async function colorOf(path) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${pageOrigin}${path}`);
  await waitState(page, 'ready');
  for (let i = 0; i < 100; i++) {
    const s = await browser.stats(`${pageOrigin}${path}`);
    if (!s.waiting.pending && !s.waiting.pumping && !s.waiting.fetching) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const color = await page.evaluate(() => getComputedStyle(document.getElementById('t')).color);
  await page.close();
  return color;
}

test('a windows-1252 sheet with no signal, linked from a windows-1252 page, matches its non-ASCII class name', { timeout: 60000 }, async () => {
  assert.notEqual(await colorOf('/latin'), 'rgb(17, 34, 51)', 'the rule was seen and its color adapted to the dark page');
});

test('a UTF-8 sheet with no signal, linked from a UTF-8 page, still matches', { timeout: 60000 }, async () => {
  assert.notEqual(await colorOf('/utf8'), 'rgb(17, 34, 51)');
});
