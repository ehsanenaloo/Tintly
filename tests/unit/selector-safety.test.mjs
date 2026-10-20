import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const S = await import(pathToFileURL(join(REPO, 'extension', 'shared', 'settings.js')).href);

const BAD = [
  'a /* x',
  '/*',
  'a/*b',
  'a\\',
  '.x\\',
  'a\\\\\\',
  '@import url(https://evil.example/x.css)',
  '@import "x.css"',
  '@media screen',
  'a, @import url(x)',
  'a */ b',
  'a }',
];
const GOOD = [
  'a',
  '.x > .y',
  'div[data-a="b]c"]',
  ':not(.a, .b)',
  'a:hover::before',
  '#id.cls',
  'a\\:b',
  '.w-1\\/2',
  'a[href$="/*"]',
  'a[title="x\\\\"]',
  '.a\\ b',
  'a\\\\',
];

test('selectors that would corrupt joined CSS are refused', () => {
  for (const s of BAD) assert.equal(S.isSafeSelector(s), false, s);
});

test('ordinary selectors, escapes and quoted comment marks are still accepted', () => {
  for (const s of GOOD) assert.equal(S.isSafeSelector(s), true, s);
});

test('the schema refuses them in strict and lenient mode', () => {
  for (const s of BAD) {
    const fix = { dynamic: { invert: [s] } };
    const strict = S.sanitizeSection('userFixes', { 'a.example': fix }, { strict: true });
    assert.ok(strict.errors.length > 0, `strict ${s}`);
    const lenient = S.sanitizeSection('userFixes', { 'a.example': fix }, { strict: false });
    assert.ok(!JSON.stringify(lenient.value ?? {}).includes(JSON.stringify(s)), `lenient ${s}`);
  }
});
