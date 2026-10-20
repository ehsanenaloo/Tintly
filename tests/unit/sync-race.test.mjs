import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { createState } = await load('background/modules/state.js');
const { createSync } = await load('background/modules/sync.js');
const S = await load('shared/settings.js');
const T = await load('shared/store.js');
const { SYNC } = await load('shared/limits.js');

/** Hold every read of an area until `release()`; `hit` resolves when the first read waits. */
function gate(area) {
  let release;
  let hit;
  const open = new Promise((r) => (release = r));
  const reached = new Promise((r) => (hit = r));
  const get = area.get.bind(area);
  area.get = async (keys) => {
    hit();
    await open;
    return get(keys);
  };
  return { release, reached };
}

/** A remote snapshot as another device would have pushed it. */
async function pushRemote(sync, { updatedAt, brightness = 90, sites = false, rules = 0 }) {
  const s = S.defaultState();
  s.settings.syncEnabled = true;
  s.settings.syncIncludeSites = sites;
  s.settings.theme.brightness = brightness;
  s.updatedAt = updatedAt;
  for (let i = 0; i < rules; i++) s.siteRules[`r${i}.example.com`] = { enabled: false, css: 'a{color:red;background:blue}'.repeat(3) };
  await T.syncPush(sync, s);
}

async function device({ at = 100, enabled = true } = {}) {
  const local = fakeArea();
  const remote = fakeArea({ quota: true });
  let t = at;
  const clock = { set: (v) => (t = v) };
  const state = createState({ local, session: fakeArea(), now: () => t });
  await state.init();
  if (enabled) await state.patchSettings({ syncEnabled: true });
  const sync = createSync({ local, sync: remote, state, setTimer: () => 1, clearTimer: () => {} });
  return { local, remote, state, sync, clock };
}

const brightness = (local) => local.peek().settings.theme.brightness;

test('a pull that waits for the remote does not roll back a newer local change', async () => {
  const { local, remote, state, sync, clock } = await device();
  await pushRemote(remote, { updatedAt: 200 });
  const g = gate(remote);
  const pull = sync.pull();
  await g.reached;
  clock.set(300);
  await state.patchSettings({ theme: { brightness: 120 } });
  g.release();
  const r = await pull;
  assert.equal(r.applied, false);
  assert.equal(brightness(local), 120);
  assert.equal(local.peek().updatedAt, 300);
});

test('turning Sync off while a pull waits keeps it off', async () => {
  const { local, remote, state, sync, clock } = await device();
  await pushRemote(remote, { updatedAt: 200 });
  const g = gate(remote);
  const pull = sync.pull();
  await g.reached;
  clock.set(150);
  await state.patchSettings({ syncEnabled: false });
  g.release();
  assert.deepEqual(await pull, { ok: false, code: 'disabled' });
  assert.equal(local.peek().settings.syncEnabled, false);
  assert.equal(brightness(local), 100);
});

test('turning site sync off while a pull waits keeps the local sites', async () => {
  const { local, remote, state, sync, clock } = await device();
  await state.patchSettings({ syncIncludeSites: true });
  await state.setSite('mine.example.com', { enabled: false });
  await pushRemote(remote, { updatedAt: 200, sites: true, rules: 2 });
  const g = gate(remote);
  const pull = sync.pull();
  await g.reached;
  clock.set(150);
  await state.patchSettings({ syncIncludeSites: false });
  g.release();
  assert.equal((await pull).applied, true);
  assert.deepEqual(Object.keys(local.peek().siteRules), ['mine.example.com']);
});

test('two overlapping pulls apply the remote once', async () => {
  const { local, remote, sync } = await device();
  await pushRemote(remote, { updatedAt: 200 });
  let writes = 0;
  const set = local.set;
  local.set = async (items) => {
    if ('settings' in items) writes += 1;
    return set(items);
  };
  const g = gate(remote);
  const first = sync.pull();
  const second = sync.pull();
  await g.reached;
  g.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.applied, true);
  assert.equal(b.applied, false);
  assert.equal(writes, 1);
  assert.equal(brightness(local), 90);
});

test('an import made while a pull waits is not rolled back', async () => {
  const { local, remote, state, sync, clock } = await device();
  const other = createState({ local: fakeArea(), session: fakeArea(), now: () => 1 });
  await other.init();
  await other.patchSettings({ theme: { brightness: 70 } });
  const text = (await other.exportText()).text;
  await pushRemote(remote, { updatedAt: 200 });
  const g = gate(remote);
  const pull = sync.pull();
  await g.reached;
  clock.set(300);
  assert.equal((await state.importText(text, true)).applied, true);
  g.release();
  assert.equal((await pull).applied, false);
  assert.equal(brightness(local), 70);
});

test('a reset made while a pull waits is not rolled back', async () => {
  const { local, remote, state, sync, clock } = await device();
  await pushRemote(remote, { updatedAt: 200 });
  const g = gate(remote);
  const pull = sync.pull();
  await g.reached;
  clock.set(300);
  assert.equal((await state.reset()).ok, true);
  g.release();
  const r = await pull;
  assert.notEqual(r.applied, true);
  assert.equal(brightness(local), 100);
});

test('a failed commit answers with a code and the queue keeps working', async () => {
  const { local, remote, state, sync } = await device();
  await pushRemote(remote, { updatedAt: 200 });
  const set = local.set;
  let fail = true;
  local.set = async (items) => {
    if (fail) {
      fail = false;
      throw new Error('disk');
    }
    return set(items);
  };
  assert.equal((await sync.pull()).ok, false);
  assert.equal((await state.patchSettings({ theme: { contrast: 110 } })).ok, true);
  assert.equal((await sync.pull()).applied, true);
  assert.equal(brightness(local), 90);
});

