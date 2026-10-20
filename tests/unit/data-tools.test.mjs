import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from '../helpers/tree.mjs';

const tool = (n) => import(pathToFileURL(join(REPO, 'scripts', 'data', n)).href);
const { buildData } = await tool('build.mjs');
const { judge, summarize } = await tool('report.mjs');
const { suggestFor } = await tool('suggest.mjs');

const VERIFIED = { date: '2026-10-15', browsers: ['chromium'], test: 'unit' };

function source(fixes, dark = []) {
  const root = mkdtempSync(join(tmpdir(), 'dk-data-'));
  mkdirSync(join(root, 'data-src', 'fixes'), { recursive: true });
  for (const [name, data] of Object.entries(fixes)) writeFileSync(join(root, 'data-src', 'fixes', name), typeof data === 'string' ? data : JSON.stringify(data));
  writeFileSync(join(root, 'data-src', 'dark-sites.json'), JSON.stringify(dark));
  return root;
}

test('good entries are sharded by host, and the index counts them', async () => {
  const root = source({ 'a.json': { 'example.com': { note: 'logo', verified: VERIFIED, dynamic: { invert: ['.logo'] } }, 'example.org/docs': { note: 'x', verified: VERIFIED, engine: 'static', static: { bg: ['.page'] } } } }, ['night.example']);
  const { errors, files, index } = await buildData(root);
  assert.deepEqual(errors, []);
  assert.equal(index.fixes, 2);
  assert.equal(files.get('dark-sites.json'), '[\n "night.example"\n]\n');
  const shard = [...files.keys()].find((k) => k.startsWith('fixes/'));
  assert.ok(shard);
  const all = [...files].filter(([k]) => k.startsWith('fixes/')).flatMap(([, v]) => Object.keys(JSON.parse(v)));
  assert.deepEqual(all.sort(), ['example.com', 'example.org/docs']);
});

test('entries without a note or a verified field, bad selectors and bad patterns are refused', async () => {
  const bad = {
    'a.json': {
      'nonote.com': { verified: VERIFIED },
      'noverify.com': { note: 'n' },
      'broad.com': { note: 'n', verified: VERIFIED, static: { bg: ['body'] } },
      'badsel.com': { note: 'n', verified: VERIFIED, dynamic: { invert: ['a{'] } },
      'Not A Host!!': { note: 'n', verified: VERIFIED },
      'unknown.com': { note: 'n', verified: VERIFIED, surprise: 1 },
    },
  };
  const { errors } = await buildData(source(bad));
  const text = errors.join('\n');
  for (const needle of ['nonote.com needs a note', 'noverify.com needs a verified', 'too broad', 'not an accepted selector', 'Not A Host!!', 'surprise']) assert.ok(text.includes(needle), `${needle}\n${text}`);
});

test('the same site in two files, and files that are not JSON, are refused', async () => {
  const entry = { note: 'n', verified: VERIFIED };
  const { errors } = await buildData(source({ 'a.json': { 'dup.com': entry }, 'b.json': { 'dup.com': entry }, 'c.json': '{not json', 'd.json': [] }));
  const text = errors.join('\n');
  assert.ok(text.includes('already defined'));
  assert.ok(text.includes('c.json: not valid JSON'));
  assert.ok(text.includes('d.json: must be an object'));
});

test('the report judges a page by what it shows', () => {
  const ok = { name: 'a', line: 'a', state: 'ready', lightBefore: 0.9, lightAfter: 0.01, checks: { lowCount: 0 }, stats: { faults: 0, capped: 0 } };
  assert.deepEqual(judge(ok), []);
  assert.deepEqual(judge({ ...ok, lightAfter: 0.8 }), ['light']);
  assert.deepEqual(judge({ ...ok, checks: { lowCount: 9 } }), ['contrast']);
  assert.deepEqual(judge({ ...ok, stats: { faults: 2, capped: 1 } }), ['fault', 'capped']);
  assert.deepEqual(judge({ ...ok, error: 'x' }), ['error']);
  // A page that is dark by itself and was left alone passes, even with low-contrast text of its own.
  assert.deepEqual(judge({ ...ok, state: null, lightBefore: 0.02, lightAfter: 0.02, checks: { lowCount: 40 } }), []);
  const s = summarize([ok, { ...ok, name: 'b', line: 'b', lightAfter: 0.9 }]);
  assert.deepEqual([s.pass, s.total, s.counts], [1, 2, { light: 1 }]);
});

test('a proposal is a draft without a verified field, and only comes from large light areas', () => {
  const failing = { name: 'a', line: 'shop.example', state: 'ready', lightBefore: 0.9, lightAfter: 0.8, checks: { lowCount: 0, lightBoxes: ['body', 'div.page > main.content', 'section.card'] } };
  const s = suggestFor(failing);
  const entry = s['shop.example'];
  assert.equal(entry.engine, 'static');
  assert.deepEqual(entry.static.bg, ['main.content', 'section.card']);
  assert.equal(entry.verified, undefined);
  assert.equal(suggestFor({ ...failing, lightAfter: 0.01 }), null);
  assert.equal(suggestFor({ ...failing, checks: { lowCount: 0, lightBoxes: [] } }), null);
});
