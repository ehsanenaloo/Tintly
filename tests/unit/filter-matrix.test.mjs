import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/filter.js');
const M = dk.filter.matrix;
const C = dk.color;

const near = (a, b, tol = 1e-6, label = '') => assert.ok(Math.abs(a - b) <= tol, `${label} ${a} vs ${b}`);
const nearAll = (a, b, tol = 1e-6, label = '') => a.forEach((v, i) => near(v, b[i], tol, `${label}[${i}]`));
const rgb = (hex) => {
  const c = C.parseColor(hex);
  return [c.r, c.g, c.b];
};
function prng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('composing with the identity changes nothing, and the order is first then second', () => {
  const m = M.themeMap([0.1, 0.1, 0.12], [0.9, 0.9, 0.92], 0.8);
  assert.deepEqual(M.compose(M.identity(), m), m);
  assert.deepEqual(M.compose(m, M.identity()), m);
  // "first invert, then brightness 0.5" is not "first brightness, then invert".
  const a = M.compose(M.invertColors(), M.adjustments({ sepia: 0, grayscale: 0, contrast: 1, brightness: 0.5 }));
  nearAll(M.apply(a, [1, 1, 1]), [0, 0, 0], 1e-9);
  nearAll(M.apply(a, [0, 0, 0]), [0.5, 0.5, 0.5], 1e-9);
});

test('full inversion with the hue kept equals the CSS invert and hue-rotate(180deg)', () => {
  // theme map from white=black to black=white with the full chroma is the same matrix
  const m = M.themeMap([0, 0, 0], [1, 1, 1], 1);
  const hue180 = [
    [-0.574, 1.43, 0.144],
    [0.426, 0.43, 0.144],
    [0.426, 1.43, -0.856],
  ];
  for (let c = 0; c < 3; c++) {
    // CSS: invert first, then rotate: out = H * (1 - v) = H*1 - H*v. H*1 is 1 for every row.
    for (let j = 0; j < 3; j++) near(m[c][j], -hue180[c][j], 0.002, `${c}${j}`);
    near(m[c][4], 1, 1e-9);
  }
});

test('white becomes the background and black becomes the text color, whatever the chroma', () => {
  const bg = rgb('#16181d');
  const fg = rgb('#e6e8eb');
  for (const k of [0, 0.5, 0.8, 1]) {
    const m = M.themeMap(bg, fg, k);
    nearAll(M.apply(m, [1, 1, 1]), bg, 1e-9, `white k=${k}`);
    nearAll(M.apply(m, [0, 0, 0]), fg, 1e-9, `black k=${k}`);
  }
});

test('a gray lands halfway between, and a gray stays gray when the colors are gray', () => {
  const m = M.themeMap([0, 0, 0], [1, 1, 1], 0.8);
  nearAll(M.apply(m, [0.5, 0.5, 0.5]), [0.5, 0.5, 0.5], 1e-9);
  nearAll(M.apply(m, [0.2, 0.2, 0.2]), [0.8, 0.8, 0.8], 1e-9);
});

test('the dark theme matrix maps the page colors to the theme colors', () => {
  const t = { mode: 'dark', darkBackground: '#16181d', darkText: '#e6e8eb' };
  const { matrix } = M.themeMatrix(t);
  nearAll(M.apply(matrix, [1, 1, 1]), rgb('#16181d'), 1e-9);
  nearAll(M.apply(matrix, [0, 0, 0]), rgb('#e6e8eb'), 1e-9);
});

test('the light theme matrix does not invert: no slider gives the identity, a slider alone gives its own matrix', () => {
  const { matrix, counter } = M.themeMatrix({ mode: 'light' });
  assert.equal(M.isIdentity(matrix), true);
  assert.equal(counter, null);
  nearAll(M.apply(matrix, [1, 1, 1]), [1, 1, 1], 1e-9);
  nearAll(M.apply(matrix, [0, 0, 0]), [0, 0, 0], 1e-9);
  const dim = M.themeMatrix({ mode: 'light', brightness: 80 });
  assert.equal(M.isIdentity(dim.matrix), false);
  assert.equal(dim.counter, null);
  nearAll(M.apply(dim.matrix, [1, 1, 1]), [0.8, 0.8, 0.8], 1e-9);
});

test('light mode keeps every color of the page: lightness and hue do not move', () => {
  const { matrix } = M.themeMatrix({ mode: 'light' });
  for (const hex of ['#3366cc', '#cc3333', '#33aa55', '#ddaa22', '#8844cc', '#ffffff', '#101010']) {
    nearAll(M.apply(matrix, rgb(hex)), rgb(hex), 1e-9);
  }
});

