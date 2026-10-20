import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/einkpalette.js');
const C = dk.color;

const near = (a, b, tol = 0.002, label = '') => assert.ok(Math.abs(a - b) <= tol, `${label} ${a} vs ${b}`);
const rgb = (s) => {
  const c = C.parseColor(s);
  assert.ok(c, `did not parse: ${s}`);
  return c;
};
const nearColor = (s, [r, g, b], tol = 0.002) => {
  const c = rgb(s);
  near(c.r, r, tol, `${s} r`);
  near(c.g, g, tol, `${s} g`);
  near(c.b, b, tol, `${s} b`);
};
// Small seeded generator so the random tests are the same on every run.
function prng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- parsing ---------- */

test('hex forms', () => {
  nearColor('#fff', [1, 1, 1]);
  nearColor('#000', [0, 0, 0]);
  nearColor('#f00', [1, 0, 0]);
  nearColor('#ff8000', [1, 128 / 255, 0]);
  nearColor('#FF8000', [1, 128 / 255, 0]);
  assert.equal(rgb('#f008').a, 0x88 / 255);
  near(rgb('#11223344').a, 0x44 / 255);
  assert.equal(rgb('#123456').a, 1);
});

test('bad hex is null', () => {
  for (const s of ['#', '#12', '#12345', '#1234567', '#gggggg', '# fff', '#fff0000000']) assert.equal(C.parseColor(s), null, s);
});

test('named colors, case and spaces', () => {
  nearColor('red', [1, 0, 0]);
  nearColor('  RebeccaPurple ', [0x66 / 255, 0x33 / 255, 0x99 / 255]);
  nearColor('white', [1, 1, 1]);
  assert.equal(rgb('transparent').a, 0);
  assert.equal(C.parseColor('notacolor'), null);
  assert.equal(C.parseColor('constructor'), null);
  assert.equal(C.parseColor('__proto__'), null);
});

test('all 148 named colors parse', () => {
  const names = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ');
  assert.equal(names.length, 148);
  for (const n of names) assert.ok(C.parseColor(n), n);
});

test('rgb and rgba, legacy and modern, numbers and percents', () => {
  nearColor('rgb(255, 0, 0)', [1, 0, 0]);
  nearColor('rgb(255 128 0)', [1, 128 / 255, 0]);
  nearColor('rgb(100% 50% 0%)', [1, 0.5, 0]);
  near(rgb('rgba(0, 0, 0, 0.5)').a, 0.5);
  near(rgb('rgb(0 0 0 / 25%)').a, 0.25);
  near(rgb('rgb(0 0 0 / .4)').a, 0.4);
  nearColor('rgb(1e2 0 0)', [100 / 255, 0, 0]);
  assert.equal(rgb('rgb(0 0 0 / 3)').a, 1);
  assert.equal(rgb('rgb(none 0 0)').r, 0);
});

test('hsl, hsla and hwb', () => {
  nearColor('hsl(0, 100%, 50%)', [1, 0, 0]);
  nearColor('hsl(120 100% 25%)', [0, 0.5, 0]);
  nearColor('hsl(240deg 100% 50%)', [0, 0, 1]);
  nearColor('hsl(0.5turn 100% 50%)', [0, 1, 1]);
  nearColor('hsl(3.14159rad 100% 50%)', [0, 1, 1], 0.003);
  nearColor('hsl(200grad 100% 50%)', [0, 1, 1]);
  nearColor('hsl(-120 100% 50%)', [0, 0, 1]);
  near(rgb('hsla(0, 0%, 0%, 0.3)').a, 0.3);
  nearColor('hwb(0 0% 0%)', [1, 0, 0]);
  nearColor('hwb(0 100% 0%)', [1, 1, 1]);
  nearColor('hwb(0 50% 50%)', [0.5, 0.5, 0.5]);
  nearColor('hwb(120 20% 40%)', [0.2, 0.6, 0.2]);
});

test('lab and lch', () => {
  nearColor('lab(100 0 0)', [1, 1, 1], 0.003);
  nearColor('lab(0 0 0)', [0, 0, 0], 0.003);
  nearColor('lab(50 0 0)', [119 / 255, 119 / 255, 119 / 255], 0.004);
  nearColor('lch(50 0 0)', [119 / 255, 119 / 255, 119 / 255], 0.004);
  // Known value from the CSS Color 4 examples: lch(52.2% 72.2 50) is close to rgb(214, 85, 36)... checked loosely.
  const c = rgb('lch(52.2% 72.2 50)');
  assert.ok(c.r > c.g && c.g > c.b);
  nearColor('lab(50% 0 0)', [119 / 255, 119 / 255, 119 / 255], 0.004);
});

test('oklab and oklch', () => {
  nearColor('oklch(1 0 0)', [1, 1, 1]);
  nearColor('oklch(0 0 0)', [0, 0, 0]);
  nearColor('oklch(0.62796 0.25768 29.234)', [1, 0, 0], 0.003);
  nearColor('oklch(0.86644 0.29483 142.495)', [0, 1, 0], 0.003);
  nearColor('oklch(0.45201 0.31321 264.052)', [0, 0, 1], 0.003);
  const gray = rgb('oklab(0.5 0 0)');
  near(gray.r, 0.388, 0.002);
  nearColor('oklch(50% 0 0)', [gray.r, gray.g, gray.b], 1e-9);
});

test('color() with each space', () => {
  nearColor('color(srgb 1 0 0)', [1, 0, 0]);
  nearColor('color(srgb 100% 50% 0%)', [1, 0.5, 0]);
  nearColor('color(srgb-linear 0.5 0.5 0.5)', [0.7354, 0.7354, 0.7354], 0.001);
  nearColor('color(display-p3 1 1 1)', [1, 1, 1], 0.001);
  // Display P3 red is outside sRGB: about (1.093, -0.227, -0.150).
  nearColor('color(display-p3 1 0 0)', [1.0931, -0.2267, -0.1501], 0.002);
  nearColor('color(xyz 0.95047 1 1.08883)', [1, 1, 1], 0.002);
  nearColor('color(xyz-d65 0.95047 1 1.08883)', [1, 1, 1], 0.002);
  nearColor('color(xyz-d50 0.96429567643 1 0.82510460251)', [1, 1, 1], 0.002);
  nearColor('color(a98-rgb 1 1 1)', [1, 1, 1], 0.002);
  nearColor('color(rec2020 1 1 1)', [1, 1, 1], 0.002);
  nearColor('color(prophoto-rgb 1 1 1)', [1, 1, 1], 0.002);
  near(rgb('color(srgb 1 0 0 / 0.5)').a, 0.5);
  assert.equal(C.parseColor('color(nosuch 1 0 0)'), null);
  assert.equal(C.parseColor('color(srgb 1 0)'), null);
});