test('a change of the page look does not move the revision', async () => {
  const { local, state, clock } = await device();
  const before = local.peek().updatedAt;
  clock.set(900);
  assert.equal((await state.setUi({ uiTheme: 'dark' })).ok, true);
  assert.equal(local.peek().ui.uiTheme, 'dark');
  assert.equal(local.peek().updatedAt, before);
});

test('a newer remote still applies after a local page-look change', async () => {
  const { local, remote, state, sync, clock } = await device();
  await pushRemote(remote, { updatedAt: 200 });
  clock.set(300);
  await state.setUi({ uiTheme: 'dark' });
  assert.equal((await sync.pull()).applied, true);
  assert.equal(brightness(local), 90);
  assert.equal(local.peek().ui.uiTheme, 'dark');
});

test('the revision grows with every change, also when the clock goes back', async () => {
  const { local, state, clock } = await device({ at: 1000 });
  const a = local.peek().updatedAt;
  clock.set(500);
  await state.patchSettings({ theme: { contrast: 110 } });
  const b = local.peek().updatedAt;
  assert.ok(b > a);
  await state.patchSettings({ theme: { contrast: 120 } });
  assert.ok(local.peek().updatedAt > b);
});

test('a revision equal to the remote one is not applied', async () => {
  const { local, remote, sync } = await device({ at: 200 });
  await pushRemote(remote, { updatedAt: local.peek().updatedAt, brightness: 55 });
  assert.equal((await sync.pull()).applied, false);
  assert.equal(brightness(local), 100);
});

test('a push does not overwrite a newer remote: it takes the remote first', async () => {
  const { local, remote, sync } = await device({ at: 100 });
  await pushRemote(remote, { updatedAt: 500, brightness: 60 });
  const r = await sync.push();
  assert.equal(r.ok, true);
  assert.equal(brightness(local), 60);
  const back = await T.parseSyncItems(remote.peek());
  assert.equal(back.updatedAt, 500);
  assert.equal(back.payload.settings.theme.brightness, 60);
});

test('a push of a newer local state replaces the remote', async () => {
  const { remote, state, sync, clock } = await device({ at: 100 });
  await pushRemote(remote, { updatedAt: 50, brightness: 60 });
  clock.set(900);
  await state.patchSettings({ theme: { brightness: 130 } });
  assert.equal((await sync.push()).ok, true);
  const back = await T.parseSyncItems(remote.peek());
  assert.equal(back.payload.settings.theme.brightness, 130);
});

test('joining: a device that turns Sync on takes the remote data, even an older one, and does not push over it', async () => {
  const { local, remote, state, sync, clock } = await device({ enabled: false });
  clock.set(900);
  await state.patchSettings({ theme: { brightness: 140 } });
  await pushRemote(remote, { updatedAt: 500, brightness: 60 });
  await state.patchSettings({ syncEnabled: true });
  const r = await sync.join();
  assert.equal(r.applied, true);
  assert.equal(brightness(local), 60);
  assert.equal(local.peek().settings.syncEnabled, true);
  assert.equal((await T.parseSyncItems(remote.peek())).payload.settings.theme.brightness, 60);
  assert.equal((await sync.push()).skipped, true);
});

test('joining: with nothing in the account yet, the device pushes its data', async () => {
  const { remote, state, sync } = await device({ enabled: false });
  await state.patchSettings({ theme: { brightness: 140 }, syncEnabled: true });
  assert.equal((await sync.join()).ok, true);
  assert.equal((await T.parseSyncItems(remote.peek())).payload.settings.theme.brightness, 140);
});

test('a remote written by a newer format is neither read nor replaced', async () => {
  const { remote, sync } = await device();
  await pushRemote(remote, { updatedAt: 200 });
  const items = remote.peek();
  items[`${SYNC.PREFIX}meta`].v = 2;
  await remote.set(items);
  const before = remote.peek();
  assert.equal((await sync.push()).ok, false);
  assert.equal((await sync.pull()).ok, false);
  assert.deepEqual(remote.peek(), before);
});

test('a push keeps the chunks of a snapshot that another device wrote meanwhile', async () => {
  const sync = fakeArea({ quota: true });
  const small = await buildState({ rules: 1, updatedAt: 10 });
  const big = await buildState({ rules: 400, updatedAt: 20 });
  const bigItems = (await T.buildSyncItems(big)).items;
  assert.ok(Object.keys(bigItems).length > 3);
  const get = sync.get.bind(sync);
  let raced = false;
  sync.get = async (keys) => {
    if (keys === null && !raced) {
      raced = true;
      await sync.set(bigItems);
    }
    return get(keys);
  };
  await T.syncPush(sync, small);
  const back = await T.parseSyncItems(sync.peek());
  assert.equal(back.ok, true);
  assert.equal(back.updatedAt, 20);
});

async function buildState({ rules, updatedAt }) {
  const s = S.defaultState();
  s.settings.syncEnabled = true;
  s.settings.syncIncludeSites = true;
  s.updatedAt = updatedAt;
  for (let i = 0; i < rules; i++) s.siteRules[`r${i}.example.com`] = { enabled: false, css: 'a{color:red;background:blue}'.repeat(3) };
  return s;
}