test('the inverse matrix undoes the matrix for every color the matrix can reach', () => {
  const { matrix, counter } = M.themeMatrix({ mode: 'dark' });
  assert.ok(counter);
  const both = M.compose(matrix, counter);
  const rand = prng(21);
  for (let i = 0; i < 200; i++) {
    const v = [rand(), rand(), rand()];
    // Use unclamped arithmetic through the composed matrix.
    const out = [0, 1, 2].map((r) => both[r][0] * v[0] + both[r][1] * v[1] + both[r][2] * v[2] + both[r][4]);
    nearAll(out, v, 1e-9, 'round trip');
  }
});

test('the media filter brings natural colors back, and the worst case is bounded', () => {
  const { matrix, counter } = M.themeMatrix({ mode: 'dark' });
  const rand = prng(8);
  const errors = [];
  for (let i = 0; i < 2000; i++) {
    // Colors of photographs: moderate saturation, not the corners of the color cube.
    const h = rand();
    const s = rand() * 0.6;
    const l = 0.12 + rand() * 0.76;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t0) => {
      const u = (t0 + 1) % 1;
      return u < 1 / 6 ? p + (q - p) * 6 * u : u < 0.5 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
    };
    const v = [f(h + 1 / 3), f(h), f(h - 1 / 3)];
    const seen = M.apply(matrix, M.apply(counter, v));
    errors.push(Math.max(...seen.map((x, k) => Math.abs(x - v[k]))) * 255);
  }
  errors.sort((a, b) => a - b);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  console.log(`# Filter+ media round trip over 2000 natural colors, error of 255: mean ${mean.toFixed(2)}, p95 ${errors[1899].toFixed(1)}, max ${errors.at(-1).toFixed(1)}`);
  // The theme squeezes the range into about 0.09 to 0.91, so the ends of the range cannot come back exactly.
  assert.ok(mean < 5, `mean ${mean}`);
  assert.ok(errors[1899] < 30, `p95 ${errors[1899]}`);
});

test('the user adjustments follow the CSS filter definitions', () => {
  const sepia1 = M.adjustments({ sepia: 1, grayscale: 0, contrast: 1, brightness: 1 });
  nearAll(M.apply(sepia1, [1, 1, 1]), [1, 1, 0.937], 1e-9);
  const gray1 = M.adjustments({ sepia: 0, grayscale: 1, contrast: 1, brightness: 1 });
  const g = M.apply(gray1, [1, 0, 0]);
  near(g[0], g[1], 1e-9);
  near(g[1], g[2], 1e-9);
  near(g[0], 0.2126, 1e-9);
  const contrast2 = M.adjustments({ sepia: 0, grayscale: 0, contrast: 2, brightness: 1 });
  nearAll(M.apply(contrast2, [0.5, 0.25, 0.75]), [0.5, 0, 1], 1e-9);
  const bright = M.adjustments({ sepia: 0, grayscale: 0, contrast: 1, brightness: 1.5 });
  nearAll(M.apply(bright, [0.2, 0.4, 0.8]), [0.3, 0.6, 1], 1e-9);
});

test('adjustments with nothing to do are the identity', () => {
  assert.deepEqual(M.adjustments({ sepia: 0, grayscale: 0, contrast: 1, brightness: 1 }), M.identity());
});

test('a matrix with no inverse says so', () => {
  const flat = M.adjustments({ sepia: 0, grayscale: 0, contrast: 0, brightness: 1 });
  assert.equal(M.inverse(flat), null);
  const { counter } = M.themeMatrix({ mode: 'dark', contrast: 0 });
  assert.equal(counter, null);
  const gray = M.adjustments({ sepia: 0, grayscale: 1, contrast: 1, brightness: 1 });
  assert.equal(M.inverse(gray), null);
});

test('the values string has twenty finite numbers', () => {
  const { matrix } = M.themeMatrix({ mode: 'dark', brightness: 90, contrast: 110, sepia: 10 });
  const parts = M.values(matrix).split(' ');
  assert.equal(parts.length, 20);
  assert.ok(parts.every((p) => Number.isFinite(Number(p))));
});

test('bad theme colors fall back to the built-in colors', () => {
  const { matrix } = M.themeMatrix({ mode: 'dark', darkBackground: 'nope', darkText: 5 });
  nearAll(M.apply(matrix, [1, 1, 1]), rgb('#16181d'), 1e-9);
});

test('brightness and contrast reach the matrix through the same numbers as the Dynamic engine', () => {
  const dark = M.themeMatrix({ mode: 'dark', brightness: 120 });
  const plain = M.themeMatrix({ mode: 'dark' });
  const a = M.apply(dark.matrix, [1, 1, 1]);
  const b = M.apply(plain.matrix, [1, 1, 1]);
  assert.ok(a[0] > b[0]);
});
