import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { loadContent } from '../helpers/content.mjs';

// prefetch.js needs a page; the part under test is the bucket function it defines.
globalThis.document = { readyState: 'loading' };
globalThis.location = { protocol: 'http:', host: 'x.test' };
globalThis.chrome = { storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener() {}, removeListener() {} } } };
const dk = await loadContent('core/prefetch.js', 'core/match.js');
const gate = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'gate.js')).href);
const { bucketOf, buildBuckets, createGate, META, LIST, PREFIX } = gate;

let seed = 7;
const rand = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed % n);
const pick = (list) => list[rand(list.length)];
const LABELS = ['a', 'b', 'www', 'example', 'shop', 'co', 'com', 'org', 'uk', 'localhost'];
const host = () => Array.from({ length: 1 + rand(4) }, () => pick(LABELS)).join('.');
const withPort = (h) => (rand(4) === 0 ? `${h}:${pick([80, 8080, 3000])}` : h);
const path = () => (rand(3) === 0 ? '/' : `/${Array.from({ length: 1 + rand(3) }, () => pick(['docs', 'a', 'b', 'x'])).join('/')}`);

test('the bucket function of the page and the one of the worker are the same', () => {
  for (const h of ['example.com', 'A.B.Example.COM:8080', '*.example.com', 'localhost', 'localhost:3000', '[::1]', '[::1]:80', '127.0.0.1', 'a.co.uk', '', 'x']) {
    assert.equal(dk.bucketOf(h), bucketOf(h), h);
  }
});

test('every key that can match a page is in the bucket of the page (random keys, hosts and paths)', () => {
  for (let round = 0; round < 300; round++) {
    const rules = {};
    const fixes = {};
    const add = [];
    const remove = [];
    for (let i = 0; i < 25; i++) {
      const h = host();
      const key = pick([h, `${h}${path()}`, `*.${h}`, withPort(h), `${withPort(h)}${path()}`]).replace(/\/$/, '');
      pick([rules, fixes])[key] = { n: i };
      (rand(2) ? add : remove).push(key);
    }
    const buckets = buildBuckets(rules, fixes, { add, remove });
    for (let q = 0; q < 20; q++) {
      const h = withPort(host());
      const p = path();
      const b = buckets.get(bucketOf(h)) ?? {};
      assert.deepEqual(dk.match.find(b.r ?? {}, h, p), dk.match.find(rules, h, p), `rule for ${h}${p}`);
      assert.deepEqual(dk.match.find(b.f ?? {}, h, p), dk.match.find(fixes, h, p), `fix for ${h}${p}`);
      const map = (list) => Object.fromEntries((list ?? []).map((k) => [k, true]));
      assert.equal(!!dk.match.find(map(b.a), h, p), !!dk.match.find(map(add), h, p), `dark add for ${h}${p}`);
      assert.equal(!!dk.match.find(map(b.d), h, p), !!dk.match.find(map(remove), h, p), `dark remove for ${h}${p}`);
    }
  }
});

test('garbage in the stored sections is skipped', () => {
  const b = buildBuckets([1], 'x', { add: [3, 'a.com'], remove: 'no' });
  assert.deepEqual([...b.keys()], ['a.com']);
});

function fakeLocal(initial = {}, { failSet = false } = {}) {
  const data = structuredClone(initial);
  const calls = { get: [], set: [], remove: [] };
  return {
    data,
    calls,
    async get(keys) {
      calls.get.push(keys);
      const list = Array.isArray(keys) ? keys : [keys];
      return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    async set(items) {
      calls.set.push(Object.keys(items));
      if (failSet) throw new Error('QUOTA_BYTES quota exceeded');
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      calls.remove.push([keys].flat());
      for (const k of [keys].flat()) delete data[k];
    },
  };
}

const SOURCE = { updatedAt: 5, siteRules: { 'a.com': { enabled: false }, 'x.b.org/p': { enabled: true } }, userFixes: { 'a.com': { engine: 'filter' } }, darkSites: { add: ['c.net'], remove: [] } };

test('the first pass writes the buckets, the list and the revision in one call', async () => {
  const local = fakeLocal(SOURCE);
  const g = createGate({ local });
  await g.start();
  assert.equal(local.calls.set.length, 1);
  assert.deepEqual(local.data[META], { v: 1, rev: 5 });
  assert.deepEqual(Object.keys(local.data[LIST]).sort(), ['a.com', 'b.org', 'c.net']);
  assert.deepEqual(local.data[`${PREFIX}a.com`], { r: { 'a.com': { enabled: false } }, f: { 'a.com': { engine: 'filter' } } });
  assert.deepEqual(local.data[`${PREFIX}c.net`], { a: ['c.net'] });
});

test('a worker that finds the copy made for this revision writes nothing', async () => {
  const local = fakeLocal(SOURCE);
  await createGate({ local }).start();
  local.calls.set.length = 0;
  await createGate({ local }).start();
  assert.deepEqual(local.calls.set, []);
});

test('a change of one section writes only the buckets that changed; a settings change moves the revision only', async () => {
  const local = fakeLocal(SOURCE);
  const g = createGate({ local });
  await g.start();
  local.calls.set.length = 0;
  local.data.updatedAt = 6;
  local.data.siteRules = { ...local.data.siteRules, 'new.org': { enabled: false } };
  await g.follow({ siteRules: {}, updatedAt: {} });
  assert.deepEqual(local.calls.set[0].sort(), [LIST, META, `${PREFIX}new.org`].sort());
  assert.equal(local.data[META].rev, 6);
  local.calls.set.length = 0;
  local.data.updatedAt = 7;
  await g.follow({ settings: {}, updatedAt: {} });
  assert.deepEqual(local.calls.set, [[META]]);
  assert.equal(local.data[META].rev, 7);
  // The keys of the copy itself are not a change.
  local.calls.set.length = 0;
  await g.follow({ [META]: {}, [`${PREFIX}a.com`]: {} });
  assert.deepEqual(local.calls.set, []);
});

test('a bucket that is gone is written empty with the new revision, then removed', async () => {
  const local = fakeLocal(SOURCE);
  const g = createGate({ local });
  await g.start();
  local.data.updatedAt = 6;
  local.data.darkSites = { add: [], remove: [] };
  await g.follow({ darkSites: {}, updatedAt: {} });
  assert.equal(local.calls.set.at(-1).includes(`${PREFIX}c.net`), true);
  assert.equal(`${PREFIX}c.net` in local.data, false);
  assert.deepEqual(Object.keys(local.data[LIST]).sort(), ['a.com', 'b.org']);
});

test('a full storage removes the copy, so pages read the sections', async () => {
  const local = fakeLocal(SOURCE, { failSet: true });
  const warned = [];
  const g = createGate({ local, warn: (e) => warned.push(String(e.message)) });
  await g.start();
  assert.equal(META in local.data, false);
  assert.equal(warned.length, 1);
});

test('many changes in a row are taken in few passes', async () => {
  const local = fakeLocal(SOURCE);
  const g = createGate({ local });
  await g.start();
  local.calls.get.length = 0;
  for (let i = 0; i < 20; i++) void g.follow({ settings: {}, updatedAt: {} });
  await g.settled();
  assert.ok(local.calls.get.length <= 4, String(local.calls.get.length));
});
