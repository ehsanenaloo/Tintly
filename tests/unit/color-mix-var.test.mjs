import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/rewrite.js');
const C = dk.color;
const rw = dk.rewrite.createRewriter(C.createTransformer(C.createTheme({ mode: 'dark' })));
const BASE = 'http://site.test/a.css';

test('a variable inside color-mix is themed like a plain variable', () => {
  const out = rw.declaration('background', 'color-mix(in srgb, var(--bg) 92%, transparent)', BASE);
  assert.ok(out.startsWith('color-mix(in srgb,'), out);
  assert.ok(out.includes('var(--dk-bg--bg,var(--bg))'), out);
  assert.ok(out.includes('92%'), out);
  assert.ok(out.includes('rgba(0, 0, 0, 0)'), out);
});

test('a literal color and a variable in one mix are both themed', () => {
  const out = rw.declaration('background-color', 'color-mix(in oklab, #fff 40%, var(--accent))', BASE);
  assert.ok(!out.includes('#fff'), out);
  assert.ok(out.includes('var(--dk-bg--accent,var(--accent))'), out);
});

test('color-mix with a leading color space is read for both spaces, with a variable', () => {
  for (const space of ['oklab', 'srgb']) {
    const out = rw.declaration('background-color', 'color-mix(in ' + space + ', var(--a) 30%, #fff)', BASE);
    assert.ok(out.startsWith('color-mix(in ' + space + ','), out);
    assert.ok(out.includes('var(--dk-bg--a,var(--a))'), out);
    assert.ok(!out.includes('#fff'), out);
  }
  const intact = rw.declaration('background-color', 'color-mix(in srgb-linear, var(--a), var(--b))', BASE);
  assert.ok(intact.startsWith('color-mix(in srgb-linear,'), intact);
});

test('the source has no control characters', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../../extension/content/engine/rewrite.js', import.meta.url), 'utf8');
  let found = -1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) found = i;
  }
  assert.equal(found, -1);
});
