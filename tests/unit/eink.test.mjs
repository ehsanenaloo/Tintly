import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadContent } from '../helpers/content.mjs';
import { REPO } from '../helpers/tree.mjs';

const dk = await loadContent('engine/color.js', 'engine/einkpalette.js', 'engine/keep.js', 'engine/calm.js', 'engine/filter.js');
const C = dk.color;
const load = (path) => import(pathToFileURL(join(REPO, 'extension', path)).href);
const S = await load('shared/settings.js');
const early = await load('background/modules/early.js');

/** A grid of page colors: grays, and every hue at several lightness and saturation steps. */
function colorGrid() {
  const out = [];
  for (let v = 0; v <= 255; v += 17) out.push(`rgb(${v},${v},${v})`);
  for (let h = 0; h < 360; h += 30) {
    for (const s of [30, 70, 100]) {
      for (const l of [12, 30, 50, 70, 90]) out.push(`hsl(${h} ${s}% ${l}%)`);
    }
  }
  return out;
}
const GRID = colorGrid();

const theme = (over = {}) => C.createTheme({ mode: 'eink', ...over });
const lum = (c) => {
  const f = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const px = (css) => C.parseColor(css);

const SETTINGS = [];
for (const einkPreset of ['eink', 'paper']) {
  for (const einkLevels of [0, 2, 4, 8, 16]) {
    for (const einkContrast of [50, 100, 200]) {
      for (const [whiteCap, einkBlue] of [[100, 0], [70, 100], [88, 30]]) {
        for (const einkColor of ['mono', 'muted']) SETTINGS.push({ einkPreset, einkLevels, einkContrast, whiteCap, einkBlue, einkColor });
      }
    }
  }
}

test('the presets of the page side and of the pages are the same table', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(C.EINK_PRESETS)), JSON.parse(JSON.stringify(S.EINK_PRESETS)));
  // And the fields the pages list are the fields the page side reads.
  assert.deepEqual([...S.EINK_FIELDS].sort(), Object.keys(S.EINK_PRESETS.paper).sort());
  assert.deepEqual(Object.keys(S.EINK_PRESETS.eink).sort(), Object.keys(S.EINK_PRESETS.paper).sort());
});

test('a theme with no mode fields takes the values of the preset, and null does too', () => {
  const paper = C.einkSettings({ mode: 'eink' });
  assert.equal(paper.preset, 'paper');
  assert.equal(paper.paperColor, '#f4f1ea');
  assert.equal(paper.inkColor, '#2b2620');
  const eink = C.einkSettings({ mode: 'eink', einkPreset: 'eink', paperColor: null, whiteCap: null });
  assert.equal(eink.preset, 'eink');
  assert.equal(eink.paperColor, '#ffffff');
  assert.equal(eink.whiteCap, 100);
  // A set value wins, a bad one falls back to the preset.
  assert.equal(C.einkSettings({ einkPreset: 'eink', einkBlue: 40 }).einkBlue, 40);
  assert.equal(C.einkSettings({ einkPreset: 'eink', einkBlue: 400 }).einkBlue, 0);
  assert.equal(C.einkSettings({ einkPreset: 'eink', einkLevels: 5 }).einkLevels, 8);
  assert.deepEqual(S.einkValues({ einkPreset: 'paper', einkBlue: null, whiteCap: 70 }).whiteCap, 70);
  assert.equal(S.einkValues({ einkPreset: 'paper', einkBlue: null }).einkBlue, S.EINK_PRESETS.paper.einkBlue);
});

test('E-ink text keeps 7 to 1 and Paper text 4.5 to 1 on the page and on a light box, over a grid of colors and settings', () => {
  let checked = 0;
  for (const s of SETTINGS) {
    const th = theme(s);
    const tr = C.createTransformer(th);
    const { page, card } = C.surfaceColors(th);
    const floor = s.einkPreset === 'eink' ? 7 : 4.5;
    for (const c of GRID) {
      const out = px(tr.transform(c, 'foreground'));
      assert.ok(C.contrastRatio(out, page) >= floor - 0.02, `${JSON.stringify(s)} ${c} on the page: ${C.contrastRatio(out, page).toFixed(2)}`);
      assert.ok(C.contrastRatio(out, card) >= floor - 0.02, `${JSON.stringify(s)} ${c} on a box: ${C.contrastRatio(out, card).toFixed(2)}`);
      checked += 1;
    }
  }
  assert.ok(checked > 10000);
});

