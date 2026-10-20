// The loader after a failure: a caller is told no once, the loader asks again in the background with growing pauses while the page is
// shown, a part that comes later starts, and a part that cannot be had is given up and the waiting code is told. The worker, the
// clock and the visibility of the page are controlled by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { REPO } from '../helpers/tree.mjs';

const source = readFileSync(join(REPO, 'extension', 'content', 'core', 'loader.js'), 'utf8');
const KEYS = { static: 'staticEngine' };

function rig() {
  let now = 0;
  let seq = 0;
  /** @type {{ id: number, at: number, fn: () => void, live: boolean }[]} */
  const timers = [];
  const sent = [];
  /** @type {Map<string, ((v: any) => void)[]>} */
  const waiting = new Map();
  const dk = {};
  const log = [];
  const listeners = [];
  const doc = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => listeners.push([type, fn]),
  };
  const sandbox = {
    __dk: dk,
    performance: { now: () => now },
    queueMicrotask,
    setTimeout: (fn, ms) => {
      const t = { id: ++seq, at: now + (ms ?? 0), fn, live: true, unref() {} };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.live = false;
    },
    document: doc,
    chrome: {
      runtime: {
        id: 'x',
        sendMessage: (m) =>
          new Promise((resolve) => {
            sent.push(m.module);
            const list = waiting.get(m.module) ?? [];
            list.push(resolve);
            waiting.set(m.module, list);
          }),
      },
    },
  };
  vm.runInNewContext(source, sandbox);
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  /** Move the clock; timers run in order of their time. */
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      due.live = false;
      now = Math.max(now, due.at);
      due.fn();
      await flush();
    }
    now = end;
    await flush();
  };
  const install = (name) => {
    dk[KEYS[name] ?? name] = { start: () => log.push(`${name}.start`), sync: () => log.push(`${name}.sync`), stop: () => log.push(`${name}.stop`) };
  };
  /** Answer the oldest open request for the module. `install` puts the module in the namespace first, as the injected file does. */
  const reply = async (name, value, put = false) => {
    const resolve = waiting.get(name).shift();
    if (put) install(name);
    resolve(value);
    await flush();
  };
  return {
    dk,
    log,
    sent,
    doc,
    listeners,
    advance,
    reply,
    install,
    flush,
    open: (name) => (waiting.get(name) ?? []).length,
    sync: (d) => dk.optional.sync(d),
    count: (name) => sent.filter((n) => n === name).length,
  };
}

const failed = { ok: false, code: 'failed' };
const ok = { ok: true };
const dark = { on: true, eink: false, kind: 'dynamic', theme: {}, images: { key: 'k', options: {} } };
const off = { on: false, eink: false, kind: 'dynamic', theme: {}, images: null };

test('a caller is told no after two waits, and a reply that comes later still brings the module and tells who waited', async () => {
  const r = rig();
  const arrived = [];
  const verdict = [];
  void r.dk.need('sitetheme').then((v) => verdict.push(v));
  r.dk.optional.whenLoaded('sitetheme', () => arrived.push('sitetheme'));
  await r.advance(8000);
  assert.deepEqual(verdict, []);
  assert.equal(r.count('sitetheme'), 2, 'asked again after the first wait');
  await r.advance(8000);
  assert.deepEqual(verdict, [false]);
  assert.deepEqual(arrived, []);
  // The worker answers the first request after all: the module is there.
  await r.reply('sitetheme', ok, true);
  assert.deepEqual(arrived, ['sitetheme']);
  const stats = r.dk.optional.stats();
  assert.equal(stats.loaded, 1);
  assert.equal(stats.late, 1);
  assert.equal(stats.failed, 1);
  // No more asking once it is there.
  await r.advance(120000);
  assert.equal(r.count('sitetheme'), 2);
  assert.equal(await r.dk.need('sitetheme'), true);
});

test('after a refusal the loader asks again with growing pauses, a part that comes then is announced', async () => {
  const r = rig();
  const arrived = [];
  r.dk.optional.whenLoaded('imagebg', () => arrived.push('imagebg'));
  const first = r.dk.need('imagebg');
  await r.reply('imagebg', failed);
  assert.equal(await first, false);
  assert.equal(r.count('imagebg'), 1);
  await r.advance(1499);
  assert.equal(r.count('imagebg'), 1, 'not before the first pause');
  await r.advance(1);
  assert.equal(r.count('imagebg'), 2);
  await r.reply('imagebg', failed);
  await r.advance(3999);
  assert.equal(r.count('imagebg'), 2);
  await r.advance(1);
  assert.equal(r.count('imagebg'), 3);
  await r.reply('imagebg', ok, true);
  assert.deepEqual(arrived, ['imagebg']);
  assert.equal(r.dk.optional.stats().abandoned, 0);
});

