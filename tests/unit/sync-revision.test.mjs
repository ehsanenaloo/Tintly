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

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** The items another device would have written, with the revision of the meta item replaced. */
async function snapshot({ brightness = 90, updatedAt }) {
  const s = S.defaultState();
  s.settings.syncEnabled = true;
  s.settings.theme.brightness = brightness;
  s.updatedAt = 1;
  const built = await T.buildSyncItems(s);
  built.items['dk.sync.meta'].updatedAt = updatedAt;
  return built.items;
}

async function device({ sync = fakeArea({ quota: true }) } = {}) {
  const local = fakeArea();
  let t = NOW;
  const clock = { set: (v) => (t = v), get: () => t };
  const state = createState({ local, session: fakeArea(), now: () => t });
  await state.init();
  await state.patchSettings({ syncEnabled: true });
  const syncer = createSync({ local, sync, state, now: () => t, setTimer: () => 1, clearTimer: () => {} });
  return { local, sync, state, syncer, clock };
}

const brightness = (local) => local.peek().settings.theme.brightness;

test('a remote revision outside the plausible range is refused or read as zero', async () => {
  for (const bad of [1e300, Number.MAX_SAFE_INTEGER, NOW + 10 * 365 * DAY, NOW + 2 * DAY, Infinity]) {
    const r = await T.parseSyncItems(await snapshot({ updatedAt: bad }), NOW);
    assert.deepEqual(r, { ok: false, code: 'broken' }, String(bad));
  }
  for (const odd of [-5, NaN, '123', null, undefined]) {
    const r = await T.parseSyncItems(await snapshot({ updatedAt: odd }), NOW);
    assert.equal(r.ok, true);
    assert.equal(r.updatedAt, 0, String(odd));
  }
  const near = await T.parseSyncItems(await snapshot({ updatedAt: NOW + 23 * 60 * 60 * 1000 }), NOW);
  assert.equal(near.ok, true);
  assert.equal(near.updatedAt, NOW + 23 * 60 * 60 * 1000);
});

test('a snapshot with a huge revision is not adopted and a later genuine edit is applied', async () => {
  for (const bad of [1e300, Number.MAX_SAFE_INTEGER, NOW + 10 * 365 * DAY]) {
    const { local, sync, syncer, clock } = await device();
    await sync.set(await snapshot({ brightness: 60, updatedAt: bad }));
    const first = await syncer.pull();
    assert.equal(first.ok, false, String(bad));
    assert.equal(brightness(local), 100);
    assert.ok(local.peek().updatedAt <= NOW + 1000);
    // Another device writes a normal snapshot later.
    clock.set(NOW + 5000);
    await sync.set(await snapshot({ brightness: 70, updatedAt: NOW + 4000 }));
    const second = await syncer.pull();
    assert.equal(second.applied, true, String(bad));
    assert.equal(brightness(local), 70);
  }
});

test('a push replaces a snapshot with a bad revision, so the account heals', async () => {
  const { local, sync, state, syncer, clock } = await device();
  await sync.set(await snapshot({ brightness: 60, updatedAt: 1e300 }));
  clock.set(NOW + 10);
  await state.patchSettings({ theme: { brightness: 80 } });
  const r = await syncer.push();
  assert.equal(r.ok, true);
  const remote = await T.fetchRemote(sync, NOW + 20);
  assert.equal(remote.ok, true);
  assert.equal(remote.updatedAt, local.peek().updatedAt);
});

test('a join reads a bad snapshot as nothing and sends this device', async () => {
  const { sync, syncer } = await device();
  await sync.set(await snapshot({ brightness: 60, updatedAt: 1e300 }));
  const r = await syncer.join();
  assert.equal(r.ok, true);
  assert.equal((await T.fetchRemote(sync, NOW)).ok, true);
});

test('a local revision far in the future is repaired and sync recovers', async () => {
  for (const bad of [1e300, Number.MAX_SAFE_INTEGER, 8.64e15]) {
    const { local, sync, state, syncer, clock } = await device();
    await local.set({ updatedAt: bad });
    const read = await state.read();
    assert.equal(read.ok, true);
    assert.ok(read.state.updatedAt <= NOW + DAY, `${bad} read as ${read.state.updatedAt}`);
    // The repair is stored, so the value is the same on the next read.
    assert.equal(local.peek().updatedAt, read.state.updatedAt);
    assert.equal((await state.read()).state.updatedAt, read.state.updatedAt);
    await state.patchSettings({ theme: { contrast: 110 } });
    assert.ok(local.peek().updatedAt <= NOW + DAY, 'a new edit does not continue the bad value');
    clock.set(NOW + 9000);
    await sync.set(await snapshot({ brightness: 75, updatedAt: NOW + 8000 }));
    assert.equal((await syncer.pull()).applied, true);
    assert.equal(brightness(local), 75);
  }
});

test('readState clamps a revision beyond a day ahead and keeps the others', async () => {
  const area = fakeArea();
  await area.set({ schemaVersion: S.SCHEMA_VERSION, updatedAt: 1e300 });
  const bad = await T.readState(area, NOW);
  assert.equal(bad.ok, true);
  assert.equal(bad.state.updatedAt, NOW);
  assert.equal(bad.changed, true);
  await area.set({ updatedAt: NOW + 3600_000 });
  assert.equal((await T.readState(area, NOW)).state.updatedAt, NOW + 3600_000);
  assert.equal(T.clampRevision(-1, NOW), 0);
  assert.equal(T.clampRevision(NaN, NOW), 0);
});
