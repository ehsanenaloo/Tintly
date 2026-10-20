import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { createState } = await load('background/modules/state.js');
const { createSync, PENDING_KEY } = await load('background/modules/sync.js');
const { createAlarms, SYNC_RETRY, MIN_ALARM_MS } = await load('background/modules/alarms.js');
const S = await load('shared/settings.js');
const T = await load('shared/store.js');

const NOW = 1_800_000_000_000;

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

/** One run of the worker around storage that outlives it. */
async function worker({ local, sync, clock, alarm, enabled = true, init = false }) {
  const state = createState({ local, session: fakeArea(), now: () => clock.t, changes: null });
  if (init) {
    await state.init();
    if (enabled) await state.patchSettings({ syncEnabled: true });
  }
  const tm = timers();
  const syncer = createSync({ local, sync, state, now: () => clock.t, random: () => 0.5, setTimer: tm.setTimer, clearTimer: tm.clearTimer, retryAlarm: alarm });
  return { state, syncer, tm };
}

/** Storage that outlives the workers, and switches that make the account fail (offline). */
function world() {
  const local = fakeArea();
  const sync = fakeArea({ quota: true });
  const net = { writesFail: false, readsFail: false, writes: 0 };
  const set = sync.set.bind(sync);
  const get = sync.get.bind(sync);
  sync.set = async (items) => {
    net.writes++;
    if (net.writesFail) throw new Error('offline');
    return set(items);
  };
  sync.get = async (keys) => {
    if (net.readsFail) throw new Error('offline');
    return get(keys);
  };
  return { local, sync, net, clock: { t: NOW } };
}

const pending = (w) => w.local.peek()[PENDING_KEY];

/* ---------- an empty account ---------- */

test('an empty account with Sync on and an unsent revision gets an upload', async () => {
  const w = world();
  const { syncer, tm } = await worker({ ...w, init: true });
  assert.deepEqual(await syncer.pull(), { ok: false, code: 'none' });
  assert.equal(tm.live().length, 1, 'a push is planned');
  assert.equal(tm.live()[0].ms, 2000);
  await tm.fire();
  const remote = await T.fetchRemote(w.sync, w.clock.t);
  assert.equal(remote.ok, true);
});

test('Sync off never uploads, also to an empty account', async () => {
  const w = world();
  const { syncer, tm } = await worker({ ...w, init: true, enabled: false });
  assert.deepEqual(await syncer.pull(), { ok: false, code: 'disabled' });
  assert.deepEqual(await syncer.push(), { ok: false, code: 'disabled' });
  assert.deepEqual(await syncer.recover(), { ok: true, code: 'none' });
  assert.equal(tm.live().length, 0);
  assert.equal(w.net.writes, 0);
});

test('a failed read of the account is not an empty account', async () => {
  const w = world();
  const { syncer, tm } = await worker({ ...w, init: true });
  w.net.readsFail = true;
  assert.deepEqual(await syncer.pull(), { ok: false, code: 'error' });
  assert.equal(tm.live().length, 0, 'nothing is planned by a pull that could not read');
  assert.equal(w.net.writes, 0);
});

test('an account of a newer format is kept: a pull plans nothing and a push writes nothing', async () => {
  const w = world();
  await w.sync.set({ 'dk.sync.meta': { v: 2, n: 0, updatedAt: NOW + 1 } });
  const before = w.sync.peek();
  const { syncer, tm } = await worker({ ...w, init: true });
  assert.equal((await syncer.pull()).code, 'newer');
  assert.equal((await syncer.push()).code, 'newer');
  assert.equal((await syncer.join()).code, 'newer');
  assert.equal(tm.live().length, 0);
  assert.deepEqual(w.sync.peek(), before);
});

test('a broken snapshot is not replaced by a pull', async () => {
  const w = world();
  await w.sync.set({ 'dk.sync.meta': { v: 1, n: 1, hash: 'x', updatedAt: NOW - 5 }, 'dk.sync.0': '{}' });
  const before = w.sync.peek();
  const { syncer, tm } = await worker({ ...w, init: true });
  assert.equal((await syncer.pull()).code, 'broken');
  assert.equal(tm.live().length, 0);
  assert.deepEqual(w.sync.peek(), before);
});

test('an empty account and a state that is the one last taken from the account plan nothing', async () => {
  const w = world();
  const first = await worker({ ...w, init: true });
  const other = S.defaultState();
  other.settings.syncEnabled = true;
  other.settings.theme.brightness = 66;
  other.updatedAt = NOW + 500;
  await T.syncPush(w.sync, other);
  w.clock.t = NOW + 1000;
  assert.equal((await first.syncer.pull()).applied, true);
  await w.sync.remove(Object.keys(w.sync.peek()));
  assert.deepEqual(await first.syncer.pull(), { ok: false, code: 'none' });
  assert.equal(first.tm.live().length, 0, 'nothing is unsent');
});