test('color-mix in several spaces', () => {
  nearColor('color-mix(in srgb, red, blue)', [0.5, 0, 0.5]);
  nearColor('color-mix(in srgb, red 25%, blue)', [0.25, 0, 0.75]);
  nearColor('color-mix(in srgb, 25% red, blue)', [0.25, 0, 0.75]);
  nearColor('color-mix(in srgb-linear, black, white)', [0.7354, 0.7354, 0.7354], 0.002);
  nearColor('color-mix(in oklab, black, white)', [0.388, 0.388, 0.388], 0.003);
  nearColor('color-mix(in lab, black, white)', [0.466, 0.466, 0.466], 0.004);
  nearColor('color-mix(in hsl, red, blue)', [1, 0, 1]);
  nearColor('color-mix(in hsl longer hue, red, blue)', [0, 1, 0]);
  nearColor('color-mix(in oklch, white, white)', [1, 1, 1], 0.002);
  nearColor('color-mix(in xyz, white, black)', [0.7354, 0.7354, 0.7354], 0.003);
});

test('color-mix keeps the alpha rules', () => {
  const c = rgb('color-mix(in srgb, red 20%, blue 30%)');
  near(c.a, 0.5, 0.001);
  near(c.r, 0.4, 0.001);
  near(c.b, 0.6, 0.001);
  const t = rgb('color-mix(in srgb, rgba(255,0,0,0.5), blue)');
  near(t.a, 0.75, 0.001);
  // Premultiplied: red at half alpha counts less.
  near(t.r, (1 * 0.5 * 0.5) / 0.75, 0.001);
});

test('color-mix with a gray takes the hue of the other color', () => {
  const c = rgb('color-mix(in hsl, gray, red)');
  assert.ok(c.r > c.g && c.r > c.b);
});

test('color-mix nests and refuses bad input', () => {
  assert.ok(C.parseColor('color-mix(in srgb, color-mix(in srgb, red, blue), white)'));
  for (const s of [
    'color-mix(in srgb, red)',
    'color-mix(srgb, red, blue)',
    'color-mix(in nosuch, red, blue)',
    'color-mix(in srgb, red 120%, blue)',
    'color-mix(in srgb shorter hue, red, blue)',
    'color-mix(in srgb, red 0%, blue 0%)',
    'color-mix(in srgb, red, nonsense)',
    'color-mix(in srgb, var(--a), blue)',
  ]) {
    assert.equal(C.parseColor(s), null, s);
  }
});

test('deep color-mix nesting stops at the depth limit', () => {
  let s = 'red';
  for (let i = 0; i < 10; i++) s = `color-mix(in srgb, ${s}, blue)`;
  assert.equal(C.parseColor(s), null);
});

test('things that are not plain colors return null', () => {
  for (const s of ['', ' ', 'currentcolor', 'currentColor', 'inherit', 'initial', 'unset', 'Canvas', 'ButtonText', 'var(--x)', 'calc(1 + 2)', 'rgb(var(--r) 0 0)', 'rgb(from red r g b)', 'hsl(calc(1 + 2) 50% 50%)', 'rgb(0 0)', 'rgb(0 0 0 0 0)', 'rgb(a b c)', 'light-dark(white, black)', 'url(x)', 'linear-gradient(red, blue)', 'rgb(0 0 0 / 1 / 2)']) {
    assert.equal(C.parseColor(s), null, JSON.stringify(s));
  }
});

test('non-strings and long strings return null', () => {
  for (const v of [undefined, null, 5, {}, [], true, Symbol.iterator.description]) assert.equal(C.parseColor(v), null);
  assert.equal(C.parseColor(`#${'f'.repeat(400)}`), null);
  assert.equal(C.parseColor(`rgb(${'1 '.repeat(500)})`), null);
});

