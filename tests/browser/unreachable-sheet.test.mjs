// A style sheet the worker cannot get (a server slower than the worker's limit, a server that refuses a request that is not the
// page's own, a file over the size limit) must not leave a light page: no painted frame is light, and the end state is dark.
// A sheet that matters little leaves the engine as it is.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServers, launch, launchPlain, paintedLightness, cpuThrottle, pixelsOf } from './harness.mjs';

let servers;
let browser;
let helper;
let pageServer;
let sheetServer;

const MAIN = 'body{margin:0;min-height:100vh;background:#fff;color:#222;font:16px system-ui}header.top{padding:12px;background:#eef;border-bottom:1px solid #ccd}.card{margin:12px;padding:12px;background:#f4f4f4;border:1px solid #ccc}h2{color:#113}';
const BODY = '<header class="top"><strong>Sheet test</strong></header><main><section class="card"><h2>One</h2><p>Text.</p></section><section class="card"><h2>Two</h2><p>More text.</p></section></main>';
const BIG_BYTES = 2 * 1024 * 1024 + 4096;

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const origin = (s) => `http://127.0.0.1:${s.address().port}`;

before(async () => {
  servers = await startServers();
  // The sheets come from another origin, so the page cannot read them and the worker has to.
  sheetServer = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    const dest = req.headers['sec-fetch-dest'];
    const send = (headers, body, delay = 0) => setTimeout(() => (res.writeHead(200, headers), res.end(body)), delay);
    const slow = /^\/slow\/(\d+)\/s\.css$/.exec(url.pathname);
    if (slow) return send({ 'content-type': 'text/css', 'cache-control': 'no-store' }, MAIN, Number(slow[1]));
    // Hotlink protection: the page's own request (a style destination) is served, the worker's request is not.
    if (url.pathname === '/hotlink/s.css') {
      if (dest === 'style') return send({ 'content-type': 'text/css' }, MAIN);
      res.writeHead(403);
      return void res.end('no');
    }
    if (url.pathname === '/huge/s.css') return send({ 'content-type': 'text/css' }, `${MAIN}\n/*${' '.repeat(BIG_BYTES)}*/`);
    if (url.pathname === '/small-hotlink/s.css') {
      if (dest === 'style') return send({ 'content-type': 'text/css' }, '.badge{background:#ffd;color:#330;padding:2px 6px}');
      res.writeHead(403);
      return void res.end('no');
    }
    if (url.pathname === '/mime/s.css') return send({ 'content-type': url.searchParams.get('type') ?? '' }, MAIN);
    res.writeHead(404);
    res.end();
  });
  pageServer = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/page.html') {
      res.writeHead(404);
      return void res.end();
    }
    const href = `${origin(sheetServer)}${url.searchParams.get('sheet')}`;
    const inline = url.searchParams.get('inline') === '1';
    const style = inline ? `<style>${MAIN}</style>` : '';
    const extra = url.searchParams.get('badge') === '1' ? '<p>Status <span class="badge">new</span></p>' : '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Unreachable sheet</title>${style}<link rel="stylesheet" href="${href}"></head><body>${BODY}${extra}</body></html>`);
  });
  browser = await launch();
  helper = await browser.context.newPage();
  await helper.goto('about:blank');
});

after(async () => {
  await browser?.close();
  await servers?.close();
  await new Promise((r) => pageServer?.close(r));
  await new Promise((r) => sheetServer?.close(r));
});

const light = (list) => list.filter((v) => v > 0.5);

/** Load the page from a dark page with a throttled main thread; report every painted frame and the end state. */
async function load(target, rate, { settle = 1500 } = {}) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await cpuThrottle(page, rate);
  await page.goto(`${servers.origin}/dark.html`);
  const url = target.startsWith('http') ? target : `${origin(pageServer)}/page.html?${target}`;
  const lightness = await paintedLightness(page, helper, async () => {
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-dk-state') && document.documentElement.getAttribute('data-dk-state') !== 'loading', null, { timeout: 60000 });
    // The hold ends when the page is settled; a slow sheet is waited for, then retried, so this can take a long time.
    for (let i = 0; i < 480; i++) {
      const st = await browser.stats(url).catch(() => null);
      if (st && st.released !== null) break;
      if (!st && i > 4) break;
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(settle);
  });
  const end = await page.evaluate(() => {
    const dk = globalThis.__dk;
    return null && dk;
  });
  void end;
  return { page, lightness, url };
}

