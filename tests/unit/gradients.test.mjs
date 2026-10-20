import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/einkpalette.js', 'engine/rewrite.js');
const C = dk.color;
const BASE = 'https://site.example/a.css';

function rewriter(themeSettings, flat) {
  const transformer = C.createTransformer(C.createTheme(themeSettings));
  return { rw: dk.rewrite.createRewriter(transformer, { flatGradients: flat }), transformer };
}
const PAPER = { mode: 'eink', einkPreset: 'paper' };
const EINK = { mode: 'eink', einkPreset: 'eink' };

test('an opaque gradient becomes one solid color, the themed average of its stops', () => {
  const { rw, transformer } = rewriter(PAPER, true);
  const out = rw.declaration('background-image', 'linear-gradient(90deg, #1a74e8, #8e24aa)', BASE);
  const m = /^linear-gradient\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/.exec(out);
  assert.ok(m, out);
  assert.equal(m[1], m[2]);
  const avg = `#${[(0x1a + 0x8e) / 2, (0x74 + 0x24) / 2, (0xe8 + 0xaa) / 2].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  assert.equal(m[1], transformer.transform(avg, 'background'));
});

test('a gradient with a transparent or a translucent stop is dropped', () => {
  const { rw } = rewriter(PAPER, true);
  const cases = [
    'radial-gradient(circle at 50% 0%, rgba(0, 200, 100, .4), rgba(255, 255, 255, 0) 60%)',
    'linear-gradient(transparent, #ffffff)',
    'linear-gradient(to right, rgba(255,255,255,0), #fff)',
    'radial-gradient(ellipse at top, hsl(160 80% 50% / .3), transparent 70%)',
  ];
  for (const c of cases) assert.equal(rw.declaration('background-image', c, BASE), 'none', c);
});

test('the same holds for the background shorthand and for a list of layers', () => {
  const { rw } = rewriter(EINK, true);
  assert.equal(rw.declaration('background', 'radial-gradient(rgba(0,0,0,.2), transparent) no-repeat', BASE), 'none no-repeat');
  const two = rw.declaration('background-image', 'radial-gradient(rgba(0,0,0,.2), transparent), linear-gradient(#ff0000, #0000ff)', BASE);
  assert.match(two, /^none, linear-gradient\(#[0-9a-f]{6}, ?#[0-9a-f]{6}\)$/);
});

test('a gradient over a picture is a scrim and keeps its behavior', () => {
  const { rw } = rewriter(PAPER, true);
  const out = rw.declaration('background-image', 'linear-gradient(rgba(0,0,0,.6), rgba(0,0,0,.6)), url(hero.jpg)', BASE);
  assert.match(out, /gradient\(/);
  assert.match(out, /url\("https:\/\/site\.example\/hero\.jpg"\)/);
  assert.doesNotMatch(out, /^none/);
});

test('hard stops and unknown colors are not flattened', () => {
  const { rw } = rewriter(PAPER, true);
  const bar = rw.declaration('background-image', 'linear-gradient(90deg, #00aa00 60%, #cccccc 60%)', BASE);
  assert.match(bar, /60%/);
  assert.notEqual(bar, 'none');
  const viaVar = rw.declaration('background-image', 'linear-gradient(var(--a), var(--b))', BASE);
  assert.match(viaVar, /var\(/);
  // A glow or a halo whose colors come from variables cannot be judged, and is dropped; a fade with a transparent end is dropped too.
  assert.equal(rw.declaration('background-image', 'radial-gradient(42% 100% at 66% 81%, var(--glow) 0, var(--glow-mid) 50%, transparent 100%)', BASE), 'none');
  assert.equal(rw.declaration('background-image', 'conic-gradient(var(--a), var(--b), var(--a))', BASE), 'none');
  assert.equal(rw.declaration('background-image', 'linear-gradient(var(--a), transparent)', BASE), 'none');
});

test('without the flat option (the dark and light modes) a gradient keeps its glow and its stops are themed', () => {
  const { rw } = rewriter({ mode: 'dark' }, false);
  const g = 'radial-gradient(circle, rgba(0,200,100,.4), rgba(255,255,255,0))';
  const out = rw.declaration('background-image', g, BASE);
  assert.match(out, /^radial-gradient\(circle, /);
  assert.notEqual(out, g);
});

test('letters filled by a clipped gradient use the foreground curve, so a pale gradient stays readable on a dark page', () => {
  const { rw, transformer } = rewriter({ mode: 'dark' }, false);
  const g = 'linear-gradient(90deg, #ffffff, #cccccc)';
  const asText = rw.declaration('background-image', g, BASE, false, true);
  const asBox = rw.declaration('background-image', g, BASE, false, false);
  assert.ok(asText.includes(transformer.transform('#ffffff', 'foreground')), asText);
  assert.ok(asBox.includes(transformer.transform('#ffffff', 'background')), asBox);
  assert.notEqual(asText, asBox);
});

test('the text of a clipped gradient becomes the ink in the E-ink and Paper mode', () => {
  const { rw, transformer } = rewriter(PAPER, true);
  const rules = rw.textClipRules(true);
  assert.equal(rules, `background-image:none!important;-webkit-text-fill-color:${transformer.transform('#000000', 'foreground')}!important;`);
  assert.equal(rewriter({ mode: 'dark' }, false).rw.textClipRules(true), '');
});
