// What keeps the quick dark version of a page up, and what ends it. A link that never fires load or error, a sheet read
// while the page is visible, and a page that is dark with one sheet the worker cannot read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SLOW, cpuThrottle } from './harness.mjs';

let browser;
let pageServer;
let otherServer;
const otherHits = [];

const origin = (s) => `http://127.0.0.1:${s.address().port}`;
const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const BODY = '<header class="top"><strong>Hold</strong></header><main><section class="card"><h2>One</h2><p>Text.</p></section></main><p class="note">Note</p>';
const CSS = 'body{margin:0;min-height:100vh;background:#fff;color:#222;font:16px system-ui}header.top{padding:12px;background:#eef}.card{margin:12px;padding:12px;background:#f4f4f4}';

before(async () => {
  otherServer = await listen((req, res) => {
    if (req.url.startsWith('/hotlink/')) {
      // The page's own request (a style destination) is served, the worker's is not.
      if (req.headers['sec-fetch-dest'] === 'style') {
        res.writeHead(200, { 'content-type': 'text/css' });
        // `body=1`: the sheet that cannot be read holds the page's background too. Without it, it holds grey text (contrast about 4) and a white card.
        return void res.end(`${req.url.includes('body=1') ? 'body{background:#fff;color:#222}' : 'body{color:#74777d}'}.card{background:#fff;color:#222}`);
      }
      res.writeHead(403);
      return void res.end('no');
    }
    otherHits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('.card{color:#300}');
  });
  pageServer = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    const other = origin(otherServer);
    if (url.pathname === '/same.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('.note{background:#ffdddd;color:#220000}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/disabled.html') {
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Disabled link</title><style>${CSS}</style><link id="off" rel="stylesheet" disabled href="${other}/disabled.css"><link id="off2" rel="stylesheet" disabled href="/same.css"></head><body>${BODY}</body></html>`);
      return;
    }
    if (url.pathname === '/dark-unreadable.html') {
      // The readable sheet themes the page dark; the sheet the worker cannot read leaves one white card (or, with `kind=light`, the whole page).
      const light = url.searchParams.get('kind') === 'light';
      const inline = light ? '' : 'body{background:#fff;color:#222}';
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Dark unreadable</title><style>body{margin:0;min-height:100vh;font:16px system-ui}${inline}</style><link rel="stylesheet" href="${other}/hotlink/s.css${light ? '?body=1' : ''}"></head><body>${BODY}</body></html>`);
      return;
    }
    if (url.pathname === '/variant-gap.html') {
      // Sheet A declares a color token, sheet B reads it. Samples are taken whenever the page changes.
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Variant gap</title>
<script>
window.__samples = [];
new MutationObserver(() => {
  const x = document.querySelector('.x');
  if (!x) return;
  const b = [...document.querySelectorAll('style[data-dk="sheet"]')].some((s) => s.textContent.includes('.x'));
  window.__samples.push({ b, bg: getComputedStyle(x).backgroundColor });
}).observe(document, { childList: true, subtree: true });
</script>
<style>:root{--surface:#ffffff;--ink:#222222}</style>
<style>.x{background:var(--surface);color:var(--ink);padding:20px}</style></head><body><div class="x">Token</div></body></html>`);
      return;
    }
    res.end('<!doctype html><title>x</title>');
  });
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => pageServer?.close(r));
  await new Promise((r) => otherServer?.close(r));
});

async function open(path, rate = SLOW) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await cpuThrottle(page, rate);
  await page.goto(`${origin(pageServer)}${path}`, { waitUntil: 'load' });
  return page;
}

/** Like `browser.stats`, but also for a page that has not finished loading. */
const statsNow = (url) =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: /** @type {number} */ (tab.id) },
      world: 'ISOLATED',
      injectImmediately: true,
      func: () => JSON.stringify(globalThis.__dk?.dynamic?.stats() ?? null),
    });
    return JSON.parse(r.result);
  }, url);

async function released(page, url) {
  for (let i = 0; i < 400; i++) {
    const st = await statsNow(url).catch(() => null);
    if (st && st.released !== null) return st;
    await page.waitForTimeout(50);
  }
  return statsNow(url);
}

for (const rate of [1, 4]) {
  test(`a disabled stylesheet link does not hold the quick version, causes no fetch, main thread ${rate} times slower`, { timeout: 90000 }, async () => {
    otherHits.length = 0;
    const page = await open('/disabled.html', rate);
    const st = await released(page, page.url());
    assert.equal(st.released, 'settled');
    assert.ok(st.holdMs < 1000 * rate, `held ${st.holdMs} ms`);
    assert.equal(otherHits.length, 0, 'the worker did not fetch a disabled link');
    await page.close();
  });
}

test('a disabled link that is enabled later is themed', { timeout: 60000 }, async () => {
  const page = await open('/disabled.html', 1);
  await released(page, page.url());
  await page.evaluate(() => {
    document.getElementById('off2').disabled = false;
  });
  await page.waitForFunction(
    () => {
      const m = /\d+/g;
      const c = getComputedStyle(document.querySelector('.note')).backgroundColor.match(m);
      return !!c && c.length >= 3 && Number(c[0]) < 100 && Number(c[3] ?? 1) > 0;
    },
    null,
    { timeout: 15000 },
  );
  await page.close();
});

for (const hold of [true, false]) {
  test(`a sheet that reads a token of an earlier sheet shows the themed color from its first frame, holdPaint ${hold}`, { timeout: 60000 }, async () => {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, holdPaint: hold, theme: { mode: 'dark' } } });
    const page = await browser.context.newPage();
    await page.goto(`${origin(pageServer)}/variant-gap.html`);
    await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', null, { timeout: 20000 });
    const samples = await page.evaluate(() => window.__samples);
    const after = samples.filter((s) => s.b);
    assert.ok(after.length > 0, 'the piece of the second sheet was seen');
    const lum = (css) => {
      const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
    };
    for (const s of after) assert.ok(lum(s.bg) < 0.4, `light after the second sheet was in: ${JSON.stringify(samples)}`);
    await page.close();
  });
}

const engineNow = (page) =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: /** @type {number} */ (tab.id) },
      world: 'ISOLATED',
      func: () => JSON.stringify({ dynamic: !!globalThis.__dk?.dynamic?.isActive(), filter: !!globalThis.__dk?.filter?.isActive(), verdict: globalThis.__dk?.dynamic?.stats()?.unreachableFallback ?? null }),
    });
    return JSON.parse(r.result);
  }, page.url());

test('a page themed dark with one white card from an unreadable sheet keeps the Dynamic engine when one sheet cannot be read', { timeout: 60000 }, async () => {
  const page = await open('/dark-unreadable.html', 1);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', null, { timeout: 20000 });
  await page.waitForTimeout(4500);
  const e = await engineNow(page);
  assert.deepEqual([e.dynamic, e.filter], [true, false], JSON.stringify([e, await page.evaluate(() => [...document.documentElement.attributes].map((a) => a.name + '=' + a.value.slice(0, 40)).join(' ') + ' styles=' + document.querySelectorAll('style[data-dk]').length)]));
  assert.equal(e.verdict, 'kept');
  await page.close();
});

test('a light page with one sheet that cannot be read goes to the Filter+ engine', { timeout: 60000 }, async () => {
  const page = await open('/dark-unreadable.html?kind=light', 1);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') !== 'loading', null, { timeout: 20000 });
  await page.waitForTimeout(4500);
  const e = await engineNow(page);
  assert.deepEqual([e.dynamic, e.filter], [false, true], JSON.stringify(e));
  await page.close();
});
