import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const load = (name) => import(pathToFileURL(join(REPO, 'extension', 'shared', name)).href);
const S = await load('settings.js');
const { L } = await load('limits.js');

// Maps have no prototype, so compare through JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

const strict = (name, input) => S.sanitizeSection(name, input, { strict: true });
const lenient = (name, input) => S.sanitizeSection(name, input, { strict: false });

/* ---------- defaults ---------- */

test('the default state passes the strict check unchanged', () => {
  const state = S.defaultState();
  for (const name of S.SECTIONS) {
    const r = strict(name, state[name]);
    assert.deepEqual(r.errors, [], name);
    assert.deepEqual(plain(r.value), plain(state[name]), name);
  }
});

test('default values sit inside their limits', () => {
  const t = S.defaultTheme();
  assert.ok(t.brightness >= L.BRIGHTNESS.min && t.brightness <= L.BRIGHTNESS.max);
  assert.ok(t.contrast >= L.CONTRAST.min && t.contrast <= L.CONTRAST.max);
  assert.equal(S.defaultSettings().engine, 'auto');
});

test('defaults are fresh objects each call', () => {
  const a = S.defaultSettings();
  a.theme.brightness = 70;
  assert.equal(S.defaultSettings().theme.brightness, 100);
});

/* ---------- settings: ranges and types ---------- */

const patchTheme = (change) => {
  const s = S.defaultSettings();
  Object.assign(s.theme, change);
  return s;
};

test('numbers outside their range are rejected in strict mode', () => {
  for (const bad of [{ brightness: 49 }, { brightness: 151 }, { contrast: 0 }, { sepia: 101 }, { grayscale: -1 }, { textStroke: 11 }]) {
    assert.ok(strict('settings', patchTheme(bad)).errors.length > 0, JSON.stringify(bad));
  }
});

test('numbers on the edge of their range are accepted', () => {
  const r = strict('settings', patchTheme({ brightness: 50, contrast: 150, sepia: 100, grayscale: 0, textStroke: 10 }));
  assert.deepEqual(r.errors, []);
});

test('non-integers, strings, NaN and Infinity are rejected for integer fields', () => {
  for (const v of [1.5, '100', NaN, Infinity, null, true]) {
    assert.ok(strict('settings', patchTheme({ brightness: v })).errors.length > 0, String(v));
  }
});

test('colors are normalized to six lower-case hex digits', () => {
  const r = strict('settings', patchTheme({ darkBackground: '#ABC', darkText: ' #A1B2C3 ' }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.theme.darkBackground, '#aabbcc');
  assert.equal(r.value.theme.darkText, '#a1b2c3');
});

test('bad colors are rejected', () => {
  for (const v of ['red', '#12', '#12345', '#gggggg', 'rgb(0,0,0)', 123, '', 'url(x)']) {
    assert.ok(strict('settings', patchTheme({ darkBackground: v })).errors.length > 0, String(v));
  }
});

test('scrollbar and selection accept auto or a color', () => {
  assert.deepEqual(strict('settings', patchTheme({ scrollbar: 'auto', selection: '#102030' })).errors, []);
  assert.ok(strict('settings', patchTheme({ scrollbar: 'dark' })).errors.length > 0);
});

test('a font name cannot carry CSS syntax', () => {
  for (const v of ['a;b', 'x}body{color:red', 'a<b', 'f\\ont', 'a\nb', '']) {
    assert.ok(strict('settings', patchTheme({ fontFamily: v })).errors.length > 0, JSON.stringify(v));
  }
  assert.deepEqual(strict('settings', patchTheme({ fontFamily: 'Vazirmatn' })).errors, []);
  assert.deepEqual(strict('settings', patchTheme({ fontFamily: 'Noto Sans, "Segoe UI"' })).errors, []);
});

test('custom CSS keeps newlines, rejects control characters and the size cap', () => {
  assert.deepEqual(strict('settings', patchTheme({ css: 'a {\n  color: red;\n}\n' })).errors, []);
  assert.ok(strict('settings', patchTheme({ css: 'a\u0000b' })).errors.length > 0);
  assert.ok(strict('settings', patchTheme({ css: 'x'.repeat(L.CSS_CHARS + 1) })).errors.length > 0);
  assert.deepEqual(strict('settings', patchTheme({ css: 'x'.repeat(L.CSS_CHARS) })).errors, []);
});

test('times, coordinates and enums are checked', () => {
  const s = S.defaultSettings();
  s.automation.time.from = '24:00';
  assert.ok(strict('settings', s).errors.length > 0);
  const t = S.defaultSettings();
  t.automation.location.lat = 91;
  assert.ok(strict('settings', t).errors.length > 0);
  const u = S.defaultSettings();
  u.automation.location = { lat: 35.7, lon: 51.4 };
  u.automation.time = { from: '23:30', to: '05:15' };
  assert.deepEqual(strict('settings', u).errors, []);
  const v = S.defaultSettings();
  v.engine = 'turbo';
  assert.ok(strict('settings', v).errors.length > 0);
});

test('unknown fields are errors in strict mode and dropped in lenient mode', () => {
  const s = S.defaultSettings();
  s.extra = 1;
  s.theme.other = 2;
  assert.ok(strict('settings', s).errors.length >= 2);
  const r = lenient('settings', s);
  assert.ok(!('extra' in r.value));
  assert.ok(!('other' in r.value.theme));
});

test('missing fields are filled with defaults', () => {
  const r = strict('settings', { enabled: false });
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.enabled, false);
  assert.equal(r.value.theme.brightness, 100);
});

