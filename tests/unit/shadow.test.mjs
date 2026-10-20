import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/einkpalette.js', 'engine/rewrite.js');
const C = dk.color;
const make = (settings) => {
  const theme = C.createTheme(settings);
  return { theme, rw: dk.rewrite.createRewriter(C.createTransformer(theme)) };
};
const dark = make({ mode: 'dark' });
const BASE = 'http://site.test/a.css';
const box = (value, ctx = dark) => ctx.rw.declaration('box-shadow', value, BASE);
// What a shadow color becomes where the shadow rule hands it to the background curve. A faint veil keeps its direction as a background, a shadow does not.
const bg = (hex, ctx = dark) => C.toCss(C.transformColor(ctx.theme, C.parseColor(hex), 'shadow'));

test('a black translucent shadow stays black and its alpha grows by 1.6, at most to 0.8', () => {
  assert.equal(box('0 1px 2px rgba(0,0,0,.1)'), '0 1px 2px rgba(0, 0, 0, 0.16)');
  assert.equal(box('0 1px 2px rgba(0,0,0,.25)'), '0 1px 2px rgba(0, 0, 0, 0.4)');
  assert.equal(box('0 8px 24px rgba(0,0,0,.6)'), '0 8px 24px rgba(0, 0, 0, 0.8)');
  assert.equal(box('0 8px 24px rgba(0,0,0,.9)'), '0 8px 24px rgba(0, 0, 0, 0.9)');
  assert.equal(box('0 1px 2px #000'), '0 1px 2px #000000');
});

test('a gray shadow becomes black, a white one follows the page', () => {
  assert.equal(box('0 2px 6px rgba(80,80,80,.2)'), '0 2px 6px rgba(0, 0, 0, 0.32)');
  assert.equal(box('0 0 0 1px #fff'), `0 0 0 1px ${bg('#fff')}`);
  assert.equal(box('0 0 4px rgba(255,255,255,.5)'), `0 0 4px ${bg('rgba(255,255,255,.5)')}`);
});

test('a colored shadow keeps its hue through the accent rule', () => {
  const out = box('0 0 12px rgba(26,115,232,.5)');
  assert.equal(out, `0 0 12px ${bg('rgba(26,115,232,.5)')}`);
  const c = C.parseColor(out.slice('0 0 12px '.length));
  const [, chroma, hue] = C.toOklch(c);
  assert.ok(chroma > 0.08, String(chroma));
  assert.ok(Math.abs(hue - C.toOklch(C.parseColor('#1a73e8'))[2]) < 15);
});

test('inset and several shadows are handled item by item', () => {
  assert.equal(box('inset 0 1px 0 rgba(255,255,255,.05), 0 1px 3px rgba(0,0,0,.2)'), `inset 0 1px 0 ${bg('rgba(255,255,255,.05)')}, 0 1px 3px rgba(0, 0, 0, 0.32)`);
  assert.equal(box('0 0 0 1px rgb(0 0 0 / 10%), 0 2px 4px rgb(0 0 0 / 0.2)'), '0 0 0 1px rgba(0, 0, 0, 0.16), 0 2px 4px rgba(0, 0, 0, 0.32)');
});

test('hex with alpha, the slash form and hsl are read', () => {
  assert.equal(box('0 1px 2px #00000033'), '0 1px 2px rgba(0, 0, 0, 0.32)');
  assert.equal(box('0 1px 2px rgb(0 0 0 / .3)'), '0 1px 2px rgba(0, 0, 0, 0.48)');
  assert.equal(box('0 1px 2px hsl(0 0% 0% / .5)'), '0 1px 2px rgba(0, 0, 0, 0.8)');
});

test('a variable color reads the shadow variable first, then the background one, then the page value', () => {
  assert.equal(box('0 1px 2px var(--s)'), '0 1px 2px var(--dk-sh--s,var(--dk-bg--s,var(--s)))');
  assert.equal(box('0 1px 2px var(--s, rgba(0,0,0,.2))'), '0 1px 2px var(--dk-sh--s,var(--dk-bg--s,var(--s, rgba(0, 0, 0, 0.32))))');
  assert.equal(dark.rw.customProperty('--shadow-color', 'rgba(0,0,0,.2)', BASE).includes('--dk-sh--shadow-color:rgba(0, 0, 0, 0.32);'), true);
  // The same as the background version is not written twice.
  assert.equal(dark.rw.customProperty('--paper', '#fff', BASE).includes('--dk-sh--paper'), false);
});

test('channel variables: the shadow list is black and the alpha is raised', () => {
  assert.equal(box('0 1px 2px rgba(var(--rgb), .2)'), '0 1px 2px rgba(var(--dk-sh-ch--rgb,var(--dk-bg-ch--rgb,var(--rgb))), 0.32)');
  assert.equal(box('0 1px 2px rgb(var(--rgb) / 10%)'), '0 1px 2px rgb(var(--dk-sh-ch--rgb,var(--dk-bg-ch--rgb,var(--rgb))) / 16%)');
  assert.match(dark.rw.customProperty('--rgb', '0 0 0', BASE), /--dk-sh-ch--rgb:0 0 0;/);
});

test('drop-shadow inside a filter is themed, other filters are left out of the copy', () => {
  assert.equal(dark.rw.declaration('filter', 'drop-shadow(0 2px 4px rgba(0,0,0,.25))', BASE), 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4))');
  assert.equal(dark.rw.declaration('filter', 'blur(2px) drop-shadow(0 1px 1px #0003) brightness(1.1)', BASE), 'blur(2px) drop-shadow(0 1px 1px rgba(0, 0, 0, 0.32)) brightness(1.1)');
  assert.equal(dark.rw.declaration('filter', 'blur(2px)', BASE), null);
  assert.equal(dark.rw.declaration('-webkit-filter', 'grayscale(1)', BASE), null);
  assert.equal(dark.rw.declaration('-webkit-filter', 'drop-shadow(0 0 3px red)', BASE), `drop-shadow(0 0 3px ${bg('red')})`);
});

test('text-shadow follows the same rule', () => {
  assert.equal(dark.rw.declaration('text-shadow', '0 1px 1px rgba(0,0,0,.3)', BASE), '0 1px 1px rgba(0, 0, 0, 0.48)');
});

test('the light mode is unchanged: shadows use the background curve as before', () => {
  const light = make({ mode: 'light' });
  assert.equal(box('0 1px 3px rgba(0,0,0,.25)', light), `0 1px 3px ${bg('rgba(0,0,0,.25)', light)}`);
  assert.equal(box('0 1px 3px rgba(0,0,0,.25)', light).includes('rgba(0, 0, 0, 0.4)'), false);
});

test('Paper and E-ink leave a neutral shadow as the page wrote it, a colored one follows the mode', () => {
  for (const einkPreset of ['paper', 'eink']) {
    const ctx = make({ mode: 'eink', einkPreset });
    assert.equal(box('0 1px 3px rgba(0,0,0,.25)', ctx), '0 1px 3px rgba(0, 0, 0, 0.25)', einkPreset);
    const colored = box('0 0 8px rgba(26,115,232,.5)', ctx);
    assert.notEqual(colored, '0 0 8px rgba(26, 115, 232, 0.5)', einkPreset);
  }
});
