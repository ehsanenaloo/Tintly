import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/einkpalette.js', 'engine/sitedark.js', 'engine/keep.js', 'engine/calm.js', 'engine/extras.js', 'engine/images.js');
const X = dk.extras;

test('nothing is written for settings that are off, automatic or invalid', () => {
  assert.equal(X.build({}), '');
  assert.equal(X.build({ fontEnabled: false, fontFamily: 'Georgia', textStroke: 0, scrollbar: 'auto', selection: 'auto' }), '');
  assert.equal(X.build({ fontEnabled: true, fontFamily: '' }), '');
  assert.equal(X.build({ textStroke: 11 }), '');
  assert.equal(X.build({ scrollbar: 'red; background:url(x)', selection: 'url(javascript:1)' }), '');
});

test('the font rule leaves out icon fonts, code and hidden decoration, and quotes names', () => {
  const css = X.build({ fontEnabled: true, fontFamily: 'Open Sans, sans-serif' });
  assert.match(css, /font-family:"Open Sans",sans-serif!important/);
  for (const part of ['i', 'svg', 'code', 'pre', 'kbd', 'samp', 'tt', '[aria-hidden="true"]', '[class*="icon" i]']) assert.ok(css.includes(part), part);
  assert.ok(css.startsWith('@media screen{'));
});

test('text weight is in tenths of a pixel', () => {
  assert.match(X.build({ textStroke: 4 }), /-webkit-text-stroke-width:0\.4px!important/);
  assert.match(X.build({ textStroke: 10 }), /-webkit-text-stroke-width:1px!important/);
});

test('scrollbar and selection colors; the selection text reads on its color', () => {
  const css = X.build({ scrollbar: '#336699', selection: '#ffcc00' });
  assert.match(css, /scrollbar-color:#336699 transparent!important/);
  assert.match(css, /::selection\{background-color:#ffcc00!important;color:#000000!important\}/);
  assert.equal(X.onColor('#102040'), '#ffffff');
  assert.equal(X.onColor('#f0f0f0'), '#000000');
  // Under the Filter engines the colors are left out.
  assert.equal(X.build({ scrollbar: '#336699', selection: '#ffcc00' }, false), '');
});

test('a tile is plain when it is opaque and has few colors or little change', () => {
  const T = dk.images.tileOf;
  const fill = (n, f) => {
    const px = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) px.set(f(i), i * 4);
    return px;
  };
  assert.equal(T(fill(256, () => [244, 240, 228, 255])), 'light');
  assert.equal(T(fill(256, () => [30, 36, 44, 255])), 'dark');
  // A clear tile, and a photo (many colors, strong change).
  assert.equal(T(fill(256, () => [244, 240, 228, 0])), 'none');
  assert.equal(T(fill(256, (i) => [(i * 97) % 256, (i * 57) % 256, (i * 31) % 256, 255])), 'none');
  assert.equal(T([]), 'none');
  // A soft texture: many colors, small change in lightness.
  assert.equal(T(fill(1024, (i) => [200 + (i % 24), 196 + ((i * 3) % 24), 190 + ((i * 7) % 24), 255])), 'light');
});

test('the font rule asks for ancestors only by tag name, which is what keeps it cheap on a big page', () => {
  const css = X.build({ fontEnabled: true, fontFamily: 'Georgia' });
  assert.ok(!css.includes(':not(:is('), 'the old form that walks the ancestors of every element');
  assert.match(css, /pre \*,code \*,kbd \*,samp \*,tt \*,svg \*,\[aria-hidden="true"\] \*\{font-family:unset!important\}/);
});
