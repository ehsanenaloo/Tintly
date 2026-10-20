// Hit testing skips elements with `pointer-events: none`. The sweep marks only those elements and lets a rule on the mark show them,
// so the page is not restyled twice for each slice: on a page without any it adds no rule at all (the long tasks of bgimages).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServers, launch, waitState, cpuThrottle, SLOW } from './harness.mjs';

let servers;
let browser;
let pageServer;

const origin = (s) => `http://127.0.0.1:${s.address().port}`;
const PHOTO = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='800' height='260'><rect width='800' height='260' fill='%23f5f5f7'/><circle cx='620' cy='130' r='90' fill='%23d9dbe0'/></svg>";

before(async () => {
  servers = await startServers();
  pageServer = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const fillers = Number(url.searchParams.get('fillers') ?? 0);
      const none = Number(url.searchParams.get('none') ?? 0);
      const overlay = url.searchParams.get('overlay') === '1';
      const rows = `${'<div class="f">Filler</div>'.repeat(fillers)}${'<i class="n"></i>'.repeat(none)}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Probe</title><style>body{margin:0;background:#fff;color:#111;font:18px system-ui}.hero{position:relative;width:800px;height:260px}.hero img{width:800px;height:260px;display:block;${overlay ? 'pointer-events:none' : ''}}.hero h1{position:absolute;left:40px;top:60px;margin:0;color:#111111;font-size:48px}.f{height:4px;font-size:2px}.n{display:inline-block;width:1px;height:1px;pointer-events:none}</style></head><body><div class="hero"><img alt="" src="${PHOTO}"><h1 id="over">Light hero</h1></div>${rows}</body></html>`);
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

async function sweep(query) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  await page.addInitScript(() => {
    window.__probes = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && n.tagName === 'STYLE' && n.getAttribute('data-dk') === 'probe') window.__probes.push(n.textContent);
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${origin(pageServer)}/?${query}`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForFunction(() => document.getElementById('over').hasAttribute('data-dk-k'), null, { timeout: 40000 * SLOW });
  // The sweep goes on until it has been over the whole grid; the marks are taken off then.
  await page.waitForTimeout(2500 * SLOW);
  await page.waitForFunction(() => document.querySelectorAll('[data-dk-ph]').length === 0, null, { timeout: 15000 * SLOW });
  const out = await page.evaluate(() => ({ probes: window.__probes, marks: document.querySelectorAll('[data-dk-ph]').length, kept: document.getElementById('over').hasAttribute('data-dk-k') }));
  await page.close();
  return out;
}

test('a page without pointer-events none adds no rule for hit testing, and finds the text on the picture', { timeout: 120000 * SLOW }, async () => {
  const got = await sweep('fillers=1500');
  assert.deepEqual(got.probes, []);
  assert.equal(got.marks, 0);
  assert.equal(got.kept, true);
});

test('a picture with pointer-events none is marked for the sweep, found, and the mark is gone afterwards', { timeout: 120000 * SLOW }, async () => {
  const got = await sweep('overlay=1&fillers=200');
  assert.equal(got.kept, true);
  assert.ok(got.probes.length >= 1);
  assert.ok(got.probes.every((p) => p === '[data-dk-ph]{pointer-events:auto!important}'), JSON.stringify(got.probes));
  assert.equal(got.marks, 0);
});

test('a page with very many elements that have pointer-events none gets the rule on every element', { timeout: 120000 * SLOW }, async () => {
  const got = await sweep('overlay=1&fillers=100&none=450');
  assert.equal(got.kept, true);
  assert.ok(got.probes.length >= 1);
  assert.ok(got.probes.every((p) => p === '*{pointer-events:auto!important}'), JSON.stringify(got.probes));
  assert.equal(got.marks, 0);
});

test('a page so large and a thread so slow that the look at the elements needs several slices still gets its sweep', { timeout: 180000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  await cpuThrottle(page, 6);
  await page.goto(`${origin(pageServer)}/?fillers=12000`);
  await waitState(page, 'ready', 120000);
  const stats = () =>
    browser.worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify(globalThis.__dk.backdrop.stats()) });
      return JSON.parse(r.result);
    }, page.url());
  const until = Date.now() + 90000;
  let s;
  do {
    await page.waitForTimeout(500);
    s = await stats();
  } while (s.passes < 1 && Date.now() < until);
  assert.ok(s.passes >= 1 && s.hitTests > 0, JSON.stringify(s));
  await page.close();
});
