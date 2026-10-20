// A frame without an address of its own belongs to the frame that made it. The worker must not give it the data of the
// top page just because the top page is the first address of the tab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch } from './harness.mjs';

let server;
let browser;
let port;

before(async () => {
  server = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    res.writeHead(200, { 'content-type': 'text/html' });
    if (host === 'top.example') res.end('<!doctype html><title>top</title><body><iframe src="http://mid.example:' + port + '/mid.html"></iframe></body>');
    else res.end('<!doctype html><title>mid</title><body><iframe id="b"></iframe><iframe id="s" srcdoc="<p>x</p>"></iframe></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  browser = await launch({ args: ['--host-resolver-rules=MAP top.example 127.0.0.1, MAP mid.example 127.0.0.1'] });
});
after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

test('SEC: a blank frame made by a third party inside the top page gets no data of the top page', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({
    settings: { enabled: true },
    userFixes: { 'top.example': { note: 'private note of the top site', dynamic: { css: '.top-only{color:#fff}' } } },
  });
  const page = await browser.context.newPage();
  await page.goto(`http://top.example:${port}/`);
  await page.waitForFunction(() => document.querySelector('iframe'), null, { timeout: 15000 });
  for (let i = 0; i < 100 && page.frames().length < 4; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(page.frames().length, 4, page.frames().map((f) => f.url()).join(' '));
  const replies = await browser.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://top.example/*' });
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'ISOLATED',
      func: async () => ({ url: location.href, reply: await chrome.runtime.sendMessage({ type: 'dk.fix.forHost' }) }),
    });
    return out.map((r) => r.result);
  });
  const byUrl = (prefix) => replies.filter((r) => r.url.startsWith(prefix));
  assert.equal(byUrl('http://top.example')[0].reply.user?.note, 'private note of the top site', 'the top page gets its own fix');
  const blank = [...byUrl('about:blank'), ...byUrl('about:srcdoc')];
  assert.equal(blank.length, 2);
  for (const r of blank) assert.equal(r.reply.user, null, `${r.url} got the fix of the top page`);
  await page.close();
});
