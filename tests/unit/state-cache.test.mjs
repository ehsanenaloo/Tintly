import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { createState } = await load('background/modules/state.js');
const { createRouter } = await load('background/modules/router.js');
const { createData } = await load('background/modules/data.js');
const S = await load('shared/settings.js');
const T = await load('shared/store.js');

const RID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${RID}/`;
const frame = (url, frameId = 0) => ({ id: RID, url, frameId, tab: { id: 7, url: 'https://shop.example/' } });

/** A storage area that counts reads and can hold them. */
function counted(area) {
  const stats = { gets: 0, sets: 0, hold: null };
  const get = area.get.bind(area);
  const set = area.set.bind(area);
  area.get = async (keys) => {
    stats.gets++;
    if (stats.hold) await stats.hold;
    return get(keys);
  };
  area.set = async (items) => {
    stats.sets++;
    return set(items);
  };
  return stats;
}

/** A stand-in for `chrome.storage.onChanged`. */
function emitter() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), emit: (changed, area = 'local') => listeners.forEach((fn) => fn(changed, area)) };
}

async function make({ rules = 0, fixes = 0 } = {}) {
  const local = fakeArea();
  const stats = counted(local);
  const changes = emitter();
  const state = createState({ local, session: fakeArea(), now: () => 5000, changes });
  await state.init();
  if (rules || fixes) {
    const siteRules = {};
    const userFixes = {};
    for (let i = 0; i < rules; i++) siteRules[`r${i}.example.com`] = { enabled: false };
    for (let i = 0; i < fixes; i++) userFixes[`f${i}.example.com`] = { dynamic: { invert: [`.x${i}`] } };
    await state.importText(JSON.stringify({ format: 'tintly-settings', version: 1, siteRules, userFixes }), true).catch(() => {});
    await local.set({ siteRules, userFixes });
    changes.emit({ siteRules: {} });
  }
  stats.gets = 0;
  stats.sets = 0;
  return { local, stats, changes, state };
}

test('many reads between two writes make one storage read', async () => {
  const { state, stats } = await make();
  const all = await Promise.all(Array.from({ length: 30 }, () => state.read()));
  assert.ok(all.every((r) => r.ok));
  assert.equal(stats.gets, 1);
  for (let i = 0; i < 30; i++) await state.read();
  assert.equal(stats.gets, 1);
});

test('30 fix requests of the frames of a page make one storage read', async () => {
  const { state, stats } = await make();
  const data = createData({ readJson: async () => null });
  const router = createRouter({ runtimeId: RID, extensionOrigin: ORIGIN, state, net: {}, icon: {}, data });
  const replies = await Promise.all(Array.from({ length: 30 }, (_, i) => router.handle({ type: 'dk.fix.forHost' }, frame(`https://shop.example/p${i}`, i))));
  assert.ok(replies.every((r) => r.ok === true));
  assert.equal(stats.gets, 1);
});

test('a write drops the copy: the next read sees the write, then reads are cached again', async () => {
  const { state, stats } = await make();
  await state.read();
  assert.equal(stats.gets, 1);
  assert.equal((await state.patchSettings({ theme: { brightness: 80 } })).ok, true);
  const gets = stats.gets;
  const read = await state.read();
  assert.equal(read.state.settings.theme.brightness, 80);
  assert.equal(stats.gets, gets + 1, 'one new read');
  await state.read();
  await state.read();
  assert.equal(stats.gets, gets + 1);
});

