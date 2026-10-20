import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadContent } from '../helpers/content.mjs';
import { REPO } from '../helpers/tree.mjs';

const dk = await loadContent('engine/color.js', 'engine/einkpalette.js', 'engine/keep.js', 'engine/calm.js');
const C = dk.color;
const calm = dk.calm;
const load = (path) => import(pathToFileURL(join(REPO, 'extension', path)).href);
const S = await load('shared/settings.js');
const { L } = await load('shared/limits.js');

const theme = (over = {}) => C.createTheme({ mode: 'eink', ...over });
const px = (css) => C.parseColor(css);
const hue = (css) => C.toOklch(px(css));
const ACCENTS = ['#c0392b', '#2563eb', '#16a34a', '#d97706', '#7c3aed'];

test('the amount of color: presets, and the two old words are read as amounts', () => {
  assert.equal(C.einkSettings({ einkPreset: 'eink' }).einkColorAmount, 0);
  assert.equal(C.einkSettings({ einkPreset: 'paper' }).einkColorAmount, 35);
  assert.equal(C.einkSettings({ einkPreset: 'paper', einkColorAmount: null }).einkColorAmount, 35);
  assert.equal(C.einkSettings({ einkPreset: 'paper', einkColor: 'mono' }).einkColorAmount, 0);
  assert.equal(C.einkSettings({ einkPreset: 'eink', einkColor: 'muted' }).einkColorAmount, 40);
  // The new field wins over the old word.
  assert.equal(C.einkSettings({ einkPreset: 'eink', einkColor: 'muted', einkColorAmount: 80 }).einkColorAmount, 80);
  assert.equal(C.einkSettings({ einkColorAmount: 101 }).einkColorAmount, 35);
  assert.equal(C.einkSettings({ einkColorAmount: 12.5 }).einkColorAmount, 35);
  assert.equal(C.einkSettings({ einkPreset: 'eink' }).einkGrayAll, true);
  assert.equal(C.einkSettings({ einkPreset: 'paper' }).einkGrayAll, false);
  assert.equal(C.einkSettings({ einkPreset: 'paper', einkGrayAll: true }).einkGrayAll, true);
  assert.equal(C.einkSettings({ einkPreset: 'paper' }).einkImages, 'follow');
});

test('the page side and the pages agree on the new fields and their limits', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(C.EINK_PRESETS)), JSON.parse(JSON.stringify(S.EINK_PRESETS)));
  assert.ok(S.EINK_FIELDS.includes('einkColorAmount') && S.EINK_FIELDS.includes('einkGrayAll') && S.EINK_FIELDS.includes('einkColor'));
  assert.deepEqual({ ...L.EINK_COLOR }, { min: 0, max: 100 });
  assert.equal(S.einkValues({ einkPreset: 'paper' }).einkColorAmount, 35);
  assert.equal(S.einkValues({ einkPreset: 'eink', einkColorAmount: 60 }).einkColorAmount, 60);
});

test('more color gives more chroma, and zero gives none', () => {
  for (const role of ['foreground', 'background']) {
    let last = -1;
    for (const amount of [0, 35, 60, 100]) {
      const tr = C.createTransformer(theme({ einkPreset: 'paper', einkColorAmount: amount }));
      // What is left over the tint of the paper and the ink, which a gray of the page gets as well.
      const tint = hue(tr.transform('#808080', role))[1];
      const chroma = ACCENTS.map((c) => hue(tr.transform(c, role))[1]).reduce((a, b) => a + b, 0) / ACCENTS.length - tint;
      if (amount === 0) assert.ok(Math.abs(chroma) < 0.004, `${role} at 0: ${chroma}`);
      assert.ok(chroma >= last - 0.005, `${role}: ${amount} gave ${chroma}, less than ${last}`);
      last = chroma;
    }
  }
});

test('two accent colors stay apart at 10, 35 and 60 percent', () => {
  for (const amount of [10, 35, 60]) {
    for (const role of ['foreground', 'background']) {
      const tr = C.createTransformer(theme({ einkPreset: 'paper', einkColorAmount: amount }));
      const outs = ACCENTS.map((c) => hue(tr.transform(c, role)));
      for (let i = 0; i < outs.length; i++) {
        assert.ok(outs[i][1] >= 0.005, `${role} ${ACCENTS[i]} at ${amount}: chroma ${outs[i][1].toFixed(3)}`);
        for (let j = i + 1; j < outs.length; j++) {
          const d = Math.abs(((outs[i][2] - outs[j][2] + 540) % 360) - 180);
          assert.ok(d >= 20, `${role} ${ACCENTS[i]} and ${ACCENTS[j]} at ${amount}: ${d.toFixed(0)} degrees`);
        }
      }
    }
  }
});

test('the contrast floors hold at every amount, in both presets', () => {
  for (const einkPreset of ['eink', 'paper']) {
    const floor = einkPreset === 'eink' ? 7 : 4.5;
    for (const amount of [0, 10, 35, 60, 100]) {
      for (const einkGrayAll of [false, true]) {
        const tr = C.createTransformer(theme({ einkPreset, einkColorAmount: amount, einkGrayAll }));
        for (const bg of ['#ffffff', '#f2f2f2', '#0a3a8a', '#ffd966', '#202020', '#c0392b']) {
          for (const fg of ['#767676', '#2563eb', '#c0392b', '#16a34a', '#000000']) {
            const pair = tr.pair(fg, bg);
            assert.ok(C.contrastRatio(px(pair.fg), px(pair.bg)) >= floor - 0.02, `${einkPreset} ${amount} ${einkGrayAll} ${fg} on ${bg}`);
          }
        }
      }
    }
  }
});