/** What a person sees at three points of the window, as lightness 0 to 1. */
async function seen(page) {
  const points = [[500, 300], [500, 120], [20, 400]];
  const px = await pixelsOf(page, helper, points);
  return px.map(([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
}

/** Which engine runs in the page. */
const engines = (page) =>
  page.evaluate(() => ({ state: document.documentElement.getAttribute('data-dk-state') })).then(async (base) => ({
    ...base,
    ...(await browser.worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => JSON.stringify({ dynamic: !!globalThis.__dk?.dynamic?.isActive(), filter: !!globalThis.__dk?.filter?.isActive(), stats: globalThis.__dk?.dynamic?.stats() ? { unreachable: globalThis.__dk.dynamic.stats().unreachable, verdict: globalThis.__dk.dynamic.stats().unreachableFallback } : null }),
      });
      return JSON.parse(r.result);
    }, page.url())),
  }));

const FALLBACK_CASES = [
  ['a server that refuses the worker (hotlink protection)', 'sheet=/hotlink/s.css'],
  ['a sheet over the size limit', 'sheet=/huge/s.css'],
];

for (const rate of [1, 4]) {
  for (const [name, query] of FALLBACK_CASES) {
    test(`${name}: the page is not light, the Filter+ engine takes over, main thread ${rate} times slower`, { timeout: 120000 }, async () => {
      const { page, lightness } = await load(query, rate);
      console.log(`# ${name} x${rate}: ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
      assert.deepEqual(light(lightness), [], 'no painted frame may be light');
      const dark = await seen(page);
      assert.ok(dark.every((v) => v < 0.4), `dark at three points: ${dark.map((v) => v.toFixed(2))}`);
      const e = await engines(page);
      assert.deepEqual([e.dynamic, e.filter], [false, true], JSON.stringify(e));
      await page.close();
    });
  }

  test(`a server slower than 10 s is waited for, no light frame, main thread ${rate} times slower`, { timeout: 150000 }, async () => {
    const { page, lightness } = await load('sheet=/slow/12000/s.css', rate);
    assert.deepEqual(light(lightness), [], 'no painted frame may be light');
    const e = await engines(page);
    assert.deepEqual([e.dynamic, e.filter], [true, false], 'the Dynamic engine read the sheet when it came');
    assert.equal(e.stats.unreachable, 0);
    const dark = await seen(page);
    assert.ok(dark.every((v) => v < 0.4), `dark at three points: ${dark.map((v) => v.toFixed(2))}`);
    await page.close();
  });
}

test('a sheet that matters little stays unread and the Dynamic engine stays', { timeout: 90000 }, async () => {
  const { page, lightness } = await load('sheet=/small-hotlink/s.css&inline=1&badge=1', 1);
  assert.deepEqual(light(lightness), []);
  const e = await engines(page);
  assert.deepEqual([e.dynamic, e.filter], [true, false], JSON.stringify(e));
  assert.deepEqual([e.stats.unreachable, e.stats.verdict], [1, 'kept']);
  const dark = await seen(page);
  assert.ok(dark.every((v) => v < 0.4), `dark: ${dark.map((v) => v.toFixed(2))}`);
  await page.close();
});

test('an engine the person chose is not replaced', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, engine: 'dynamic' } });
  const page = await browser.context.newPage();
  await page.goto(`${origin(pageServer)}/page.html?sheet=/hotlink/s.css`);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const e = await engines(page);
  assert.deepEqual([e.dynamic, e.filter], [true, false], JSON.stringify(e));
  await page.close();
});

test('the Light mode is not sent to the Filter+ engine', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'light' } } });
  const page = await browser.context.newPage();
  await page.goto(`${origin(pageServer)}/page.html?sheet=/hotlink/s.css`);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const e = await engines(page);
  assert.deepEqual([e.dynamic, e.filter], [true, false], JSON.stringify(e));
  await page.close();
});

test('a type that the browser applies but the worker refuses is handled like any other unreadable sheet', { timeout: 180000 }, async () => {
  const plain = await launchPlain();
  const applied = [];
  try {
    for (const type of ['text/plain', 'application/octet-stream', '']) {
      const p = await plain.context.newPage();
      await p.goto(`${origin(pageServer)}/page.html?sheet=${encodeURIComponent(`/mime/s.css?type=${type}`)}`);
      await p.waitForTimeout(400);
      const white = await p.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)' && getComputedStyle(document.querySelector('.card')).backgroundColor !== 'rgba(0, 0, 0, 0)');
      if (white) applied.push(type);
      await p.close();
    }
  } finally {
    await plain.close();
  }
  console.log(`# types the browser applies: ${JSON.stringify(applied)}`);
  for (const type of applied) {
    const { page, lightness } = await load(`sheet=${encodeURIComponent(`/mime/s.css?type=${type}`)}`, 1);
    assert.deepEqual(light(lightness), [], type);
    const dark = await seen(page);
    assert.ok(dark.every((v) => v < 0.4), `${type}: dark at three points: ${dark.map((v) => v.toFixed(2))}`);
    await page.close();
  }
});
