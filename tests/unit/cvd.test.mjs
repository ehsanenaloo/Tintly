// The color vision model and correction (cvd.js) and how the color transform uses it (color.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';
import { sanitizeSection, defaultSettings, migrate } from '../../extension/shared/settings.js';

const dk = await loadContent('engine/color.js', 'engine/einkpalette.js', 'engine/cvd.js');
const C = dk.color;
const V = dk.cvd;

const KINDS = ['protan', 'deutan', 'tritan'];
const LUMA = [0.2126, 0.7152, 0.0722];
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
const mul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));

/** OKLab of a gamma sRGB color. */
function oklab(rgb) {
  const [r, g, b] = rgb.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const dist = (a, b) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]));
/** What a person with the deficiency sees of a gamma sRGB color. */
const seen = (m, rgb) => V.apply(m.simulate, rgb.map(lin)).map((v) => gam(Math.min(Math.max(v, 0), 1)));

test('no kind or a severity of 0 gives no matrices; the same kind and severity give the same frozen object', () => {
  assert.equal(V.matrices('none', 100), null);
  assert.equal(V.matrices('protan', 0), null);
  assert.equal(V.matrices(undefined, 50), null);
  const a = V.matrices('deutan', 60);
  assert.ok(Object.isFrozen(a));
  assert.equal(V.matrices('deutan', 60.001), a);
  assert.equal(V.matrices('deutan', 200).severity, 100, 'the severity is capped at 100');
});

test('the simulation keeps white, and at 100 percent the person has two kinds of cone (the matrix loses a rank)', () => {
  for (const kind of KINDS) {
    for (const s of [10, 50, 100]) {
      const m = V.matrices(kind, s);
      V.apply(m.simulate, [1, 1, 1]).forEach((v) => assert.ok(Math.abs(v - 1) < 1e-6, `${kind} ${s} white ${v}`));
    }
    const [[a, b, c], [d, e, f], [g, h, i]] = V.matrices(kind, 100).simulate;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    assert.ok(Math.abs(det) < 1e-3, `${kind} det ${det}`);
  }
});

test('the correction keeps every gray and the luminance of every color, and its inverse undoes it', () => {
  for (const kind of KINDS) {
    for (const s of [25, 100]) {
      const m = V.matrices(kind, s);
      for (const g of [0, 0.2, 0.5, 1]) V.apply(m.correct, [g, g, g]).forEach((v) => assert.ok(Math.abs(v - g) < 1e-9, `${kind} gray ${g}`));
      // Deutan and tritan keep the luminance a normal viewer sees. Protan keeps the luminance the person sees.
      const view = kind === 'protan' ? mul(m.simulate, m.correct) : m.correct;
      for (let c = 0; c < 3; c++) {
        const y = LUMA[0] * view[0][c] + LUMA[1] * view[1][c] + LUMA[2] * view[2][c];
        assert.ok(Math.abs(y - LUMA[c]) < 1e-9, `${kind} luminance column ${c}`);
      }
      mul(m.undo, m.correct).forEach((row, r) => row.forEach((v, c) => assert.ok(Math.abs(v - (r === c ? 1 : 0)) < 1e-9)));
    }
  }
});

