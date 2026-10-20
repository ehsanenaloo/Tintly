import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';
import { corpus, scanCode, glyph } from '../helpers/png.mjs';

const dk = await loadContent('engine/sitedark.js', 'engine/images.js');

test('the synthetic corpus of 60 or more images is sorted as built, and no photo is inverted', () => {
  const images = corpus();
  assert.ok(images.length >= 60, String(images.length));
  const wrong = images.filter((i) => dk.images.classify(i.px) !== i.expect);
  console.log(`# image corpus: ${images.length - wrong.length} of ${images.length} sorted as expected`);
  assert.ok(wrong.length / images.length <= 0.05, wrong.map((w) => `${w.name}: ${dk.images.classify(w.px)} not ${w.expect}`).join('; '));
  const photoInverted = images.filter((i) => /photo|gradient/.test(i.name) && dk.images.classify(i.px) === 'invert');
  assert.deepEqual(photoInverted.map((i) => i.name), []);
});

test('edge cases: nothing visible, an empty image, a single color and an almost clear image', () => {
  assert.equal(dk.images.classify([]), 'keep');
  assert.equal(dk.images.classify(new Uint8ClampedArray(48 * 48 * 4)), 'keep');
  const white = new Uint8ClampedArray(48 * 48 * 4).fill(255);
  assert.equal(dk.images.classify(white), 'dim');
  const black = new Uint8ClampedArray(48 * 48 * 4);
  for (let i = 3; i < black.length; i += 4) black[i] = 255;
  assert.equal(dk.images.classify(black), 'keep');
  const dot = new Uint8ClampedArray(48 * 48 * 4);
  dot.set([0, 0, 0, 255], 0);
  assert.equal(dk.images.classify(dot), 'keep');
});

test('a scan code on a clear background keeps its colors and gets a plate; a logo or icon is still inverted', () => {
  let plates = 0;
  for (const modules of [21, 25, 29, 33, 37]) {
    for (const seed of [1, 2, 3]) {
      const qr = scanCode(modules, { seed });
      assert.equal(dk.images.classify(qr, { square: true }), 'plate', `${modules} modules, seed ${seed}`);
      plates++;
    }
  }
  assert.equal(plates, 15);
  // Not square: it is not treated as a code.
  assert.equal(dk.images.classify(scanCode(25), { square: false }), 'invert');
  assert.equal(dk.images.classify(scanCode(25)), 'invert');
  // A glyph has few steps along its rows, whatever its shape.
  assert.equal(dk.images.classify(glyph(), { square: true }), 'invert');
  // On white it is a flat graphic, so it is only dimmed, as before.
  assert.notEqual(dk.images.classify(scanCode(29, { opaque: true }), { square: true }), 'plate');
});

function paint(side, pick) {
  const px = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) px.set(pick(x, y), (y * side + x) * 4);
  return px;
}
const CLEAR = [0, 0, 0, 0];

test('a flag with a white band, a badge with a light ring and a two-hue mark are kept; a one-hue dark logo is still inverted', () => {
  const corner = (x, y) => (x < 6 || x > 25) && (y < 6 || y > 25);
  const flag = paint(32, (x, y) => (corner(x, y) ? CLEAR : x < 11 ? [0, 32, 160, 255] : x < 22 ? [255, 255, 255, 255] : [200, 16, 46, 255]));
  assert.equal(dk.images.classify(flag), 'keep');
  const badge = paint(32, (x, y) => {
    const d = Math.hypot(x - 15.5, y - 15.5);
    return d > 15 ? CLEAR : d > 11 ? [255, 255, 255, 255] : [10, 30, 90, 255];
  });
  assert.equal(dk.images.classify(badge), 'keep');
  const twoHues = paint(32, (x, y) => (corner(x, y) ? CLEAR : x < 16 ? [120, 10, 20, 255] : [10, 20, 120, 255]));
  assert.equal(dk.images.classify(twoHues), 'keep');
  const navy = paint(32, (x, y) => (Math.hypot(x - 15.5, y - 15.5) < 10 ? [10, 30, 90, 255] : CLEAR));
  assert.equal(dk.images.classify(navy), 'invert');
  const black = paint(32, (x, y) => (x > 8 && x < 24 && y > 8 && y < 24 ? [0, 0, 0, 255] : CLEAR));
  assert.equal(dk.images.classify(black), 'invert');
});

test('a picture is seen through the invert and brightness functions of its page filter', () => {
  const mark = (v) => {
    const px = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < px.length; i += 4) {
      const inside = (i >> 2) % 32 >= 8 && (i >> 2) % 32 < 24 && (i >> 2) >> 5 >= 8 && (i >> 2) >> 5 < 24;
      if (inside) px.set([v, v, v, 255], i);
    }
    return px;
  };
  const white = mark(255);
  assert.equal(dk.images.classify(white), 'keep');
  assert.equal(dk.images.classify(dk.images.filtered(white, 'invert(1)')), 'invert');
  assert.equal(dk.images.classify(dk.images.filtered(white, 'brightness(0)')), 'invert');
  assert.equal(dk.images.classify(dk.images.filtered(white, 'invert(100%)')), 'invert');
  assert.equal(dk.images.classify(dk.images.filtered(white, 'invert(0)')), 'keep');
  assert.equal(dk.images.classify(dk.images.filtered(mark(0), 'invert(1)')), 'keep');
  assert.equal(dk.images.filtered(white, 'invert(1) hue-rotate(180deg)'), null);
  assert.equal(dk.images.filtered(white, 'drop-shadow(rgb(0, 0, 0) 0px 0px 1px)'), null);
  assert.equal(dk.images.filtered(white, ''), null);
  assert.equal(white[(16 * 32 + 16) * 4], 255);
});