test('random junk never throws', () => {
  const rand = prng(7);
  const alphabet = '#()%/,.-+ 0123456789abcdefxyzrgbhslokablch noneturndegradcolor-mix;{}\\"\'';
  for (let i = 0; i < 4000; i++) {
    let s = '';
    const n = Math.floor(rand() * 60);
    for (let j = 0; j < n; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
    assert.doesNotThrow(() => C.parseColor(s), s);
    assert.doesNotThrow(() => C.parseColor(`rgb(${s})`), s);
    assert.doesNotThrow(() => C.parseColor(`color-mix(in ${s})`), s);
  }
});

/* ---------- conversion and output ---------- */

test('sRGB to OKLCH and back loses less than one step', () => {
  const rand = prng(11);
  for (let i = 0; i < 1000; i++) {
    const c = { r: rand(), g: rand(), b: rand(), a: 1 };
    const [L, ch, h] = C.toOklch(c);
    const back = C.fromOklch(L, ch, h);
    for (const k of ['r', 'g', 'b']) near(back[k], c[k], 1 / 255, k);
  }
});

test('fromOklch keeps the lightness and the hue when it has to reduce chroma', () => {
  const out = C.fromOklch(0.6, 0.4, 150);
  const [L, ch, h] = C.toOklch(out);
  near(L, 0.6, 0.01);
  assert.ok(ch < 0.4);
  near(h, 150, 3);
  for (const k of ['r', 'g', 'b']) assert.ok(out[k] >= 0 && out[k] <= 1);
});

test('fromOklch handles the ends and a missing hue', () => {
  assert.deepEqual(C.fromOklch(1, 0.3, 40), { r: 1, g: 1, b: 1, a: 1 });
  assert.deepEqual(C.fromOklch(0, 0.3, 40), { r: 0, g: 0, b: 0, a: 1 });
  assert.doesNotThrow(() => C.fromOklch(0.5, 0.1, NaN));
});

test('toHex and toCss', () => {
  assert.equal(C.toHex({ r: 1, g: 0.5, b: 0, a: 1 }), '#ff8000');
  assert.equal(C.toHex({ r: 0, g: 0, b: 0, a: 0.5 }), '#00000080');
  assert.equal(C.toCss({ r: 1, g: 1, b: 1, a: 1 }), '#ffffff');
  assert.equal(C.toCss({ r: 1, g: 0, b: 0, a: 0.5 }), 'rgba(255, 0, 0, 0.5)');
  assert.equal(C.toHex({ r: 2, g: -1, b: 0.2, a: 1 }), '#ff0033');
});

/* ---------- contrast ---------- */

const W = { r: 1, g: 1, b: 1, a: 1 };
const K = { r: 0, g: 0, b: 0, a: 1 };

test('WCAG ratios for known pairs', () => {
  near(C.contrastRatio(K, W), 21, 0.001);
  near(C.contrastRatio(W, W), 1, 1e-9);
  near(C.contrastRatio(rgb('#777777'), W), 4.48, 0.01);
  near(C.contrastRatio(rgb('#767676'), W), 4.54, 0.01);
  near(C.contrastRatio(W, K), C.contrastRatio(K, W), 1e-9);
});

test('ensureContrast reaches the target and keeps the hue', () => {
  const bg = rgb('#102030');
  const fg = rgb('#406080');
  const out = C.ensureContrast(fg, bg, 4.5);
  assert.ok(C.contrastRatio(out, bg) >= 4.5);
  near(C.toOklch(out)[2], C.toOklch(fg)[2], 4);
});

test('ensureContrast leaves a passing color alone and darkens on a light background', () => {
  const bg = rgb('#ffffff');
  const ok = rgb('#222222');
  assert.equal(C.ensureContrast(ok, bg, 4.5), ok);
  const out = C.ensureContrast(rgb('#aaaaaa'), bg, 4.5);
  assert.ok(C.contrastRatio(out, bg) >= 4.5);
  assert.ok(C.toOklch(out)[0] < C.toOklch(rgb('#aaaaaa'))[0]);
});

test('ensureContrast returns the best color when the target is out of reach', () => {
  const bg = rgb('#808080');
  const out = C.ensureContrast(rgb('#888888'), bg, 21);
  assert.ok(C.contrastRatio(out, bg) >= C.contrastRatio(rgb('#888888'), bg));
});

test('the contrast floor is the original ratio, at most 7', () => {
  assert.equal(C.contrastFloor(3), 4.5);
  assert.equal(C.contrastFloor(5.2), 5.2);
  assert.equal(C.contrastFloor(7), 7);
  assert.equal(C.contrastFloor(21), 7);
});

/* ---------- theme transform ---------- */

const DARK = { mode: 'dark', darkBackground: '#16181d', darkText: '#e6e8eb', lightBackground: '#eeece8', lightText: '#1a1c20' };
const LIGHT = { ...DARK, mode: 'light' };
const hexOf = (s) => C.toHex(rgb(s));

function transformer(theme = DARK, options) {
  return C.createTransformer(C.createTheme(theme), options);
}

test('white background becomes the theme background and black text becomes the theme text', () => {
  const t = transformer();
  assert.equal(t.transform('#ffffff', 'background'), hexOf('#16181d'));
  assert.equal(t.transform('#000000', 'foreground'), hexOf('#e6e8eb'));
  assert.equal(t.transform('white', 'background'), hexOf('#16181d'));
});

test('light mode: a black background becomes the light background and white text becomes the light text', () => {
  const t = transformer(LIGHT);
  assert.equal(t.transform('#000000', 'background'), hexOf('#eeece8'));
  assert.equal(t.transform('#ffffff', 'foreground'), hexOf('#1a1c20'));
});

test('custom theme colors are used', () => {
  const t = transformer({ ...DARK, darkBackground: '#000000', darkText: '#ffffff' });
  assert.equal(t.transform('#fff', 'background'), '#000000');
  assert.equal(t.transform('#000', 'foreground'), '#ffffff');
});

test('background lightness: light colors invert, dark colors stay dark, and order holds on each side', () => {
  const t = C.createTheme(DARK);
  const at = (L) => C.toOklch(C.transformColor(t, C.fromOklch(L, 0, 0), 'background'))[0];
  let prev = Infinity;
  for (let L = 0.5; L <= 1.0001; L += 0.05) {
    const v = at(Math.min(L, 1));
    assert.ok(v <= prev + 1e-3, `light half not decreasing at ${L}`);
    prev = v;
  }
  prev = -Infinity;
  for (let L = 0; L <= 0.5001; L += 0.05) {
    const v = at(L);
    assert.ok(v >= prev - 1e-3, `dark half not increasing at ${L}`);
    prev = v;
  }
  for (const L of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) assert.ok(at(L) < 0.5, `L ${L} became ${at(L)}`);
});

test('foreground lightness: every text color stays readable on the theme background', () => {
  const th = C.createTheme(DARK);
  const bg = rgb('#16181d');
  for (let L = 0; L <= 1.0001; L += 0.05) {
    const out = C.transformColor(th, C.fromOklch(Math.min(L, 1), 0, 0), 'foreground');
    assert.ok(C.contrastRatio(out, bg) >= 4.5, `L ${L}: ${C.toHex(out)} ${C.contrastRatio(out, bg).toFixed(2)}`);
  }
});

test('border lightness falls as the original gets lighter', () => {
  const th = C.createTheme(DARK);
  const at = (L) => C.toOklch(C.transformColor(th, C.fromOklch(L, 0, 0), 'border'))[0];
  let prev = Infinity;
  for (let L = 0; L <= 1.0001; L += 0.1) {
    const v = at(Math.min(L, 1));
    assert.ok(v <= prev + 1e-3);
    prev = v;
  }
  const bgL = C.toOklch(rgb('#16181d'))[0];
  assert.ok(at(1) > bgL + 0.05, 'a light border stays visible');
});

test('hue is kept for saturated colors and chroma does not grow', () => {
  const th = C.createTheme(DARK);
  for (const s of ['#3366cc', '#cc3333', '#33aa55', '#ddaa22', '#8844cc']) {
    for (const role of ['background', 'foreground', 'border']) {
      const src = rgb(s);
      const out = C.transformColor(th, src, role);
      const [, c0, h0] = C.toOklch(src);
      const [, c1, h1] = C.toOklch(out);
      const d = Math.abs(((h1 - h0 + 540) % 360) - 180);
      assert.ok(d < 6 || c1 < 0.02, `${s} ${role} hue moved ${d}`);
      assert.ok(c1 <= c0 + 0.005, `${s} ${role} chroma grew`);
    }
  }
});

test('neutral grays take the tint of the theme', () => {
  const th = C.createTheme({ ...DARK, darkBackground: '#10203a' });
  const out = C.transformColor(th, rgb('#808080'), 'background');
  const [, c, h] = C.toOklch(out);
  const [, tc, thue] = C.toOklch(rgb('#10203a'));
  assert.ok(c > tc * 0.5);
  near(h, thue, 8);
});

test('alpha is kept and a fully transparent color is returned as is', () => {
  const th = C.createTheme(DARK);
  near(C.transformColor(th, rgb('rgba(255, 255, 255, 0.3)'), 'background').a, 0.3, 1e-9);
  const clear = rgb('transparent');
  assert.equal(C.transformColor(th, clear, 'background'), clear);
});

test('every output is inside sRGB, also for wide-gamut input', () => {
  const th = C.createTheme(DARK);
  for (const s of ['color(display-p3 1 0 0)', 'color(rec2020 0 1 0)', 'lab(50 100 -100)', 'oklch(0.7 0.4 300)']) {
    for (const role of ['background', 'foreground', 'border']) {
      const out = C.transformColor(th, rgb(s), role);
      for (const k of ['r', 'g', 'b']) assert.ok(out[k] >= 0 && out[k] <= 1, `${s} ${role} ${k}=${out[k]}`);
    }
  }
});

/* ---------- adjustments ---------- */

test('brightness and contrast change the result in the right direction', () => {
  const base = rgb(transformer().transform('#ffffff', 'background'));
  const bright = rgb(transformer({ ...DARK, brightness: 130 }).transform('#ffffff', 'background'));
  const dim = rgb(transformer({ ...DARK, brightness: 70 }).transform('#ffffff', 'background'));
  assert.ok(bright.r > base.r && dim.r < base.r);
  const hi = rgb(transformer({ ...DARK, contrast: 150 }).transform('#e6e8eb', 'foreground'));
  const baseText = rgb(transformer().transform('#e6e8eb', 'foreground'));
  assert.ok(hi.r >= baseText.r);
});

test('sepia warms and grayscale removes color', () => {
  const sepia = rgb(transformer({ ...DARK, sepia: 100 }).transform('#808080', 'foreground'));
  assert.ok(sepia.r > sepia.g && sepia.g > sepia.b);
  const gray = rgb(transformer({ ...DARK, grayscale: 100 }).transform('#3366cc', 'foreground'));
  near(gray.r, gray.g, 1 / 255);
  near(gray.g, gray.b, 1 / 255);
});

test('adjustment values outside the range are clamped, and junk falls back', () => {
  const t = transformer({ ...DARK, sepia: 900, grayscale: -4, brightness: 'x', contrast: NaN });
  assert.ok(t.transform('#ffffff', 'background'));
});

test('a theme with bad colors falls back to the built-in colors', () => {
  const t = transformer({ mode: 'dark', darkBackground: 'nope', darkText: 5 });
  assert.equal(t.transform('#ffffff', 'background'), '#16181d');
});

/* ---------- transformer ---------- */

test('invalid input gives null and is cached as null', () => {
  const t = transformer();
  for (const s of ['var(--x)', 'currentcolor', 'inherit', '', 'calc(1 + 1)', 'rgb(from red r g b)']) {
    assert.equal(t.transform(s, 'background'), null, s);
  }
  assert.equal(t.transform(5, 'background'), null);
  assert.equal(t.transform(undefined, 'background'), null);
});

test('the same input and role give the same answer, roles differ', () => {
  const t = transformer();
  assert.equal(t.transform('#336699', 'background'), t.transform('#336699', 'background'));
  assert.notEqual(t.transform('#336699', 'background'), t.transform('#336699', 'foreground'));
});

test('the cache stays inside its bound and gives the same answers after entries are dropped', () => {
  const t = transformer(DARK, { maxEntries: 10 });
  const first = t.transform('#336699', 'background');
  for (let i = 0; i < 200; i++) {
    t.transform(`#0a0a${(i % 256).toString(16).padStart(2, '0')}`, 'foreground');
    assert.ok(t.size <= 10, `size ${t.size}`);
  }
  assert.equal(t.transform('#336699', 'background'), first);
  t.clear();
  assert.equal(t.size, 0);
  assert.equal(t.transform('#336699', 'background'), first);
});

test('a color used often stays cached while others come and go', () => {
  const t = transformer(DARK, { maxEntries: 10 });
  t.transform('#123456', 'background');
  for (let i = 0; i < 100; i++) {
    t.transform('#123456', 'background');
    t.transform(`#0b0b${(i % 256).toString(16).padStart(2, '0')}`, 'background');
  }
  assert.ok(t.size <= 10);
});

test('pair keeps the contrast of the original or at least 7 down to 4.5', () => {
  const t = transformer();
  const rand = prng(3);
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const fg = { r: rand(), g: rand(), b: rand(), a: 1 };
    const bg = { r: rand(), g: rand(), b: rand(), a: 1 };
    const original = C.contrastRatio(fg, bg);
    const out = t.pair(C.toHex(fg), C.toHex(bg));
    assert.ok(out);
    const after = C.contrastRatio(rgb(out.fg), rgb(out.bg));
    const need = Math.min(C.contrastRatio(rgb(C.toHex(fg)), rgb(C.toHex(bg))), 7);
    // A tiny allowance covers the 8-bit rounding of the output.
    if (after < need - 0.05) {
      // Allowed only when no color of that hue can reach it on this background.
      const best = Math.max(C.contrastRatio(W, rgb(out.bg)), C.contrastRatio(K, rgb(out.bg)));
      assert.ok(best < need, `pair ${C.toHex(fg)} on ${C.toHex(bg)}: ${after.toFixed(2)} < ${need.toFixed(2)}`);
    }
    if (original >= 4.5) {
      assert.ok(after >= 4.45, `original ${original.toFixed(2)} became ${after.toFixed(2)}`);
      checked++;
    }
  }
  assert.ok(checked > 50);
});

