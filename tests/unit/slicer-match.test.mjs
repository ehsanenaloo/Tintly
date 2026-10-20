import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('core/match.js', 'engine/slicer.js');

/* ---------- slicer ---------- */

function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('a slice should end after the soft limit', () => {
  const clock = fakeClock();
  const s = dk.slicer.createSlicer({ softMs: 6, hardMs: 12, now: clock.now, yield: async () => {} });
  assert.equal(s.shouldYield(), false);
  clock.advance(5.9);
  assert.equal(s.shouldYield(), false);
  clock.advance(0.2);
  assert.equal(s.shouldYield(), true);
});

test('yielding closes the slice, counts it and starts a new one', async () => {
  const clock = fakeClock();
  let yields = 0;
  const s = dk.slicer.createSlicer({ softMs: 6, hardMs: 12, now: clock.now, yield: async () => { yields++; clock.advance(100); } });
  clock.advance(7);
  await s.yieldNow();
  assert.equal(yields, 1);
  assert.equal(s.stats.slices, 1);
  assert.equal(s.stats.totalMs, 7);
  assert.equal(s.stats.overruns, 0);
  // The time spent while yielding is not counted in the next slice.
  assert.equal(s.shouldYield(), false);
});

test('a slice over the hard limit is an overrun, and overruns in a row are counted', async () => {
  const clock = fakeClock();
  const s = dk.slicer.createSlicer({ softMs: 6, hardMs: 12, now: clock.now, yield: async () => {} });
  for (const ms of [13, 20, 5, 30]) {
    clock.advance(ms);
    await s.yieldNow();
  }
  assert.equal(s.stats.slices, 4);
  assert.equal(s.stats.overruns, 3);
  assert.equal(s.stats.maxOverrunsInARow, 2);
  assert.equal(s.stats.overrunsInARow, 1);
  assert.equal(s.stats.maxMs, 30);
});

test('slices are counted by phase', async () => {
  const clock = fakeClock();
  const s = dk.slicer.createSlicer({ softMs: 6, hardMs: 12, now: clock.now, yield: async () => {} });
  s.phase('quick');
  for (const ms of [40, 48]) {
    clock.advance(ms);
    await s.yieldNow();
  }
  s.phase('live');
  for (const ms of [4, 9]) {
    clock.advance(ms);
    await s.yieldNow();
  }
  assert.deepEqual(s.stats.phases.quick, { slices: 2, maxMs: 48, overruns: 2 });
  assert.deepEqual(s.stats.phases.live, { slices: 2, maxMs: 9, overruns: 0 });
  assert.equal(s.stats.slices, 4);
});

test('maybeYield only yields when the slice is used up', async () => {
  const clock = fakeClock();
  let yields = 0;
  const s = dk.slicer.createSlicer({ now: clock.now, yield: async () => { yields++; } });
  await s.maybeYield();
  assert.equal(yields, 0);
  clock.advance(10);
  await s.maybeYield();
  assert.equal(yields, 1);
});

test('forEach visits every item and yields on the way', async () => {
  const clock = fakeClock();
  let yields = 0;
  const s = dk.slicer.createSlicer({ softMs: 6, now: clock.now, yield: async () => { yields++; } });
  const seen = [];
  await s.forEach([1, 2, 3, 4, 5, 6], (n) => { seen.push(n); clock.advance(4); });
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  assert.equal(yields, 3);
});

test('forEach stops when asked to', async () => {
  const s = dk.slicer.createSlicer({ yield: async () => {} });
  const seen = [];
  await s.forEach([1, 2, 3, 4], (n) => seen.push(n), () => seen.length >= 2);
  assert.deepEqual(seen, [1, 2]);
});

test('the real yield works without a scheduler', async () => {
  const s = dk.slicer.createSlicer();
  await s.yieldNow();
  assert.equal(s.stats.slices, 1);
});

/* ---------- match ---------- */

const find = (rules, host, path = '/') => dk.match.find(rules, host, path);

test('candidates come most specific first', () => {
  assert.deepEqual(dk.match.candidates('a.b.example.com', '/x/y'), [
    'a.b.example.com/x/y',
    'a.b.example.com/x',
    'a.b.example.com',
    'b.example.com',
    'example.com',
    '*.b.example.com',
    '*.example.com',
  ]);
});

test('a port is tried first, then the host without it', () => {
  assert.deepEqual(dk.match.candidates('localhost:8080', '/'), ['localhost:8080', 'localhost']);
  assert.deepEqual(dk.match.candidates('example.com', '/'), ['example.com']);
});

test('a rule for a domain also covers its subdomains, the longest match wins', () => {
  const rules = { 'example.com': { id: 'apex' }, 'blog.example.com': { id: 'blog' } };
  assert.equal(find(rules, 'example.com').id, 'apex');
  assert.equal(find(rules, 'www.example.com').id, 'apex');
  assert.equal(find(rules, 'blog.example.com').id, 'blog');
  assert.equal(find(rules, 'a.blog.example.com').id, 'blog');
  assert.equal(find(rules, 'other.org'), undefined);
});

test('a path rule beats a host rule, the longest prefix wins', () => {
  const rules = { 'example.com': { id: 'host' }, 'example.com/docs': { id: 'docs' }, 'example.com/docs/api': { id: 'api' } };
  assert.equal(find(rules, 'example.com', '/').id, 'host');
  assert.equal(find(rules, 'example.com', '/docs/x').id, 'docs');
  assert.equal(find(rules, 'example.com', '/docs/api/v1').id, 'api');
  assert.equal(find(rules, 'example.com', '/documents').id, 'host');
});

test('a wildcard covers subdomains only', () => {
  const rules = { '*.example.com': { id: 'wild' } };
  assert.equal(find(rules, 'www.example.com').id, 'wild');
  assert.equal(find(rules, 'example.com'), undefined);
});

test('the TLD alone is never a parent', () => {
  assert.deepEqual(dk.match.candidates('example.com', '/'), ['example.com']);
  assert.equal(find({ com: { id: 'tld' } }, 'example.com'), undefined);
});

test('host matching ignores case', () => {
  assert.equal(find({ 'example.com': { id: 'x' } }, 'WWW.Example.COM').id, 'x');
});

test('hostile or missing rule maps are handled', () => {
  assert.equal(find(null, 'a.com'), undefined);
  assert.equal(find(undefined, 'a.com'), undefined);
  assert.equal(find('text', 'a.com'), undefined);
  assert.equal(find({}, 'a.com'), undefined);
  assert.equal(find({}, 'constructor'), undefined);
  assert.equal(find({}, '__proto__'), undefined);
  assert.equal(find({}, 'toString'), undefined);
  assert.equal(find(Object.create(null), 'a.com'), undefined);
});

test('odd hosts and paths do not break the lookup', () => {
  assert.doesNotThrow(() => dk.match.candidates('', ''));
  assert.doesNotThrow(() => dk.match.candidates('[::1]:80', '//a//b///'));
  assert.doesNotThrow(() => dk.match.candidates(undefined, undefined));
  // Empty segments inside a path are kept, as a stored pattern keeps them (`a.com//x//` is stored as `a.com//x`).
  assert.deepEqual(dk.match.candidates('a.com', '//x//'), ['a.com//x', 'a.com']);
});
