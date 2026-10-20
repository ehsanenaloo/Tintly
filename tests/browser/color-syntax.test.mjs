// The color parser agrees with Chromium: what the browser ignores is not a color here, huge numbers give no NaN,
// and color-mix gives the browser's color in every interpolation space.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchPlain } from './harness.mjs';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/einkpalette.js');
const C = dk.color;
let plain;
let page;
before(async () => {
  plain = await launchPlain();
  page = await plain.context.newPage();
  await page.goto('about:blank');
});
after(async () => {
  await plain?.close();
});

/** For each text: whether the browser takes it as a color, and the 8-bit sRGB pixel and alpha it paints. */
const ask = (list) =>
  page.evaluate(
    (texts) =>
      texts.map((s) => {
        if (!CSS.supports('color', s)) return { s, ok: false };
        const ctx = document.createElement('canvas').getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
        ctx.fillStyle = '#010203';
        ctx.fillStyle = s;
        ctx.globalCompositeOperation = 'copy';
        ctx.fillRect(0, 0, 1, 1);
        return { s, ok: true, px: [...ctx.getImageData(0, 0, 1, 1).data] };
      }),
    list,
  );

const MIXES = [];
for (const space of ['srgb', 'srgb-linear', 'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020', 'lab', 'lch', 'oklab', 'oklch', 'hsl', 'hwb', 'xyz', 'xyz-d50']) {
  for (const [a, b] of [['white', 'red'], ['#808080', '#3b82f6'], ['#ccc', '#ff0'], ['#333', 'red'], ['#f5f5f5', '#0a7'], ['black', 'white'], ['#fff', '#ccc'], ['#3b82f6', '#f5f5f5']]) {
    MIXES.push(`color-mix(in ${space}, ${a}, ${b})`, `color-mix(in ${space}, ${a} 20%, ${b})`);
  }
}

const SYNTAX = [
  'rgb(10,20,30)', 'rgb(10 20 30)', 'rgb(10 20 30 / 50%)', 'rgba(10,20,30,.5)', 'rgb(10,20,30,50%)', 'rgb(10% 20% 30%)', 'rgb(10 20% 30)', 'rgb(300 0 0)', 'rgb(-5 0 0)', 'rgb(1.5 2.5 3.5)',
  'hsl(120 50% 50%)', 'hsl(120deg,50%,50%)', 'hsl(120 50 50)', 'hsl(.5turn 50% 50%)', 'hsl(2rad 50% 50%)', 'hsl(100grad 50% 50%)', 'hsl(120 150% 50%)', 'hsla(120,50%,50%,.5)', 'hsl(120 50% 50%/50%)',
  'hwb(120 20% 30%)', 'hwb(120 60% 60%)', 'lab(50% 40 30)', 'lch(50% 40 30)', 'oklab(0.5 0.1 0.1)', 'oklch(50% 0.2 30)', 'oklch(none 0.2 30)', 'oklch(0.5 none none)',
  'color(srgb 1 0 0)', 'color(srgb 1 0 0 / .5)', 'color(display-p3 1 0 0)', 'color(a98-rgb 0.5 0.5 0.5)', 'color(prophoto-rgb 0.5 0.5 0.5)', 'color(rec2020 0.5 0.5 0.5)', 'color(xyz 0.2 0.3 0.4)', 'color(xyz-d50 0.2 0.3 0.4)', 'color(srgb-linear 0.5 0.5 0.5)',
  '#abc', '#abcd', '#aabbcc', '#aabbccdd', 'RED', 'rebeccapurple', 'rgb(1e2 0 0)', 'rgb(+10 0 0)', 'rgb(10.0 0 0)', 'rgb( 10 , 20 , 30 )',
];
// What a browser ignores.
const INVALID = [
  'rgb(10 20 30 0.5)', 'rgb(10, 20, 30 / 0.5)', 'rgb(10 20 30 40)', 'rgb(10,20,30,)', 'rgb(10 20)', 'rgb(10, 20)', 'rgb(10,20,30,40,50)', 'rgb(10, 20 30)', 'rgb(10,20%,30)', 'rgb(10 20 30 /)', 'rgb(10 20 30 / 0.5 0.5)',
  'hsl(120 50% 50% 0.5)', 'hsl(120,50,50)', 'hsl(120, 50%, 50)', 'hsl(120 50% 50% / 0.5 0.5)', 'hwb(120, 20%, 30%)', 'lab(50, 40, 30)', 'lch(50 40 30 0.5)', 'oklch(0.5, 0.2, 30)', 'color(srgb 1 0 0 0.5)', 'color(srgb 1, 0, 0)', 'color(srgb 1 0)',
  'rgb(none, 0, 0)', 'rgba(10 20 30 40)', 'hsla(120 50% 50% 0.5)', 'rgb(10 20 30,)', '#abcde', '#ab', 'rgb(a b c)', 'rgb(1px 2px 3px)',
];
// Where the browser's answer is defined by the standard, the parser gives it too.
const HUGE = [
  'rgb(1e308 0 0)', 'rgb(-1e308 0 0)', 'rgb(1e999 0 0)', 'rgb(1e308, 1e308, 1e308)', 'rgb(1e308% 0% 0%)', 'hsl(120 1e308% 50%)', 'hwb(120 1e308% 1e308%)',
  'lab(50 1e308 1e308)', 'lab(1e308 0 0)', 'lch(50 1e308 30)', 'oklch(1e308 0.1 30)', 'color(srgb 1e308 0 0)', 'color(srgb-linear 1e308 0 0)',
  'rgb(10 20 30 / 1e308)', 'rgb(10 20 30 / 1e999)', 'color-mix(in srgb, rgb(1e308 0 0), blue)',
];
// Where it is not (a hue of a size nobody writes, a color far outside every gamut): a color or none, and no NaN.
const ABSURD = [
  'hsl(1e308 50% 50%)', 'hwb(1e308 10% 10%)', 'lch(50 50 1e308)', 'oklab(0.5 1e308 1e308)', 'oklch(0.5 1e308 30)', 'color(display-p3 1e308 1e308 1e308)', 'color(xyz 1e308 0 0)',
  'color-mix(in oklch, red, oklch(0.5 1e308 30))', 'color-mix(in lch, lab(50 1e308 0), blue)', 'color-mix(in hsl, hsl(1e308 50% 50%), blue)', 'color-mix(in srgb, red 1e308%, blue)',
];