test('with the root filter on, the palette keeps the full color and the filter takes it down', () => {
  const full = C.createTransformer(theme({ einkPreset: 'paper', einkColorAmount: 100, einkGrayAll: false }));
  const viaFilter = C.createTransformer(theme({ einkPreset: 'paper', einkColorAmount: 35, einkGrayAll: true }));
  for (const c of ACCENTS) assert.equal(viaFilter.transform(c, 'foreground'), full.transform(c, 'foreground'));
  const zero = C.createTransformer(theme({ einkPreset: 'paper', einkColorAmount: 0, einkGrayAll: true }));
  const tint = hue(zero.transform('#808080', 'foreground'))[1];
  for (const c of ACCENTS) assert.ok(Math.abs(hue(zero.transform(c, 'foreground'))[1] - tint) < 0.004);
});

test('the root filter: gray at 0, a saturation step between, nothing at 100, nothing when off or under a Filter engine', () => {
  const rule = (over, options) => calm.build({ mode: 'eink', ...over }, options);
  assert.match(rule({ einkPreset: 'eink' }), /html\{filter:grayscale\(1\)!important\}/);
  assert.match(rule({ einkPreset: 'eink', einkColorAmount: 35 }), /html\{filter:saturate\(0\.35\)!important\}/);
  assert.doesNotMatch(rule({ einkPreset: 'eink', einkColorAmount: 100 }), /html\{filter/);
  assert.doesNotMatch(rule({ einkPreset: 'paper' }), /html\{filter/);
  assert.match(rule({ einkPreset: 'paper', einkGrayAll: true }), /html\{filter:saturate\(0\.35\)!important\}/);
  assert.doesNotMatch(rule({ einkPreset: 'eink' }, { rootFilter: false }), /html\{filter/);
  assert.doesNotMatch(rule({ einkPreset: 'eink', einkGrayAll: false }), /html\{filter/);
  // The contrast of a picture is set on the picture only; the root filter holds no contrast.
  assert.doesNotMatch(rule({ einkPreset: 'eink', einkImageContrast: 150 }).match(/html\{filter[^}]*\}/)[0], /contrast/);
});

test('pictures follow the amount, or are forced gray, and a root filter is not applied twice', () => {
  const e = (over) => C.einkSettings({ mode: 'eink', ...over });
  assert.equal(calm.pictureFilter(e({ einkPreset: 'eink', einkImages: 'gray' })), 'grayscale(1) contrast(1.2)');
  // Follow, with no root filter: the saturation of the amount and the soft dim.
  assert.equal(calm.pictureFilter(e({ einkPreset: 'paper', einkGrayAll: false })), 'saturate(0.35) brightness(0.88)');
  // Follow, with the root filter on: the saturation comes from the root, the picture keeps only the dim.
  assert.equal(calm.pictureFilter(e({ einkPreset: 'paper', einkGrayAll: true })), 'brightness(0.88)');
  assert.equal(calm.pictureFilter(e({ einkPreset: 'paper', einkImages: 'dim', einkGrayAll: true })), 'grayscale(1) brightness(0.88)');
  assert.equal(calm.pictureFilter(e({ einkPreset: 'paper', einkImages: 'off' })), '');
  assert.equal(calm.pictureFilter(e({ einkPreset: 'paper', einkColorAmount: 100, einkGrayAll: false })), 'brightness(0.88)');
});

test('settings: the new fields, the old word and the new picture choice are valid and survive an export', () => {
  const s = S.defaultSettings();
  s.theme.mode = 'eink';
  Object.assign(s.theme, { einkColorAmount: 35, einkGrayAll: true, einkImages: 'follow', einkColor: 'muted' });
  const r = S.sanitizeSection('settings', s, { strict: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.theme.einkColorAmount, 35);
  assert.equal(r.value.theme.einkGrayAll, true);
  assert.equal(r.value.theme.einkImages, 'follow');
  for (const bad of [{ einkColorAmount: 101 }, { einkColorAmount: -1 }, { einkColorAmount: 1.5 }, { einkColorAmount: '35' }, { einkGrayAll: 'yes' }, { einkImages: 'sepia' }]) {
    const copy = structuredClone(s);
    Object.assign(copy.theme, bad);
    assert.ok(S.sanitizeSection('settings', copy, { strict: true }).errors.length > 0, JSON.stringify(bad));
  }
  const state = S.defaultState();
  Object.assign(state.settings.theme, { einkColorAmount: 60, einkGrayAll: false });
  const imported = S.parseImport(S.serializeExport(state, 0));
  assert.equal(imported.ok, true);
  assert.equal(imported.state.settings.theme.einkColorAmount, 60);
  assert.equal(imported.state.settings.theme.einkGrayAll, false);
  // Data from before the fields: they are null, and an old word still counts.
  const old = S.defaultState();
  old.settings.theme.einkColor = 'muted';
  delete old.settings.theme.einkColorAmount;
  delete old.settings.theme.einkGrayAll;
  const text = JSON.parse(S.serializeExport(old, 0));
  delete text.settings.theme.einkColorAmount;
  delete text.settings.theme.einkGrayAll;
  const back = S.parseImport(JSON.stringify(text));
  assert.equal(back.ok, true, JSON.stringify(back.errors));
  assert.equal(back.state.settings.theme.einkColorAmount, null);
  assert.equal(C.einkSettings(back.state.settings.theme).einkColorAmount, 40);
});