test('lenient mode repairs a bad value with its default and keeps the rest', () => {
  const s = S.defaultSettings();
  s.theme.brightness = 9999;
  s.theme.mode = 'light';
  const r = lenient('settings', s);
  assert.equal(r.value.theme.brightness, 100);
  assert.equal(r.value.theme.mode, 'light');
  assert.ok(r.errors.length > 0);
});

test('a wrong type for a whole section gives defaults in lenient mode and undefined in strict mode', () => {
  assert.deepEqual(plain(lenient('settings', 'oops').value), plain(S.defaultSettings()));
  assert.equal(strict('settings', 'oops').value, undefined);
  assert.equal(strict('settings', null).value, undefined);
  assert.equal(strict('settings', []).value, undefined);
});

/* ---------- patterns ---------- */

test('patterns normalize to host plus path', () => {
  const cases = {
    'Example.COM': 'example.com',
    'https://Example.com/': 'example.com',
    'http://example.com/a/b/?q=1#x': 'example.com/a/b',
    'sub.example.com:8080/p': 'sub.example.com:8080/p',
    '*.example.com': '*.example.com',
    'localhost': 'localhost',
    '192.168.0.1': '192.168.0.1',
    'xn--mgbaam7a8h.example': 'xn--mgbaam7a8h.example',
    'example.com/Path/CaseKept': 'example.com/Path/CaseKept',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(S.normalizePattern(input), want, input);
});

test('bad patterns return null', () => {
  const bad = ['', ' ', '/path', 'a b.com', 'exa_mple.com', '-a.com', 'a..com', 'a.com/<x>', 'a\n.com', 'user@a.com', '__proto__', 'x'.repeat(301), 5, null, undefined, {}];
  for (const input of bad) assert.equal(S.normalizePattern(input), null, String(input));
});

test('selectors: accepted and refused', () => {
  for (const ok of ['a', '.x > .y', 'div[data-a="b]c"]', ':not(.a, .b)', 'a:hover::before', '#id.cls']) {
    assert.equal(S.isSafeSelector(ok), true, ok);
  }
  for (const bad of ['', ' ', 'a{}', 'a;b', 'a<b', 'a(', 'a)', '[a', 'a"b', 'x'.repeat(201), 'a\u0000', 5]) {
    assert.equal(S.isSafeSelector(bad), false, String(bad));
  }
});

/* ---------- maps and lists ---------- */

test('site rules: keys are normalized, values checked, the map has no prototype', () => {
  const r = strict('siteRules', {
    'Example.com/': { enabled: false },
    'b.org': { engine: 'filter', theme: { brightness: 80 }, css: 'a{color:red}' },
  });
  assert.deepEqual(r.errors, []);
  assert.equal(Object.getPrototypeOf(r.value), null);
  assert.deepEqual(Object.keys(r.value).sort(), ['b.org', 'example.com']);
  assert.equal(r.value['b.org'].theme.brightness, 80);
});

test('site rules: a partial theme does not get defaults', () => {
  const r = strict('siteRules', { 'a.com': { theme: { sepia: 10 } } });
  assert.deepEqual(plain(r.value['a.com'].theme), { sepia: 10 });
});

test('site rules: duplicates after normalizing, bad keys and bad values are errors', () => {
  assert.ok(strict('siteRules', { 'a.com': {}, 'A.com/': {} }).errors.length > 0);
  assert.ok(strict('siteRules', { 'bad key': {} }).errors.length > 0);
  assert.ok(strict('siteRules', { 'a.com': { enabled: 'yes' } }).errors.length > 0);
  assert.ok(strict('siteRules', { 'a.com': { nope: 1 } }).errors.length > 0);
});

test('site rules: the entry cap is enforced', () => {
  const many = {};
  for (let i = 0; i <= L.SITE_RULES; i++) many[`h${i}.example`] = {};
  assert.ok(strict('siteRules', many).errors.some((e) => e.includes('more than')));
});

test('presets: ids must be unique and present', () => {
  const theme = S.defaultTheme();
  const ok = [{ id: 'night', name: 'Night', theme }, { id: 'day', name: 'Day', theme }];
  assert.deepEqual(strict('presets', ok).errors, []);
  assert.ok(strict('presets', [ok[0], ok[0]]).errors.some((e) => e.includes('repeats')));
  assert.ok(strict('presets', [{ name: 'x', theme }]).errors.length > 0);
  assert.ok(strict('presets', [{ id: 'Bad Id', name: 'x', theme }]).errors.length > 0);
});

test('presets: the count cap is enforced', () => {
  const theme = S.defaultTheme();
  const list = Array.from({ length: L.PRESETS + 1 }, (_, i) => ({ id: `p${i}`, name: 'x', theme }));
  assert.ok(strict('presets', list).errors.some((e) => e.includes('more than')));
});

test('presets: lenient mode drops a broken preset and keeps the others', () => {
  const theme = S.defaultTheme();
  const r = lenient('presets', [{ id: 'a', name: 'A', theme }, { name: 'no id', theme }]);
  assert.equal(r.value.length, 1);
});

test('user fixes: selectors and nested theme are checked', () => {
  const good = { 'a.com': { note: 'logo', dynamic: { invert: ['.logo'], ignoreImage: ['img.photo'], css: '.x{opacity:1}', theme: { brightness: 90 } }, static: { bg: ['.page', 'main.content'], skip: ['.k'] }, darkHint: ['html.dark'] } };
  assert.deepEqual(strict('userFixes', good).errors, []);
  assert.ok(strict('userFixes', { 'a.com': { dynamic: { invert: ['a{}'] } } }).errors.length > 0);
  // A list that names the whole page is not a per-site fix.
  for (const broad of ['*', 'html', 'body', ':root', ' BODY , html ']) {
    assert.ok(strict('userFixes', { 'a.com': { static: { bg: [broad] } } }).errors.some((e) => e.includes('too broad')), broad);
    assert.ok(strict('userFixes', { 'a.com': { dynamic: { invert: [broad] } } }).errors.some((e) => e.includes('too broad')), broad);
  }
  assert.deepEqual(strict('userFixes', { 'a.com': { dynamic: { ignoreInline: ['body'] } } }).errors, []);
  assert.ok(strict('userFixes', { 'a.com': { dynamic: { theme: { brightness: 5 } } } }).errors.length > 0);
});

test('user fixes: style sheet addresses to skip and the not-dark flag are checked', () => {
  const ok = { 'a.com': { dynamic: { ignoreCssUrl: ['//fonts.example/', 'cdn.example/*/icons.css', '/wp-content/fonts.css?ver=1'] }, notDark: true } };
  assert.deepEqual(strict('userFixes', ok).errors, []);
  assert.equal(strict('userFixes', ok).value['a.com'].notDark, true);
  for (const bad of ['has space', '<script>', 'a"b', 'x'.repeat(201), '', 'a\nb']) {
    assert.ok(strict('userFixes', { 'a.com': { dynamic: { ignoreCssUrl: [bad] } } }).errors.length > 0, JSON.stringify(bad));
  }
  assert.ok(strict('userFixes', { 'a.com': { dynamic: { ignoreCssUrl: Array.from({ length: 51 }, (_, i) => `h${i}.example`) } } }).errors.length > 0);
  assert.ok(strict('userFixes', { 'a.com': { notDark: 'yes' } }).errors.length > 0);
  assert.ok(S.isUrlPart('fonts.example/*') && !S.isUrlPart('a b') && !S.isUrlPart(''));
});

test('dark sites: patterns are normalized and deduplicated', () => {
  const r = strict('darkSites', { add: ['A.com', 'a.com/', 'b.org'], remove: [] });
  assert.deepEqual(r.value.add, ['a.com', 'b.org']);
  assert.ok(strict('darkSites', { add: ['bad host'], remove: [] }).errors.length > 0);
});

test('ui: only shipped locales and themes', () => {
  assert.deepEqual(strict('ui', { locale: 'fa', uiTheme: 'dark' }).errors, []);
  assert.deepEqual(strict('ui', { locale: 'auto', uiTheme: 'system' }).errors, []);
  assert.ok(strict('ui', { locale: 'xx', uiTheme: 'dark' }).errors.length > 0);
});

/* ---------- hostile input ---------- */

test('prototype keys in a parsed object do not reach the result', () => {
  const evil = JSON.parse('{"__proto__": {"polluted": true}, "enabled": true}');
  const r = lenient('settings', evil);
  assert.equal({}.polluted, undefined);
  assert.equal(r.value.polluted, undefined);
  assert.ok(strict('settings', evil).errors.some((e) => e.includes('not a known field')));
});

test('prototype names as site keys are refused', () => {
  const evil = JSON.parse('{"__proto__": {}, "constructor": {}, "a.com": {}}');
  const r = strict('siteRules', evil);
  assert.ok(r.errors.length >= 1);
  assert.equal({}.polluted, undefined);
  // "constructor" is a valid host label and is harmless as a key of a map without a prototype.
  const l = lenient('siteRules', evil);
  assert.deepEqual(Object.keys(l.value).sort(), ['a.com', 'constructor']);
  assert.equal(Object.getPrototypeOf(l.value), null);
});

test('objects with a custom prototype are not accepted', () => {
  class Odd {}
  assert.equal(strict('settings', new Odd()).value, undefined);
});

test('huge strings, long lists and deep objects are handled without a crash', () => {
  const s = S.defaultSettings();
  s.theme.colorSchemeDark = 'x'.repeat(1_000_000);
  assert.ok(strict('settings', s).errors.length > 0);
  const deep = {};
  let cur = deep;
  for (let i = 0; i < 5000; i++) cur = cur.n = {};
  assert.ok(strict('settings', { theme: deep }).errors.length > 0);
  assert.ok(strict('darkSites', { add: new Array(L.DARK_SITE_ENTRIES + 1).fill('a.com'), remove: [] }).errors.length > 0);
});

test('error output is capped', () => {
  const many = {};
  for (let i = 0; i < 500; i++) many[`bad key ${i}`] = {};
  assert.ok(strict('siteRules', many).errors.length <= L.MAX_ERRORS);
});

/* ---------- patch ---------- */

test('a patch merges objects by key and leaves the rest', () => {
  const base = S.defaultSettings();
  const r = S.applyPatch(base, { theme: { brightness: 120 }, enabled: false });
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.theme.brightness, 120);
  assert.equal(r.value.theme.contrast, 100);
  assert.equal(r.value.enabled, false);
  assert.equal(base.theme.brightness, 100);
});

