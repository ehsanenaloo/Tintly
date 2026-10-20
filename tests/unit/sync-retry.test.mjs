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

/** Timers that run when the test says so. */
function timers() {
  const list = [];
  return {
    list,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      list.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.live = false;
    },
    live: () => list.filter((t) => t.live),
    async fire() {
      const t = list.filter((x) => x.live).at(-1);
      assert.ok(t, 'a timer is waiting');
      t.live = false;
      await t.fn();
    },
  };
}

async function device({ sync = fakeArea({ quota: true }), local = fakeArea(), random = () => 0.5, t = NOW } = {}) {
  const clock = { t };
  const state = createState({ local, session: fakeArea(), now: () => clock.t, changes: null });
  await state.init();
  await state.patchSettings({ syncEnabled: true });
  const tm = timers();
  const syncer = createSync({ local, sync, state, now: () => clock.t, random, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  return { local, sync, state, syncer, tm, clock };
}

/** An area whose writes fail while `broken.on` is true. */
function flaky(area, broken, message = 'offline') {
  const set = area.set.bind(area);
  area.set = async (items) => {
    broken.writes++;
    if (broken.on) throw new Error(message);
    return set(items);
  };
  return area;
}

test('a failed push is tried again after a growing delay with jitter, and stops being retried at the limit', async () => {
  const broken = { on: true, writes: 0 };
  const sync = flaky(fakeArea({ quota: true }), broken);
  const { syncer, tm } = await device({ sync });
  syncer.schedulePush();
  assert.equal(tm.live().at(-1).ms, 2000);
  const delays = [];
  for (let i = 0; i < 12; i++) {
    await tm.fire();
    const next = tm.live().at(-1);
    if (!next) break;
    delays.push(next.ms);
  }
  assert.deepEqual(delays.slice(0, 5), [4000, 8000, 16000, 32000, 64000]);
  assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]), 'never shorter than the one before');
  assert.ok(Math.max(...delays) <= 300_000 * 1.25, 'bounded');
  assert.ok(delays.length < 12, 'the automatic tries end');
  assert.equal(tm.live().length, 0);
});

test('the delay has jitter of a quarter either way', async () => {
  for (const [rnd, factor] of [[0, 0.75], [1, 1.25]]) {
    const broken = { on: true, writes: 0 };
    const { syncer, tm } = await device({ sync: flaky(fakeArea({ quota: true }), broken), random: () => rnd });
    syncer.schedulePush();
    await tm.fire();
    assert.equal(tm.live().at(-1).ms, Math.round(4000 * factor));
  }
});

test('a push that works after failures ends the retries and the next change waits the short time again', async () => {
  const broken = { on: true, writes: 0 };
  const sync = flaky(fakeArea({ quota: true }), broken);
  const { state, syncer, tm, clock } = await device({ sync });
  syncer.schedulePush();
  await tm.fire();
  assert.equal(tm.live().length, 1, 'a retry waits');
  broken.on = false;
  await tm.fire();
  assert.equal(tm.live().length, 0);
  assert.equal((await T.fetchRemote(sync, clock.t)).ok, true);
  clock.t += 10;
  await state.patchSettings({ theme: { brightness: 80 } });
  syncer.schedulePush();
  assert.equal(tm.live().at(-1).ms, 2000);
});

test('data that cannot be sent is not retried', async () => {
  const { state, syncer, tm } = await device();
  // A state over the account limit: the push refuses and no timer is set.
  assert.equal((await state.patchSettings({ syncIncludeSites: true })).ok, true);
  for (const host of ['a.example', 'b.example']) assert.equal((await state.setSite(host, { css: 'a{color:red}'.repeat(8333) })).ok, true);
  const out = await syncer.push();
  assert.equal(out.code, 'too-large');
  assert.equal(tm.live().length, 0);
  await state.patchSettings({ syncEnabled: false });
  assert.deepEqual(await syncer.push(), { ok: false, code: 'disabled' });
  assert.equal(tm.live().length, 0);
});

test('a state that was pulled is not pushed back after the worker restarts', async () => {
  const sync = fakeArea({ quota: true });
  const local = fakeArea();
  const first = await device({ sync, local });
  const other = S.defaultState();
  other.settings.syncEnabled = true;
  other.settings.theme.brightness = 66;
  other.updatedAt = NOW + 500;
  await T.syncPush(sync, other);
  first.clock.t = NOW + 1000;
  assert.equal((await first.syncer.pull()).applied, true);
  const writes = { n: 0 };
  const set = sync.set.bind(sync);
  sync.set = async (items) => {
    writes.n++;
    return set(items);
  };
  assert.deepEqual(await first.syncer.push(), { ok: true, skipped: true });
  // A new worker: new objects around the same storage.
  const state = createState({ local, session: fakeArea(), now: () => NOW + 2000, changes: null });
  const tm = timers();
  const again = createSync({ local, sync, state, now: () => NOW + 2000, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  assert.deepEqual(await again.push(), { ok: true, skipped: true });
  assert.equal(writes.n, 0, 'nothing was written to the account');
  // A local change after that is pushed.
  await state.patchSettings({ theme: { brightness: 70 } });
  assert.equal((await again.push()).ok, true);
  assert.equal(writes.n > 0, true);
});

test('after a restart a local change that was never sent is pushed', async () => {
  const sync = fakeArea({ quota: true });
  const local = fakeArea();
  const first = await device({ sync, local });
  assert.equal((await first.syncer.push()).ok, true);
  first.clock.t += 50;
  await first.state.patchSettings({ theme: { brightness: 77 } });
  // The worker stops before the push. A new one pulls at start.
  const state = createState({ local, session: fakeArea(), now: () => NOW + 5000, changes: null });
  const tm = timers();
  const again = createSync({ local, sync, state, now: () => NOW + 5000, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
  await again.pull();
  assert.equal(tm.live().length, 1, 'a push is planned');
  await tm.fire();
  const remote = await T.fetchRemote(sync, NOW + 5000);
  assert.equal(remote.payload.settings.theme.brightness, 77);
});
