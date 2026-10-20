// leftovers.js removes what a build left in a page whose world is gone. Its list of marks must name every `data-dk-*` attribute
// the content files write, or a new mark would stay behind after an update in Firefox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const CONTENT = join(REPO, 'extension', 'content');
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));

test('the sweep of leftovers.js knows every data-dk-* mark the content files write', () => {
  const ns = readFileSync(join(CONTENT, 'core', 'leftovers.js'), 'utf8');
  const list = /const MARKS = \[([^\]]*)\]/.exec(ns);
  assert.ok(list, 'the list of marks is there');
  const known = new Set([...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const used = new Set();
  for (const file of files(CONTENT)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/data-dk-([a-z]+)\b/g)) used.add(`data-dk-${m[1]}`);
  }
  assert.ok(used.size > 5);
  const missing = [...used].filter((name) => !known.has(name));
  assert.deepEqual(missing, []);
});
