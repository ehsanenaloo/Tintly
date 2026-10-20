import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const load = (name) => import(pathToFileURL(join(REPO, 'extension', 'shared', name)).href);
const S = await load('settings.js');
const { L } = await load('limits.js');

const plain = (v) => JSON.parse(JSON.stringify(v));
const strict = (name, input) => S.sanitizeSection(name, input, { strict: true });
const lenient = (name, input) => S.sanitizeSection(name, input, { strict: false });
const withTheme = (change) => {
  const s = S.defaultSettings();
  Object.assign(s.theme, change);
  return s;
};

test('the mode accepts eink, and the style accepts eink and paper only', () => {
  assert.deepEqual(strict('settings', withTheme({ mode: 'eink', einkPreset: 'eink' })).errors, []);
  assert.deepEqual(strict('settings', withTheme({ mode: 'eink', einkPreset: 'paper' })).errors, []);
  for (const bad of [{ mode: 'sepia' }, { einkPreset: 'book' }, { einkPreset: null }]) assert.ok(strict('settings', withTheme(bad)).errors.length > 0, JSON.stringify(bad));
});

test('every field of the mode is null by default and the style is paper', () => {
  const t = S.defaultTheme();
  assert.equal(t.einkPreset, 'paper');
  for (const key of S.EINK_FIELDS) assert.equal(t[key], null, key);
  assert.deepEqual(strict('settings', S.defaultSettings()).errors, []);
});

test('the numbers of the mode are checked against their limits', () => {
  const edge = { einkContrast: L.EINK_CONTRAST.min, whiteCap: L.WHITE_CAP.max, einkBlue: L.EINK_BLUE.max, einkImageContrast: L.IMAGE_CONTRAST.min, einkWeight: L.EINK_WEIGHT.max };
  assert.deepEqual(strict('settings', withTheme(edge)).errors, []);
  const bad = [
    { einkContrast: 49 }, { einkContrast: 201 }, { whiteCap: 49 }, { whiteCap: 101 }, { einkBlue: -1 }, { einkBlue: 101 },
    { einkImageContrast: 49 }, { einkImageContrast: 201 }, { einkWeight: 4 }, { einkWeight: -1 },
    { whiteCap: 80.5 }, { whiteCap: '80' }, { einkBlue: NaN }, { einkBlue: Infinity },
  ];
  for (const b of bad) assert.ok(strict('settings', withTheme(b)).errors.length > 0, JSON.stringify(b));
});

test('the gray levels are one of 0, 2, 4, 8 and 16', () => {
  for (const v of L.EINK_LEVELS) assert.deepEqual(strict('settings', withTheme({ einkLevels: v })).errors, [], String(v));
  for (const v of [1, 3, 5, 15, 32, -2, 4.5, '4', true]) assert.ok(strict('settings', withTheme({ einkLevels: v })).errors.length > 0, String(v));
});

