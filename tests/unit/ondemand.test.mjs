import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { createOnDemand, MODULES, LIMITS } from '../../extension/background/modules/ondemand.js';
import { ENGINE_FILES, HOOK_FILES } from '../../extension/background/modules/register.js';
import { loadContent } from '../helpers/content.mjs';

const manifest = JSON.parse(readFileSync(join(REPO, 'extension', 'manifest.json'), 'utf8'));
const listed = new Set([...HOOK_FILES, ...ENGINE_FILES]);

function make(now = () => 0) {
  const calls = [];
  const scripting = { executeScript: async (injection) => (calls.push(injection), [{}]) };
  return { calls, od: createOnDemand({ scripting, now }) };
}

test('the injectable files are real, are not in the manifest and together with it cover every content script', () => {
  for (const [name, file] of Object.entries(MODULES)) {
    assert.ok(existsSync(join(REPO, 'extension', file)), name);
    assert.ok(!listed.has(file), `${name} is registered and on demand`);
    assert.ok(/^content\/(engine|core)\/[a-z]+\.js$/.test(file));
  }
  const all = [];
  for (const dir of ['core', 'engine']) for (const f of readdirSync(join(REPO, 'extension', 'content', dir))) all.push(`content/${dir}/${f}`);
  for (const f of all) assert.ok(listed.has(f) || Object.values(MODULES).includes(f), `${f} is loaded by nobody`);
});

test('a name from the list is injected into the asking frame only, in the isolated world', async () => {
  const { od, calls } = make();
  const r = await od.inject('images', { tabId: 7, frameId: 3 });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { target: { tabId: 7, frameIds: [3] }, files: ['content/engine/images.js'], world: 'ISOLATED', injectImmediately: true });
});

test('anything that is not a name of the list is refused and nothing is injected', async () => {
  const { od, calls } = make();
  for (const bad of ['', 'content/engine/images.js', '../manifest.json', 'images.js', 'IMAGES', 'constructor', '__proto__', 'toString', 7, null, undefined, {}, ['images']]) {
    assert.deepEqual(await od.inject(bad, { tabId: 1, frameId: 0 }), { ok: false, code: 'invalid' }, String(bad));
  }
  assert.equal(calls.length, 0);
});

test('a frame has a small allowance and a tab a larger one, both per minute', async () => {
  let t = 0;
  const { od, calls } = make(() => t);
  for (let i = 0; i < LIMITS.FRAME_COUNT; i++) assert.equal((await od.inject('calm', { tabId: 1, frameId: 0 })).ok, true);
  assert.deepEqual(await od.inject('calm', { tabId: 1, frameId: 0 }), { ok: false, code: 'rate' });
  // Another frame of the same tab still has its own allowance.
  assert.equal((await od.inject('calm', { tabId: 1, frameId: 1 })).ok, true);
  // The window passes.
  t += LIMITS.WINDOW_MS + 1;
  assert.equal((await od.inject('calm', { tabId: 1, frameId: 0 })).ok, true);
  // The tab allowance: many frames together.
  const tab = make(() => 0);
  let ok = 0;
  for (let f = 0; f < 200; f++) for (let k = 0; k < 4; k++) if ((await tab.od.inject('calm', { tabId: 2, frameId: f })).ok) ok++;
  assert.equal(ok, LIMITS.TAB_COUNT);
  assert.ok(calls.length > 0);
});

test('forgetting a tab clears its counts, and a failed injection is a plain refusal', async () => {
  const { od } = make();
  for (let i = 0; i < LIMITS.FRAME_COUNT; i++) await od.inject('calm', { tabId: 5, frameId: 0 });
  od.forgetTab(5);
  assert.equal((await od.inject('calm', { tabId: 5, frameId: 0 })).ok, true);
  const failing = createOnDemand({ scripting: { executeScript: async () => { throw new Error('no frame'); } } });
  assert.deepEqual(await failing.inject('calm', { tabId: 1, frameId: 0 }), { ok: false, code: 'failed' });
});

test('the router takes dk.inject from a content script only, with exactly one field', async () => {
  const { createRouter } = await import('../../extension/background/modules/router.js');
  const asked = [];
  const router = createRouter({ runtimeId: 'r', extensionOrigin: 'chrome-extension://r/', state: {}, net: {}, icon: {}, data: {}, ondemand: { inject: async (name, who) => (asked.push([name, who.tabId, who.frameId]), { ok: true }) } });
  const content = { id: 'r', url: 'https://a.example/', tab: { id: 4, url: 'https://a.example/' }, frameId: 2 };
  assert.deepEqual(await router.handle({ type: 'dk.inject', module: 'filter' }, content), { ok: true });
  assert.deepEqual(asked, [['filter', 4, 2]]);
  assert.equal((await router.handle({ type: 'dk.inject', module: 'filter' }, { id: 'r', url: 'chrome-extension://r/pages/popup/popup.html' })).code, 'denied');
  assert.equal((await router.handle({ type: 'dk.inject' }, content)).code, 'invalid');
  assert.equal((await router.handle({ type: 'dk.inject', module: 'filter', extra: 1 }, content)).code, 'invalid');
  assert.equal((await router.handle({ type: 'dk.inject', module: 7 }, content)).code, 'invalid');
  assert.equal((await router.handle({ type: 'dk.inject', module: 'x'.repeat(21) }, content)).code, 'invalid');
  assert.equal((await router.handle({ type: 'dk.inject', module: 'filter' }, { id: 'other', url: 'https://a.example/', tab: { id: 4 }, frameId: 0 })).code, 'denied');
});

