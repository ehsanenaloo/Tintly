// A page that is switched off leaves nothing of the modules behind: no listener on the window, the document or the root, whether the
// engine in the tab is let go by the worker (the master switch, a bare-host rule) or only stops (a rule the registration cannot say).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

let servers;
let browser;
before(async () => {
  servers = await startServers();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await servers?.close();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A page with a CDP session that knows the isolated world of the extension. */
async function openPage(path) {
  const page = await browser.context.newPage();
  const cdp = await page.context().newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  cdp.on('Runtime.executionContextDestroyed', (e) => contexts.splice(0, contexts.length, ...contexts.filter((c) => c.id !== e.executionContextId)));
  await cdp.send('Runtime.enable');
  await page.goto(`${servers.origin}${path}`);
  return { page, cdp, contexts };
}

/** The listeners that code of the extension has on the window, the document and the root. */
async function listeners({ cdp, contexts }) {
  const world = contexts.filter((c) => c.auxData?.type === 'isolated' && /Tintly/.test(c.name)).pop();
  if (!world) return [];
  const out = [];
  for (const expr of ['window', 'document', 'document.documentElement']) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr, contextId: world.id });
    if (!result.objectId) continue;
    const { listeners: list } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    for (const l of list) out.push(`${expr}:${l.type}`);
  }
  return out.sort();
}

const settle = async (p, ms = 1500) => sleep(ms * SLOW);

test('the master switch lets the engine go: the namespace and every listener', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const p = await openPage('/dynamic.html');
  await waitState(p.page, 'ready', 20000 * SLOW);
  await settle();
  const on = await listeners(p);
  assert.ok(on.length > 10, `the themed page has the listeners of the modules: ${on.length}`);
  await browser.setStorage({ settings: { enabled: false } });
  await p.page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 10000 * SLOW });
  // The worker lets the engine go after a quiet time (RETIRE_MS).
  await sleep(3500 * SLOW);
  assert.deepEqual(await listeners(p), []);
  await p.page.close();
});

test('a rule with a path that turns the page off leaves only the listeners of a page that loaded off', { timeout: 120000 * SLOW }, async () => {
  const rules = { siteRules: { '127.0.0.1/dynamic.html': { enabled: false } } };
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true }, siteRules: {} });
  const p = await openPage('/dynamic.html');
  await waitState(p.page, 'ready', 20000 * SLOW);
  await settle();
  await browser.setStorage({ settings: { enabled: true }, ...rules });
  await p.page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 10000 * SLOW });
  await settle(2500);
  const after = await listeners(p);
  const fresh = await openPage('/dynamic.html');
  await fresh.page.waitForLoadState('load');
  await settle(2500);
  const baseline = await listeners(fresh);
  assert.deepEqual(after, baseline);
  await p.page.close();
  await fresh.page.close();
});
