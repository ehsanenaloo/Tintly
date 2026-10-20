// in repair mode a color that the page's own dark theme writes stays, for a literal and for a variable that holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/rewrite.js', 'engine/sitedark.js', 'engine/sitetheme.js', 'engine/sheettext.js');
const C = dk.color;
const transformer = C.createTransformer(C.createTheme({ mode: 'dark' }));
const rw = dk.rewrite.createRewriter(transformer, { rootValue: (name) => ({ '--accent': '#5ee6b0', '--ink': '#062a1c', '--card': '#ffffff' })[name] ?? '', relativeColor: true });
const BASE = 'http://site.test/a.css';
const key = (c) => `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
const own = new Set(['b|94,230,176', 'c|6,42,28']);
const isOwn = (c, role) => own.has(`${{ background: 'b', foreground: 'c' }[role]}|${key(c)}`);

const run = (property, value, owned = true) => {
  rw.setRepair(true);
  dk.sitetheme.useOwn(owned ? isOwn : null);
  const out = rw.declaration(property, value, BASE);
  dk.sitetheme.useOwn(null);
  rw.setRepair(false);
  return out;
};

test('a bright accent and its dark ink are left when the dark theme of the page uses them', () => {
  assert.equal(run('background-color', '#5ee6b0'), null);
  assert.equal(run('color', '#062a1c'), null);
});

test('the same colors are moved when the page does not own them', () => {
  assert.notEqual(run('background-color', '#5ee6b0', false), null);
  assert.notEqual(run('color', '#062a1c', false), null);
});

test('a light color that the dark theme does not use is still repaired', () => {
  assert.notEqual(run('background-color', '#ffffff'), null);
});

test('var(): a variable whose root value is a color of the page theme is left, a light one is not', () => {
  assert.equal(run('background-color', 'var(--accent)'), null);
  assert.equal(run('color', 'var(--ink)'), null);
  assert.match(run('background-color', 'var(--card)'), /^oklch\(from var\(--card\)/);
  assert.match(run('background-color', 'var(--accent)', false), /^oklch\(from var\(--accent\)/);
});
