// a public-looking name that resolves to a private address. The proxy checks the name, not the address, so the worker
// fetches it. Two local servers stand in for a public page and a private server; the browser maps both public-looking names to the
// loopback address, and `--ip-address-space-overrides` makes the page's server count as public, so the browser's own private
// network rule applies to the page. A third server stands in for a public CDN. The worker names the address space the page may
// reach and the browser checks the real connection; where it cannot, the page reads the file itself with CORS. So the
// private server gets no request and the page gets no copy of its sheet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, waitState } from './harness.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MARK = 'dk-private-mark';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((r) => (server ? server.close(r) : r()));

let browser;
let priv;
let pub;
let proxy;
let cdn;
let privPort;
let pubPort;
let cdnPort;
/** @type {{ path: string, referer?: string, origin?: string, cookie?: string }[]} */
const seen = [];

before(async () => {
  priv = http.createServer((req, res) => {
    seen.push({ path: req.url, referer: req.headers.referer, origin: req.headers.origin, cookie: req.headers.cookie });
    const png = req.url.includes('.png');
    res.writeHead(200, { 'content-type': png ? 'image/png' : 'text/css', 'cache-control': 'no-store' });
    res.end(png ? PNG : `.${MARK}{color:#ff0000}body{background:#fff}` + Array.from({ length: 50 }, (_, i) => `.p${i}{color:#${(0x101010 + i * 997).toString(16).slice(-6)}}`).join(''));
  });
  privPort = await listen(priv);
  cdn = http.createServer((req, res) => {
    const h = { 'content-type': req.url.includes('.png') ? 'image/png' : 'text/css', 'cache-control': 'max-age=60' };
    if (req.url.includes('cors')) h['access-control-allow-origin'] = '*';
    res.writeHead(200, h);
    res.end(req.url.includes('.png') ? PNG : '.cdn-mark{color:#00f}');
  });
  cdnPort = await listen(cdn);
  const target = `http://intranet.corp-example.com:${privPort}`;
  pub = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>pub</title><link rel="stylesheet" href="${target}/secret.css"><link rel="stylesheet" href="http://cdn.public-example.com:${cdnPort}/site.css"><body><p id="t" class="${MARK}">x</p><img id="i" src="${target}/secret.png"><script>
      addEventListener('load', async () => {
        const p = {};
        try { p.rules = document.styleSheets[0].cssRules.length; } catch (e) { p.rules = e.name; }
        p.img = document.getElementById('i').naturalWidth;
        try { await fetch('${target}/secret.css?nocors', { mode: 'no-cors' }); p.fetch = 'ok'; } catch { p.fetch = 'blocked'; }
        window.__probe = p;
      });</script>`,
    );
  });
  pubPort = await listen(pub);
  browser = await launch({
    args: [
      '--host-resolver-rules=MAP enaloo.com ~NOTFOUND, MAP www.page-example.com 127.0.0.1, MAP intranet.corp-example.com 127.0.0.1, MAP cdn.public-example.com 127.0.0.1',
      `--ip-address-space-overrides=127.0.0.1:${pubPort}=public,127.0.0.1:${cdnPort}=public`,
    ],
  });
});

after(async () => {
  await browser?.close();
  await Promise.all([close(priv), close(pub), close(proxy), close(cdn)]);
});

const ask = (type, url) =>
  browser.worker.evaluate(
    async ({ type, url }) => {
      const [tab] = await chrome.tabs.query({ url: 'http://www.page-example.com/*' });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (m) => chrome.runtime.sendMessage(m), args: [{ type, url }] });
      return r.result;
    },
    { type, url },
  );

test('the browser blocks the public page from the private server, and the worker refuses it too; a public CDN still works', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`http://www.page-example.com:${pubPort}/page.html`);
  await waitState(page, 'ready');
  await page.waitForFunction(() => window.__probe, null, { timeout: 15000 });
  const probe = await page.evaluate(() => window.__probe);
  console.log('# page', JSON.stringify(probe));
  assert.equal(probe.img, 0, 'the browser blocked the image for the page');
  assert.equal(probe.fetch, 'blocked', 'the browser blocked the page fetch');

  const target = `http://intranet.corp-example.com:${privPort}`;
  const text = await ask('dk.net.text', `${target}/secret.css`);
  const image = await ask('dk.net.image', `${target}/secret.png`);
  const unused = await ask('dk.net.text', `${target}/other.css`);
  const open = await ask('dk.net.text', `http://cdn.public-example.com:${cdnPort}/site.css`);
  console.log('# seen by the private server', JSON.stringify(seen));
  assert.deepEqual(seen, [], 'nothing reached the private server');
  assert.deepEqual(text, { ok: false, code: 'unused' });
  assert.deepEqual(image, { ok: false, code: 'unused' });
  assert.deepEqual(unused, { ok: false, code: 'unused' }, 'an address the page does not name is still refused');
  assert.equal(open.ok, true, 'a public sheet the page loads is still fetched');
  assert.ok(open.text.includes('cdn-mark'));

  const read = await page.evaluate((mark) => {
    let styles = 0;
    for (const s of document.querySelectorAll('style')) if ((s.textContent || '').includes(mark)) styles++;
    return styles;
  }, MARK);
  assert.equal(read, 0, "no copy of the private sheet is in the page");
  await page.close();
});