test('the pauses are bounded: five more tries, then the module is given up and the code that waited for it is told once', async () => {
  const r = rig();
  const gone = [];
  r.dk.optional.whenGivenUp('static', () => gone.push('static'));
  void r.dk.need('static');
  await r.reply('static', failed);
  for (const pause of [1500, 4000, 10000, 25000, 60000]) {
    assert.deepEqual(gone, []);
    await r.advance(pause);
    await r.reply('static', failed);
  }
  assert.deepEqual(gone, ['static']);
  assert.equal(r.count('static'), 6);
  assert.equal(r.dk.optional.stats().abandoned, 1);
  await r.advance(600000);
  assert.equal(r.count('static'), 6, 'nothing is asked after the last pause');
  // A later listener hears at once.
  r.dk.optional.whenGivenUp('static', () => gone.push('again'));
  await r.flush();
  assert.deepEqual(gone, ['static', 'again']);
});

test('an answer that no later try can change gives the module up at once', async () => {
  const r = rig();
  const gone = [];
  r.dk.optional.whenGivenUp('filter', () => gone.push('filter'));
  const first = r.dk.need('filter');
  await r.reply('filter', { ok: false, code: 'invalid' });
  assert.equal(await first, false);
  assert.deepEqual(gone, ['filter']);
  await r.advance(200000);
  assert.equal(r.count('filter'), 1);
});

test('a page that is hidden asks nothing; it asks when it is shown again, and the pause is not used up', async () => {
  const r = rig();
  const first = r.dk.need('backdrop');
  await r.reply('backdrop', failed);
  await first;
  r.doc.visibilityState = 'hidden';
  await r.advance(1500);
  assert.equal(r.count('backdrop'), 1, 'hidden: no request');
  await r.advance(60000);
  assert.equal(r.count('backdrop'), 1);
  r.doc.visibilityState = 'visible';
  for (const [type, fn] of r.listeners.splice(0)) if (type === 'visibilitychange') fn();
  await r.flush();
  assert.equal(r.count('backdrop'), 2);
});

test('a part that arrives late starts if the decision is still the same, and not after a newer decision', async () => {
  const r = rig();
  r.sync(dark);
  await r.reply('backdrop', failed);
  await r.reply('images', failed);
  await r.flush();
  // The recovery of both parts: the second try brings them.
  await r.advance(1500);
  await r.reply('backdrop', ok, true);
  await r.reply('images', ok, true);
  assert.deepEqual(r.log.filter((x) => x.endsWith('.start')).sort(), ['backdrop.start', 'images.start']);

  const s = rig();
  s.sync(dark);
  await s.reply('backdrop', failed);
  await s.reply('images', failed);
  await s.flush();
  s.sync(off);
  await s.advance(1500);
  await s.reply('backdrop', ok, true);
  await s.reply('images', ok, true);
  assert.deepEqual(s.log.filter((x) => x.endsWith('.start')), []);
});

test('a request that is in flight is shared, and a module that is there is not asked for', async () => {
  const r = rig();
  const a = r.dk.need('calm');
  const b = r.dk.need('calm');
  assert.equal(a, b);
  assert.equal(r.count('calm'), 1);
  await r.reply('calm', ok, true);
  assert.equal(await a, true);
  assert.equal(await r.dk.need('calm'), true);
  assert.equal(r.count('calm'), 1);
  let heard = 0;
  r.dk.optional.whenLoaded('calm', () => heard++);
  await r.flush();
  assert.equal(heard, 1);
});

test('a module the page waits for with a dependency is asked in order, and the failure of the first fails the second', async () => {
  const r = rig();
  const extras = r.dk.need('extras');
  await r.flush();
  assert.equal(r.count('calm'), 1);
  assert.equal(r.count('extras'), 0);
  await r.reply('calm', failed);
  assert.equal(await extras, false);
  assert.equal(r.count('extras'), 0);
});

test('a module that was given up is not asked for again: the next caller hears no at once', async () => {
  const r = rig();
  const first = r.dk.need('schedule');
  await r.reply('schedule', { ok: false, code: 'unavailable' });
  assert.equal(await first, false);
  assert.equal(r.count('schedule'), 1);
  let answer = null;
  void r.dk.need('schedule').then((v) => (answer = v));
  await r.flush();
  assert.equal(answer, false, 'told at once, without the two waits');
  assert.equal(r.count('schedule'), 1, 'nothing is sent');
});

test('a stopped loader ends its tries in the background and asks for nothing', async () => {
  const r = rig();
  const first = r.dk.need('imagebg');
  await r.reply('imagebg', failed);
  await first;
  r.dk.optional.stop();
  await r.advance(200000);
  assert.equal(r.count('imagebg'), 1, 'the pending try did not run');
  assert.equal(await r.dk.need('calm'), false);
  assert.equal(r.count('calm'), 0);
});
