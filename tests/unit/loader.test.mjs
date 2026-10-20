import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { REPO } from '../helpers/tree.mjs';

const source = readFileSync(process.env.DK_LOADER_FILE ?? join(REPO, 'extension', 'content', 'core', 'loader.js'), 'utf8');
const KEYS = { static: 'staticEngine' };

/** The real loader.js in a context whose worker answers only when the test says so. */
function rig() {
  const log = [];
  const waiting = new Map();
  const dk = {};
  const sandbox = {
    __dk: dk,
    performance: { now: () => 0 },
    setTimeout,
    queueMicrotask,
    clearTimeout,
    chrome: {
      runtime: {
        sendMessage: (m) =>
          new Promise((resolve) => {
            const list = waiting.get(m.module) ?? [];
            list.push(resolve);
            waiting.set(m.module, list);
          }),
      },
    },
  };
  vm.runInNewContext(source, sandbox);
  /** Answer the oldest open request for a module: install it (ok) or refuse. */
  const reply = async (name, ok = true) => {
    const resolve = waiting.get(name).shift();
    if (ok) {
      const key = KEYS[name] ?? name;
      dk[key] = {
        start: (...a) => log.push(`${name}.start`),
        sync: () => log.push(`${name}.sync`),
        stop: () => log.push(`${name}.stop`),
      };
    }
    resolve(ok ? { ok: true } : { ok: false, code: 'failed' });
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  const open = (name) => (waiting.get(name) ?? []).length;
  return { dk, log, reply, open, sync: (d) => dk.optional.sync(d) };
}

const theme = { fontEnabled: true };
const off = { on: false, eink: false, kind: 'dynamic', theme: {}, images: null };
const dark = { on: true, eink: false, kind: 'dynamic', theme, images: { key: 'k', options: {} } };
const eink = { on: true, eink: true, kind: 'dynamic', theme: {}, images: null };
const started = (log) => log.filter((x) => /\.(start|sync)$/.test(x));

test('backdrop and images that arrive after the images went off start nothing', async () => {
  const r = rig();
  r.sync(dark);
  r.sync({ ...off });
  await r.reply('backdrop');
  await r.reply('images');
  await r.reply('calm');
  if (r.open('extras')) await r.reply('extras');
  assert.deepEqual(started(r.log), []);
});

test('calm that arrives after the decision went off starts nothing', async () => {
  const r = rig();
  r.sync(eink);
  r.sync(off);
  await r.reply('einkpalette');
  await r.reply('calm');
  assert.deepEqual(started(r.log), []);
});

test('readability after an E-ink decision that went off starts nothing, with the replies in reverse order', async () => {
  const r = rig();
  r.dk.dynamic = {};
  r.sync(eink);
  r.sync(off);
  await r.reply('calm');
  await r.reply('einkpalette');
  assert.equal(r.open('readability'), 0);
  assert.deepEqual(started(r.log), []);
});

test('calm does not start when the E-ink palette could not be loaded', async () => {
  const r = rig();
  r.sync(eink);
  await r.reply('einkpalette', false);
  await r.reply('calm');
  assert.deepEqual(started(r.log), []);
});

test('the newest decision of a rapid dark, E-ink, off, on run wins and old replies are dropped', async () => {
  const r = rig();
  r.dk.dynamic = {};
  r.sync(dark);
  r.sync(eink);
  r.sync(off);
  const last = { ...dark, images: { key: 'k2', options: {} } };
  r.sync(last);
  // A change soon after a start waits for a quiet moment before the picture modules start.
  await new Promise((done) => setTimeout(done, 900));
  await r.reply('einkpalette');
  await r.reply('calm');
  for (const name of ['backdrop', 'images']) while (r.open(name)) await r.reply(name);
  while (r.open('extras')) await r.reply('extras');
  const s = started(r.log);
  assert.ok(!s.includes('calm.start'));
  assert.equal(s.filter((x) => x === 'backdrop.start').length, 1);
  assert.equal(s.filter((x) => x === 'images.start').length, 1);
  assert.equal(s.filter((x) => x === 'extras.sync').length, 1);
});

test('an images decision that is repeated keeps its pending start', async () => {
  const r = rig();
  r.sync(dark);
  r.sync(dark);
  await r.reply('backdrop');
  await r.reply('images');
  assert.deepEqual(started(r.log).sort(), ['backdrop.start', 'images.start']);
});

test('a module that failed to load is asked for again by the next decision', async () => {
  const r = rig();
  r.sync(dark);
  // Each failed request is asked twice when the answer is a timeout; a refusal is final.
  await r.reply('backdrop', false);
  await r.reply('images', false);
  r.sync(dark);
  assert.equal(r.open('backdrop'), 1);
  await r.reply('backdrop');
  await r.reply('images');
  assert.deepEqual(started(r.log).sort(), ['backdrop.start', 'images.start']);
});

test('with a defer list the changes of the modules wait for the commit of the engine swap', async () => {
  const r = rig();
  const defer = [];
  r.sync({ ...eink, defer });
  await r.reply('einkpalette');
  await r.reply('calm');
  assert.deepEqual(started(r.log), []);
  assert.ok(defer.length > 0);
  defer.splice(0).forEach((f) => f());
  assert.deepEqual(started(r.log), ['calm.start']);
});

test('a stop is deferred too, and a decision made after it drops the deferred changes', async () => {
  const r = rig();
  r.sync(eink);
  await r.reply('einkpalette');
  await r.reply('calm');
  assert.deepEqual(started(r.log), ['calm.start']);
  const defer = [];
  r.sync({ ...off, defer });
  assert.ok(!r.log.includes('calm.stop'));
  r.sync({ ...eink, defer: null });
  defer.splice(0).forEach((f) => f());
  assert.ok(!r.log.includes('calm.stop'), 'a deferred change of an older decision runs');
});

test('images that are deferred set their key at the commit, so a repeated decision still starts them', async () => {
  const r = rig();
  const defer = [];
  r.sync({ ...dark, defer });
  r.sync({ ...dark, defer: null });
  await r.reply('backdrop');
  await r.reply('images');
  assert.deepEqual(started(r.log).sort(), ['backdrop.start', 'images.start']);
  defer.splice(0).forEach((f) => f());
  assert.equal(started(r.log).length, 2);
});

test('a module that arrives after the deferred changes were run starts at once', async () => {
  const r = rig();
  const defer = [];
  r.sync({ ...eink, defer });
  defer.done = true;
  defer.splice(0).forEach((f) => f());
  await r.reply('einkpalette');
  await r.reply('calm');
  assert.deepEqual(started(r.log), ['calm.start']);
  assert.equal(defer.length, 0);
});
