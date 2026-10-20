// T-03: a public address that redirects to a private one must not cause a request to the private server. Two local servers count
// what reaches them. The public names are mapped to the loopback address by the browser, so they look public to the extension.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch } from './harness.mjs';

let browser;
let pub;
let priv;
let pubPort;
let privPort;
const seenPub = [];
const seenPriv = [];

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  priv = http.createServer((req, res) => {
    seenPriv.push(req.url);
    res.writeHead(200, { 'content-type': req.url.endsWith('.png') ? 'image/png' : 'text/css' });
    res.end(req.url.endsWith('.png') ? PNG : 'secret{color:red}');
  });
  privPort = await listen(priv);
  pub = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    // Fetch metadata is not sent over plain http to a name that is not local, so the page's own loads (which carry a referrer) are told apart from the extension's (no referrer).
    const dest = req.headers.referer ? 'page' : 'extension';
    seenPub.push({ host, path: req.url, dest });
    if (req.url === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><title>pub</title><link rel="stylesheet" href="http://cdn.test:${pubPort}/ok.css"><link rel="stylesheet" href="http://cdn.test:${pubPort}/private.css"><link rel="stylesheet" href="http://cdn.test:${pubPort}/chain.css"><link rel="stylesheet" href="http://cdn.test:${pubPort}/loop.css"><body><p>x</p><img src="http://cdn.test:${pubPort}/private.png"></body>`,
      );
      return;
    }
    // The page loads every file by itself without a redirect; only the extension's fetch (not a style or an image load) is sent on.
    const own = dest === 'page';
    const png = req.url.endsWith('.png');
    if (req.url === '/ok.css' || own) {
      res.writeHead(200, { 'content-type': png ? 'image/png' : 'text/css' });
      res.end(png ? PNG : 'p{color:#123456}');
      return;
    }
    const to = { '/private.css': `http://127.0.0.1:${privPort}/secret.css`, '/private.png': `http://127.0.0.1:${privPort}/secret.png`, '/chain.css': '/chain2.css', '/chain2.css': `http://127.0.0.1:${privPort}/hop.css`, '/loop.css': '/loop.css' }[req.url];
    if (!to) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(302, { location: to });
    res.end();
  });
  pubPort = await listen(pub);
  browser = await launch({ args: ['--host-resolver-rules=MAP *.test 127.0.0.1'] });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => pub?.close(r));
  await new Promise((r) => priv?.close(r));
});

const ask = (type, url) =>
  browser.worker.evaluate(
    async ({ type, url }) => {
      const [tab] = await chrome.tabs.query({ url: 'http://pub.test/*' });
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: (m) => chrome.runtime.sendMessage(m),
        args: [{ type, url }],
      });
      return r.result;
    },
    { type, url },
  );

test('T-03: a public address that redirects to a private one never reaches the private server', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`http://pub.test:${pubPort}/page.html`);
  await page.waitForLoadState('load');
  // The page's own loads (no redirect for them) are done; from here only the extension asks.
  const base = `http://cdn.test:${pubPort}`;
  const results = {
    ok: await ask('dk.net.text', `${base}/ok.css`),
    private: await ask('dk.net.text', `${base}/private.css`),
    chain: await ask('dk.net.text', `${base}/chain.css`),
    loop: await ask('dk.net.text', `${base}/loop.css`),
    image: await ask('dk.net.image', `${base}/private.png`),
  };
  console.log('# results', JSON.stringify(results));
  assert.equal(results.ok.ok, true, 'a direct stylesheet still works');
  for (const name of ['private', 'chain', 'loop', 'image']) assert.deepEqual(results[name], { ok: false, code: 'redirect' }, name);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(seenPriv, [], `the private server was asked: ${seenPriv.join(' ')}`);
  const fetched = seenPub.filter((r) => r.dest === 'extension' && r.path !== '/favicon.ico' && r.path !== '/page.html');
  console.log('# extension requests', JSON.stringify(fetched));
  // The engine asked for each sheet on its own, and the test asked once more: the first hop only, each time. The second hop of the
  // chain and the turns of the loop were never asked.
  assert.equal(fetched.filter((r) => r.path === '/chain2.css').length, 0);
  assert.equal(fetched.filter((r) => r.path === '/loop.css').length, 2);
  assert.equal(fetched.filter((r) => r.path === '/private.css').length, 2);
  await page.close();
});

test('T-03: a page on the private network reaches the private server itself (no redirect involved)', { timeout: 60000 }, async () => {
  const before = seenPriv.length;
  const page = await browser.context.newPage();
  await page.goto(`http://127.0.0.1:${privPort}/`);
  await page.close();
  assert.ok(seenPriv.length > before);
});
