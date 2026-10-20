import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';
import { DARK_PALETTES, LIGHT_PALETTES, CUSTOM, paletteIdFor, paletteFields, paletteLabels, palettesFor } from '../../extension/shared/palettes.js';
import * as S from '../../extension/shared/settings.js';
import { L } from '../../extension/shared/limits.js';

const dk = await loadContent('engine/color.js');
const C = dk.color;
const rgb = (hex) => C.parseColor(hex);
const ratio = (a, b) => C.contrastRatio(rgb(a), rgb(b));
const strict = (name, input) => S.sanitizeSection(name, input, { strict: true });

test('the lists hold the planned names', () => {
  assert.deepEqual(DARK_PALETTES.map((p) => p.id), ['Default', 'Graphite', 'AMOLED', 'Midnight', 'Solarized', 'Nord', 'Gruvbox']);
  assert.deepEqual(LIGHT_PALETTES.map((p) => p.id), ['Default', 'WarmPaper', 'CoolGray', 'HighContrast']);
  for (const p of [...DARK_PALETTES, ...LIGHT_PALETTES]) assert.ok(p.id.length <= L.NAME_CHARS && /^[A-Za-z]+$/.test(p.id));
});

test('the default palettes are the default theme', () => {
  const t = S.defaultTheme();
  assert.deepEqual([DARK_PALETTES[0].background, DARK_PALETTES[0].text], [t.darkBackground, t.darkText]);
  assert.deepEqual([LIGHT_PALETTES[0].background, LIGHT_PALETTES[0].text], [t.lightBackground, t.lightText]);
});

test('text reads on its background in every palette (7 to 1 for the defaults, 4.5 to 1 for the rest)', () => {
  for (const kind of ['dark', 'light']) {
    for (const p of palettesFor(kind)) {
      const r = ratio(p.text, p.background);
      assert.ok(r >= (p.id === 'Default' ? 7 : C.FLOORS.text), `${kind} ${p.id} ${r.toFixed(2)}`);
    }
  }
});

test('the engine keeps the floors with every palette: a black page text on a white page background', () => {
  for (const kind of ['dark', 'light']) {
    for (const p of palettesFor(kind)) {
      const theme = C.createTheme(kind === 'dark'
        ? { mode: 'dark', darkBackground: p.background, darkText: p.text }
        : { mode: 'light', lightBackground: p.background, lightText: p.text });
      const tr = C.createTransformer(theme);
      const bg = tr.transform('#ffffff', 'background');
      const fg = tr.transform('#000000', 'foreground');
      const gray = tr.transform('#777777', 'foreground');
      const r = C.contrastRatio(rgb(fg), rgb(bg));
      assert.ok(r >= C.FLOORS.text, `${kind} ${p.id}: ${r.toFixed(2)} (${fg} on ${bg})`);
      assert.ok(C.contrastRatio(rgb(gray), rgb(bg)) >= C.FLOORS.text - 0.01, `${kind} ${p.id} gray text`);
    }
  }
});

test('AMOLED black is a true black page background', () => {
  const tr = C.createTransformer(C.createTheme({ mode: 'dark', darkBackground: '#000000', darkText: '#e8e8e8' }));
  assert.equal(tr.transform('#ffffff', 'background'), '#000000');
});

test('palettes differ from each other in background or text', () => {
  for (const list of [DARK_PALETTES, LIGHT_PALETTES]) {
    const keys = new Set(list.map((p) => `${p.background}/${p.text}`));
    assert.equal(keys.size, list.length);
    const bgs = new Set(list.map((p) => p.background));
    assert.equal(bgs.size, list.length, 'backgrounds are distinct');
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const chan = (hex) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
        const a = chan(list[i].background);
        const b = chan(list[j].background);
        const d = a.reduce((n, v, k) => n + Math.abs(v - b[k]), 0);
        assert.ok(d >= 8, `${list[i].id} and ${list[j].id} backgrounds are too close`);
      }
    }
  }
});

test('the id follows the colors, in both directions', () => {
  assert.equal(paletteIdFor('dark', '#2e3440', '#D8DEE9'), 'Nord');
  assert.equal(paletteIdFor('dark', '#2e3440', '#ffffff'), CUSTOM);
  assert.equal(paletteIdFor('light', '#ffffff', '#000000'), 'HighContrast');
  assert.deepEqual(paletteFields('dark', 'Gruvbox'), { darkBackground: '#282828', darkText: '#ebdbb2', colorSchemeDark: 'Gruvbox' });
  assert.deepEqual(paletteFields('light', 'WarmPaper'), { lightBackground: '#f4ecd8', lightText: '#3a2e20', colorSchemeLight: 'WarmPaper' });
  assert.equal(paletteFields('dark', CUSTOM), null);
  assert.equal(paletteFields('dark', 'Nope'), null);
  assert.deepEqual(paletteLabels({ darkBackground: '#000000' }), {});
});

