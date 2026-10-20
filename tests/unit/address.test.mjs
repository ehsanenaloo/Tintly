import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContent } from '../helpers/content.mjs';
import { REPO } from '../helpers/tree.mjs';
import { L } from '../../extension/shared/limits.js';
import { isUrlPart } from '../../extension/shared/settings.js';

const dk = await loadContent('core/match.js');
const tester = (...patterns) => dk.match.addressTester(patterns);

test('a pattern without a star is a part of the address, in any case', () => {
  const t = tester('//fonts.example/', '/WP-Content/fonts.css');
  assert.equal(t('https://fonts.example/css?family=x'), true);
  assert.equal(t('https://FONTS.example/css'), true);
  assert.equal(t('https://site.example/wp-content/fonts.css?ver=1'), true);
  assert.equal(t('https://site.example/other.css'), false);
});

test('a star stands for any run of characters, empty or not, and the parts keep their order', () => {
  const t = tester('cdn.example/*/icons.css');
  assert.equal(t('https://cdn.example/v1/icons.css'), true);
  assert.equal(t('https://cdn.example/a/b/c/icons.css'), true);
  assert.equal(t('https://cdn.example//icons.css'), true);
  assert.equal(t('https://cdn.example/icons.css'), false);
  assert.equal(t('https://other.example/v1/icons.css'), false);
  const order = tester('b*a');
  assert.equal(order('xxbxxa'), true);
  assert.equal(order('xxaxxb'), false);
});

test('parts do not overlap, stars at the ends and doubled stars change nothing', () => {
  assert.equal(tester('ab*ba')('aba'), false);
  assert.equal(tester('ab*ba')('abba'), true);
  assert.equal(tester('*icons*')('https://x.example/icons.css'), true);
  assert.equal(tester('a**b')('xaxbx'), true);
  assert.equal(tester('*')('anything'), true);
  assert.equal(tester('***')(''), true);
});

test('what the old regular expression matched, the new matcher matches (differential)', () => {
  const old = (p, s) => new RegExp(p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i').test(s);
  const patterns = ['a*b', 'a.b', '*x*', 'ab*ba', 'a*b*c', '/css/*.css', '?v=1', 'a+b', '(x)', '[y]', 'q*', '*q', 'a*a*a'];
  const inputs = ['ab', 'axb', 'a.b', 'aXb', 'https://h/css/main.css', 'x?v=1', 'a+b', '(x)', '[y]', 'qq', 'aaa', 'aa', 'zzaabzzbazz', 'abba', 'aba', 'abc', ''];
  for (const p of patterns) {
    const t = tester(p);
    for (const s of inputs) assert.equal(t(s), old(p, s), `${JSON.stringify(p)} on ${JSON.stringify(s)}`);
  }
});

test('bad or oversize patterns and inputs are ignored, never thrown on', () => {
  const t = tester(7, null, '', 'x'.repeat(201), '*'.repeat(9), 'ok');
  assert.equal(t('ok'), true);
  assert.equal(t('xxx'), false);
  assert.equal(tester('*'.repeat(8))('a'), true);
  assert.equal(tester('a')('a'.repeat(2049)), false);
  assert.equal(tester('a')(undefined), false);
  assert.equal(dk.match.addressTester(undefined)('a'), false);
  assert.equal(dk.match.addressTester(Array.from({ length: 80 }, (_, i) => `host-${i}.x`))('host-60.x'), false);
  assert.equal(dk.match.addressTester(Array.from({ length: 80 }, (_, i) => `host-${i}.x`))('host-49.x'), true);
});

test('hostile patterns finish in a few milliseconds', () => {
  const longInput = `https://h.example/${'a'.repeat(2000)}`;
  const cases = [
    ['*a'.repeat(8) + 'b', longInput],
    ['a*a*a*a*a*a*a*a*b', 'a'.repeat(2048)],
    [`${'a'.repeat(100)}*${'a'.repeat(99)}b`, 'a'.repeat(2048)],
    ['(a*)*b', 'a'.repeat(2048)],
    ['(a+)+$', `${'a'.repeat(2040)}!`],
    ['*'.repeat(8) + 'z', 'a'.repeat(2048)],
  ];
  const t = tester(...cases.map((c) => c[0]));
  const start = performance.now();
  for (let i = 0; i < 50; i++) for (const [, input] of cases) t(input);
  const ms = performance.now() - start;
  assert.ok(ms < 100, `300 hostile checks took ${ms.toFixed(1)} ms`);
  assert.equal(t(longInput), false);
});

test('the settings check refuses more stars than the matcher takes', () => {
  assert.equal(L.URL_PART_STARS, 8);
  assert.equal(isUrlPart('*'.repeat(8) + 'a'), true);
  assert.equal(isUrlPart('*'.repeat(9) + 'a'), false);
  assert.equal(isUrlPart('a*b*c'), true);
});

test('no regular expression is built from text in the content scripts', () => {
  for (const file of ['core/match.js', 'engine/dynamic.js']) {
    const text = readFileSync(join(REPO, 'extension', 'content', file), 'utf8');
    assert.equal(/\bRegExp\s*\(/.test(text), false, file);
  }
});
