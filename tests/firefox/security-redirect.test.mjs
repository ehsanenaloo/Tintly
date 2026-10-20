// T-03 in Firefox: a public address that redirects to a private one must not cause a request to the private server.
// The public names are resolved to the loopback address by a preference of the test profile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServers } from '../browser/harness.mjs';
import { startFirefox, firefoxSkip } from './driver.mjs';

const skip = firefoxSkip();
let servers;
let ff;
let ext;
let pub;
let priv;
let pubPort;
let privPort;
const seenPub = [];
const seenPriv = [];
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  priv = http.createServer((req, res) => {
    seenPriv.push(req.url);
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('secret{color:red}');
  });
  privPort = await listen(priv);
  pub = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    // The page's own loads carry a referrer; the extension's fetch does not.
    const from = req.headers.referer ? 'page' : 'extension';
    seenPub.push({ host, path: req.url, from });
    if (req.url === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><title>pub</title><link rel="stylesheet" href="http://cdn.test:${pubPort}/ok.css"><link rel="stylesheet" href="http://cdn.test:${pubPort}/private.css"><link rel="stylesheet" href="http://cdn.test:${pubPort}/chain.css"><link rel="stylesheet" href="http://cdn.test:${pubPort}/loop.css"><body><p>x</p></body>`,
      );
      return;
    }
    const to = { '/private.css': `http://127.0.0.1:${privPort}/secret.css`, '/chain.css': '/chain2.css', '/chain2.css': `http://127.0.0.1:${privPort}/hop.css`, '/loop.css': '/loop.css' }[req.url];
    if (req.url === '/ok.css' || from === 'page' || !to) {
      res.writeHead(req.url === '/ok.css' || from === 'page' ? 200 : 404, { 'content-type': 'text/css' });
      res.end('p{color:#123456}');
      return;
    }
    res.writeHead(302, { location: to });
    res.end();
  });
  pubPort = await listen(pub);
  servers = await startServers();
  ff = await startFirefox({ prefs: { 'network.dns.localDomains': 'pub.test,cdn.test' } });
  ext = (await ff.extensionPage(servers.origin, '/pages/options/options.html')).frame;
});

after(async () => {
  await ff?.close();
  await servers?.close();
  await new Promise((r) => pub?.close(r));
  await new Promise((r) => priv?.close(r));
});

test('T-03: a public address that redirects to a private one never reaches the private server', { skip, timeout: 90000 }, async () => {
  await ff.run(ext, async () => (await browser.storage.local.clear(), await browser.storage.local.set({ settings: { enabled: true } }), await browser.runtime.sendMessage({ type: 'dk.register.sync' })));
  const tab = await ff.newTab(`http://pub.test:${pubPort}/page.html`);
  // The engine asks the worker for each sheet of another origin; wait until it has asked for all of them.
  for (let i = 0; i < 100 && !['/ok.css', '/private.css', '/chain.css', '/loop.css'].every((p) => seenPub.some((r) => r.from === 'extension' && r.path === p)); i++) await sleep(100);
  await sleep(500);
  const asked = seenPub.filter((r) => r.from === 'extension' && r.path !== '/page.html' && r.path !== '/favicon.ico');
  console.log('# extension requests', JSON.stringify(asked.map((r) => r.path)));
  assert.ok(asked.some((r) => r.path === '/private.css'), 'the worker asked for the redirecting sheet');
  assert.deepEqual(seenPriv, [], `the private server was asked: ${seenPriv.join(' ')}`);
  assert.equal(asked.filter((r) => r.path === '/chain2.css').length, 0, 'the second hop was not asked');
  assert.equal(asked.filter((r) => r.path === '/loop.css').length, 1, 'a loop is one request');
  assert.ok(tab);
});
