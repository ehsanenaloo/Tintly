import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { createState } = await load('background/modules/state.js');
const S = await load('shared/settings.js');
const T = await load('shared/store.js');

const CSS = 'a{color:red}';

function fileWithCss(css = CSS) {
  const file = S.defaultState();
  file.settings.theme.css = css;
  file.siteRules = { 'a.example': { css } };
  file.userFixes = { 'b.example': { dynamic: { css } } };
  return S.serializeExport(file);
}

async function fresh() {
  const local = fakeArea();
  const state = createState({ local, session: fakeArea() });
  await state.init();
  return { state, local };
}

const held = async (state) => S.heldCss((await state.read()).state);

test('CSS held: data stored before the flag existed keeps its CSS on', async () => {
  const local = fakeArea();
  const old = S.defaultState();
  old.settings.theme.css = CSS;
  delete old.settings.cssHeld;
  await local.set({ schemaVersion: S.SCHEMA_VERSION, updatedAt: 5, settings: old.settings, siteRules: { 'a.example': { css: CSS } }, userFixes: { 'b.example': { dynamic: { css: CSS } } } });
  const state = createState({ local, session: fakeArea() });
  await state.init();
  const read = (await state.read()).state;
  assert.deepEqual(S.heldCss(read), { settings: false, siteRules: [], userFixes: [] });
  assert.equal(read.settings.theme.css, CSS);
  assert.equal(read.siteRules['a.example'].cssHeld, undefined);
});

test('CSS held: an import holds the CSS of all three places and the summary counts them', async () => {
  const { state } = await fresh();
  const preview = await state.importText(fileWithCss(), false);
  assert.equal(preview.summary.heldCss, 3);
  assert.deepEqual(await held(state), { settings: false, siteRules: [], userFixes: [] }, 'a preview writes nothing');
  const done = await state.importText(fileWithCss(), true);
  assert.equal(done.summary.heldCss, 3);
  assert.deepEqual(await held(state), { settings: true, siteRules: ['a.example'], userFixes: ['b.example'] });
  const read = (await state.read()).state;
  assert.equal(read.settings.theme.css, CSS, 'the text is stored, only held');
});

test('CSS held: a file that says cssHeld false is held all the same', async () => {
  const { state } = await fresh();
  const file = JSON.parse(fileWithCss());
  file.settings.cssHeld = false;
  file.siteRules['a.example'].cssHeld = false;
  file.userFixes['b.example'].cssHeld = false;
  assert.equal((await state.importText(JSON.stringify(file), true)).ok, true);
  assert.deepEqual(await held(state), { settings: true, siteRules: ['a.example'], userFixes: ['b.example'] });
});

test('CSS held: a file without CSS holds nothing, and an import without CSS ends an old hold', async () => {
  const { state } = await fresh();
  await state.importText(fileWithCss(), true);
  await state.importText(S.serializeExport(S.defaultState()), true);
  assert.deepEqual(await held(state), { settings: false, siteRules: [], userFixes: [] });
});

test('CSS held: CSS the person already trusts on this device stays on when the same text comes back', async () => {
  const { state } = await fresh();
  await state.patchSettings({ theme: { css: CSS } });
  await state.setSite('a.example', { css: CSS });
  await state.setFix('b.example', { dynamic: { css: CSS } });
  assert.deepEqual(await held(state), { settings: false, siteRules: [], userFixes: [] });
  const done = await state.importText(fileWithCss(), true);
  assert.equal(done.summary.heldCss, 0);
  assert.deepEqual(await held(state), { settings: false, siteRules: [], userFixes: [] });
  const other = await state.importText(fileWithCss('a{color:blue}'), true);
  assert.equal(other.summary.heldCss, 3);
});

test('CSS held: an export carries no flag', async () => {
  const { state } = await fresh();
  await state.importText(fileWithCss(), true);
  const text = (await state.exportText()).text;
  assert.equal(text.includes('cssHeld'), false);
  assert.equal(JSON.parse(text).settings.theme.css, CSS);
});

test('CSS held: edits on this device keep the hold until the person turns it on; empty CSS ends it', async () => {
  const { state } = await fresh();
  await state.importText(fileWithCss(), true);
  assert.equal((await state.patchSettings({ theme: { css: 'a{color:blue}' }, cssHeld: false })).ok, true);
  assert.equal((await state.setSite('a.example', { css: 'b{color:blue}', cssHeld: false })).ok, true);
  assert.equal((await state.setFix('b.example', { note: 'x', dynamic: { css: 'c{color:blue}' } })).ok, true);
  assert.deepEqual(await held(state), { settings: true, siteRules: ['a.example'], userFixes: ['b.example'] });
  await state.patchSettings({ theme: { css: '' } });
  await state.setSite('a.example', { enabled: true });
  await state.setFix('b.example', { note: 'x' });
  assert.deepEqual(await held(state), { settings: false, siteRules: [], userFixes: [] });
  await state.patchSettings({ theme: { css: CSS } });
  assert.deepEqual(await held(state), { settings: false, siteRules: [], userFixes: [] }, 'CSS typed after the hold ended is the person\'s');
});

test('CSS held: a rule written with a flag set by the page is not held when it was not held before', async () => {
  const { state } = await fresh();
  assert.equal((await state.setSite('c.example', { css: CSS, cssHeld: true })).ok, true);
  assert.equal((await state.read()).state.siteRules['c.example'].cssHeld, undefined);
});