// The browser primitive a fix could use, with no new permission. Chromium only; Firefox 158 ignores the option.
test('Chromium: fetch with targetAddressSpace "public" refuses a loopback address before sending, and fails behind a proxy', { timeout: 90000 }, async () => {
  const go = (url, space) =>
    browser.worker.evaluate(
      async ({ url, space }) => {
        try {
          return (await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'manual', targetAddressSpace: space })).status;
        } catch {
          return 'failed';
        }
      },
      { url, space },
    );
  const target = `http://intranet.corp-example.com:${privPort}`;
  const before = seen.length;
  const wrong = await go(`${target}/space-public.css`, 'public');
  const right = await go(`${target}/space-loopback.css`, 'loopback');
  console.log('# targetAddressSpace', JSON.stringify({ wrong, right, seen: seen.slice(before).map((r) => r.path) }));
  if (wrong === 200) {
    // An older browser ignores the option.
    console.log('# this browser ignores targetAddressSpace');
    return;
  }
  assert.equal(wrong, 'failed');
  assert.equal(right, 200);
  assert.deepEqual(
    seen.slice(before).map((r) => r.path),
    ['/space-loopback.css'],
    'the refused request was never sent',
  );

  // Behind a proxy the browser cannot see the address, and every value of the option fails, even for a public site.
  const hits = [];
  proxy = http.createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url);
    const up = http.request({ host: '127.0.0.1', port: Number(u.port || 80), path: u.pathname, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => (res.writeHead(502), res.end()));
    req.pipe(up);
  });
  const proxyPort = await listen(proxy);
  const proxied = await launch({ args: [`--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>'] });
  try {
    const url = `http://cdn.public-example.com:${privPort}/proxied.css`;
    const results = await proxied.worker.evaluate(async (u) => {
      const one = async (space) => {
        try {
          return (await fetch(`${u}?${space}`, { cache: 'no-store', credentials: 'omit', ...(space === 'none' ? {} : { targetAddressSpace: space }) })).status;
        } catch {
          return 'failed';
        }
      };
      return { none: await one('none'), public: await one('public'), loopback: await one('loopback') };
    }, url);
    console.log('# behind a proxy', JSON.stringify(results));
    assert.equal(results.none, 200);
    assert.equal(results.public, 'failed');
    assert.equal(results.loopback, 'failed');
  } finally {
    await proxied.close();
  }
});