test('on sRGB the correction stays in the gamut and leaves gray, black and white as they are', () => {
  for (const kind of KINDS) {
    const m = V.matrices(kind, 100);
    for (const g of ['#000000', '#808080', '#ffffff']) {
      const rgb = hex(g);
      V.onSrgb(m.correct, rgb).forEach((v, i) => assert.ok(Math.abs(v - rgb[i]) < 1e-6, `${kind} ${g}`));
    }
    for (const s of ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff']) V.onSrgb(m.correct, hex(s)).forEach((v) => assert.ok(v >= 0 && v <= 1));
  }
});

// Pairs that each deficiency confuses: the simulation brings them close. After the correction they are further apart for that person.
// A fully saturated primary has no room in the gamut to move, so its pairs gain little (a known limit).
// The gain needed grows with the severity: a mild deficiency confuses less and is corrected less.
const PAIRS = {
  protan: [['#ef6c00', '#689f38'], ['#d32f2f', '#5d7a1f'], ['#c62828', '#558b2f']],
  deutan: [['#cc3333', '#6b8e23'], ['#c62828', '#558b2f'], ['#e53935', '#7cb342']],
  tritan: [['#1e88e5', '#43a047'], ['#5c6bc0', '#26a69a'], ['#3949ab', '#00897b']],
};

test('for each kind and severity, pairs the deficiency confuses become easier to tell apart after the correction', () => {
  for (const kind of KINDS) {
    for (const s of [50, 75, 100]) {
      const m = V.matrices(kind, s);
      for (const [x, y] of PAIRS[kind]) {
        const a = hex(x);
        const b = hex(y);
        const normal = dist(a, b);
        const before = dist(seen(m, a), seen(m, b));
        assert.ok(before < normal, `${kind} ${s} ${x}/${y}: the model confuses the pair (${before} < ${normal})`);
        const after = dist(seen(m, V.onSrgb(m.correct, a)), seen(m, V.onSrgb(m.correct, b)));
        assert.ok(after > before * (s === 50 ? 1.08 : 1.25), `${kind} ${s} ${x}/${y}: ${before.toFixed(3)} -> ${after.toFixed(3)}`);
      }
    }
  }
});

test('the theme carries the correction only when it is wanted; E-ink with no color turns it off', () => {
  assert.equal(C.createTheme({ mode: 'dark' }).cvd, null);
  assert.equal(C.createTheme({ mode: 'dark', cvdType: 'none' }).cvd, null);
  assert.equal(C.createTheme({ mode: 'dark', cvdType: 'protan', cvdSeverity: 0 }).cvd, null);
  assert.equal(C.createTheme({ mode: 'dark', cvdType: 'protan', cvdSeverity: 40 }).cvd.severity, 40);
  assert.equal(C.cvdWanted({ mode: 'eink', einkPreset: 'eink', cvdType: 'deutan' }), false, 'the E-ink preset has no color');
  assert.equal(C.cvdWanted({ mode: 'eink', einkPreset: 'paper', cvdType: 'deutan' }), true);
  assert.equal(C.cvdWanted({ mode: 'eink', einkPreset: 'paper', einkColorAmount: 0, cvdType: 'deutan' }), false);
  assert.equal(C.createTheme({ mode: 'eink', einkPreset: 'eink', cvdType: 'tritan' }).cvd, null);
});

test('the original mode keeps every color without a correction, and changes only the colors with one', () => {
  const plain = C.createTransformer(C.createTheme({ mode: 'original' }));
  for (const c of ['#ff0000', '#123456', '#ffffff', 'rgb(10 200 30 / 50%)']) assert.equal(C.parseColor(plain.transform(c, 'foreground')).r, C.parseColor(c).r);
  assert.equal(plain.pair?.('#000', '#fff') ?? null, null, 'no contrast pair is made for the page colors');
  const t = C.createTransformer(C.createTheme({ mode: 'original', cvdType: 'deutan', cvdSeverity: 100 }));
  assert.equal(t.original, true);
  assert.ok(t.cvd);
  assert.equal(t.transform('#808080', 'background'), C.toHex(C.parseColor('#808080')));
  assert.notEqual(t.transform('#cc3333', 'foreground'), '#cc3333');
  const a = C.parseColor(t.transform('rgb(204 51 51 / 0.5)', 'foreground'));
  assert.ok(Math.abs(a.a - 0.5) < 0.01, 'alpha stays');
  assert.equal(t.plain('#cc3333', 'foreground'), C.toHex(C.parseColor('#cc3333')));
});

test('with a theme the correction comes after the theme colors', () => {
  const settings = { mode: 'dark', cvdType: 'protan', cvdSeverity: 100 };
  const t = C.createTransformer(C.createTheme(settings));
  const off = C.createTransformer(C.createTheme({ mode: 'dark' }));
  assert.equal(t.plain('#d32f2f', 'foreground'), off.transform('#d32f2f', 'foreground'));
  const themed = C.parseColor(off.transform('#d32f2f', 'foreground'));
  const m = V.matrices('protan', 100);
  const want = V.onSrgb(m.correct, [themed.r, themed.g, themed.b]);
  const got = C.parseColor(t.transform('#d32f2f', 'foreground'));
  [got.r, got.g, got.b].forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 0.004));
  // The theme's page color is a gray with a faint tint, so it moves by at most a step.
  const page = C.parseColor(t.transform('#ffffff', 'background'));
  const was = C.parseColor(off.transform('#ffffff', 'background'));
  for (const k of ['r', 'g', 'b']) assert.ok(Math.abs(page[k] - was[k]) <= 2 / 255, `page ${k}`);
});

