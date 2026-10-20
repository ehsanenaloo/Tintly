import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/rewrite.js', 'engine/sitedark.js', 'engine/sitetheme.js', 'engine/sheettext.js');
const C = dk.color;
const theme = C.createTheme({ mode: 'dark' });
const transformer = C.createTransformer(theme);
const rw = dk.rewrite.createRewriter(transformer);
const BASE = 'http://site.test/a.css';

const full = (value, property) => {
  rw.setRepair(false);
  return rw.declaration(property, value, BASE);
};
const repaired = (value, property) => {
  rw.setRepair(true);
  const out = rw.declaration(property, value, BASE);
  rw.setRepair(false);
  return out;
};

test('repair mode: a dark background, a light text and a shadow are left as the page wrote them', () => {
  assert.equal(repaired('#101418', 'background-color'), null);
  assert.equal(repaired('rgb(27, 33, 40)', 'background'), null);
  assert.equal(repaired('#e8eaed', 'color'), null);
  assert.equal(repaired('#8ab4f8', 'color'), null);
  assert.equal(repaired('0 1px 3px rgba(0,0,0,.2)', 'box-shadow'), null);
  assert.equal(repaired('1px solid #3b4450', 'border'), null);
});

test('repair mode: a light background, a dark text and a light border are rewritten by the usual curves', () => {
  assert.equal(repaired('#ffffff', 'background-color'), full('#ffffff', 'background-color'));
  assert.equal(repaired('#f1f3f5', 'background'), full('#f1f3f5', 'background'));
  assert.equal(repaired('#222', 'color'), full('#222', 'color'));
  assert.equal(repaired('#e3e3e3', 'border-bottom-color'), full('#e3e3e3', 'border-bottom-color'));
  assert.equal(repaired('1px solid #ddd', 'border'), full('1px solid #ddd', 'border'));
  assert.notEqual(repaired('#ffffff', 'background-color'), '#ffffff');
});

test('repair mode: a gradient keeps its dark stops and darkens the light ones', () => {
  const out = repaired('linear-gradient(180deg, #fff 80%, #0b0f14)', 'background-image');
  assert.ok(out.includes('#0b0f14'), out);
  assert.ok(!out.includes('#fff'), out);
  assert.equal(repaired('linear-gradient(#10151c, #0b0f14)', 'background-image'), null);
});

test('repair mode: translucent colors are judged over the page', () => {
  assert.equal(repaired('rgba(255,255,255,0.04)', 'background-color'), null);
  assert.notEqual(repaired('rgba(255,255,255,0.9)', 'background-color'), null);
  assert.equal(repaired('rgba(0,0,0,0.5)', 'background-color'), null);
});

test('repair mode: accents that carry white text stay, light accents are rewritten', () => {
  assert.equal(repaired('#1a73e8', 'background-color'), null);
  assert.notEqual(repaired('#fbc02d', 'background-color'), null);
  assert.equal(repaired('#c62828', 'background-color'), null);
});

test('repair mode: var() and custom properties are left to the page, light-dark() is read on its dark side', () => {
  assert.equal(repaired('var(--bg)', 'background-color'), null);
  rw.setRepair(true);
  assert.equal(rw.customProperty('--bg', '#fff', BASE), '');
  rw.setRepair(false);
  assert.equal(repaired('light-dark(#fff, #101418)', 'background-color'), null);
  const mixed = repaired('light-dark(#fff, #ffffff)', 'background-color');
  assert.ok(mixed.startsWith('light-dark(#fff,'), mixed);
  assert.equal(repaired('rgb(var(--ch) / 0.2)', 'background-color'), null);
});

test('repair mode: nothing moves in the full mode again after it is switched off', () => {
  const before = full('#ffffff', 'background-color');
  repaired('#ffffff', 'background-color');
  assert.equal(full('#ffffff', 'background-color'), before);
  assert.equal(full('#101418', 'background-color') !== null, true);
  assert.equal(rw.customProperty('--bg', '#fff', BASE).length > 0, true);
});

test('repair mode: the reader drops the declarations the page dark rules cover and the ones that did not move', () => {
  const reader = dk.sheettext.createReader({
    rw,
    isControl: () => false,
    maxRules: 1000,
    maxDepth: 8,
    chunkChars: 100000,
    cover: (selector) => (selector === '.card' ? new Set(['b', 'c']) : null),
  });
  const read = (text) => {
    const run = reader.start(text, BASE, { rules: 0, capped: false });
    let step = run.steps.next();
    while (!step.done) step = run.steps.next();
    return run.state.out.join('');
  };
  const css = '.card{background:#fff;color:#222;border:1px solid #ddd}.hero{background:#fff;color:#e8eaed}.dark{background:#101418}';
  rw.setRepair(true);
  reader.reset();
  const out = read(css);
  rw.setRepair(false);
  reader.reset();
  // The card: background and color are covered; the border is not. The hero: the background moves, the light text stays.
  assert.ok(out.startsWith('.card{border-color:'), out);
  assert.ok(out.includes('.hero{background-color:'), out);
  assert.ok(!out.includes('color:#e8eaed'), out);
  assert.ok(!out.includes('.dark'), out);
  assert.ok(read(css).includes('.dark{background-image:initial;background-color:'));
});

test('the keys of the dark rules: the state is taken out, the root in front of a selector is not part of the key', () => {
  const site = dk.sitetheme;
  const move = (s) => site.coverKeys(dk.sitedark.rewriteSelectors(s));
  assert.deepEqual(move('[data-theme=dark] .card'), ['.card']);
  assert.deepEqual(move('html.dark body'), ['html body', 'body']);
  assert.deepEqual(move(':root[data-theme="dark"] a'), [':root a', 'a']);
  assert.deepEqual(move('.dark'), ['html', 'body']);
  assert.deepEqual(move('.dark .a, .dark .b > i'), ['.a', '.b>i']);
  assert.equal(site.family('background-image'), 'b');
  assert.equal(site.family('border-top-color'), 'd');
  assert.equal(site.family('width'), '');
});
