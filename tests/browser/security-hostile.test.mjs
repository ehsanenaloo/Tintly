// Hostile style sheets: a sheet built to make the engine slow must not freeze the page. The same sheet is tried inline and
// from another origin (the second one goes through the worker and the text reader).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, waitState } from './harness.mjs';

const rep = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const SHEETS = {
  'unterminated-url': () => `a{background:${'url('.repeat(40000)}}\nbody{margin:0}`,
  'nested-var': () => `a{color:${'var(--a,'.repeat(15000)}red${')'.repeat(15000)}}\nbody{margin:0}`,
  'repeated-shorthand': () => `${rep('a background:x ', 300000)};b{color:var(--a)}\nbody{margin:0}`,
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const kind = url.searchParams.get('kind');
      if (url.pathname === '/hostile.css' && SHEETS[kind]) {
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end(SHEETS[kind]());
      } else if (url.pathname === '/inline.html' && SHEETS[kind]) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><title>h</title><style>${SHEETS[kind]()}</style><body style="background:#fff"><p>text</p></body>`);
      } else if (url.pathname === '/linked.html' && SHEETS[kind]) {
        const other = url.searchParams.get('other');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><title>h</title><link rel="stylesheet" href="${other}/hostile.css?kind=${kind}"><body style="background:#fff"><p>text</p></body>`);
      } else {
        res.writeHead(404);
        res.end('no');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let a;
let b;
let browser;
const origin = (s) => `http://127.0.0.1:${s.address().port}`;

before(async () => {
  a = await serve();
  b = await serve();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await new Promise((r) => a?.close(r));
  await new Promise((r) => b?.close(r));
});

async function longestTask(path) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.addInitScript(() => {
    window.__long = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__long = Math.max(window.__long, e.duration);
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(`${origin(a)}${path}`, { waitUntil: 'commit', timeout: 60000 });
  // Give the engine time to read the sheet, then ask the page something: it must answer.
  await page.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 60000 });
  await waitState(page, 'ready', 40000).catch(() => {});
  const answer = await Promise.race([page.evaluate(() => 1 + 1), new Promise((r) => setTimeout(() => r('frozen'), 10000))]);
  const long = await page.evaluate(() => window.__long).catch(() => Infinity);
  await page.close();
  return { answer, long };
}

for (const kind of Object.keys(SHEETS)) {
  for (const via of ['inline', 'linked']) {
    test(`SEC: a hostile sheet (${kind}, ${via}) does not freeze the page`, { timeout: 120000 }, async () => {
      const path = via === 'inline' ? `/inline.html?kind=${kind}` : `/linked.html?kind=${kind}&other=${encodeURIComponent(origin(b))}`;
      const { answer, long } = await longestTask(path);
      console.log(`# ${kind} ${via}: longest task ${Math.round(long)} ms`);
      assert.equal(answer, 2);
      assert.ok(long < 2500, `a task ran ${Math.round(long)} ms`);
    });
  }
}