test('schema: the ids are checked, Default stays valid, Custom is allowed', () => {
  const s = S.defaultSettings();
  for (const [field, list] of [['colorSchemeDark', DARK_PALETTES], ['colorSchemeLight', LIGHT_PALETTES]]) {
    for (const p of list) {
      const copy = structuredClone(s);
      copy.theme[field] = p.id;
      const bg = field === 'colorSchemeDark' ? 'darkBackground' : 'lightBackground';
      const tx = field === 'colorSchemeDark' ? 'darkText' : 'lightText';
      copy.theme[bg] = p.background;
      copy.theme[tx] = p.text;
      const r = strict('settings', copy);
      assert.deepEqual(r.errors, [], p.id);
      assert.equal(r.value.theme[field], p.id);
    }
    const custom = structuredClone(s);
    custom.theme[field] = CUSTOM;
    assert.deepEqual(strict('settings', custom).errors, []);
    for (const bad of ['Nord2', 'x'.repeat(61), '', 7, null]) {
      const copy = structuredClone(s);
      copy.theme[field] = bad;
      assert.ok(strict('settings', copy).errors.length > 0, JSON.stringify(bad));
    }
  }
  // A dark id is not a light id.
  const mixed = structuredClone(s);
  mixed.theme.colorSchemeLight = 'Nord';
  assert.ok(strict('settings', mixed).errors.length > 0);
});

test('old data: Default with other colors becomes Custom, Default with the default colors stays Default', () => {
  const old = S.defaultSettings();
  old.theme.darkBackground = '#101010';
  old.theme.colorSchemeDark = 'Default';
  const r = strict('settings', old);
  assert.equal(r.value.theme.colorSchemeDark, CUSTOM);
  assert.equal(r.value.theme.colorSchemeLight, 'Default');
  const lenient = S.sanitizeSection('settings', { ...S.defaultSettings(), theme: { ...S.defaultSettings().theme, colorSchemeDark: 'something old' } });
  assert.equal(lenient.value.theme.colorSchemeDark, 'Default');
});

test('a change of one color through a patch switches the id to Custom, and back', () => {
  const base = strict('settings', S.defaultSettings()).value;
  const nord = S.applyPatch(base, { theme: paletteFields('dark', 'Nord') });
  assert.deepEqual(nord.errors, []);
  assert.equal(nord.value.theme.colorSchemeDark, 'Nord');
  const edited = S.applyPatch(nord.value, { theme: { darkText: '#ffffff' } });
  assert.equal(edited.value.theme.colorSchemeDark, CUSTOM);
  const back = S.applyPatch(edited.value, { theme: { darkText: '#d8dee9' } });
  assert.equal(back.value.theme.colorSchemeDark, 'Nord');
});

test('presets, site rules and fixes carry the palette too', () => {
  const rule = { 'a.com': { theme: { mode: 'dark', darkBackground: '#000000', darkText: '#e8e8e8' } } };
  assert.equal(strict('siteRules', rule).value['a.com'].theme.colorSchemeDark, 'AMOLED');
  const partial = { 'a.com': { theme: { darkBackground: '#000000' } } };
  assert.equal(strict('siteRules', partial).value['a.com'].theme.colorSchemeDark, undefined);
  const fix = { 'a.com': { dynamic: { theme: { darkBackground: '#123456', darkText: '#ffffff' } } } };
  assert.equal(strict('userFixes', fix).value['a.com'].dynamic.theme.colorSchemeDark, CUSTOM);
  const preset = [{ id: 'p-1', name: 'x', theme: { ...S.defaultTheme(), darkBackground: '#0b1426', darkText: '#dbe5f4' } }];
  assert.equal(strict('presets', preset).value[0].theme.colorSchemeDark, 'Midnight');
});

test('export and import keep the palette', () => {
  const state = S.defaultState();
  Object.assign(state.settings.theme, paletteFields('dark', 'Solarized'), paletteFields('light', 'CoolGray'));
  const text = S.serializeExport(state, 0);
  const r = S.parseImport(text);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.state.settings.theme.colorSchemeDark, 'Solarized');
  assert.equal(r.state.settings.theme.colorSchemeLight, 'CoolGray');
  assert.equal(r.state.settings.theme.darkBackground, '#002b36');
  // An old file that names Default with colors that are no palette is imported as Custom.
  const oldFile = JSON.parse(text);
  oldFile.settings.theme.colorSchemeDark = 'Default';
  oldFile.settings.theme.darkText = '#fafafa';
  const r2 = S.parseImport(JSON.stringify(oldFile));
  assert.equal(r2.state.settings.theme.colorSchemeDark, CUSTOM);
});