test('a patch with a bad value or an unknown key changes nothing', () => {
  const base = S.defaultSettings();
  assert.equal(S.applyPatch(base, { theme: { brightness: 500 } }).value, undefined);
  assert.equal(S.applyPatch(base, { nope: 1 }).value, undefined);
  assert.equal(S.applyPatch(base, 'x').value, undefined);
  assert.equal(S.applyPatch(base, JSON.parse('{"__proto__": {"x": 1}}')).value, undefined);
  assert.equal({}.x, undefined);
});

test('a patch can set and clear a nullable value', () => {
  const a = S.applyPatch(S.defaultSettings(), { automation: { location: { lat: 10, lon: 20 } } });
  assert.deepEqual(a.value.automation.location, { lat: 10, lon: 20 });
  const b = S.applyPatch(a.value, { automation: { location: { lat: null, lon: null } } });
  assert.deepEqual(b.value.automation.location, { lat: null, lon: null });
});

/* ---------- migration ---------- */

test('data without a version is migrated to the current version', () => {
  const r = S.migrate({ settings: {} });
  assert.equal(r.ok, true);
  assert.equal(r.raw.schemaVersion, S.SCHEMA_VERSION);
});

test('newer data is refused and not touched', () => {
  assert.deepEqual(S.migrate({ schemaVersion: S.SCHEMA_VERSION + 1 }), { ok: false, code: 'newer' });
});