test('borders keep 3 to 1 in E-ink and controls keep 3 to 1 in both presets', () => {
  for (const s of SETTINGS) {
    const th = theme(s);
    const tr = C.createTransformer(th);
    const { page, card } = C.surfaceColors(th);
    for (const c of GRID) {
      const edge = px(tr.transform(c, 'edge'));
      assert.ok(C.contrastRatio(edge, page) >= 3 - 0.02, `${JSON.stringify(s)} edge ${c}: ${C.contrastRatio(edge, page).toFixed(2)}`);
      assert.ok(C.contrastRatio(edge, card) >= 3 - 0.02, `${JSON.stringify(s)} edge ${c} on a box`);
      const border = px(tr.transform(c, 'border'));
      const floor = s.einkPreset === 'eink' ? 3 : 1.6;
      assert.ok(C.contrastRatio(border, page) >= floor - 0.02, `${JSON.stringify(s)} border ${c}: ${C.contrastRatio(border, page).toFixed(2)}`);
    }
  }
});

test('gray levels: the colors of the E-ink preset fall on N steps between ink and paper', () => {
  for (const levels of [2, 4, 8, 16]) {
    const th = theme({ einkPreset: 'eink', einkLevels: levels, einkColor: 'mono' });
    const tr = C.createTransformer(th);
    const steps = new Set();
    for (const role of ['background', 'foreground', 'border', 'edge']) {
      for (const c of GRID) {
        const out = px(tr.transform(c, role));
        // Gray, and one of the steps (in OKLab lightness between black and white).
        assert.ok(Math.abs(out.r - out.g) < 0.004 && Math.abs(out.g - out.b) < 0.004, `${role} ${c} is not gray`);
        const L = C.toOklch(out)[0];
        const k = Math.round(L * (levels - 1));
        assert.ok(Math.abs(L - k / (levels - 1)) < 0.004, `${levels} levels: ${role} ${c} has lightness ${L}`);
        steps.add(k);
      }
    }
    assert.ok(steps.size <= levels);
    assert.ok(steps.has(0) && steps.has(levels - 1), `${levels} levels use both ends`);
  }
});

test('with levels off the colors are not rounded', () => {
  const th = theme({ einkPreset: 'eink', einkLevels: 0 });
  const tr = C.createTransformer(th);
  const ls = new Set(['#ddd', '#cfcfcf', '#bbb', '#a4a4a4', '#888', '#6a6a6a'].map((c) => px(tr.transform(c, 'border')).r.toFixed(3)));
  assert.ok(ls.size >= 4);
});

test('the white cap holds: no color is brighter than the cap, whatever the paper', () => {
  for (const paperColor of ['#ffffff', '#f4f1ea', '#fff4c8', '#e0e0e0']) {
    for (const whiteCap of [50, 60, 75, 88, 100]) {
      for (const einkBlue of [0, 40, 100]) {
        const th = theme({ einkPreset: 'paper', paperColor, whiteCap, einkBlue });
        const tr = C.createTransformer(th);
        const { page } = C.pageColors(th);
        assert.ok(lum(px(page)) <= whiteCap / 100 + 0.004, `${paperColor} cap ${whiteCap} blue ${einkBlue}: page luminance ${lum(px(page)).toFixed(3)}`);
        for (const role of ['background', 'foreground', 'border']) {
          for (const c of GRID.filter((_, i) => i % 7 === 0)) {
            const out = px(tr.transform(c, role));
            assert.ok(lum(out) <= whiteCap / 100 + 0.004, `${role} ${c}: ${lum(out).toFixed(3)} over the cap ${whiteCap}`);
          }
        }
      }
    }
  }
});

test('less blue takes blue out of the paper and leaves red alone', () => {
  const base = px(C.pageColors(theme({ einkPreset: 'paper', einkBlue: 0, whiteCap: 100 })).page);
  const low = px(C.pageColors(theme({ einkPreset: 'paper', einkBlue: 100, whiteCap: 100 })).page);
  assert.ok(low.b < base.b * 0.8);
  assert.ok(low.g < base.g);
  assert.equal(low.r.toFixed(3), base.r.toFixed(3));
});

test('the page color, ink color and edge are what the base style and the first paint use', () => {
  const e = C.pageColors(theme({ einkPreset: 'eink' }));
  assert.equal(e.page, '#ffffff');
  assert.equal(e.text, '#000000');
  const p = C.pageColors(theme({ einkPreset: 'paper', einkBlue: 0, whiteCap: 100 }));
  assert.equal(p.page, '#f4f1ea');
  assert.equal(p.text, '#2b2620');
  // Dark and light keep their old values.
  const dark = C.pageColors(C.createTheme({ mode: 'dark' }));
  assert.equal(dark.page, '#16181d');
  assert.equal(dark.text, '#e6e8eb');
});