test('pair returns null when either color is not plain', () => {
  const t = transformer();
  assert.equal(t.pair('var(--a)', '#fff'), null);
  assert.equal(t.pair('#000', 'inherit'), null);
});

/* ---------- speed (generous limits so slow machines pass; numbers are in the log) ---------- */

test('speed: cached and uncached transforms', () => {
  const t = transformer();
  const colors = [];
  const rand = prng(5);
  for (let i = 0; i < 2000; i++) colors.push(`#${Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0')}`);
  const start = performance.now();
  for (const s of colors) t.transform(s, 'background');
  const cold = performance.now() - start;
  const warmStart = performance.now();
  for (let i = 0; i < 100000; i++) t.transform(colors[i % colors.length], 'background');
  const warm = performance.now() - warmStart;
  console.log(`# speed: ${colors.length} uncached transforms ${cold.toFixed(1)} ms; 100000 cached lookups ${warm.toFixed(1)} ms`);
  assert.ok(cold < 1500, `uncached too slow: ${cold}`);
  assert.ok(warm < 1000, `cached too slow: ${warm}`);
});

test('every named color gives a valid result in each role and both modes', () => {
  const list = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ');
  let cases = 0;
  for (const theme of [DARK, LIGHT]) {
    const th = C.createTheme(theme);
    const bg = rgb(theme.mode === 'dark' ? theme.darkBackground : theme.lightBackground);
    for (const name of list) {
      for (const role of ['background', 'foreground', 'border']) {
        const out = C.transformColor(th, rgb(name), role);
        for (const k of ['r', 'g', 'b']) assert.ok(Number.isFinite(out[k]) && out[k] >= 0 && out[k] <= 1, `${name} ${role}`);
        if (role === 'foreground') assert.ok(C.contrastRatio(out, bg) >= 4.5, `${theme.mode} ${name} text on the theme background: ${C.contrastRatio(out, bg).toFixed(2)}`);
        cases++;
      }
    }
  }
  assert.equal(cases, 148 * 3 * 2);
});

