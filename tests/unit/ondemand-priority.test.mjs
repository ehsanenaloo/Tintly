// The worker injects the parts that a first look waits for before the picture and reading parts, and repeats nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnDemand, LIMITS } from '../../extension/background/modules/ondemand.js';

/** An injection API whose calls finish when the test says so. */
function slow() {
  const started = [];
  const gates = [];
  const scripting = {
    executeScript: (injection) =>
      new Promise((resolve, reject) => {
        started.push(injection.files[0].replace(/^content\/\w+\/|\.js$/g, ''));
        gates.push({ resolve: () => resolve([{}]), reject: () => reject(new Error('gone')) });
      }),
  };
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { od: createOnDemand({ scripting }), started, gates, flush };
}

const who = (n, doc = `d${n}`) => ({ tabId: 1, frameId: 0, documentId: doc });

test('a place is kept for the parts a first look waits for: the picture parts take one place, the others the rest', async () => {
  const s = slow();
  const asked = ['images', 'backdrop', 'imagebg', 'readability'].map((name, i) => s.od.inject(name, who(i)));
  await s.flush();
  assert.deepEqual(s.started, ['images'], 'only one picture part runs at a time');
  const decision = s.od.inject('sitetheme', who(9));
  const palette = s.od.inject('einkpalette', who(8));
  await s.flush();
  assert.deepEqual(s.started, ['images', 'sitetheme', 'einkpalette']);
  assert.equal(LIMITS.RUNNING, 3);
  // The place of the first part that ends goes to the waiting one with the best rank, not the oldest.
  s.gates[1].resolve();
  await s.flush();
  const calm = s.od.inject('calm', who(7));
  await s.flush();
  assert.deepEqual(s.started, ['images', 'sitetheme', 'einkpalette', 'calm']);
  for (const g of s.gates) g.resolve();
  await s.flush();
  for (let i = 0; i < 6; i++) {
    for (const g of s.gates) g.resolve();
    await s.flush();
  }
  assert.deepEqual(await Promise.all([...asked, decision, palette, calm]), Array(7).fill({ ok: true }));
  assert.deepEqual(s.started.slice(4).sort(), ['backdrop', 'imagebg', 'readability']);
});

test('a better rank that waits goes before a worse one that came first', async () => {
  const s = slow();
  // Fill the three places with parts of the best rank.
  const first = ['schedule', 'filter', 'static'].map((name, i) => s.od.inject(name, who(i)));
  const late = s.od.inject('images', who(5));
  const decision = s.od.inject('sitetheme', who(6));
  await s.flush();
  assert.deepEqual(s.started, ['schedule', 'filter', 'static']);
  s.gates[0].resolve();
  await s.flush();
  assert.equal(s.started[3], 'sitetheme');
  for (let i = 0; i < 8; i++) {
    for (const g of s.gates) g.resolve();
    await s.flush();
  }
  await Promise.all([...first, late, decision]);
  assert.equal(s.started[4], 'images');
});

test('a second request for the same part of the same document shares the first and counts once', async () => {
  const s = slow();
  const a = s.od.inject('sitetheme', who(1));
  const b = s.od.inject('sitetheme', who(1));
  await s.flush();
  assert.equal(s.started.length, 1);
  s.gates[0].resolve();
  assert.deepEqual(await Promise.all([a, b]), [{ ok: true }, { ok: true }]);
  // Another document asks for its own.
  const c = s.od.inject('sitetheme', who(2));
  await s.flush();
  assert.equal(s.started.length, 2);
  s.gates[1].resolve();
  await c;
  // After the answer the same document may ask again (a refused try is repeated by the page).
  const d = s.od.inject('sitetheme', who(1));
  await s.flush();
  assert.equal(s.started.length, 3);
  s.gates[2].resolve();
  await d;
});

test('a failed injection frees its place and the queue goes on', async () => {
  const s = slow();
  const jobs = ['sitetheme', 'filter', 'static', 'schedule'].map((name, i) => s.od.inject(name, who(i)));
  await s.flush();
  assert.equal(s.started.length, 3);
  s.gates[0].reject();
  await s.flush();
  assert.equal(s.started.length, 4);
  for (let i = 0; i < 6; i++) {
    for (const g of s.gates) g.resolve();
    await s.flush();
  }
  const done = await Promise.all(jobs);
  assert.deepEqual(done[0], { ok: false, code: 'failed' });
  assert.deepEqual(done.slice(1), Array(3).fill({ ok: true }));
});