test('muted color keeps two accent colors apart, mono takes the color out', () => {
  const hue = (css) => C.toOklch(px(css));
  const accents = ['#c0392b', '#2563eb', '#16a34a', '#d97706', '#7c3aed'];
  for (const role of ['foreground', 'background']) {
    const th = theme({ einkPreset: 'paper', einkColor: 'muted' });
    const tr = C.createTransformer(th);
    const outs = accents.map((c) => hue(tr.transform(c, role)));
    for (let i = 0; i < outs.length; i++) {
      assert.ok(outs[i][1] >= 0.02, `${role} ${accents[i]} lost its color (chroma ${outs[i][1].toFixed(3)})`);
      for (let j = i + 1; j < outs.length; j++) {
        const d = Math.abs(((outs[i][2] - outs[j][2] + 540) % 360) - 180);
        assert.ok(d >= 20, `${role} ${accents[i]} and ${accents[j]} are ${d.toFixed(0)} degrees apart`);
      }
    }
    const mono = C.createTransformer(theme({ einkPreset: 'eink', einkColor: 'mono' }));
    for (const c of accents) assert.ok(hue(mono.transform(c, role))[1] < 0.004, `${role} ${c} in mono`);
  }
});

test('the paper tone reaches backgrounds and the ink tone reaches text', () => {
  const th = theme({ einkPreset: 'paper', einkBlue: 0, whiteCap: 100 });
  const tr = C.createTransformer(th);
  assert.equal(tr.transform('#ffffff', 'background'), '#f4f1ea');
  assert.equal(tr.transform('#000000', 'foreground'), '#2b2620');
  assert.equal(tr.transform('#ffffff', 'foreground'), '#2b2620');
  // A transparent color stays transparent, and an alpha is kept.
  assert.ok(tr.transform('rgba(255,255,255,0)', 'background').endsWith(', 0)'));
  assert.match(tr.transform('rgba(0,0,0,0.5)', 'background'), /^rgba\(\d+, \d+, \d+, 0\.5\)$/);
});

test('pair() keeps the contrast floor of the preset', () => {
  for (const einkPreset of ['eink', 'paper']) {
    const tr = C.createTransformer(theme({ einkPreset }));
    const floor = einkPreset === 'eink' ? 7 : 4.5;
    for (const bg of ['#ffffff', '#f2f2f2', '#0a3a8a', '#ffd966', '#202020']) {
      const pair = tr.pair('#767676', bg);
      assert.ok(C.contrastRatio(px(pair.fg), px(pair.bg)) >= floor - 0.02, `${einkPreset} ${bg}`);
    }
  }
});

test('a bad paper or ink color cannot break the contrast: the ink stays darker than the paper', () => {
  const th = theme({ einkPreset: 'eink', paperColor: '#202020', inkColor: '#f0f0f0' });
  const tr = C.createTransformer(th);
  const { page } = C.surfaceColors(th);
  assert.ok(C.contrastRatio(px(tr.transform('#000', 'foreground')), page) >= 7);
});

test('the dark and light themes are not changed by the mode', () => {
  const d = C.createTransformer(C.createTheme({ mode: 'dark' }));
  const l = C.createTransformer(C.createTheme({ mode: 'light' }));
  assert.equal(d.transform('#ffffff', 'background'), '#16181d');
  assert.equal(l.transform('#000000', 'background').length, 7);
  assert.equal(C.createTheme({ mode: 'dark' }).eink, null);
  assert.equal(C.createTheme({ mode: 'eink' }).dark, false);
});

/* ---------- the extra rules ---------- */

test('calm.build writes the motion, link, border, font, weight and picture rules the settings ask for', () => {
  const eink = dk.calm.build({ mode: 'eink', einkPreset: 'eink' });
  for (const part of ['animation-duration:.01ms', 'scroll-behavior:auto', 'box-shadow:none', 'text-shadow:none', 'text-decoration:underline', 'border-width:2px', 'outline-width:3px', 'grayscale(1)', 'contrast(1.2)']) {
    assert.ok(eink.includes(part), `E-ink rules lack ${part}`);
  }
  assert.ok(!eink.includes('brightness'), 'E-ink pictures are not dimmed');
  // A duration on every element makes every style change start a transition; transitions are ended by an event handler.
  assert.ok(!eink.includes('transition'), 'no universal transition rule');
  const paper = dk.calm.build({ mode: 'eink', einkPreset: 'paper' });
  assert.ok(!paper.includes('animation'), 'Paper keeps animations');
  assert.ok(!paper.includes('box-shadow'));
  assert.ok(paper.includes('text-decoration:underline'));
  assert.ok(paper.includes('brightness(0.88)'), 'Paper pictures are dimmed');
  assert.ok(!paper.includes('border-width'));
  // Every switch can be set apart from the style.
  const custom = dk.calm.build({ mode: 'eink', einkPreset: 'paper', noAnimation: true, einkLinks: false, einkImages: 'off', einkWeight: 2, einkFont: 'serif' });
  assert.ok(custom.includes('animation-duration'));
  assert.ok(!custom.includes('text-decoration'));
  assert.ok(!custom.includes('grayscale'));
  assert.ok(custom.includes('-webkit-text-stroke-width:0.24px'));
  assert.ok(custom.includes('font-family:Georgia'));
  // With everything off there is nothing to write.
  assert.equal(
    dk.calm.build({ einkPreset: 'paper', einkLinks: false, einkImages: 'off' }),
    '',
  );
});