const close = (got, px) => {
  const a = px[3] / 255;
  if (Math.abs(Math.round(got.a * 255) - px[3]) > 1) return false;
  if (a === 0) return true;
  const tolerance = a < 1 ? 3 : 3;
  const have = [got.r, got.g, got.b].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
  return have.every((v, i) => Math.abs(v - px[i]) <= tolerance);
};

test('what the browser ignores is not a color, and what it takes gives its color', async () => {
  const answers = await ask([...SYNTAX, ...INVALID]);
  const problems = [];
  for (const t of answers) {
    const ours = C.parseColor(t.s);
    if (!t.ok) {
      if (ours) problems.push(`${t.s}: the browser ignores it, the parser reads it`);
      continue;
    }
    if (!ours) problems.push(`${t.s}: the browser takes it, the parser does not`);
    else if (!close(ours, t.px)) problems.push(`${t.s}: ours ${JSON.stringify(ours)}, browser ${t.px}`);
  }
  assert.deepEqual(problems, []);
  // The list of invalid forms is invalid for the browser too (the test would prove nothing otherwise).
  for (const t of answers.slice(SYNTAX.length)) assert.equal(t.ok, false, `${t.s} is valid in this browser`);
});

test('huge numbers give a color or none, never NaN, and the browser takes the same ones', async () => {
  const answers = await ask([...HUGE, ...ABSURD]);
  const th = C.createTheme({ mode: 'dark' });
  const problems = [];
  for (const t of answers) {
    const ours = C.parseColor(t.s);
    if (ours === null) continue;
    for (const k of ['r', 'g', 'b', 'a']) if (!Number.isFinite(ours[k])) problems.push(`${t.s}: ${k} is ${ours[k]}`);
    for (const role of ['background', 'foreground', 'border']) {
      const out = C.toCss(C.transformColor(th, ours, role));
      if (/NaN|Infinity/.test(out)) problems.push(`${t.s} ${role}: ${out}`);
    }
    if (!HUGE.includes(t.s)) continue;
    if (!t.ok) problems.push(`${t.s}: the browser ignores it, the parser reads it`);
    else if (!close(ours, t.px)) problems.push(`${t.s}: ours ${JSON.stringify(ours)}, browser ${t.px}`);
  }
  assert.deepEqual(problems, []);
  assert.equal(C.toHex({ r: NaN, g: Infinity, b: -Infinity, a: NaN }).includes('NaN'), false);
  assert.equal(C.toCss({ r: NaN, g: 0, b: 0, a: 0.5 }).includes('NaN'), false);
});

test('color-mix gives the color of the browser in every interpolation space, also with gray operands', async () => {
  const answers = await ask(MIXES);
  const problems = [];
  for (const t of answers) {
    const ours = C.parseColor(t.s);
    if (!t.ok) {
      if (ours) problems.push(`${t.s}: the browser ignores it`);
      continue;
    }
    if (!ours) problems.push(`${t.s}: the parser does not read it`);
    else if (!close(ours, t.px)) problems.push(`${t.s}: ours ${[ours.r, ours.g, ours.b].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255))}, browser ${t.px.slice(0, 3)}`);
  }
  assert.deepEqual(problems, []);
});