test('a flat picture is a surface: a faint tile, a flat tone, and light line art on a dark neutral ground', () => {
  const kind = (px, how = 1) => dk.images.kindOf(dk.images.toneOf(px), how);
  const grid = (fill, n = 32) => {
    const px = new Uint8ClampedArray(n * n * 4);
    for (let i = 0; i < n * n; i++) px.set(fill(i % n, Math.floor(i / n)), i * 4);
    return px;
  };
  const line = (x, y) => x % 8 === 0 || y % 8 === 0;
  assert.equal(kind(grid((x, y) => (line(x, y) ? [232, 232, 240, 255] : [255, 255, 255, 255]))), 'pale');
  assert.equal(kind(grid((x, y) => (line(x, y) ? [206, 164, 184, 255] : [214, 172, 192, 255]))), 'pale');
  assert.equal(kind(grid((x, y) => (line(x, y) ? [20, 26, 32, 255] : [11, 20, 26, 255]))), 'deep');
  assert.equal(kind(grid((x, y) => (line(x, y) ? [233, 237, 239, 255] : [11, 20, 26, 255]))), 'wall');
  // A clear tile, a dark photo, a saturated dark banner and a chart on white are not surfaces.
  // A dark picture with no ground that covers it (a night scene with a few bright windows) is not light line art.
  assert.equal(kind(grid((x, y) => (x % 7 === 0 && y % 5 === 0 ? [240, 210, 120, 255] : [(x * 8) % 90, (y * 6) % 80, ((x + y) * 2) % 70, 255]))), 'none');
  assert.equal(kind(grid((x, y) => (line(x, y) ? [60, 60, 70, 255] : [0, 0, 0, 0]))), 'none');
  // Light lines on a clear ground are line art that is lost on a light color; a colored or very sparse picture is not.
  assert.equal(kind(grid((x, y) => (line(x, y) ? [200, 200, 215, 255] : [0, 0, 0, 0]))), 'lines');
  assert.equal(kind(grid((x, y) => (x === 3 && y === 3 ? [240, 240, 240, 255] : [0, 0, 0, 0]))), 'none');
  assert.equal(kind(grid((x, y) => (line(x, y) ? [240, 120, 40, 255] : [0, 0, 0, 0]))), 'none');
  assert.equal(kind(grid((x, y) => (line(x, y) ? [(x * 31) % 256, (y * 17) % 256, ((x + y) * 29) % 256, 255] : [0, 0, 0, 0]))), 'none');
  assert.equal(kind(grid((x, y) => [(x * 53 + y * 31) % 90, (x * 17 + y * 7) % 90, (x * 5 + y * 29) % 90, 255])), 'none');
  assert.equal(kind(grid((x, y) => (line(x, y) ? [250, 230, 90, 255] : [20, 10, 120, 255]))), 'none');
  assert.equal(kind(grid((x, y) => (x < 14 && y < 20 ? [30, 90, 200, 255] : [255, 255, 255, 255]))), 'none');
  // A picture that does not repeat must be nearly one tone; the legacy attribute may carry a bit more: a stronger pattern on white is still a tile.
  assert.equal(kind(grid((x, y) => (line(x, y) ? [232, 232, 240, 255] : [255, 255, 255, 255])), 0), 'none');
  assert.equal(kind(grid((x, y) => (line(x, y) ? [210, 214, 236, 255] : [218, 222, 242, 255])), 0), 'pale');
  const stripes = grid((x) => (x % 4 < 2 ? [255, 255, 255, 255] : [200, 200, 200, 255]));
  assert.equal(kind(stripes), 'none');
  assert.equal(kind(stripes, 2), 'pale');
  assert.equal(dk.images.tileOf(stripes), 'light');
});

test('the bytes of a base64 text come from the engine decoder when it has one and from a plain loop when not, fast in both', () => {
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 2654435761) >>> 24);
  const text = Buffer.from(bytes).toString('base64');
  const same = (got) => got.length === bytes.length && got.every((v, i) => v === bytes[i]);
  const native = Uint8Array.fromBase64;
  try {
    for (const mode of ['native', 'loop']) {
      if (mode === 'loop') Uint8Array.fromBase64 = undefined;
      dk.images.bytesOf(text);
      // The fastest of five: a slow decoder is slow every time, a busy machine only stalls some runs.
      let ms = Infinity;
      let got = null;
      for (let run = 0; run < 5; run++) {
        const t = performance.now();
        got = dk.images.bytesOf(text);
        ms = Math.min(ms, performance.now() - t);
      }
      assert.ok(same(got), mode);
      assert.ok(ms < 60, `${mode}: ${ms.toFixed(1)} ms for 1 MB`);
    }
    assert.deepEqual([...dk.images.bytesOf('AQID')], [1, 2, 3]);
    assert.deepEqual([...dk.images.bytesOf('')], []);
  } finally {
    Uint8Array.fromBase64 = native;
    if (native === undefined) delete Uint8Array.fromBase64;
  }
});