// Behind an HTTP proxy every value of the option fails, and the page's own check cannot see the address either: the proxy resolves
// the name. So the page reads the file itself with CORS: a public sheet with a CORS header comes through, one without is refused
//.
test('behind a proxy a public sheet with a CORS header comes through, read by the page; one without is refused', { timeout: 90000 }, async () => {
  const forwarded = [];
  const relay = http.createServer((req, res) => {
    forwarded.push(req.url);
    const u = new URL(req.url);
    const up = http.request({ host: '127.0.0.1', port: Number(u.port || 80), path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => (res.writeHead(502), res.end()));
    req.pipe(up);
  });
  const relayPort = await listen(relay);
  const proxied = await launch({ args: [`--proxy-server=http://127.0.0.1:${relayPort}`, '--proxy-bypass-list=<-loopback>'] });
  try {
    await proxied.clearStorage();
    await proxied.setStorage({ settings: { enabled: true } });
    const page = await proxied.context.newPage();
    await page.goto(`http://www.page-example.com:${pubPort}/page.html`);
    await waitState(page, 'ready');
    const viaProxy = (url) =>
      proxied.worker.evaluate(async (u) => {
        const [tab] = await chrome.tabs.query({ url: 'http://www.page-example.com/*' });
        const [x] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (m) => chrome.runtime.sendMessage(m), args: [{ type: 'dk.net.text', url: u }] });
        return x.result;
      }, url);
    await page.evaluate((u) => new Promise((r) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = u; l.onload = l.onerror = r; document.head.append(l); }), `http://cdn.public-example.com:${cdnPort}/site-cors.css`);
    const r = await viaProxy(`http://cdn.public-example.com:${cdnPort}/site-cors.css`);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.text.includes('cdn-mark'));
    assert.deepEqual(await viaProxy(`http://cdn.public-example.com:${cdnPort}/site.css`), { ok: false, code: 'unused' }, 'no CORS header: the worker does not read it for the page');
    assert.ok(forwarded.some((u) => u.includes('/site-cors.css')), 'the requests went through the proxy');
    await page.close();
  } finally {
    await proxied.close();
    await close(relay);
  }
});

// A page on a private network may read a private server, not this machine. The worker asks for the public space, then the private
// one, and the browser judges each against the real address. The page has a private name; its sheets have public-looking names.
test('a page on a private network: a sheet on a private server comes through by the private space; one on this machine is refused unsent', { timeout: 90000 }, async () => {
  const officeSeen = [];
  const office = http.createServer((req, res) => {
    officeSeen.push(req.url);
    res.writeHead(200, { 'content-type': req.url.endsWith('.css') ? 'text/css' : 'text/html' });
    res.end(req.url.endsWith('.css') ? '.office-mark{color:#0a0}' : '<!doctype html><title>office</title><p>x');
  });
  const officePort = await listen(office);
  const lan = await launch({
    args: [
      '--host-resolver-rules=MAP enaloo.com ~NOTFOUND, MAP portal.corp 127.0.0.1, MAP files.office-example.com 127.0.0.1, MAP intranet.corp-example.com 127.0.0.1',
      `--ip-address-space-overrides=127.0.0.1:${officePort}=private`,
    ],
  });
  try {
    await lan.clearStorage();
    await lan.setStorage({ settings: { enabled: true } });
    const page = await lan.context.newPage();
    await page.goto(`http://portal.corp:${officePort}/index.html`);
    const sheets = [`http://files.office-example.com:${officePort}/a.css`, `http://intranet.corp-example.com:${privPort}/office.css`];
    // The page names both sheets, so the use check passes.
    await page.evaluate((list) => list.forEach((u) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = u; document.head.append(l); }), sheets);
    await page.waitForTimeout(500);
    const ask = (url) =>
      lan.worker.evaluate(async (u) => {
        const [tab] = await chrome.tabs.query({ url: 'http://portal.corp/*' });
        const [x] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (m) => chrome.runtime.sendMessage(m), args: [{ type: 'dk.net.text', url: u }] });
        return x.result;
      }, url);
    const before = seen.length;
    const near = await ask(sheets[0]);
    const loop = await ask(sheets[1]);
    assert.equal(near.ok, true, JSON.stringify(near));
    assert.ok(near.text.includes('office-mark'));
    assert.deepEqual(loop, { ok: false, code: 'unused' });
    // The page's own CORS read may reach it (this browser lets a private page send to this machine); CORS keeps the answer from it.
    assert.ok(
      seen.slice(before).every((r) => r.origin === `http://portal.corp:${officePort}`),
      `this machine got no request from the worker: ${JSON.stringify(seen.slice(before))}`,
    );
    await page.close();
  } finally {
    await lan.close();
    await close(office);
  }
});