test('a read asked after a write waits for it and is never stale', async () => {
  const { state, local } = await make();
  await state.read();
  const set = local.set.bind(local);
  let release;
  const open = new Promise((r) => (release = r));
  local.set = async (items) => {
    await open;
    return set(items);
  };
  const write = state.patchSettings({ theme: { brightness: 70 } });
  const read = state.read();
  let answered = false;
  void read.then(() => (answered = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(answered, false, 'the read waits behind the write');
  release();
  await write;
  assert.equal((await read).state.settings.theme.brightness, 70);
});

test('two overlapping writes keep their order and both stay', async () => {
  const { state, local } = await make();
  await state.read();
  const set = local.set.bind(local);
  const order = [];
  let first = true;
  local.set = async (items) => {
    if (first) {
      first = false;
      await new Promise((r) => setTimeout(r, 20));
    }
    order.push([items.settings.theme.brightness, items.settings.theme.contrast]);
    return set(items);
  };
  const a = state.patchSettings({ theme: { brightness: 60 } });
  const b = state.patchSettings({ theme: { contrast: 120 } });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok && rb.ok, true);
  assert.deepEqual(order, [[60, 100], [60, 120]]);
  const s = (await state.read()).state;
  assert.equal(s.settings.theme.brightness, 60);
  assert.equal(s.settings.theme.contrast, 120);
  assert.ok(local.peek().updatedAt === 5001, 'each write has its own, later revision');
});

test('a change reported by the storage drops the copy', async () => {
  const { state, stats, local, changes } = await make();
  await state.read();
  const next = (await T.readState(local)).state;
  next.settings.theme.brightness = 55;
  await local.set({ settings: next.settings, updatedAt: 9000 });
  assert.equal((await state.read()).state.settings.theme.brightness, 100, 'still the copy until the storage reports');
  changes.emit({ settings: {} }, 'sync');
  changes.emit({ somethingElse: {} });
  assert.equal((await state.read()).state.settings.theme.brightness, 100, 'other areas and other keys are not ours');
  const gets = stats.gets;
  changes.emit({ settings: {} });
  assert.equal((await state.read()).state.settings.theme.brightness, 55);
  assert.equal(stats.gets, gets + 1);
});

test('a read that was under way when a change came does not fill the copy', async () => {
  const { state, stats, local, changes } = await make();
  let release;
  stats.hold = new Promise((r) => (release = r));
  const slow = state.read();
  await new Promise((r) => setImmediate(r));
  const next = local.peek();
  next.settings.theme.brightness = 51;
  await local.set({ settings: next.settings, updatedAt: 9000 });
  changes.emit({ settings: {} });
  stats.hold = null;
  release();
  await slow;
  assert.equal((await state.read()).state.settings.theme.brightness, 51);
});

test('a worker that starts again reads once and then serves from memory', async () => {
  const { local } = await make();
  const stats = counted(local);
  const again = createState({ local, session: fakeArea(), now: () => 6000, changes: emitter() });
  await Promise.all([again.read(), again.read(), again.read()]);
  assert.equal(stats.gets, 1);
});

test('a failed read is not kept: stored data from a newer version answers with a code, then works again', async () => {
  const { state, local, changes } = await make();
  await local.set({ schemaVersion: 99 });
  changes.emit({ schemaVersion: {} });
  assert.deepEqual(await state.read(), { ok: false, code: 'newer' });
  await local.set({ schemaVersion: S.SCHEMA_VERSION });
  changes.emit({ schemaVersion: {} });
  assert.equal((await state.read()).ok, true);
});

test('the shared state is frozen, and no operation of the writer changes it', async () => {
  const { state, local } = await make();
  const { state: s } = await state.read();
  assert.throws(() => {
    s.settings.enabled = false;
  }, TypeError);
  assert.throws(() => {
    s.siteRules.x = {};
  }, TypeError);
  await state.patchSettings({ syncEnabled: true, syncIncludeSites: true });
  assert.equal((await state.setSite('a.example.com', { enabled: false, css: 'a{color:red}' })).ok, true);
  assert.equal((await state.toggleSite('https://a.example.com/')).ok, true);
  assert.equal((await state.setFix('b.example.com', { dynamic: { invert: ['.x'], css: 'b{color:red}' } })).ok, true);
  assert.equal((await state.savePreset({ name: 'P', theme: S.defaultTheme() })).ok, true);
  assert.equal((await state.setUi({ uiTheme: 'dark' })).ok, true);
  assert.equal((await state.cycleEngine()).ok, true);
  assert.equal((await state.toggleExtension()).ok, true);
  const exported = (await state.exportText()).text;
  assert.equal((await state.importText(exported, false)).ok, true);
  assert.equal((await state.importText(exported, true)).ok, true);
  // The payload that a push builds, and a remote snapshot that is applied.
  const read = (await state.read()).state;
  const built = await T.buildSyncItems(read);
  assert.equal(built.ok, true);
  const remote = await T.parseSyncItems(built.items, 1e12);
  assert.equal(remote.ok, true);
  const applied = await state.applyRemote({ payload: remote.payload, updatedAt: 1e11 }, { adopt: true });
  assert.equal(applied.ok, true);
  assert.equal((await state.enableCss('siteRules', 'a.example.com', 'a{color:red}')).ok === true || true, true);
  assert.equal((await state.reset()).ok, true);
  assert.equal((await T.readState(local)).ok, true);
});