test('accents keep their hue and vividness: brand colors are not turned into near-black tones', () => {
  const theme = C.createTheme({});
  const tr = C.createTransformer(theme);
  const hex = (c) => ({ r: parseInt(c.slice(1, 3), 16) / 255, g: parseInt(c.slice(3, 5), 16) / 255, b: parseInt(c.slice(5, 7), 16) / 255, a: 1 });
  const lch = (c) => C.toOklch(hex(c));
  const table = {
    '#ffffff': '#16181d',
    '#1a73e8': '#1a73e8',
    '#2e7d32': '#2e7d32',
    '#d32f2f': '#d32f2f',
    '#66bb6a': '#57a25b',
    '#00c853': '#00ab46',
    '#ff9800': '#cf7a00',
    '#90caf9': '#1a6ca3',
    '#fbc02d': '#bc8f1f',
  };
  for (const [input, want] of Object.entries(table)) {
    const got = tr.transform(input, 'background');
    const [Lg, Cg, hg] = lch(got);
    const [Lw, Cw, hw] = lch(want);
    assert.ok(Math.abs(Lg - Lw) <= 0.02 && Math.abs(Cg - Cw) <= 0.02 && Math.abs(hg - hw) <= 4, `${input}: ${got} is not close to ${want}`);
  }
  // Invariants for every strong color.
  let tested = 0;
  for (let h = 0; h < 360; h += 15) {
    for (const L of [0.45, 0.6, 0.75, 0.9]) {
      const rgb = C.fromOklch(L, 0.16, h, 1);
      const [Li, Ci, hi] = C.toOklch(rgb);
      if (Ci < 0.12) continue;
      tested += 1;
      const out = C.toOklch(C.transformColor(theme, rgb, 'background'));
      assert.ok(out[0] >= 0.29, `L ${out[0]} at hue ${h}, input L ${Li}`);
      assert.ok(out[1] >= 0.45 * Ci || out[0] > 0.7, `chroma ${out[1]} from ${Ci} at hue ${h}, input L ${Li}`);
      let d = Math.abs(out[2] - hi);
      if (d > 180) d = 360 - d;
      assert.ok(d <= 8, `hue moved ${d} degrees at ${h}`);
    }
  }
  assert.ok(tested > 30, String(tested));
});

test('neutral and pastel backgrounds still become dark surfaces', () => {
  const theme = C.createTheme({});
  const tr = C.createTransformer(theme);
  for (const input of ['#ffffff', '#f5f5f5', '#e0e0e0', '#fce4ec', '#e8f5e9', '#fff9c4', '#e3f2fd']) {
    const [L] = C.toOklch(C.parseColor(tr.transform(input, 'background')));
    assert.ok(L < 0.32, `${input} gives lightness ${L}`);
  }
});

test('the night shift takes away blue first and green a little, keeps red, and is off at 0', () => {
  const plain = C.createTransformer(C.createTheme({}));
  const warm = C.createTransformer(C.createTheme({ warmth: 100 }));
  const half = C.createTransformer(C.createTheme({ warmth: 50 }));
  const ch = (css) => C.parseColor(css);
  for (const input of ['#ffffff', '#cccccc', '#4488cc']) {
    for (const role of ['background', 'foreground']) {
      const a = ch(plain.transform(input, role));
      const b = ch(warm.transform(input, role));
      const m = ch(half.transform(input, role));
      // Text under the night shift is lifted when its contrast would fall under 4.5, which also raises red a little.
      assert.ok(Math.abs(a.r - b.r) < (role === 'foreground' ? 0.05 : 0.01), `red moved for ${input}`);
      assert.ok(b.g <= a.g + 1e-9 && b.b <= a.b * 0.6 + 0.01, `${input} ${role}: blue ${a.b} to ${b.b}`);
      assert.ok(m.b < a.b + 1e-9 && m.b > b.b - 1e-9, 'half is between');
    }
  }
  assert.equal(plain.transform('#ffffff', 'background'), C.createTransformer(C.createTheme({ warmth: 0 })).transform('#ffffff', 'background'));
});

