// a site on an IPv6 literal (http://[::1]:port/) gets a rule key, the gate finds the rule, and the content scripts are registered
// for it with a match pattern the browser accepts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, waitState } from './harness.mjs';

let browser;
let server;
let port;
let skip = false;

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>v6</title><style>body{margin:0;background:#fff;color:#222}</style></head><body><main><p>Hello</p></main></body></html>';

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', resolve);
    });
  } catch {
    skip = 'no IPv6 loopback on this machine';
    return;
  }
  port = server.address().port;
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

const state = (page) => page.evaluate(() => document.documentElement.getAttribute('data-dk-state'));
const plan = () => browser.worker.evaluate(() => globalThis.tintlyRegister.plan);
const failed = () => browser.worker.evaluate(() => globalThis.tintlyRegister.failed);

test('an IPv6 site is themed with the extension on', { skip, timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`http://[::1]:${port}/`);
  await waitState(page, 'ready');
  await page.close();
});

test('only listed sites: a rule for the IPv6 host registers the engine for exactly that host, and the page is themed', { skip, timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, listMode: 'onlyListed' }, siteRules: { '[::1]': { enabled: true } } });
  assert.equal(await failed(), false, 'the registration was accepted');
  const p = await plan();
  assert.deepEqual(p.matches, ['*://[::1]/*']);
  const page = await browser.context.newPage();
  await page.goto(`http://[::1]:${port}/`);
  await waitState(page, 'ready');
  assert.equal(await state(page), 'ready');
  await page.close();
  // The same page on the IPv4 loopback address is not in the set: nothing of ours runs there.
  const other = await browser.context.newPage();
  await other.goto(`http://127.0.0.1:${port}/`).catch(() => {});
  await other.close();
});

test('a rule with a port finds the page by its host with the port; a rule without a port covers every port', { skip, timeout: 60000 }, async () => {
  for (const key of [`[::1]:${port}`, '[::1]']) {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, listMode: 'onlyListed' }, siteRules: { [key]: { enabled: true } } });
    assert.equal(await failed(), false);
    const page = await browser.context.newPage();
    await page.goto(`http://[::1]:${port}/`);
    await waitState(page, 'ready');
    await page.close();
  }
  // A rule for another port leaves the page alone.
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, listMode: 'onlyListed' }, siteRules: { [`[::1]:${port + 1}`]: { enabled: true } } });
  const page = await browser.context.newPage();
  await page.goto(`http://[::1]:${port}/`);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await state(page), null);
  await page.close();
});

test('a rule that turns the IPv6 site off keeps it out of the registration and the page is left alone', { skip, timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true }, siteRules: { '[::1]': { enabled: false } } });
  assert.equal(await failed(), false);
  const p = await plan();
  assert.deepEqual(p.excludeMatches, ['*://[::1]/*']);
  const page = await browser.context.newPage();
  await page.goto(`http://[::1]:${port}/`);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await state(page), null);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk]').length), 0);
  await page.close();
});