/* ---------- a push that waits survives the worker ---------- */

test('a failed push is written down, and a new worker started by any event sends it without another change', async () => {
  const w = world();
  const first = await worker({ ...w, init: true });
  w.net.writesFail = true;
  first.syncer.schedulePush();
  await first.tm.fire();
  await first.syncer.settled();
  assert.equal(first.tm.live().length, 1, 'the retry waits in memory');
  assert.deepEqual(pending(w), { revision: pending(w).revision, failures: 1, next: NOW + 4000 });
  // The worker is stopped: its timer and its state are gone. The network is back. A new worker starts for an ordinary event.
  w.net.writesFail = false;
  w.clock.t = NOW + 1000;
  const next = await worker({ ...w });
  assert.deepEqual(await next.syncer.recover(), { ok: true, code: 'planned' });
  assert.equal(next.tm.live().length, 1);
  assert.equal(next.tm.live()[0].ms, 3000, 'the time of the record, not a new delay');
  await next.tm.fire();
  await next.syncer.settled();
  assert.equal((await T.fetchRemote(w.sync, w.clock.t)).ok, true, 'the revision reached the account');
  assert.equal(pending(w), undefined, 'the record is gone');
});

test('the failure count survives restarts, so the backoff keeps growing', async () => {
  const w = world();
  let current = await worker({ ...w, init: true });
  w.net.writesFail = true;
  current.syncer.schedulePush();
  const waits = [];
  for (let i = 0; i < 4; i++) {
    await current.tm.fire();
    await current.syncer.settled();
    waits.push(pending(w).next - w.clock.t);
    // Restart: a new worker around the same storage, at the time the record says.
    w.clock.t = pending(w).next;
    current = await worker({ ...w });
    await current.syncer.recover();
    assert.equal(current.tm.live()[0].ms, 0);
  }
  assert.deepEqual(waits, [4000, 8000, 16000, 32000]);
});

test('offline: the read of the account fails, the push is tried again later and then goes through', async () => {
  const w = world();
  const { syncer, tm } = await worker({ ...w, init: true });
  w.net.readsFail = true;
  syncer.schedulePush();
  await tm.fire();
  await syncer.settled();
  assert.equal(tm.live().length, 1, 'planned again');
  assert.equal(pending(w).failures, 1);
  assert.equal(w.net.writes, 0, 'nothing was written while the account was out of reach');
  w.net.readsFail = false;
  await tm.fire();
  await syncer.settled();
  assert.equal((await T.fetchRemote(w.sync, w.clock.t)).ok, true);
  assert.equal(pending(w), undefined);
});

test('recover is safe to call again: a push that waits in this worker is left alone', async () => {
  const w = world();
  const { syncer, tm } = await worker({ ...w, init: true });
  w.net.writesFail = true;
  syncer.schedulePush();
  await tm.fire();
  await syncer.settled();
  const waiting = tm.live().length;
  assert.deepEqual(await syncer.recover(), { ok: true, code: 'waiting' });
  assert.deepEqual(await syncer.recover(), { ok: true, code: 'waiting' });
  assert.equal(tm.live().length, waiting);
  const fresh = await worker({ ...w });
  await Promise.all([fresh.syncer.recover(), fresh.syncer.recover()]);
  assert.equal(fresh.tm.live().length, 1, 'two calls at once plan one push');
});

test('a burst of changes writes the record once', async () => {
  const w = world();
  const { syncer, tm } = await worker({ ...w, init: true });
  let writes = 0;
  const set = w.local.set.bind(w.local);
  w.local.set = async (items) => {
    if (PENDING_KEY in items) writes++;
    return set(items);
  };
  for (let i = 0; i < 25; i++) syncer.schedulePush();
  await syncer.settled();
  assert.equal(writes, 1);
  assert.equal(tm.live().length, 1);
  await tm.fire();
  await syncer.settled();
  assert.equal(pending(w), undefined);
});

test('nothing is written while Sync is off', async () => {
  const w = world();
  const { syncer } = await worker({ ...w, init: true, enabled: false });
  for (let i = 0; i < 5; i++) syncer.schedulePush();
  await syncer.settled();
  assert.equal(pending(w), undefined);
});

test('turning Sync off drops the waiting push, the record and the alarm, and a running push does not write', async () => {
  const w = world();
  const calls = [];
  const alarm = { set: async (t) => calls.push(['set', t]), clear: async () => calls.push(['clear']) };
  const { syncer, tm } = await worker({ ...w, init: true, alarm });
  w.net.writesFail = true;
  syncer.schedulePush();
  await tm.fire();
  await syncer.settled();
  assert.ok(pending(w));
  assert.deepEqual(calls.at(-1), ['set', NOW + 4000]);
  await syncer.cancel();
  assert.equal(tm.live().length, 0);
  assert.equal(pending(w), undefined);
  assert.deepEqual(calls.at(-1), ['clear']);
  // A new worker finds nothing to do.
  const next = await worker({ ...w });
  assert.deepEqual(await next.syncer.recover(), { ok: true, code: 'none' });

  // A push that has started when Sync is turned off.
  const w2 = world();
  const run = await worker({ ...w2, init: true });
  let release;
  const open = new Promise((r) => (release = r));
  let reached;
  const hit = new Promise((r) => (reached = r));
  const get = w2.sync.get.bind(w2.sync);
  w2.sync.get = async (keys) => {
    reached();
    await open;
    return get(keys);
  };
  const push = run.syncer.push();
  await hit;
  const gone = run.syncer.cancel();
  release();
  assert.deepEqual(await push, { ok: false, code: 'disabled' });
  await gone;
  assert.equal(w2.net.writes, 0);
});

