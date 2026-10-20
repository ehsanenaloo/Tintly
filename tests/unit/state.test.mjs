import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';
import { loadContent } from '../helpers/content.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { createState } = await load('background/modules/state.js');
const M = await load('shared/match.js');
const S = await load('shared/settings.js');
const dk = await loadContent('core/match.js');

function make(now = 1000) {
  const local = fakeArea();
  const session = fakeArea();
  let t = now;
  const state = createState({ local, session, now: () => t++ });
  return { state, local, session };
}

/* ---------- the module twin of the content-side match ---------- */

test('the module and the content script find the same rule for the same page', () => {
  const rules = { 'example.com': 1, 'blog.example.com': 2, 'example.com/docs': 3, 'example.com/docs/api': 4, '*.example.com': 5, 'localhost:8080': 6, 'a.b.c.org': 7 };
  const hosts = ['example.com', 'www.example.com', 'blog.example.com', 'a.blog.example.com', 'localhost:8080', 'localhost', 'a.b.c.org', 'x.a.b.c.org', 'other.net', 'EXAMPLE.com', '', 'com', 'a.com:81'];
  const paths = ['/', '/docs', '/docs/x', '/docs/api/v1', '/documents', '//docs//', ''];
  for (const h of hosts) {
    for (const p of paths) {
      assert.deepEqual(M.candidates(h, p), dk.match.candidates(h, p), `${h} ${p}`);
      assert.equal(M.find(rules, h, p), dk.match.find(rules, h, p), `${h} ${p}`);
    }
  }
});

test('siteEnabled follows the rule, then the list mode', () => {
  const s = (listMode) => ({ listMode });
  assert.equal(M.siteEnabled(s('allExcept'), {}, 'https://a.com/'), true);
  assert.equal(M.siteEnabled(s('onlyListed'), {}, 'https://a.com/'), false);
  assert.equal(M.siteEnabled(s('allExcept'), { 'a.com': { enabled: false } }, 'https://www.a.com/x'), false);
  assert.equal(M.siteEnabled(s('onlyListed'), { 'a.com': { enabled: true } }, 'https://a.com/'), true);
  assert.equal(M.siteEnabled(s('allExcept'), { 'a.com': { theme: {} } }, 'https://a.com/'), true);
});

test('pages without a site (browser pages, files, junk) are never enabled and have no pattern', () => {
  for (const u of ['chrome://settings', 'about:blank', 'file:///c:/a.html', 'javascript:1', '', null, undefined, 5, 'x'.repeat(5000), 'http://']) {
    assert.equal(M.siteEnabled({ listMode: 'allExcept' }, {}, u), false, String(u));
    assert.equal(M.patternFor(u), null, String(u));
  }
});

test('the pattern for a page is its host, with a non-default port', () => {
  assert.equal(M.patternFor('https://Www.Example.com/a?b#c'), 'www.example.com');
  assert.equal(M.patternFor('http://localhost:8080/x'), 'localhost:8080');
  assert.equal(M.patternFor('https://example.com:443/'), 'example.com');
});

/* ---------- the write queue ---------- */

test('first run writes defaults, and the state reads back', async () => {
  const { state, local } = make();
  assert.deepEqual(await state.init(), { ok: true, fresh: true, repaired: false });
  assert.equal(local.peek().settings.enabled, true);
  const r = await state.read();
  assert.equal(r.ok, true);
  assert.equal(r.state.settings.engine, 'auto');
});

test('writes run one after the other, in the order they were asked for', async () => {
  const { state, local } = make();
  await state.init();
  const order = [];
  const set = local.set;
  local.set = async (items) => {
    order.push(Object.keys(items).filter((k) => k === 'settings' || k === 'siteRules').join());
    await new Promise((r) => setTimeout(r, order.length === 1 ? 20 : 0));
    return set(items);
  };
  const results = await Promise.all([
    state.patchSettings({ theme: { brightness: 80 } }),
    state.setSite('a.com', { enabled: false }),
    state.patchSettings({ theme: { contrast: 120 } }),
  ]);
  assert.deepEqual(order, ['settings', 'siteRules', 'settings']);
  assert.ok(results.every((r) => r.ok));
  const final = local.peek();
  // Each change saw the result of the one before it.
  assert.equal(final.settings.theme.brightness, 80);
  assert.equal(final.settings.theme.contrast, 120);
  assert.deepEqual(Object.keys(final.siteRules), ['a.com']);
});

test('a failing job does not stop the jobs behind it', async () => {
  const { state } = make();
  await state.init();
  const bad = state.patchSettings({ theme: { brightness: 9999 } });
  const good = state.patchSettings({ theme: { brightness: 90 } });
  assert.equal((await bad).ok, false);
  assert.equal((await good).ok, true);
});