test('a chain of steps runs in order, each once', () => {
  const calls = [];
  const steps = {
    0: (raw) => (calls.push(0), { ...raw, a: 1 }),
    1: (raw) => (calls.push(1), { ...raw, b: raw.a + 1 }),
    2: (raw) => (calls.push(2), { ...raw, c: raw.b + 1 }),
  };
  const r = S.migrate({ schemaVersion: 1, a: 5 }, steps, 3);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(r.raw.c, 7);
  assert.equal(r.raw.schemaVersion, 3);
});

test('a missing step is reported', () => {
  assert.deepEqual(S.migrate({ schemaVersion: 1 }, { 0: (x) => x }, 3), { ok: false, code: 'no-path' });
});

test('a non-object is invalid', () => {
  for (const v of [null, 'x', 1, []]) assert.deepEqual(S.migrate(v), { ok: false, code: 'invalid' });
});

/* ---------- export and import ---------- */

function sampleState() {
  const state = S.defaultState();
  state.settings.theme.brightness = 90;
  state.settings.automation.location = { lat: 35.7, lon: 51.4 };
  state.siteRules = strict('siteRules', { 'a.com': { enabled: false }, 'b.org/docs': { css: 'a{color:red}' } }).value;
  state.presets = [{ id: 'night', name: 'Night', theme: S.defaultTheme() }];
  state.userFixes = strict('userFixes', { 'c.net': { dynamic: { invert: ['.logo'] } } }).value;
  state.darkSites = { add: ['d.io'], remove: ['e.io'] };
  return state;
}

