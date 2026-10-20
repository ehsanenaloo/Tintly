import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/rewrite.js');
const { parseVarShorthands: parse, normalizeSelector: norm } = dk.rewrite;

test('a shorthand with var() followed by a longhand is found by selector', () => {
  const css = '.a{color:red}.vector-sticky::after{content:"";background:linear-gradient(rgba(255,255,255,0),var(--bg,#fff));background-repeat:no-repeat}.b{margin:0}';
  const m = parse(css);
  assert.deepEqual([...m.keys()], ['.vector-sticky::after']);
  assert.match(m.get('.vector-sticky::after')[0], /background:linear-gradient/);
});

test('rules inside @media, @supports and @layer are found, keyframes and font faces are not', () => {
  const css = '@media screen{.x{border:1px solid var(--c)}}@supports (a:b){@layer l{.y{background:var(--d)}}}@keyframes k{from{background:var(--z)}}@font-face{font-family:f;src:url(a)}';
  assert.deepEqual([...parse(css).keys()].sort(), ['.x', '.y']);
});

test('comments, strings and braces inside them do not confuse the reader', () => {
  const css = '/* .no{background:var(--q)} */.s::before{content:"}{;";background:var(--w);color:red}.t{background:var(--e)}';
  const m = parse(css);
  assert.deepEqual([...m.keys()].sort(), ['.s::before', '.t']);
  assert.match(m.get('.s::before')[0], /content:"\}\{;"/);
});

test('the same selector twice keeps both, in order, and a sheet without var shorthands is empty', () => {
  const m = parse('.r{background:var(--a)}.r{border:1px solid var(--b)}');
  assert.equal(m.get('.r').length, 2);
  assert.match(m.get('.r')[1], /border/);
  assert.equal(parse('.a{background:#fff}.b{color:var(--x)}').size, 0);
});

test('selectors are normalized the way the browser prints them', () => {
  assert.equal(norm('.a   >  .b ,.c:after'), '.a>.b,.c::after');
  assert.equal(norm(".a[x='y']"), '.a[x="y"]');
  assert.equal(norm('a::after'), 'a::after');
});

test('hostile text does not hang or throw', () => {
  const junk = '{'.repeat(5000) + 'background:var(--x)' + '}'.repeat(5000);
  parse(junk);
  parse('.a{background:var(--x)'); // unterminated
  parse('/* open comment .a{background:var(--x)}');
  parse('"open string .a{background:var(--x)}');
  assert.equal(parse('').size, 0);
});

test('light-dark() has both sides themed', () => {
  const theme = dk.color.createTheme({});
  const rw = dk.rewrite.createRewriter(dk.color.createTransformer(theme));
  const out = rw.declaration('background-color', 'light-dark(#ffffff, #1b1b1b)', 'https://a.test/');
  assert.match(out, /^light-dark\(#[0-9a-f]{6},#[0-9a-f]{6}\)$/);
  assert.notEqual(out, 'light-dark(#ffffff, #1b1b1b)');
  const text = rw.declaration('color', 'light-dark(rgb(0 0 0 / 80%), var(--x, #fff))', 'https://a.test/');
  assert.match(text, /^light-dark\(/);
  assert.equal(rw.declaration('color', 'light-dark(red)', 'https://a.test/'), 'light-dark(red)');
});