test('a patch with a bad value is refused with the reasons and writes nothing', async () => {
  const { state, local } = make();
  await state.init();
  const before = local.peek();
  const r = await state.patchSettings({ theme: { brightness: 5 }, nope: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
  assert.ok(r.errors.length >= 2);
  assert.deepEqual(local.peek(), before);
  for (const bad of [null, 'x', 5, [], JSON.parse('{"__proto__": {"a": 1}}')]) {
    assert.equal((await state.patchSettings(bad)).ok, false);
  }
  assert.equal({}.a, undefined);
});

test('data from a newer version is not touched and answers with a code', async () => {
  const { state, local } = make();
  await local.set({ schemaVersion: S.SCHEMA_VERSION + 1, settings: { odd: true } });
  const before = local.peek();
  assert.deepEqual(await state.read(), { ok: false, code: 'newer' });
  assert.deepEqual(await state.patchSettings({ enabled: false }), { ok: false, code: 'newer' });
  assert.deepEqual(local.peek(), before);
});

test('site rules: set, change, remove, and refuse bad patterns and bad rules', async () => {
  const { state, local } = make();
  await state.init();
  assert.equal((await state.setSite('Example.com/', { enabled: false })).ok, true);
  assert.deepEqual(local.peek().siteRules, { 'example.com': { enabled: false } });
  assert.equal((await state.setSite('example.com', { engine: 'filter' })).ok, true);
  assert.deepEqual(local.peek().siteRules, { 'example.com': { engine: 'filter' } });
  assert.equal((await state.setSite('example.com', null)).ok, true);
  assert.deepEqual(local.peek().siteRules, {});
  assert.equal((await state.setSite('bad host', {})).ok, false);
  assert.equal((await state.setSite('a.com', { enabled: 'yes' })).ok, false);
  assert.equal((await state.setSite('a.com', { nope: 1 })).ok, false);
  assert.equal((await state.setSite(5, {})).ok, false);
  assert.equal((await state.setSite('__proto__', {})).ok, false);
});

test('presets: save, replace, delete, and the cap', async () => {
  const { state, local } = make();
  await state.init();
  const theme = S.defaultTheme();
  const saved = await state.savePreset({ name: 'Night', theme });
  assert.equal(saved.ok, true);
  assert.match(saved.id, /^p-[a-z0-9]+$/);
  assert.equal((await state.savePreset({ id: saved.id, name: 'Night 2', theme })).ok, true);
  assert.equal(local.peek().presets.length, 1);
  assert.equal(local.peek().presets[0].name, 'Night 2');
  assert.equal((await state.savePreset({ name: '', theme })).ok, false);
  assert.equal((await state.savePreset({ id: 'Bad Id', name: 'x', theme })).ok, false);
  assert.equal((await state.deletePreset(saved.id)).ok, true);
  assert.equal(local.peek().presets.length, 0);
  for (let i = 0; i < 50; i++) assert.equal((await state.savePreset({ id: `p${i}`, name: 'x', theme })).ok, true);
  assert.equal((await state.savePreset({ id: 'one-more', name: 'x', theme })).ok, false);
});

test('import: a summary first, applied only when confirmed, refused when bad', async () => {
  const { state, local } = make();
  await state.init();
  const source = S.defaultState();
  source.settings.theme.brightness = 85;
  source.siteRules = S.sanitizeSection('siteRules', { 'a.com': { css: 'a{color:red}' } }, { strict: true }).value;
  const text = S.serializeExport(source);
  const preview = await state.importText(text, false);
  assert.deepEqual([preview.ok, preview.applied, preview.summary.customCss], [true, false, true]);
  assert.equal(local.peek().settings.theme.brightness, 100);
  const applied = await state.importText(text, true);
  assert.equal(applied.applied, true);
  assert.equal(local.peek().settings.theme.brightness, 85);
  assert.deepEqual(Object.keys(local.peek().siteRules), ['a.com']);
  for (const bad of ['{', '[]', '{"app":"x"}', 'x'.repeat(2 * 1024 * 1024), 5]) {
    const r = await state.importText(bad, true);
    assert.equal(r.ok, false);
  }
  assert.equal(local.peek().settings.theme.brightness, 85);
});

test('export gives text that imports back to the same data', async () => {
  const { state } = make();
  await state.init();
  await state.setSite('a.com', { enabled: false });
  const out = await state.exportText();
  assert.equal(out.ok, true);
  const back = S.parseImport(out.text);
  assert.equal(back.ok, true);
  assert.deepEqual(Object.keys(back.state.siteRules), ['a.com']);
});

test('toggle the extension', async () => {
  const { state, local } = make();
  await state.init();
  assert.deepEqual(await state.toggleExtension(), { ok: true, enabled: false });
  assert.equal(local.peek().settings.enabled, false);
  assert.deepEqual(await state.toggleExtension(), { ok: true, enabled: true });
});

test('toggle a site turns it off, then on, and keeps the other fields of its rule', async () => {
  const { state, local } = make();
  await state.init();
  assert.deepEqual(await state.toggleSite('https://www.example.com/page'), { ok: true, enabled: false, pattern: 'www.example.com' });
  assert.deepEqual(local.peek().siteRules, { 'www.example.com': { enabled: false } });
  await state.setSite('www.example.com', { enabled: false, engine: 'filter' });
  assert.deepEqual(await state.toggleSite('https://www.example.com/'), { ok: true, enabled: true, pattern: 'www.example.com' });
  assert.deepEqual(local.peek().siteRules['www.example.com'], { enabled: true, engine: 'filter' });
  for (const u of ['chrome://settings', 'about:blank', '', undefined]) assert.deepEqual(await state.toggleSite(u), { ok: false, code: 'no-site' });
});

test('toggle a site in only-listed mode turns it on', async () => {
  const { state, local } = make();
  await state.init();
  await state.patchSettings({ listMode: 'onlyListed' });
  assert.deepEqual(await state.toggleSite('https://a.com/'), { ok: true, enabled: true, pattern: 'a.com' });
  assert.deepEqual(local.peek().siteRules, { 'a.com': { enabled: true } });
});

test('the engine cycles through auto, dynamic, filterPlus, filter and back', async () => {
  const { state } = make();
  await state.init();
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push((await state.cycleEngine()).engine);
  assert.deepEqual(seen, ['dynamic', 'filterPlus', 'filter', 'auto', 'dynamic']);
});

test('tab status and host marks live in the session area and expire', async () => {
  const local = fakeArea();
  const session = fakeArea();
  let t = 1_000_000;
  const state = createState({ local, session, now: () => t });
  await state.setTabStatus(7, 'on');
  assert.equal((await state.getTabStatus(7)).status, 'on');
  assert.equal(await state.getTabStatus(8), null);
  await state.clearTab(7);
  assert.equal(await state.getTabStatus(7), null);
  await state.markHost('a.com', 'fallback');
  assert.equal((await state.getHostMark('a.com')).mode, 'fallback');
  t += 25 * 60 * 60 * 1000;
  assert.equal(await state.getHostMark('a.com'), null);
  // The expired mark is gone from the area, not only ignored.
  assert.deepEqual(Object.keys(session.peek()).filter((k) => k.startsWith('wd:')), []);
  assert.deepEqual(local.peek(), {});
});

test('expired host marks are removed in one pass, fresh marks and tab data stay', async () => {
  const session = fakeArea();
  let t = 5_000_000;
  const state = createState({ local: fakeArea(), session, now: () => t });
  await state.markHost('old.com', 'fallback');
  await state.markHost('older.com', 'safe');
  await state.setTabStatus(3, 'on');
  t += 25 * 60 * 60 * 1000;
  await state.markHost('fresh.com', 'fallback');
  assert.equal(await state.pruneMarks(), 2);
  assert.deepEqual(Object.keys(session.peek()).sort(), ['tab:3', 'wd:fresh.com']);
  assert.equal(await state.pruneMarks(), 0);
});

test('setUi merges and checks the language and look; reset keeps them', async () => {
  const { state } = make();
  await state.init();
  assert.equal((await state.setUi({ locale: 'fa' })).ok, true);
  assert.equal((await state.setUi({ locale: 'xx' })).ok, false);
  assert.equal((await state.setUi([])).ok, false);
  await state.patchSettings({ theme: { brightness: 70 } });
  await state.setSite('a.com', { enabled: false });
  assert.equal((await state.reset()).ok, true);
  const s = (await state.read()).state;
  assert.equal(s.settings.theme.brightness, 100);
  assert.deepEqual(Object.keys(s.siteRules), []);
  assert.equal(s.ui.locale, 'fa');
});

test('setFix stores, replaces and removes a fix, and refuses bad ones', async () => {
  const { state } = make();
  await state.init();
  assert.equal((await state.setFix('Example.com', { note: 'n', dynamic: { css: 'a { color: red }', invert: ['.logo'] } })).ok, true);
  assert.deepEqual(Object.keys((await state.read()).state.userFixes), ['example.com']);
  assert.equal((await state.setFix('example.com', { dynamic: { invert: ['a{'] } })).ok, false);
  assert.equal((await state.setFix('example.com', { unknown: 1 })).ok, false);
  assert.equal((await state.setFix('not a host!!', {})).ok, false);
  assert.equal((await state.setFix('example.com', null)).ok, true);
  assert.deepEqual(Object.keys((await state.read()).state.userFixes), []);
});