test('export then import gives the same data', () => {
  const state = sampleState();
  const text = S.serializeExport(state, 1_700_000_000_000);
  const r = S.parseImport(text);
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const name of ['settings', 'siteRules', 'presets', 'userFixes', 'darkSites']) {
    assert.deepEqual(plain(r.state[name]), plain(state[name]), name);
  }
  assert.equal(r.summary.siteRules, 2);
  assert.equal(r.summary.presets, 1);
  assert.equal(r.summary.userFixes, 1);
  assert.equal(r.summary.darkSiteEntries, 2);
  assert.equal(r.summary.customCss, true);
});

test('the export has no ui section and names the app', () => {
  const out = S.exportState(sampleState(), 0);
  assert.equal(out.app, 'tintly');
  assert.ok(!('ui' in out));
  assert.equal(out.exportedAt, '1970-01-01T00:00:00.000Z');
});

test('summary says when no custom CSS is present', () => {
  assert.equal(S.parseImport(S.serializeExport(S.defaultState())).summary.customCss, false);
});

test('import refuses wrong input with a clear code', () => {
  const code = (text) => S.parseImport(text).code;
  assert.equal(code(5), 'invalid');
  assert.equal(code('{not json'), 'not-json');
  assert.equal(code('[]'), 'invalid');
  assert.equal(code('{"app":"other"}'), 'wrong-app');
  assert.equal(code(`{"app":"tintly","schemaVersion":${S.SCHEMA_VERSION + 1}}`), 'newer-version');
  assert.equal(code('x'.repeat(L.IMPORT_BYTES + 1)), 'too-large');
});

test('import counts bytes, not characters', () => {
  const text = `{"app":"tintly","note":"${'ی'.repeat(L.IMPORT_BYTES / 2)}"}`;
  assert.equal(S.parseImport(text).code, 'too-large');
});

test('import refuses data nested too deep', () => {
  let deep = '1';
  for (let i = 0; i < L.MAX_DEPTH + 2; i++) deep = `{"n":${deep}}`;
  assert.equal(S.parseImport(`{"app":"tintly","settings":${deep}}`).code, 'too-deep');
});

test('import survives extreme nesting without a crash', () => {
  const text = `{"app":"tintly","settings":${'['.repeat(200_000)}${']'.repeat(200_000)}}`;
  const r = S.parseImport(text);
  assert.equal(r.ok, false);
});

test('import refuses an unknown section, an unknown field and a bad value', () => {
  const base = JSON.parse(S.serializeExport(S.defaultState()));
  const tryWith = (change) => S.parseImport(JSON.stringify({ ...base, ...change }));
  assert.equal(tryWith({ ui: {} }).code, 'invalid-data');
  assert.equal(tryWith({ extra: 1 }).code, 'invalid-data');
  assert.equal(tryWith({ settings: { ...base.settings, enabled: 'yes' } }).code, 'invalid-data');
  assert.equal(tryWith({ siteRules: { 'bad host': {} } }).code, 'invalid-data');
});

test('import drops prototype keys before they are read', () => {
  const text = '{"app":"tintly","settings":{"__proto__":{"enabled":false},"enabled":true}}';
  const r = S.parseImport(text);
  assert.equal(r.ok, true);
  assert.equal(r.state.settings.enabled, true);
  assert.equal({}.enabled, undefined);
});

test('an import without a version is read as the oldest version', () => {
  const r = S.parseImport('{"app":"tintly","settings":{"enabled":false}}');
  assert.equal(r.ok, true);
  assert.equal(r.state.settings.enabled, false);
});

test('import never carries the updated time or the language', () => {
  const r = S.parseImport(JSON.stringify({ app: 'tintly', updatedAt: 5 }));
  assert.equal(r.code, 'invalid-data');
});
