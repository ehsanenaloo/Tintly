// The site switch acts on the rule that decides for the page, field changes of two windows both stay, and paths keep their empty
// segments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { createState, patchRule } = await load('background/modules/state.js');
const M = await load('shared/match.js');
const S = await load('shared/settings.js');

async function make(siteRules = {}, settings = {}) {
  const state = createState({ local: fakeArea(), session: fakeArea(), now: () => 1234, changes: null });
  await state.init();
  if (Object.keys(settings).length) assert.equal((await state.patchSettings(settings)).ok, true);
  for (const [k, v] of Object.entries(siteRules)) assert.equal((await state.setSite(k, v)).ok, true);
  return state;
}
const read = async (state) => (await state.read()).state;
const on = async (state, url) => {
  const s = await read(state);
  return M.siteEnabled(s.settings, s.siteRules, url);
};

test('the switch changes the page it is on, also under a path rule, and keeps the other fields of the rule', async () => {
  const url = 'https://example.com/docs/a';
  const off = await make({ 'example.com/docs': { enabled: false, engine: 'filter', theme: { mode: 'light' } } });
  const r = await off.toggleSite(url);
  assert.deepEqual(r, { ok: true, enabled: true, pattern: 'example.com/docs' });
  assert.equal(await on(off, url), true);
  assert.deepEqual((await read(off)).siteRules['example.com/docs'], { enabled: true, engine: 'filter', theme: { mode: 'light' } });
  assert.equal((await read(off)).siteRules['example.com'], undefined, 'the site rule is not touched');

  const pathOn = await make({ 'example.com': { enabled: false }, 'example.com/docs': { enabled: true } });
  assert.deepEqual(await pathOn.toggleSite(url), { ok: true, enabled: false, pattern: 'example.com/docs' });
  assert.equal(await on(pathOn, url), false);
  assert.equal(await on(pathOn, 'https://example.com/other'), false);

  const host = await make({ 'example.com': { enabled: true, css: 'a{}' } });
  assert.deepEqual(await host.toggleSite(url, false), { ok: true, enabled: false, pattern: 'example.com' });
  assert.equal((await read(host)).siteRules['example.com'].css, 'a{}');
});

test('a parent or wildcard rule is left for the other subdomains: the switch writes the rule of this host', async () => {
  for (const parent of ['example.com', '*.example.com']) {
    const state = await make({ [parent]: { enabled: false } });
    const r = await state.toggleSite('https://www.example.com/x');
    assert.deepEqual(r, { ok: true, enabled: true, pattern: 'www.example.com' });
    assert.equal(await on(state, 'https://www.example.com/x'), true);
    assert.equal(await on(state, 'https://mail.example.com/'), false);
  }
});

test('both list modes: the reply is the state of the page read back from what was saved', async () => {
  for (const listMode of ['allExcept', 'onlyListed']) {
    const state = await make({}, { listMode });
    const url = 'https://a.example.org/p';
    const before = await on(state, url);
    const r = await state.toggleSite(url);
    assert.equal(r.ok, true);
    assert.equal(r.enabled, !before, listMode);
    assert.equal(await on(state, url), r.enabled, listMode);
    assert.equal((await state.toggleSite(url, r.enabled)).enabled, r.enabled, 'setting the same value keeps it');
  }
});

test('a more specific rule that only sets a theme does not hide the switch of its site', () => {
  const rules = { 'example.com': { enabled: false }, 'example.com/docs': { theme: { mode: 'light' } } };
  assert.equal(M.siteEnabled({ listMode: 'allExcept' }, rules, 'https://example.com/docs/x'), false);
  assert.deepEqual(M.findEnabled(rules, 'example.com', '/docs/x'), { key: 'example.com', enabled: false });
  assert.equal(M.switchKey(rules, 'https://example.com/docs/x'), 'example.com');
});

test('two windows that change different fields of one rule keep both changes', async () => {
  const state = await make({ 'a.com': { enabled: true, engine: 'auto', theme: { mode: 'dark', brightness: 100 } } });
  assert.equal((await state.patchSite('a.com', { engine: 'filter' })).ok, true);
  assert.equal((await state.patchSite('a.com', { enabled: false })).ok, true);
  assert.equal((await state.patchSite('a.com', { theme: { brightness: 90 } })).ok, true);
  assert.equal((await state.patchSite('a.com', { theme: { mode: 'light' } })).ok, true);
  assert.deepEqual((await read(state)).siteRules['a.com'], { enabled: false, engine: 'filter', theme: { mode: 'light', brightness: 90 } });
  // The same field: the later change wins.
  await state.patchSite('a.com', { engine: 'dynamic' });
  assert.equal((await read(state)).siteRules['a.com'].engine, 'dynamic');
});