test('colors, enums and switches of the mode', () => {
  const r = strict('settings', withTheme({ paperColor: '#F4F1EA', inkColor: '#abc' }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.theme.paperColor, '#f4f1ea');
  assert.equal(r.value.theme.inkColor, '#aabbcc');
  for (const bad of [{ paperColor: 'cream' }, { inkColor: '#12' }, { paperColor: 'auto' }, { einkColor: 'vivid' }, { einkImages: 'sepia' }, { noShadow: 'yes' }, { einkLinks: 1 }, { reducedMotionHint: 'true' }]) {
    assert.ok(strict('settings', withTheme(bad)).errors.length > 0, JSON.stringify(bad));
  }
  const ok = { einkColor: 'muted', einkImages: 'dim', einkLinks: false, einkBorders: true, noAnimation: true, noTransition: false, noSmoothScroll: true, noShadow: false, reducedMotionHint: true };
  assert.deepEqual(strict('settings', withTheme(ok)).errors, []);
});

test('the font of the mode is a keyword or a plain family name', () => {
  for (const v of ['keep', 'serif', 'sans', 'Vazirmatn', 'Noto Serif, Georgia']) assert.deepEqual(strict('settings', withTheme({ einkFont: v })).errors, [], v);
  for (const v of ['a;b', 'x}body{color:red', 'a<b', 'f\\ont', '', 'x'.repeat(L.FONT_CHARS + 1)]) assert.ok(strict('settings', withTheme({ einkFont: v })).errors.length > 0, JSON.stringify(v));
});

test('null means the style: every field takes null and stays null', () => {
  const reset = plain(S.EINK_RESET);
  const r = strict('settings', withTheme({ whiteCap: 70, einkFont: 'serif', ...reset }));
  assert.deepEqual(r.errors, []);
  for (const key of S.EINK_FIELDS) assert.equal(r.value.theme[key], null, key);
});

test('a bad value in stored data is replaced by the default, the rest is kept', () => {
  const r = lenient('settings', withTheme({ mode: 'eink', whiteCap: 12, einkLevels: 3, einkBlue: 30 }));
  assert.equal(r.value.theme.mode, 'eink');
  assert.equal(r.value.theme.whiteCap, null);
  assert.equal(r.value.theme.einkLevels, null);
  assert.equal(r.value.theme.einkBlue, 30);
});

test('data saved before the mode existed gets the defaults for the new fields', () => {
  const old = S.defaultSettings();
  for (const key of ['einkPreset', ...S.EINK_FIELDS]) delete old.theme[key];
  delete old.automation.activeMode;
  delete old.automation.idleMode;
  const r = lenient('settings', old);
  assert.equal(r.value.theme.einkPreset, 'paper');
  assert.equal(r.value.theme.whiteCap, null);
  assert.equal(r.value.automation.activeMode, 'dark');
  assert.equal(r.value.automation.idleMode, 'light');
  const st = strict('settings', old);
  assert.deepEqual(st.errors, []);
  assert.equal(st.value.theme.einkPreset, 'paper');
});

test('a patch can set the mode and the style, and a site rule can hold both', () => {
  const s = S.defaultSettings();
  const p = S.applyPatch(s, { theme: { mode: 'eink', einkPreset: 'eink', whiteCap: 80, ...plain(S.EINK_RESET) } });
  assert.deepEqual(p.errors, []);
  assert.equal(p.value.theme.mode, 'eink');
  assert.equal(p.value.theme.whiteCap, null);
  assert.ok(S.applyPatch(s, { theme: { whiteCap: 12 } }).errors.length > 0);
  assert.ok(S.applyPatch(s, { theme: { einkDither: true } }).errors.length > 0);
  const rules = { 'a.test': { theme: { mode: 'eink', einkPreset: 'paper', einkBlue: 40 } }, 'b.test': { theme: { mode: 'eink' } } };
  assert.deepEqual(strict('siteRules', rules).errors, []);
  assert.ok(strict('siteRules', { 'a.test': { theme: { mode: 'eink', einkBlue: 400 } } }).errors.length > 0);
});

test('the schedule can name the mode inside and outside its hours', () => {
  const s = S.defaultSettings();
  s.automation.behavior = 'scheme';
  s.automation.activeMode = 'eink';
  s.automation.idleMode = 'dark';
  assert.deepEqual(strict('settings', s).errors, []);
  s.automation.activeMode = 'sepia';
  assert.ok(strict('settings', s).errors.length > 0);
});

test('a preset carries the fields of the mode, and a preset made before them still loads', () => {
  const theme = { ...S.defaultTheme(), mode: 'eink', einkPreset: 'paper', paperColor: '#fff4c8', whiteCap: 76, einkFont: 'serif' };
  const r = strict('presets', [{ id: 'p-1', name: 'Night book', theme }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.value[0].theme.whiteCap, 76);
  assert.equal(r.value[0].theme.paperColor, '#fff4c8');
  const oldTheme = S.defaultTheme();
  for (const key of ['einkPreset', ...S.EINK_FIELDS]) delete oldTheme[key];
  const old = strict('presets', [{ id: 'p-2', name: 'Old', theme: oldTheme }]);
  assert.deepEqual(old.errors, []);
  assert.equal(old.value[0].theme.einkPreset, 'paper');
});

test('export and import keep the fields of the mode, site rules and presets', () => {
  const state = S.defaultState();
  state.settings.theme = { ...state.settings.theme, mode: 'eink', einkPreset: 'eink', inkColor: '#111111', einkLevels: 4, noShadow: false, einkFont: 'Vazirmatn' };
  state.siteRules = Object.assign(Object.create(null), { 'books.test': { theme: { mode: 'eink', einkPreset: 'paper', whiteCap: 70 } } });
  state.presets = [{ id: 'p-3', name: 'Reading', theme: { ...S.defaultTheme(), mode: 'eink', einkBlue: 55 } }];
  const text = S.serializeExport(state, 0);
  const back = S.parseImport(text);
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.state.settings.theme.mode, 'eink');
  assert.equal(back.state.settings.theme.inkColor, '#111111');
  assert.equal(back.state.settings.theme.einkLevels, 4);
  assert.equal(back.state.settings.theme.einkFont, 'Vazirmatn');
  assert.deepEqual(plain(back.state.siteRules['books.test']), plain(state.siteRules['books.test']));
  assert.equal(back.state.presets[0].theme.einkBlue, 55);
  // An export from before the mode (no new fields) still imports.
  const old = JSON.parse(text);
  for (const key of ['einkPreset', ...S.EINK_FIELDS]) delete old.settings.theme[key];
  delete old.settings.automation.activeMode;
  delete old.settings.automation.idleMode;
  for (const p of old.presets) for (const key of ['einkPreset', ...S.EINK_FIELDS]) delete p.theme[key];
  const older = S.parseImport(JSON.stringify(old));
  assert.equal(older.ok, true, JSON.stringify(older));
  assert.equal(older.state.settings.theme.einkPreset, 'paper');
  // A bad value in an import is refused.
  old.settings.theme.whiteCap = 10;
  assert.equal(S.parseImport(JSON.stringify(old)).ok, false);
});

test('einkValues fills the style and keeps what the person set', () => {
  const v = S.einkValues({ einkPreset: 'eink', whiteCap: 77, inkColor: null });
  assert.equal(v.preset, 'eink');
  assert.equal(v.whiteCap, 77);
  assert.equal(v.inkColor, '#000000');
  assert.equal(v.noAnimation, true);
  assert.equal(S.einkValues({ einkPreset: 'paper' }).noAnimation, false);
  assert.equal(S.einkValues({ einkPreset: 'paper', noAnimation: true }).noAnimation, true);
  assert.equal(S.einkValues(undefined).preset, 'paper');
  // A switch the person turned off stays off in a style that has it on.
  assert.equal(S.einkValues({ einkPreset: 'eink', noShadow: false }).noShadow, false);
});
