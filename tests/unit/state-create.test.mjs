import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { createState } = await load('background/modules/state.js');
const { createRouter } = await load('background/modules/router.js');
const S = await load('shared/settings.js');

const RID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${RID}/`;
const PAGE = { id: RID, url: `${ORIGIN}pages/fixes/fixes.html` };

async function make(options = {}) {
  const local = fakeArea();
  const state = createState({ local, session: fakeArea(), now: () => 1234, ...options });
  await state.init();
  const router = createRouter({ runtimeId: RID, extensionOrigin: ORIGIN, state, net: {}, icon: {}, data: { forHost: async () => ({}) } });
  return { local, state, router };
}

/* ---------- preset ids ---------- */

test('new presets saved at the same millisecond keep distinct ids', async () => {
  const { state, local } = await make();
  const theme = S.defaultTheme();
  const ids = new Set();
  for (let i = 0; i < 10; i++) {
    const r = await state.savePreset({ name: `N${i}`, theme });
    assert.equal(r.ok, true);
    assert.match(r.id, /^[a-z0-9-]+$/);
    assert.ok(r.id.length <= 40);
    ids.add(r.id);
  }
  assert.equal(ids.size, 10);
  assert.equal(local.peek().presets.length, 10);
});

test('a generated id that is taken is replaced by another one', async () => {
  const seq = ['p-a', 'p-a', 'p-b'];
  const { state, local } = await make({ newId: () => seq.shift() });
  const theme = S.defaultTheme();
  assert.equal((await state.savePreset({ name: 'One', theme })).id, 'p-a');
  assert.equal((await state.savePreset({ name: 'Two', theme })).id, 'p-b');
  assert.deepEqual(local.peek().presets.map((p) => p.name), ['One', 'Two']);
});

test('an explicit id replaces only its own preset', async () => {
  const { state, local } = await make();
  const theme = S.defaultTheme();
  const a = (await state.savePreset({ name: 'A', theme })).id;
  const b = (await state.savePreset({ name: 'B', theme })).id;
  assert.equal((await state.savePreset({ id: a, name: 'A2', theme })).id, a);
  const byId = Object.fromEntries(local.peek().presets.map((p) => [p.id, p.name]));
  assert.deepEqual(byId, { [a]: 'A2', [b]: 'B' });
});

/* ---------- create if absent ---------- */

test('adding a fix that exists keeps it, also under another spelling', async () => {
  const { state, local } = await make();
  const fix = { note: 'mine', dynamic: { css: 'a { color: red; }' }, engine: 'filter' };
  assert.equal((await state.setFix('example.com', fix)).ok, true);
  const before = local.peek().userFixes;
  for (const spelling of ['example.com', 'EXAMPLE.COM', ' Example.com/ ']) {
    const r = await state.setFix(spelling, {}, true);
    assert.deepEqual(r, { ok: true, created: false, pattern: 'example.com' });
  }
  assert.deepEqual(local.peek().userFixes, before);
});

test('adding a site that exists keeps its rule', async () => {
  const { state, local } = await make();
  assert.equal((await state.setSite('example.com', { enabled: false, engine: 'filter', css: 'b{color:red}' })).ok, true);
  const before = local.peek().siteRules;
  assert.deepEqual(await state.setSite('EXAMPLE.com', { enabled: true }, true), { ok: true, created: false, pattern: 'example.com' });
  assert.deepEqual(local.peek().siteRules, before);
});

test('adding a new entry creates it and names the stored pattern', async () => {
  const { state, local } = await make();
  assert.deepEqual(await state.setFix('New.Example.com', {}, true), { ok: true, created: true, pattern: 'new.example.com' });
  assert.deepEqual(await state.setSite('New.Example.com', { enabled: true }, true), { ok: true, created: true, pattern: 'new.example.com' });
  assert.deepEqual(Object.keys(local.peek().userFixes), ['new.example.com']);
  assert.deepEqual(Object.keys(local.peek().siteRules), ['new.example.com']);
});

test('two pages that add the same site at once do not erase each other', async () => {
  const { state, local } = await make();
  const first = state.setFix('race.example.com', { note: 'first' }, true);
  const second = state.setFix('race.example.com', { note: 'second' }, true);
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.created, b.created], [true, false]);
  assert.equal(local.peek().userFixes['race.example.com'].note, 'first');
});

test('without ifAbsent a set still replaces', async () => {
  const { state, local } = await make();
  await state.setFix('example.com', { note: 'old' });
  assert.deepEqual(await state.setFix('example.com', { note: 'new' }), { ok: true });
  assert.equal(local.peek().userFixes['example.com'].note, 'new');
});

test('the worker takes ifAbsent as a flag and refuses other values', async () => {
  const { router, local } = await make();
  const ask = (message) => router.handle(message, PAGE);
  assert.equal((await ask({ type: 'dk.fix.set', pattern: 'a.example.com', fix: { note: 'x' } })).ok, true);
  assert.deepEqual(await ask({ type: 'dk.fix.set', pattern: 'A.example.com', fix: {}, ifAbsent: true }), { ok: true, created: false, pattern: 'a.example.com' });
  assert.equal(local.peek().userFixes['a.example.com'].note, 'x');
  assert.deepEqual(await ask({ type: 'dk.fix.set', pattern: 'b.example.com', fix: {}, ifAbsent: 'yes' }), { ok: false, code: 'invalid' });
  assert.deepEqual(await ask({ type: 'dk.site.set', pattern: 'b.example.com', rule: {}, ifAbsent: 1 }), { ok: false, code: 'invalid' });
  assert.deepEqual(await ask({ type: 'dk.site.set', pattern: 'b.example.com', rule: { enabled: true }, ifAbsent: true }), { ok: true, created: true, pattern: 'b.example.com' });
  assert.deepEqual(await ask({ type: 'dk.site.set', pattern: 'b.example.com', rule: { enabled: false }, ifAbsent: true }), { ok: true, created: false, pattern: 'b.example.com' });
  assert.equal(local.peek().siteRules['b.example.com'].enabled, true);
});
