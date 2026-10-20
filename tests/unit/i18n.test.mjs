import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const mod = await import(pathToFileURL(join(REPO, 'extension', 'shared', 'i18n.js')).href);

test('a stored locale wins when it is shipped', () => {
  assert.equal(mod.pickLocale('he', ['en-US']), 'he');
});

test('an unknown stored locale falls back to the browser language', () => {
  assert.equal(mod.pickLocale('xx', ['fa-IR', 'en']), 'fa');
});

test('the browser language tag is matched by its base', () => {
  assert.equal(mod.pickLocale(undefined, ['ar-EG']), 'ar');
});

test('the old language code of Hebrew and an underscore tag are understood', () => {
  assert.equal(mod.pickLocale(undefined, ['iw']), 'he');
  assert.equal(mod.pickLocale(undefined, ['iw-IL']), 'he');
  assert.equal(mod.pickLocale(undefined, ['fa_IR']), 'fa');
});

test('the language of the browser interface is tried before the languages of web pages', () => {
  assert.equal(mod.pickLocale(undefined, ['ar', 'fa', 'en']), 'ar');
});

test('English is the final fallback', () => {
  assert.equal(mod.pickLocale(undefined, ['de', 'ja']), 'en');
});

test('format fills placeholders and keeps unknown ones', () => {
  assert.equal(mod.format('{a} and {b} and {c}', { a: 1, b: 'x' }), '1 and x and {c}');
});

test('format ignores inherited names', () => {
  assert.equal(mod.format('{toString}', {}), '{toString}');
});

test('every shipped locale loads and has the same keys', async () => {
  const en = await mod.loadCatalog('en');
  for (const code of mod.LOCALES) {
    assert.deepEqual(Object.keys(await mod.loadCatalog(code)).sort(), Object.keys(en).sort());
  }
});

test('the Persian catalog uses the polite plural, never the singular imperative, and says تاریک and not تیره', async () => {
  const fa = await mod.loadCatalog('fa');
  const singular = new Set(['کن', 'نکن', 'بده', 'نده', 'نزن', 'بزن', 'بگو', 'نگو', 'بگذار', 'نگذار', 'ببین', 'بیار', 'ببر', 'بذار']);
  for (const [key, text] of Object.entries(fa)) {
    for (const word of text.split(/[\s.,،:؛؟!()«»"]+/)) assert.ok(!singular.has(word), `${key} uses the singular imperative «${word}»`);
    assert.ok(!text.includes('تیره'), `${key} says تیره`);
  }
});

test('every catalog keeps the placeholders of the English text', async () => {
  const en = await mod.loadCatalog('en');
  const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const code of mod.LOCALES) {
    const catalog = await mod.loadCatalog(code);
    for (const [key, text] of Object.entries(en)) assert.deepEqual(names(catalog[key]), names(text), `${code} ${key}`);
  }
});