test('a record of a Sync that is off, or a damaged one, is removed', async () => {
  const w = world();
  const first = await worker({ ...w, init: true });
  await w.local.set({ [PENDING_KEY]: { revision: 1, failures: 0, next: NOW } });
  await first.state.patchSettings({ syncEnabled: false });
  const off = await worker({ ...w });
  assert.deepEqual(await off.syncer.recover(), { ok: true, code: 'cleared' });
  assert.equal(pending(w), undefined);

  for (const junk of ['x', { next: 'soon', failures: 0 }, { next: NOW, failures: -1 }, { next: NOW, failures: 1.5 }, null]) {
    await first.state.patchSettings({ syncEnabled: true });
    await w.local.set({ [PENDING_KEY]: junk });
    const again = await worker({ ...w });
    assert.deepEqual(await again.syncer.recover(), { ok: true, code: 'cleared' }, JSON.stringify(junk));
    assert.equal(pending(w), undefined);
    assert.equal(again.tm.live().length, 0);
  }
});

test('a record whose time is far ahead (the clock moved back) is capped, and one in the past runs at once', async () => {
  const w = world();
  await worker({ ...w, init: true });
  await w.local.set({ [PENDING_KEY]: { revision: 1, failures: 3, next: NOW + 10 * 3600_000 } });
  const a = await worker({ ...w });
  await a.syncer.recover();
  assert.ok(a.tm.live()[0].ms <= 300_000 * 1.25);
  await w.local.set({ [PENDING_KEY]: { revision: 1, failures: 0, next: NOW - 60_000 } });
  const b = await worker({ ...w });
  await b.syncer.recover();
  assert.equal(b.tm.live()[0].ms, 0);
});

test('without the alarms permission nothing is asked of the browser, and recovery still works', async () => {
  const w = world();
  const first = await worker({ ...w, init: true });
  w.net.writesFail = true;
  first.syncer.schedulePush();
  await first.tm.fire();
  await first.syncer.settled();
  const next = await worker({ ...w });
  assert.equal((await next.syncer.recover()).code, 'planned');
});

test('the alarm of the waiting push comes from the alarm plan: only with the permission, and not part of the schedule', async () => {
  const created = [];
  const cleared = [];
  let allowed = true;
  const api = {
    create: async (name, info) => created.push([name, info]),
    get: async () => undefined,
    clear: async (name) => (cleared.push(name), true),
  };
  const clock = { t: NOW };
  const alarms = createAlarms({ api: () => api, permissions: { contains: async () => allowed }, now: () => clock.t });
  assert.equal(await alarms.retry.set(NOW + 2000), true);
  assert.deepEqual(created.at(-1), [SYNC_RETRY, { when: NOW + MIN_ALARM_MS }], 'moved to the earliest time the browsers give');
  assert.equal(await alarms.retry.set(NOW + 120_000), true);
  assert.deepEqual(created.at(-1), [SYNC_RETRY, { when: NOW + 120_000 }]);
  // A pass over the schedule does not touch it.
  await alarms.sync({ enabled: true, automation: { mode: 'off' } }, true);
  assert.equal(cleared.includes(SYNC_RETRY), false);
  assert.equal(await alarms.retry.clear(), true);
  assert.equal(cleared.at(-1), SYNC_RETRY);
  allowed = false;
  const before = created.length;
  assert.equal(await alarms.retry.set(NOW + 120_000), false);
  assert.equal(created.length, before, 'no permission: no alarm');
  const none = createAlarms({ api: () => undefined, permissions: { contains: async () => false } });
  assert.equal(await none.retry.set(NOW), false);
  assert.equal(await none.retry.clear(), false);
});

test('the sync worker sets and clears the alarm with the record', async () => {
  const w = world();
  const calls = [];
  const alarm = { set: async (t) => calls.push(['set', t]), clear: async () => calls.push(['clear']) };
  const { syncer, tm } = await worker({ ...w, init: true, alarm });
  syncer.schedulePush();
  await syncer.settled();
  assert.deepEqual(calls, [['set', NOW + 2000]]);
  await tm.fire();
  await syncer.settled();
  assert.deepEqual(calls.at(-1), ['clear']);
});