test('the feColorMatrix values hold the matrix in four rows of five', () => {
  const values = V.svgValues(V.matrices('tritan', 100).correct).split(' ').map(Number);
  assert.equal(values.length, 20);
  assert.deepEqual(values.slice(15), [0, 0, 0, 1, 0]);
});

test('the settings take the color vision fields and the original mode, and refuse values out of range', () => {
  const ok = sanitizeSection('settings', { ...defaultSettings(), theme: { ...defaultSettings().theme, mode: 'original', cvdType: 'tritan', cvdSeverity: 70, cvdMedia: true, linkUnderline: true } }, { strict: true });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.theme.cvdType, 'tritan');
  for (const bad of [{ cvdType: 'red' }, { cvdSeverity: 101 }, { cvdSeverity: -1 }, { cvdBoost: 101 }, { cvdMedia: 'yes' }]) {
    const r = sanitizeSection('settings', { ...defaultSettings(), theme: { ...defaultSettings().theme, ...bad } }, { strict: true });
    assert.ok(r.errors.length > 0, JSON.stringify(bad));
  }
  const d = defaultSettings().theme;
  assert.deepEqual([d.cvdType, d.cvdSeverity, d.cvdBoost, d.cvdMedia, d.linkUnderline], ['none', 100, 50, true, false]);
  for (const cvdType of ['grayscale', 'grayscaleInverted', 'inverted']) {
    assert.deepEqual(sanitizeSection('settings', { ...defaultSettings(), theme: { ...defaultSettings().theme, cvdType } }, { strict: true }).errors, [], cvdType);
  }
  const auto = sanitizeSection('settings', { ...defaultSettings(), automation: { ...defaultSettings().automation, idleMode: 'original' } }, { strict: true });
  assert.deepEqual(auto.errors, []);
  const rule = sanitizeSection('siteRules', { 'example.test': { enabled: true, theme: { mode: 'original', cvdType: 'protan' } } }, { strict: true });
  assert.deepEqual(rule.errors, [], 'a site rule can set its own correction');
});

test('the plain filters: grayscale makes every color gray with its luminance, the inversions flip it, and the intensity mixes', () => {
  const colors = ['#c62828', '#2e7d32', '#1565c0', '#f9ab00', '#000000', '#ffffff', '#808080'].map(hex);
  const g = V.matrices('grayscale', 100);
  const gi = V.matrices('grayscaleInverted', 100);
  const inv = V.matrices('inverted', 100);
  for (const c of colors) {
    const y = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
    for (const v of V.run(g, c)) assert.ok(Math.abs(v - y) < 1e-6);
    for (const v of V.run(gi, c)) assert.ok(Math.abs(v - (1 - y)) < 1e-6);
    V.run(inv, c).forEach((v, i) => assert.ok(Math.abs(v - (1 - c[i])) < 1e-6));
    const half = V.run(V.matrices('grayscale', 50), c);
    half.forEach((v, i) => assert.ok(Math.abs(v - (c[i] + y) / 2) < 1e-6));
  }
  assert.equal(g.undo, null, 'full grayscale has no inverse');
  // A frame shows root(counter(frame(x))) with the same filter in the frame: full grayscale inverted shows once.
  for (const c of colors) {
    const once = V.run(gi, c);
    const counter = V.apply(gi.undo, V.run(gi, c)).map((v, i) => v + gi.undoOffset[i]);
    V.run(gi, counter).forEach((v, i) => assert.ok(Math.abs(v - once[i]) < 1e-6));
    // Full gray has no counter: gray twice is gray once.
    V.run(g, V.run(g, c)).forEach((v, i) => assert.ok(Math.abs(v - V.run(g, c)[i]) < 1e-6));
  }
  assert.equal(V.matrices('inverted', 50).undo, null, 'an inversion at 50 percent has no inverse');
  assert.equal(g.simulate, null);
  const part = V.matrices('inverted', 30);
  const c = [0.2, 0.5, 0.9];
  const back = V.apply(part.undo, V.run(part, c)).map((v, i) => v + part.undoOffset[i]);
  back.forEach((v, i) => assert.ok(Math.abs(v - c[i]) < 1e-9));
  assert.equal(V.svgValues(inv.correct, inv.offset), '-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0');
});