test('CSS held: turning on needs the text that was shown', async () => {
  const { state } = await fresh();
  await state.importText(fileWithCss(), true);
  assert.deepEqual(await state.enableCss('settings', undefined, 'other'), { ok: false, code: 'changed' });
  assert.deepEqual(await state.enableCss('siteRules', 'a.example', 'other'), { ok: false, code: 'changed' });
  assert.deepEqual(await state.enableCss('userFixes', 'b.example', 'other'), { ok: false, code: 'changed' });
  assert.deepEqual(await state.enableCss('siteRules', 'none.example', CSS), { ok: false, code: 'invalid' });
  assert.deepEqual(await state.enableCss('presets', 'a.example', CSS), { ok: false, code: 'invalid' });
  assert.deepEqual(await state.enableCss('settings', undefined, 5), { ok: false, code: 'invalid' });
  assert.deepEqual(await held(state), { settings: true, siteRules: ['a.example'], userFixes: ['b.example'] });
  assert.equal((await state.enableCss('siteRules', 'a.example', CSS)).ok, true);
  assert.deepEqual(await held(state), { settings: true, siteRules: [], userFixes: ['b.example'] });
  assert.equal((await state.enableCss('userFixes', 'b.example', CSS)).ok, true);
  assert.equal((await state.enableCss('settings', undefined, CSS)).ok, true);
  assert.deepEqual(await held(state), { settings: false, siteRules: [], userFixes: [] });
  const read = (await state.read()).state;
  assert.equal(read.siteRules['a.example'].css, CSS);
  assert.equal(read.userFixes['b.example'].dynamic.css, CSS);
});

test('CSS held: reset clears the hold with the CSS', async () => {
  const { state } = await fresh();
  await state.importText(fileWithCss(), true);
  await state.reset();
  assert.deepEqual(await held(state), { settings: false, siteRules: [], userFixes: [] });
  assert.equal((await state.read()).state.settings.theme.css, '');
});

/* ----- sync ----- */

async function syncedDevices() {
  const sync = fakeArea({ quota: true });
  const a = fakeArea();
  const b = fakeArea();
  return { sync, a, b };
}

function deviceState(css, updatedAt) {
  const s = S.defaultState();
  s.settings.syncEnabled = true;
  s.settings.syncIncludeSites = true;
  s.settings.theme.css = css;
  s.siteRules = { 'a.example': { css } };
  s.userFixes = { 'b.example': { dynamic: { css } } };
  s.updatedAt = updatedAt;
  return s;
}

async function put(area, s) {
  await area.set({ schemaVersion: S.SCHEMA_VERSION, updatedAt: s.updatedAt, settings: s.settings, siteRules: s.siteRules, userFixes: s.userFixes, presets: s.presets, darkSites: s.darkSites });
}

test('CSS held: sync pushes no flag, and a pull holds CSS that this device did not have', async () => {
  const { sync, a, b } = await syncedDevices();
  const remote = deviceState(CSS, 500);
  remote.settings.cssHeld = true;
  remote.siteRules['a.example'].cssHeld = true;
  await T.syncPush(sync, remote);
  assert.equal(JSON.stringify(sync.peek()).includes('cssHeld'), false);
  await put(b, deviceState('', 1));
  const r = await T.syncPull(sync, b);
  assert.equal(r.applied, true);
  const read = (await T.readState(b)).state;
  assert.deepEqual(S.heldCss(read), { settings: true, siteRules: ['a.example'], userFixes: ['b.example'] });
  void a;
});

test('CSS held: a pull of the same CSS this device already trusts changes nothing about the hold', async () => {
  const { sync, b } = await syncedDevices();
  await T.syncPush(sync, deviceState(CSS, 500));
  await put(b, deviceState(CSS, 1));
  assert.equal((await T.syncPull(sync, b)).applied, true);
  assert.deepEqual(S.heldCss((await T.readState(b)).state), { settings: false, siteRules: [], userFixes: [] });
});

test('CSS held: a pull of the same CSS that is still held keeps it held', async () => {
  const { sync, b } = await syncedDevices();
  await T.syncPush(sync, deviceState(CSS, 500));
  const local = deviceState(CSS, 1);
  local.settings.cssHeld = true;
  local.siteRules['a.example'].cssHeld = true;
  local.userFixes['b.example'].cssHeld = true;
  await put(b, local);
  await T.syncPull(sync, b);
  assert.deepEqual(S.heldCss((await T.readState(b)).state), { settings: true, siteRules: ['a.example'], userFixes: ['b.example'] });
});

test('CSS held: with site data left out of sync, a pull holds the global CSS only and leaves the sites alone', async () => {
  const { sync, b } = await syncedDevices();
  const remote = deviceState(CSS, 500);
  await T.syncPush(sync, remote);
  const local = deviceState('', 1);
  local.settings.syncIncludeSites = false;
  local.siteRules = { 'a.example': { css: 'x{}' } };
  local.userFixes = Object.create(null);
  await put(b, local);
  await T.syncPull(sync, b);
  const read = (await T.readState(b)).state;
  assert.deepEqual(S.heldCss(read), { settings: true, siteRules: [], userFixes: [] });
  assert.equal(read.siteRules['a.example'].css, 'x{}');
});

/* ----- the gate ----- */

test('CSS held: the gate leaves out the CSS of a held record', async () => {
  const text = (await import('node:fs')).readFileSync(join(REPO, 'extension', 'content', 'core', 'boot.js'), 'utf8');
  assert.match(text, /settings\.cssHeld === true \? '' : globalCss/);
  assert.match(text, /rule\.cssHeld !== true \? rule\.css/);
  assert.match(text, /userFix\.cssHeld === true \? '' : dyn\.css/);
});