test('the page side: a module is asked for once, an answer without the module counts as failed, a failure can be retried', async () => {
  const dk = await loadContent('core/loader.js');
  const sent = [];
  let respond = async (m) => {
    sent.push(m.module);
    dk.images = {};
    return { ok: true };
  };
  globalThis.chrome = { runtime: { sendMessage: (m) => respond(m) } };
  const [a, b] = await Promise.all([dk.need('images'), dk.need('images')]);
  assert.deepEqual([a, b], [true, true]);
  assert.deepEqual(sent, ['images']);
  assert.equal(await dk.need('images'), true);
  assert.deepEqual(sent, ['images'], 'a loaded module is not asked for again');

  // The worker says yes but the module is not there.
  respond = async (m) => (sent.push(m.module), { ok: true });
  assert.equal(await dk.need('backdrop'), false);
  // The worker refuses.
  respond = async (m) => (sent.push(m.module), { ok: false, code: 'rate' });
  assert.equal(await dk.need('filter'), false);
  // The call throws (no worker).
  respond = async () => { throw new Error('gone'); };
  assert.equal(await dk.need('static'), false);
  assert.equal(dk.optional.stats().failed, 3);
  // A later request goes out again.
  respond = async (m) => (sent.push(m.module), (dk.staticEngine = {}), { ok: true });
  assert.equal(await dk.need('static'), true);
  // extras needs calm first.
  sent.length = 0;
  respond = async (m) => (sent.push(m.module), (dk[m.module] = {}), { ok: true });
  assert.equal(await dk.need('extras'), true);
  assert.deepEqual(sent, ['calm', 'extras']);
  delete globalThis.chrome;
});

test('the page side: an answer that never comes is waited for a while, asked once more, then counted as failed, and the module can come in late', async () => {
  const { mock } = await import('node:test');
  // The module is loaded again under another address, so it starts with an empty namespace.
  const { pathToFileURL } = await import('node:url');
  globalThis.__dk = Object.create(null);
  await import(`${pathToFileURL(join(REPO, 'extension', 'content', 'core', 'loader.js')).href}?late`);
  const dk = globalThis.__dk;
  const sent = [];
  globalThis.chrome = { runtime: { sendMessage: (m) => (sent.push(m.module), new Promise(() => {})) } };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const job = dk.need('images');
    const flush = () => new Promise((r) => setImmediate(r));
    await flush();
    assert.deepEqual(sent, ['images']);
    mock.timers.tick(8000);
    await flush();
    assert.deepEqual(sent, ['images', 'images'], 'asked once more');
    mock.timers.tick(8000);
    assert.equal(await job, false);
    assert.ok(dk.optional.stats().failed >= 1);
    // The first injection arrives late: the module is there at the next request.
    dk.images = {};
    assert.equal(await dk.need('images'), true);
    // A slow answer that does come in time is taken at once.
    sent.length = 0;
    delete dk.backdrop;
    globalThis.chrome = { runtime: { sendMessage: async (m) => (sent.push(m.module), (dk.backdrop = {}), { ok: true }) } };
    assert.equal(await dk.need('backdrop'), true);
    assert.deepEqual(sent, ['backdrop']);
  } finally {
    mock.timers.reset();
    delete globalThis.chrome;
  }
});

test('the parts that rarely run are on the list under their own names, and the always-loaded files do not hold them', () => {
  const expected = {
    einkpalette: 'content/engine/einkpalette.js',
    sitetheme: 'content/engine/sitetheme.js',
    shadowroots: 'content/engine/shadowroots.js',
  };
  for (const [name, file] of Object.entries(expected)) {
    assert.equal(MODULES[name], file, name);
    assert.ok(!listed.has(file), `${file} is registered`);
  }
  const text = (file) => readFileSync(join(REPO, 'extension', file), 'utf8');
  // The functions that moved are not in the files every page loads.
  const always = [...listed].filter((f) => f.startsWith('content/')).map(text).join('\n');
  for (const gone of ['function einkPalette', 'function einkTransform', 'function repairVar', 'function collectCover', 'function trySite', 'function syncAdopted', 'function startRootInline', 'function lightSections']) {
    assert.ok(!always.includes(gone), `${gone} is in an always-loaded file`);
  }
  assert.ok(text(expected.einkpalette).includes('function einkTransform'));
  assert.ok(text(expected.sitetheme).includes('function trySite') && text(expected.sitetheme).includes('function assess'));
  assert.ok(text(expected.shadowroots).includes('function syncAdopted') && text(expected.shadowroots).includes('function startRootInline'));
});

test('the page side: the parts that moved are asked for one by one, each is timed, and none waits for another', async () => {
  const { pathToFileURL } = await import('node:url');
  globalThis.__dk = Object.create(null);
  await import(`${pathToFileURL(join(REPO, 'extension', 'content', 'core', 'loader.js')).href}?deps`);
  const dk = globalThis.__dk;
  const sent = [];
  globalThis.chrome = { runtime: { sendMessage: async (m) => (sent.push(m.module), (dk[m.module] = {}), { ok: true }) } };
  assert.equal(await dk.need('sitetheme'), true);
  assert.deepEqual(sent, ['sitetheme'], 'one injection, not a chain of two');
  assert.equal(await dk.need('einkpalette'), true);
  assert.equal(await dk.need('shadowroots'), true);
  assert.deepEqual(sent, ['sitetheme', 'einkpalette', 'shadowroots']);
  const ms = dk.optional.stats().ms;
  for (const name of ['sitetheme', 'einkpalette', 'shadowroots']) assert.ok(Number.isFinite(ms[name]) && ms[name] >= 0, name);
  delete globalThis.chrome;
});