test('a patch removes the fields it names, removes an empty rule, makes a new rule, and keeps the hold of custom CSS', async () => {
  const state = await make({ 'a.com': { enabled: true, theme: { mode: 'dark' } } });
  await state.patchSite('a.com', {}, ['theme.mode']);
  assert.deepEqual((await read(state)).siteRules['a.com'], { enabled: true });
  const gone = await state.patchSite('a.com', {}, ['enabled']);
  assert.deepEqual(gone, { ok: true, pattern: 'a.com', rule: null });
  assert.equal(Object.hasOwn((await read(state)).siteRules, 'a.com'), false);
  assert.equal((await state.patchSite('B.com', { engine: 'filter' })).pattern, 'b.com');
  assert.equal((await state.patchSite('a.com', 'x')).ok, false);
  assert.equal((await state.patchSite('a.com', { engine: 'nope' })).ok, false, 'the result is checked like any rule');
  assert.equal((await state.patchSite('a.com', { cssHeld: false, enabled: true })).ok, true);

  // A held rule stays held when other fields change, and a patch cannot clear the hold.
  const file = S.serializeExport({ ...(await read(state)), siteRules: { 'h.com': { css: 'a{color:red}' } } }, 1);
  assert.equal((await state.importText(file, true)).ok, true);
  assert.equal((await read(state)).siteRules['h.com'].cssHeld, true);
  await state.patchSite('h.com', { engine: 'filter', cssHeld: false });
  assert.equal((await read(state)).siteRules['h.com'].cssHeld, true);
  assert.deepEqual(patchRule({ a: 1 }, { ['__proto__']: { x: 1 }, b: 2 }), { a: 1, b: 2 });
  assert.equal((await state.patchSite('a.com', {}, 'engine')).ok, false, 'remove must be a list');
});

test('null in a site theme is a value, "not the global setting", and a patch keeps it', async () => {
  const state = await make({}, { theme: { whiteCap: 66 } });
  assert.equal((await state.patchSite('b.test', { theme: { mode: 'eink', einkPreset: 'eink', whiteCap: null } })).ok, true);
  assert.deepEqual((await read(state)).siteRules['b.test'].theme, { mode: 'eink', einkPreset: 'eink', whiteCap: null });
  await state.patchSite('b.test', { theme: { brightness: 90 } });
  assert.equal((await read(state)).siteRules['b.test'].theme.whiteCap, null, 'another change keeps the null');
  await state.patchSite('b.test', {}, ['theme.whiteCap', 'theme.einkPreset']);
  assert.deepEqual((await read(state)).siteRules['b.test'].theme, { mode: 'eink', brightness: 90 });
  assert.deepEqual(patchRule({ theme: { a: 1 } }, {}, ['theme.a', 'theme.a.b', '__proto__', 'cssHeld']), {}, 'an empty theme goes, deeper paths are ignored');
});

test('paths keep their empty segments: a rule for /a//b matches its own page and not /a/b', () => {
  const p = S.normalizePattern('example.com/a//b');
  assert.equal(p, 'example.com/a//b');
  assert.deepEqual(M.find({ [p]: { enabled: false } }, 'example.com', '/a//b'), { enabled: false });
  assert.equal(M.find({ [p]: { enabled: false } }, 'example.com', '/a/b'), undefined);
  assert.equal(M.find({ 'example.com/a/b': { enabled: false } }, 'example.com', '/a//b'), undefined, 'no alias of a different path');
  assert.deepEqual(M.find({ 'example.com/a': 1 }, 'example.com', '/a//b'), 1, 'a prefix still matches at a segment boundary');
  assert.equal(M.find({ 'example.com/a': 1 }, 'example.com', '/ab'), undefined);
  assert.deepEqual(M.candidates('example.com', '/a/b/'), ['example.com/a/b', 'example.com/a', 'example.com']);
  assert.deepEqual(M.candidates('example.com', '//a'), ['example.com//a', 'example.com']);
  assert.equal(M.find({ [S.normalizePattern('example.com//a')]: 2 }, 'example.com', '//a'), 2);
  assert.deepEqual(M.candidates('example.com:8080', '/a//b').slice(0, 4), ['example.com:8080/a//b', 'example.com:8080/a', 'example.com:8080', 'example.com/a//b']);
  assert.deepEqual(M.candidates('[::1]:8080', '/x'), ['[::1]:8080/x', '[::1]:8080', '[::1]/x', '[::1]']);
  assert.deepEqual(M.candidates('example.com', '/'), ['example.com']);
});
