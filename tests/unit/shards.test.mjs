import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitShards } from '../../scripts/lib/shards.mjs';

const items = (/** @type {number[]} */ w) => w.map((weight, i) => ({ file: `f${i}.mjs`, weight }));

test('every file lands in exactly one group', () => {
  const groups = splitShards(items([5, 3, 8, 1, 9, 2, 7]), 3);
  const all = groups.flat().sort();
  assert.deepEqual(all, items([5, 3, 8, 1, 9, 2, 7]).map((i) => i.file).sort());
});

test('groups are close to equal in weight', () => {
  const w = [90, 80, 70, 60, 50, 40, 30, 20, 10];
  const groups = splitShards(items(w), 3);
  const sums = groups.map((g) => g.reduce((s, f) => s + w[Number(/f(\d+)/.exec(f)?.[1])], 0));
  assert.ok(Math.max(...sums) - Math.min(...sums) <= 20, String(sums));
});

test('more groups than files, zero files and a bad count are safe', () => {
  assert.equal(splitShards(items([1, 2]), 5).length, 2);
  assert.deepEqual(splitShards([], 3), []);
  assert.equal(splitShards(items([1, 2, 3]), NaN).length, 1);
  assert.equal(splitShards(items([1, 2, 3]), 0).length, 1);
});

test('the result does not depend on the order of the input', () => {
  const a = splitShards(items([4, 9, 2, 7, 5]), 2);
  const b = splitShards([...items([4, 9, 2, 7, 5])].reverse(), 2);
  assert.deepEqual(a, b);
});