test('the color boost moves colors less at 0 and more at 100; it does not touch the plain filters', () => {
  // A soft color has room to move; a strong one meets the edge of the gamut early.
  const soft = hex('#c08080');
  const move = (boost) => dist(soft, V.run(V.matrices('deutan', 100, boost), soft));
  assert.ok(move(0) < move(50) && move(50) < move(100), `${move(0)} ${move(50)} ${move(100)}`);
  assert.equal(V.matrices('deutan', 100), V.matrices('deutan', 100, 50), 'a missing boost is 50');
  assert.equal(V.matrices('inverted', 100, 0), V.matrices('inverted', 100, 100));
});

test('the theme carries a plain filter in the original mode only', () => {
  const th = C.createTheme({ mode: 'original', cvdType: 'inverted' });
  assert.ok(th.cvd);
  const out = C.transformColor(th, { r: 1, g: 1, b: 1, a: 1 }, 'background');
  assert.ok(out.r < 1e-6 && out.g < 1e-6 && out.b < 1e-6);
  for (const mode of ['dark', 'light', 'eink']) for (const cvdType of ['grayscale', 'grayscaleInverted', 'inverted']) assert.equal(C.cvdWanted({ mode, cvdType }), false, `${mode} ${cvdType}`);
  assert.equal(C.createTheme({ mode: 'dark', cvdType: 'inverted' }).cvd, null);
  for (const mode of ['dark', 'light', 'eink']) assert.equal(C.cvdWanted({ mode, cvdType: 'deutan' }), true, 'a deficiency works with a theme');
});

test('red weak and green weak get different corrections: protan lifts reds the person sees darker', () => {
  for (const sev of [50, 100]) {
    const p = V.matrices('protan', sev).correct;
    const d = V.matrices('deutan', sev).correct;
    assert.ok(p.some((row, r) => row.some((v, c) => Math.abs(v - d[r][c]) > 0.02)), `protan and deutan differ at ${sev}`);
  }
  const m = V.matrices('protan', 100);
  const y = (v) => LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2];
  const red = [0.4, 0.05, 0.05];
  assert.ok(y(V.apply(m.correct, red)) > y(red), 'a red gets lighter for a normal viewer');
  assert.ok(Math.abs(y(V.apply(m.simulate, V.apply(m.correct, red))) - y(red)) < 1e-9, 'and as light as before for the person');
});

test('above a boost of 50 strong colors move too, and a light color never gets darker nor a dark one lighter', () => {
  const pure = hex('#ff0000');
  for (const kind of ['protan', 'deutan']) {
    assert.ok(dist(V.run(V.matrices(kind, 100, 50), pure), pure) < 1e-6, `${kind}: a pure red has no room at 50`);
    assert.ok(dist(V.run(V.matrices(kind, 100, 100), pure), pure) > 0.1, `${kind}: it moves at 100`);
  }
  const y = (rgb) => { const l = rgb.map(lin); return LUMA[0] * l[0] + LUMA[1] * l[1] + LUMA[2] * l[2]; };
  for (const kind of KINDS) {
    const m50 = V.matrices(kind, 100, 50);
    const m = V.matrices(kind, 100, 100);
    for (let i = 0; i < 6 ** 3; i++) {
      const c = [i % 6, Math.floor(i / 6) % 6, Math.floor(i / 36)].map((v) => v / 5);
      const out = V.run(m, c);
      out.forEach((v) => assert.ok(v >= 0 && v <= 1));
      // Only the free part above 50 is held to the side: the matrix itself may change luminance for protan.
      const base = y(V.run(m50, c)) - y(c);
      if (y(c) >= 0.1842) assert.ok(y(out) - y(c) >= Math.min(0, base) * 1.75 - 1e-6, `${kind} light ${c}`);
      else assert.ok(y(out) - y(c) <= Math.max(0, base) * 1.75 + 1e-6, `${kind} dark ${c}`);
    }
  }
});

test('the off of pictures that the first run of an old version stored gives way to the new default once', () => {
  const r = migrate({ schemaVersion: 1, settings: { enabled: true, theme: { mode: 'original', cvdMedia: false, cvdType: 'protan' } } });
  assert.ok(r.ok);
  assert.equal('cvdMedia' in r.raw.settings.theme, false);
  assert.equal(r.raw.settings.theme.cvdType, 'protan');
  assert.equal(sanitizeSection('settings', r.raw.settings).value.theme.cvdMedia, true);
  // A choice made at the current version stays.
  const now = migrate({ schemaVersion: 2, settings: { theme: { cvdMedia: false } } });
  assert.equal(now.raw.settings.theme.cvdMedia, false);
});