test('a custom font name is quoted, and cannot close the rule', () => {
  assert.equal(dk.calm.fontStack('keep'), null);
  assert.equal(dk.calm.fontStack('Vazirmatn'), '"Vazirmatn"');
  assert.equal(dk.calm.fontStack('Noto Serif, serif'), '"Noto Serif",serif');
  assert.equal(dk.calm.fontStack('a"b'), '"ab"');
  assert.equal(dk.calm.fontStack(`"'`), null);
  const css = dk.calm.build({ mode: 'eink', einkFont: `X"},body{display:none` });
  assert.ok(!css.includes('display:none{') && !css.includes('"},body'));
});

/* ---------- the Filter engines ---------- */

test('the Filter matrix of the mode maps white to the paper and black to the ink, and has no invert', () => {
  const M = dk.filter.matrix;
  const eink = M.themeMatrix({ mode: 'eink', einkPreset: 'eink', einkImages: 'gray' });
  assert.equal(eink.dark, false);
  const white = M.apply(eink.matrix, [1, 1, 1]);
  const black = M.apply(eink.matrix, [0, 0, 0]);
  assert.ok(white.every((v) => Math.abs(v - 1) < 1e-6), String(white));
  assert.ok(black.every((v) => Math.abs(v) < 1e-6), String(black));
  // Mono makes every color gray; pictures that stay as they are need a matrix with an inverse.
  const red = M.apply(eink.matrix, [1, 0, 0]);
  assert.ok(Math.abs(red[0] - red[1]) < 1e-6 && Math.abs(red[1] - red[2]) < 1e-6);
  assert.equal(eink.counter, null);
  assert.notEqual(M.themeMatrix({ mode: 'eink', einkPreset: 'eink', einkImages: 'off' }).counter, null);
  const paper = M.themeMatrix({ mode: 'eink', einkPreset: 'paper', einkBlue: 0, whiteCap: 100 });
  const p = M.apply(paper.matrix, [1, 1, 1]);
  const want = C.parseColor('#f4f1ea');
  assert.ok(Math.abs(p[0] - want.r) < 1e-3 && Math.abs(p[2] - want.b) < 1e-3, String(p));
  assert.ok(paper.counter, 'muted color keeps an inverse');
  // A lighter color is lighter after the matrix: it is no inversion.
  assert.ok(M.apply(paper.matrix, [0.9, 0.9, 0.9])[0] > M.apply(paper.matrix, [0.2, 0.2, 0.2])[0]);
});

/* ---------- the first paint ---------- */

test('the first-paint plan: nothing for E-ink and Paper (a registered rule for every element slows the page), the quick dark version for Dark with other modes excluded', () => {
  const base = { enabled: true, listMode: 'allExcept', holdPaint: true, automation: { mode: 'none' } };
  assert.equal(early.planFor({ ...base, theme: { mode: 'eink', einkPreset: 'paper' } }, {}), null);
  assert.equal(early.planFor({ ...base, theme: { mode: 'eink', einkPreset: 'eink' } }, {}), null);
  assert.equal(early.planFor({ ...base, theme: { mode: 'eink', einkPreset: 'paper', noTransition: true } }, {}), null);
  // A site with its own mode is left out, so it gets no first paint of the wrong kind.
  const dark = early.planFor({ ...base, theme: { mode: 'dark' } }, { 'x.test': { theme: { mode: 'eink' } } });
  assert.deepEqual(dark.js, ['content/early/hold.js', 'content/early/sheet.js']);
  assert.ok(dark.excludeMatches.some((m) => m.includes('x.test')));
  assert.ok(dark.respect, 'the marker style for pages that keep one scheme is part of the plan');
});
