import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { createData, shardOf } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'data.js')).href);

const HOST = 'shop.example.com';
const SHARD = `data/fixes/${shardOf(HOST)}.json`;

/** A file reader whose answers are listed by hand; a function entry runs, an Error entry rejects. */
function reader(script) {
  const calls = [];
  const readJson = async (path) => {
    calls.push(path);
    const next = script[path]?.shift();
    if (typeof next === 'function') return next();
    if (next instanceof Error) throw next;
    return next ?? null;
  };
  return { readJson, calls };
}

test('a shard that was read is kept for good', async () => {
  const { readJson, calls } = reader({ [SHARD]: [{ [HOST]: { engine: 'filter' } }], 'data/dark-sites.json': [[]] });
  const data = createData({ readJson, now: () => 0 });
  for (let i = 0; i < 5; i++) assert.equal((await data.forHost(HOST, '/', undefined)).builtin.engine, 'filter');
  assert.equal(calls.filter((p) => p === SHARD).length, 1);
});

test('a failed shard read is not kept: the next ask after a short wait reads again', async () => {
  let t = 0;
  const { readJson, calls } = reader({ [SHARD]: [new Error('disk'), { [HOST]: { engine: 'filter' } }], 'data/dark-sites.json': [[]] });
  const data = createData({ readJson, now: () => t });
  assert.equal((await data.forHost(HOST, '/', undefined)).builtin, null);
  // Asked again at once: the failure is not read again for every frame of the page.
  assert.equal((await data.forHost(HOST, '/', undefined)).builtin, null);
  assert.equal(calls.filter((p) => p === SHARD).length, 1);
  t = 60_000;
  assert.equal((await data.forHost(HOST, '/', undefined)).builtin.engine, 'filter');
  assert.equal(calls.filter((p) => p === SHARD).length, 2);
  t = 10_000_000;
  await data.forHost(HOST, '/', undefined);
  assert.equal(calls.filter((p) => p === SHARD).length, 2, 'the success stays');
});

test('a missing shard (null) is asked again later, not for ever', async () => {
  let t = 0;
  const { readJson, calls } = reader({ [SHARD]: [null, { [HOST]: { engine: 'static' } }], 'data/dark-sites.json': [[]] });
  const data = createData({ readJson, now: () => t });
  assert.equal((await data.forHost(HOST, '/', undefined)).builtin, null);
  t = 60_000;
  assert.equal((await data.forHost(HOST, '/', undefined)).builtin.engine, 'static');
  assert.equal(calls.filter((p) => p === SHARD).length, 2);
});

test('the dark list is kept after a success and read again after a failure', async () => {
  let t = 0;
  const { readJson, calls } = reader({ [SHARD]: [{}, {}, {}], 'data/dark-sites.json': [new Error('disk'), [HOST]] });
  const data = createData({ readJson, now: () => t });
  assert.equal((await data.forHost(HOST, '/', undefined)).dark, false);
  t = 60_000;
  assert.equal((await data.forHost(HOST, '/', undefined)).dark, true);
  t = 120_000;
  assert.equal((await data.forHost(HOST, '/', undefined)).dark, true);
  assert.equal(calls.filter((p) => p === 'data/dark-sites.json').length, 2);
});

test('asks that arrive while a read runs share it', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { readJson, calls } = reader({ [SHARD]: [() => gate.then(() => ({ [HOST]: { engine: 'filter' } }))], 'data/dark-sites.json': [[]] });
  const data = createData({ readJson, now: () => 0 });
  const all = Promise.all(Array.from({ length: 10 }, () => data.forHost(HOST, '/', undefined)));
  await new Promise((r) => setImmediate(r));
  release();
  assert.ok((await all).every((r) => r.builtin.engine === 'filter'));
  assert.equal(calls.filter((p) => p === SHARD).length, 1);
});

test('path keys are found from an index: the same answers as a scan, and the key list is read once', async () => {
  const big = {};
  for (let i = 0; i < 3000; i++) big[`h${i}.example.org`] = { engine: 'filter' };
  big[`${HOST}/account`] = { engine: 'static' };
  big['*.pathy.example.com/x'] = { engine: 'static' };
  big['deep.example.com/a/b'] = { engine: 'static' };
  let listed = 0;
  const shard = new Proxy(big, {
    ownKeys(target) {
      listed++;
      return Reflect.ownKeys(target);
    },
  });
  const { readJson } = reader({ [SHARD]: [shard], 'data/dark-sites.json': [[]] });
  // Every host of the cases below shares the shard of example.com.
  const data = createData({ readJson, now: () => 0 });
  const cases = [
    [HOST, true],
    ['www.shop.example.com', true],
    ['q.pathy.example.com', true],
    ['deep.example.com', true],
    ['other.example.com', false],
    ['example.com', false],
  ];
  for (let round = 0; round < 20; round++) {
    for (const [host, want] of cases) {
      const r = await data.forHost(host, '/', undefined);
      assert.equal(r.paths, want, host);
    }
  }
  assert.ok(listed <= 1, `the keys were listed ${listed} times`);
});