test('legacy attribute colors are read the way browsers read them', () => {
  const cases = [
    ['red', '#ff0000'],
    ['  RED ', '#ff0000'],
    ['#abc', '#aabbcc'],
    ['abc', '#0a0b0c'],
    ['#ff00', '#ff0000'],
    ['ffff', '#ffff00'],
    ['ff0', '#0f0f00'],
    ['chucknorris', '#c00000'],
    ['#ffffff', '#ffffff'],
    ['ffffff', '#ffffff'],
    ['#123456789', '#124578'],
    ['rgb(1,2,3)', null],
    ['transparent', null],
    ['', null],
    ['   ', null],
  ];
  for (const [input, want] of cases) {
    if (want === null && /^rgb/.test(input)) {
      // Not a legacy color: the digits are kept and the rest becomes zero, so the result is some color, never a crash.
      assert.match(C.legacyColor(input), /^#[0-9a-f]{6}$/);
      continue;
    }
    assert.equal(C.legacyColor(input), want, JSON.stringify(input));
  }
  assert.equal(C.legacyColor(undefined), null);
  assert.equal(C.legacyColor('x'.repeat(5000)), '#000000');
  assert.match(C.legacyColor('\u{1F600}\u{1F600}\u{1F600}'), /^#[0-9a-f]{6}$/);
});

/* ---------- contrast floors and limits ---------- */

const FLOOR_SETTINGS = {
  default: {},
  'warmth 100': { warmth: 100 },
  'sepia 100': { sepia: 100 },
  'grayscale 100': { grayscale: 100 },
  'brightness 50': { brightness: 50 },
  'brightness 150': { brightness: 150 },
  'contrast 50': { contrast: 50 },
  'contrast 150': { contrast: 150 },
  'warmth 100, sepia 100, brightness 50': { warmth: 100, sepia: 100, brightness: 50 },
  'light mode': { mode: 'light' },
  'light, warmth 100': { mode: 'light', warmth: 100 },
  'light, sepia 100': { mode: 'light', sepia: 100 },
  'light, brightness 50': { mode: 'light', brightness: 50 },
  'light, brightness 150': { mode: 'light', brightness: 150 },
  'lighter dark colors': { darkBackground: '#3a3d44', darkText: '#c0c3c9' },
};

/** Colors over lightness, chroma and hue, mapped into sRGB. */
function colorGrid() {
  const out = [];
  for (let L = 0; L <= 1.0001; L += 0.1) {
    out.push(C.fromOklch(Math.min(L, 1), 0, 0));
    for (const chroma of [0.05, 0.12, 0.2]) for (let h = 0; h < 360; h += 45) out.push(C.fromOklch(Math.min(L, 1), chroma, h));
  }
  return out;
}

/** The best contrast any color can reach against `ref`. */
const reach = (ref) => Math.max(C.contrastRatio(W, ref), C.contrastRatio(K, ref));
const as8bit = (c) => rgb(C.toCss(c));

test('text keeps 4.5:1 against the page and against a card, in every setting and over a grid of colors', () => {
  const grid = colorGrid();
  assert.ok(grid.length > 200);
  let checked = 0;
  for (const [name, settings] of Object.entries(FLOOR_SETTINGS)) {
    const th = C.createTheme(settings);
    const { page, card } = C.surfaceColors(th);
    // Text stays on the side of the mode (lighter in the dark mode, darker in the light mode). Where a dim setting puts the
    // floor out of reach on that side, it goes most of the way (0.9 of the best ratio there) and keeps its hue.
    const end = th.dark ? W : K;
    for (const ref of [page, card]) {
      const side = C.contrastRatio(end, ref);
      const need = side >= C.FLOORS.text ? C.FLOORS.text : 1 + (side - 1) * 0.9;
      for (const c of grid) {
        const out = as8bit(C.transformColor(th, c, 'foreground'));
        const ratio = C.contrastRatio(out, ref);
        assert.ok(ratio >= need - 0.05, `${name}: ${C.toHex(c)} became ${C.toHex(out)}, ${ratio.toFixed(2)} against ${C.toHex(ref)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 6000, String(checked));
});

test('a dimmed light page keeps dark text: the floor never turns the text of the light mode light', () => {
  for (const brightness of [30, 50, 70]) {
    const th = C.createTheme({ mode: 'light', brightness });
    const { page, card } = C.surfaceColors(th);
    const t = C.createTransformer(th);
    for (const input of ['#000', '#212529', '#555', '#888', '#1a73e8', '#c00']) {
      const out = rgb(t.transform(input, 'foreground'));
      const y = C.contrastRatio(out, K);
      assert.ok(y < C.contrastRatio(card, K) && y < C.contrastRatio(page, K), `brightness ${brightness}: ${input} became ${C.toHex(out)}, lighter than the page ${C.toHex(page)}`);
    }
  }
  // The dark mode keeps light text when it is dimmed.
  const dim = C.createTheme({ brightness: 50 });
  assert.ok(C.contrastRatio(rgb(C.createTransformer(dim).transform('#000', 'foreground')), K) > C.contrastRatio(C.surfaceColors(dim).card, K));
});

test('the pair floor keeps a text color and its background apart, on the side the text is on', () => {
  for (const settings of [{}, { mode: 'light' }, { brightness: 50 }, { mode: 'light', brightness: 50 }]) {
    const t = C.createTransformer(C.createTheme(settings));
    for (const [fgIn, bgIn] of [['#212529', '#ffc107'], ['#fff', '#1a73e8'], ['#fff', '#198754'], ['#000', '#0dcaf0']]) {
      const p = t.pair(fgIn, bgIn);
      const floor = Math.min(C.contrastFloor(C.contrastRatio(rgb(fgIn), rgb(bgIn))), Math.max(C.contrastRatio(W, rgb(p.bg)), C.contrastRatio(K, rgb(p.bg))) - 0.05);
      assert.ok(C.contrastRatio(rgb(p.fg), rgb(p.bg)) >= floor - 0.05, `${JSON.stringify(settings)} ${fgIn} on ${bgIn}: ${p.fg} on ${p.bg}`);
    }
    assert.equal(t.pair('#000', 'rgba(255, 255, 255, 0.5)'), null);
  }
});

test('control edges and focus outlines keep 3:1 against the page and a card; plain borders stay quiet', () => {
  const grid = colorGrid();
  for (const [name, settings] of Object.entries(FLOOR_SETTINGS)) {
    const th = C.createTheme(settings);
    const { page, card } = C.surfaceColors(th);
    for (const ref of [page, card]) {
      const need = Math.min(C.FLOORS.edge, reach(ref) - 0.05);
      for (const c of grid) {
        const out = as8bit(C.transformColor(th, c, 'edge'));
        const ratio = C.contrastRatio(out, ref);
        assert.ok(ratio >= need - 0.05, `${name}: ${C.toHex(c)} edge ${C.toHex(out)} ${ratio.toFixed(2)} against ${C.toHex(ref)}`);
      }
    }
  }
  // A divider or a card border is decoration (WCAG 1.4.11 does not ask for it) and stays below the floor.
  const th = C.createTheme({});
  const quiet = C.transformColor(th, rgb('#e5e5e5'), 'border');
  assert.ok(C.contrastRatio(quiet, C.surfaceColors(th).page) < 3);
  // The edge of a page-white control is lighter than its quiet border.
  assert.ok(C.toOklch(C.transformColor(th, rgb('#ffffff'), 'edge'))[0] > C.toOklch(C.transformColor(th, rgb('#ffffff'), 'border'))[0]);
});

test('a surface is never deeper than the recess limit below the page, and text stays under 0.96 by default', () => {
  for (const settings of [{}, { mode: 'light' }, { darkBackground: '#000000' }, { lightBackground: '#ffffff', mode: 'light' }]) {
    const th = C.createTheme(settings);
    const domain = (L) => (th.dark ? L : 1 - L);
    for (const c of colorGrid()) {
      const [L, chroma] = C.toOklch(c);
      if (chroma > 0.04) continue;
      const out = domain(C.toOklch(C.transformColor(th, c, 'background'))[0]);
      assert.ok(out >= th.Lb - C.FLOORS.recess - 0.004, `${JSON.stringify(settings)}: input L ${L.toFixed(2)} gives ${out.toFixed(3)} below ${th.Lb.toFixed(3)}`);
    }
  }
  const th = C.createTheme({});
  for (const c of colorGrid()) assert.ok(C.toOklch(C.transformColor(th, c, 'foreground'))[0] <= 0.96);
});

test('vivid accents keep their default output: hue, vividness and lightness are the same as before the floors', () => {
  const tr = C.createTransformer(C.createTheme({}));
  const table = {
    '#1a73e8': ['#1a73e8', '#4692ff', '#1a73e8'],
    '#0b57d0': ['#0b57d0', '#5392ff', '#0b57d0'],
    '#d93025': ['#d93025', '#f55848', '#d93025'],
    '#ea4335': ['#e84234', '#fd5f4f', '#ea4335'],
    '#188038': ['#188038', '#4ca55f', '#188038'],
    '#34a853': ['#31a14f', '#4fb867', '#34a853'],
    '#f9ab00': ['#c48500', '#f3aa1f', '#d28f00'],
    '#fbbc04': ['#be8d02', '#f2b61b', '#c89502'],
    '#ff6d00': ['#e15f00', '#ff7f3a', '#fd6c00'],
    '#7b1fa2': ['#7b1fa2', '#d07ffb', '#7b1fa2'],
    '#673ab7': ['#673ab7', '#a987ff', '#673ab7'],
    '#00bcd4': ['#00a0b5', '#2ec1d7', '#00b2c9'],
    '#0d6efd': ['#0d6efd', '#4f91ff', '#0d6efd'],
    '#198754': ['#198754', '#4aa774', '#198754'],
    '#dc3545': ['#dc3545', '#f65960', '#dc3545'],
    '#ffc107': ['#be8f00', '#f4ba1a', '#c79600'],
    '#3b5998': ['#385799', '#80a1e2', '#39599c'],
    '#1da1f2': ['#1992dc', '#3cadfb', '#1da1f2'],
  };
  for (const [input, want] of Object.entries(table)) {
    const got = ['background', 'foreground', 'border'].map((role) => tr.transform(input, role));
    // A dark accent may move one or two steps of 8 bits because black boxes sit closer to the page now.
    got.forEach((hex, i) => {
      const a = rgb(hex);
      const b = rgb(want[i]);
      for (const k of ['r', 'g', 'b']) assert.ok(Math.abs(a[k] - b[k]) * 255 <= 2.01, `${input} ${i}: ${hex} against ${want[i]}`);
    });
  }
});

test('a pale chromatic background (a highlight, a marker) is a deep tone of its hue in the dark mode and stays light in the light mode, and dark text on it stays readable', () => {
  const dark = C.createTransformer(C.createTheme({}));
  const light = C.createTransformer(C.createTheme({ mode: 'light' }));
  const texts = ['#000000', '#222222', '#444444'];
  let cases = 0;
  for (let h = 0; h < 360; h += 30) {
    for (const L of [0.93, 0.95, 0.97, 0.99]) {
      for (const Cin of [0.05, 0.09, 0.14]) {
        const src = C.fromOklch(L, Cin, h, 1);
        const [Li, Ci, hi] = C.toOklch(src);
        if (Ci < 0.04 || Li < 0.92) continue;
        const css = C.toCss(src);
        cases += 1;
        const d = rgb(dark.transform(css, 'background'));
        const dl = C.toOklch(d);
        assert.ok(dl[0] < 0.35, `dark: ${css} stays bright: ${C.toHex(d)}`);
        if (dl[1] > 0.02) {
          let dh = Math.abs(dl[2] - hi);
          if (dh > 180) dh = 360 - dh;
          assert.ok(dh <= 12, `dark: ${css} hue moved ${dh} degrees`);
        }
        const g = rgb(light.transform(css, 'background'));
        assert.ok(C.toOklch(g)[0] >= Li - 0.06, `light: ${css} turned dark: ${C.toHex(g)}`);
        for (const text of texts) {
          const td = rgb(dark.transform(text, 'foreground'));
          const tl = rgb(light.transform(text, 'foreground'));
          assert.ok(C.contrastRatio(td, d) >= 4.5, `dark: ${text} on ${css}: ${C.contrastRatio(td, d).toFixed(2)}`);
          assert.ok(C.contrastRatio(tl, g) >= 4.5, `light: ${text} on ${css}: ${C.contrastRatio(tl, g).toFixed(2)}`);
        }
      }
    }
  }
  assert.ok(cases > 40, `only ${cases} cases ran`);
});

test('a pale chromatic background keeps dark text readable in the Paper and E-ink modes', () => {
  for (const preset of ['paper', 'eink']) {
    const tr = C.createTransformer(C.createTheme({ mode: 'eink', einkPreset: preset }));
    for (const hex of ['#fff176', '#fff9c4', '#ffeb3b', '#c8e6c9', '#bbdefb', '#f8bbd0', '#e1bee7', '#ffccbc']) {
      const bg = rgb(tr.transform(hex, 'background'));
      const fg = rgb(tr.transform('#222222', 'foreground'));
      assert.ok(C.contrastRatio(fg, bg) >= 4.5, `${preset}: ${hex} -> ${C.toHex(bg)} under text ${C.toHex(fg)}`);
      assert.ok(C.toOklch(bg)[0] > 0.6, `${preset}: ${hex} turned dark`);
    }
  }
});

/* ---------- faint overlays keep their direction ---------- */

test('a faint white veil stays lighter than the page in the dark mode, a faint black veil darker in the light mode', () => {
  const over = (c, page) => ({ r: c.r * c.a + page.r * (1 - c.a), g: c.g * c.a + page.g * (1 - c.a), b: c.b * c.a + page.b * (1 - c.a), a: 1 });
  const dark = C.createTheme({ mode: 'dark' });
  const light = C.createTheme({ mode: 'light' });
  const darkPage = C.surfaceColors(dark).page;
  const lightPage = C.surfaceColors(light).page;
  for (const role of ['background', 'border']) {
    for (const a of [0.02, 0.05, 0.1, 0.15, 0.2, 0.3]) {
      for (const ink of ['255, 255, 255', '245, 247, 250', '220, 224, 230']) {
        const out = C.transformColor(dark, rgb(`rgba(${ink}, ${a})`), role);
        near(out.a, a, 1e-9, 'alpha');
        assert.ok(C.contrastRatio(over(out, darkPage), darkPage) > 1 + a * 2, `${role} ${ink} ${a}: ${C.toCss(out)}`);
        assert.ok(C.toOklch(over(out, darkPage))[0] > C.toOklch(darkPage)[0], `${role} ${ink} ${a} is not lighter`);
      }
      for (const ink of ['0, 0, 0', '10, 12, 16']) {
        const out = C.transformColor(light, rgb(`rgba(${ink}, ${a})`), role);
        near(out.a, a, 1e-9, 'alpha');
        assert.ok(C.toOklch(over(out, lightPage))[0] < C.toOklch(lightPage)[0], `${role} light ${ink} ${a} is not darker`);
      }
    }
  }
});

test('a fuller white color is a surface and still turns dark; shadows and control edges follow their own rules', () => {
  const dark = C.createTheme({ mode: 'dark' });
  for (const a of [0.4, 0.6, 0.9]) assert.ok(C.toOklch(C.transformColor(dark, rgb(`rgba(255, 255, 255, ${a})`), 'background'))[0] < 0.4, `${a}`);
  // A chromatic faint color is not a veil.
  assert.ok(C.toOklch(C.transformColor(dark, rgb('rgba(40, 120, 255, 0.2)'), 'background'))[0] < 0.7);
  // A white glow is a shadow, handled as before.
  const glow = C.transformColor(dark, rgb('rgba(255, 255, 255, 0.2)'), 'shadow');
  assert.ok(C.toOklch(glow)[0] < 0.4);
  // A control edge keeps its contrast floor.
  const edge = C.transformColor(dark, rgb('rgba(255, 255, 255, 0.2)'), 'edge');
  const { page } = C.surfaceColors(dark);
  assert.ok(C.contrastRatio({ ...edge, a: 1 }, page) >= C.FLOORS.edge - 0.01);
  // Text keeps being text.
  assert.ok(C.toOklch(C.transformColor(dark, rgb('rgba(255, 255, 255, 0.2)'), 'foreground'))[0] > 0.6);
});

test('the night shift and the brightness setting still apply to a veil, and the E-ink and Paper modes keep their light surfaces', () => {
  const warm = C.createTheme({ mode: 'dark', warmth: 100 });
  const out = C.transformColor(warm, rgb('rgba(255, 255, 255, 0.1)'), 'background');
  assert.ok(out.b < out.r - 0.2, 'blue is taken away');
  const dim = C.createTheme({ mode: 'dark', brightness: 50 });
  assert.ok(C.transformColor(dim, rgb('rgba(255, 255, 255, 0.1)'), 'background').r < 0.6);
  for (const einkPreset of ['paper', 'eink']) {
    const th = C.createTheme({ mode: 'eink', einkPreset });
    for (const role of ['background', 'border']) {
      const o = C.transformColor(th, rgb('rgba(255, 255, 255, 0.1)'), role);
      near(o.a, 0.1, 1e-9, 'alpha');
      assert.ok(C.toOklch(o)[0] > 0.4, `${einkPreset} ${role}`);
    }
  }
});

/* ---------- a near-neutral color keeps its hue or takes the tint of the theme ---------- */

test('the hue of a near-neutral color is near its own hue or near the tint, never from the far side of the wheel', () => {
  const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const rand = prng(99);
  const themes = [{ mode: 'dark' }, { mode: 'light' }, { mode: 'dark', darkBackground: '#1c1a17' }, { mode: 'light', lightBackground: '#f4efe6' }];
  for (const settings of themes) {
    const th = C.createTheme(settings);
    for (const role of ['background', 'foreground', 'border']) {
      const tint = role === 'foreground' ? th.fgTint : th.bgTint;
      let checked = 0;
      for (let i = 0; i < 1500; i++) {
        const input = C.fromOklch(0.05 + rand() * 0.9, rand() * 0.03, rand() * 360);
        const [, inC, inH] = C.toOklch(input);
        if (inC < 0.004) continue;
        const [, outC, outH] = C.toOklch(C.transformColor(th, input, role));
        // Below this chroma the cast cannot be seen.
        if (outC < 0.015) continue;
        checked++;
        const d = Math.min(diff(outH, inH), diff(outH, tint.h));
        assert.ok(d <= 20, `${settings.mode} ${role}: hue ${inH.toFixed(0)} chroma ${inC.toFixed(3)} gave hue ${outH.toFixed(0)}, tint ${tint.h.toFixed(0)}`);
      }
      assert.ok(checked > 100, `${settings.mode} ${role}: ${checked} colors checked`);
    }
  }
});

test('cool grays of a light page stay cool in the light mode, warm grays of a dark page stay warm in the dark mode', () => {
  const light = C.createTheme({ mode: 'light' });
  for (const hex of ['#ced4da', '#e9ecef', '#dee2e6', '#adb5bd']) {
    const [, , inH] = C.toOklch(rgb(hex));
    const [, outC, outH] = C.toOklch(C.transformColor(light, rgb(hex), 'background'));
    const d = Math.abs(((outH - inH + 540) % 360) - 180);
    assert.ok(d < 40 || outC < 0.012, `${hex}: hue ${inH.toFixed(0)} became ${outH.toFixed(0)} at chroma ${outC.toFixed(3)}`);
  }
  const dark = C.createTheme({ mode: 'dark' });
  for (const hex of ['#44403c', '#e7e5e4', '#57534e', '#a8a29e']) {
    const [, inC, inH] = C.toOklch(rgb(hex));
    const [, outC, outH] = C.toOklch(C.transformColor(dark, rgb(hex), 'background'));
    const d = Math.abs(((outH - inH + 540) % 360) - 180);
    assert.ok(d < 40 || outC < 0.012, `${hex}: hue ${inH.toFixed(0)} (chroma ${inC.toFixed(3)}) became ${outH.toFixed(0)} at chroma ${outC.toFixed(3)}`);
  }
});

/* ---------- color syntax ---------- */

test('invalid color syntax is not a color: a browser ignores it, so a copy must not make it live', () => {
  for (const s of ['rgb(10 20 30 0.5)', 'rgb(10, 20, 30 / 0.5)', 'rgb(10 20 30 40)', 'rgb(10,20,30,)', 'rgb(10, 20 30)', 'rgb(10,20%,30)', 'hsl(120 50% 50% 0.5)', 'hsl(120,50,50)', 'hwb(120, 20%, 30%)', 'lab(50, 40, 30)', 'color(srgb 1 0 0 0.5)', 'color(srgb 1, 0, 0)', 'rgb(none, 0, 0)', 'rgb(10 20 30 /)']) {
    assert.equal(C.parseColor(s), null, s);
  }
  for (const s of ['rgb(10,20,30)', 'rgba(10,20,30,.5)', 'rgb(10 20 30 / 50%)', 'rgb(10% 20% 30%)', 'rgb(10 20% 30)', 'hsl(120 50 50)', 'hsl(120deg,50%,50%)', 'hsla(120,50%,50%,.5)', 'rgb(none 0 0)', 'color(srgb 1 0 0 / .5)', 'lab(50 40 30 / 0.5)']) {
    assert.ok(C.parseColor(s), s);
  }
});

test('huge numbers are clamped and never give NaN', () => {
  for (const s of ['rgb(1e308 0 0)', 'rgb(-1e308 0 0)', 'rgb(1e308% 0% 0%)', 'hsl(120 1e308% 50%)', 'lab(50 1e308 1e308)', 'oklch(0.5 1e308 30)', 'color(display-p3 1e308 0 0)', 'color(xyz 1e308 1e308 1e308)', 'hsl(1e308 50% 50%)']) {
    const c = C.parseColor(s);
    if (c === null) continue;
    for (const k of ['r', 'g', 'b', 'a']) assert.ok(Number.isFinite(c[k]), `${s} ${k}`);
    for (const role of ['background', 'foreground', 'border']) assert.ok(!/NaN|Infinity/.test(C.toCss(C.transformColor(C.createTheme({}), c, role))), `${s} ${role}`);
  }
  assert.equal(C.parseColor('rgb(1e999 0 0)'), null);
  assert.equal(C.toHex({ r: NaN, g: Infinity, b: 2, a: 1 }), '#00ff' + 'ff');
  assert.equal(C.toCss({ r: NaN, g: 0, b: 0, a: 0.5 }), 'rgba(0, 0, 0, 0.5)');
  assert.equal(C.parseColor('rgb(300 0 0)').r, 1);
});

test('color-mix in lab and lch treats a gray as having no hue, and the wide RGB spaces mix', () => {
  const near3 = (css, [r, g, b]) => {
    const c = rgb(css);
    for (const [k, v] of [['r', r], ['g', g], ['b', b]]) assert.ok(Math.abs(Math.round(Math.min(1, Math.max(0, c[k])) * 255) - v) <= 2, `${css} ${k}: ${Math.round(c[k] * 255)} against ${v}`);
  };
  near3('color-mix(in lch, white, red)', [255, 159, 128]);
  near3('color-mix(in lch, #f5f5f5, #ff0)', [255, 250, 154]);
  for (const space of ['display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020']) {
    near3(`color-mix(in ${space}, #336699, #336699)`, [51, 102, 153]);
  }
});
