// In Firefox, the match pattern of an IPv6 host is accepted by the registration, and the page is themed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServers } from '../browser/harness.mjs';
import { startFirefox, firefoxSkip } from './driver.mjs';

const ffSkip = firefoxSkip();
let servers;
let ff;
let ext;
let tabPage;
let server;
let port;
let skip = ffSkip;

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>v6</title><style>body{margin:0;background:#fff;color:#222}</style></head><body><main><p>Hello</p></main></body></html>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (ffSkip) return;
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
  servers = await startServers();
  ff = await startFirefox();
  ext = (await ff.extensionPage(servers.origin, '/pages/options/options.html')).frame;
  // `scripting` exists in an extension page that is a tab of its own, and not in a frame of a web page.
  tabPage = await ff.extensionTab(servers.origin, '/pages/options/options.html');
});
after(async () => {
  await ff?.close();
  await servers?.close();
  await new Promise((r) => server?.close(r));
});

const setStorage = (items) => ff.run(ext, async (o) => (await browser.storage.local.clear(), await browser.storage.local.set(o), await browser.runtime.sendMessage({ type: 'dk.register.sync' })), items);
const registered = () => ff.run(tabPage, async () => (await browser.scripting.getRegisteredContentScripts()).map((s) => ({ id: s.id, matches: s.matches, excludeMatches: s.excludeMatches })));
const state = (tab) => ff.run(tab, () => document.documentElement.getAttribute('data-dk-state'));

test('Firefox: a rule for an IPv6 host registers `*://[::1]/*` and the page is themed', { skip, timeout: 90000 }, async () => {
  await setStorage({ settings: { enabled: true, listMode: 'onlyListed' }, siteRules: { '[::1]': { enabled: true } } });
  const scripts = await registered();
  const engine = scripts.find((s) => s.id === 'dk-engine');
  assert.ok(engine, JSON.stringify(scripts));
  assert.deepEqual(engine.matches, ['*://[::1]/*']);
  const tab = await ff.newTab(`http://[::1]:${port}/`);
  let seen = null;
  for (let i = 0; i < 100 && seen !== 'ready'; i++) {
    seen = await state(tab);
    if (seen !== 'ready') await sleep(100);
  }
  assert.equal(seen, 'ready');
});

test('Firefox: a rule that turns the IPv6 host off is an exclusion and the page is left alone', { skip, timeout: 90000 }, async () => {
  await setStorage({ settings: { enabled: true }, siteRules: { '[::1]': { enabled: false } } });
  const engine = (await registered()).find((s) => s.id === 'dk-engine');
  assert.ok(engine);
  assert.deepEqual(engine.excludeMatches, ['*://[::1]/*']);
  const tab = await ff.newTab(`http://[::1]:${port}/`);
  await sleep(1500);
  assert.equal(await state(tab), null);
});
