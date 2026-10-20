import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const load = (name) => import(pathToFileURL(join(REPO, 'extension', 'shared', name)).href);
const S = await load('settings.js');
const T = await load('store.js');
const { SYNC } = await load('limits.js');

const plain = (v) => JSON.parse(JSON.stringify(v));

/* ---------- local state ---------- */

test('an empty storage reads as the defaults', async () => {
  const r = await T.readState(fakeArea());
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.state), plain(S.defaultState()));
});

test('first run writes the defaults and says so', async () => {
  const area = fakeArea();
  const r = await T.ensureMigrated(area);
  assert.deepEqual(r, { ok: true, fresh: true, repaired: false });
  const stored = area.peek();
  assert.equal(stored.schemaVersion, S.SCHEMA_VERSION);
  assert.equal(stored.settings.enabled, true);
  for (const name of S.SECTIONS) assert.ok(name in stored, name);
});

test('a second run changes nothing', async () => {
  const area = fakeArea();
  await T.ensureMigrated(area);
  const before = area.peek();
  const r = await T.ensureMigrated(area);
  assert.deepEqual(r, { ok: true, fresh: false, repaired: false });
  assert.deepEqual(area.peek(), before);
});

test('bad stored values are repaired and the good ones kept', async () => {
  const area = fakeArea();
  const settings = S.defaultSettings();
  settings.theme.brightness = 5000;
  settings.theme.mode = 'light';
  await area.set({ schemaVersion: S.SCHEMA_VERSION, settings });
  const r = await T.ensureMigrated(area);
  assert.equal(r.repaired, true);
  const stored = area.peek().settings;
  assert.equal(stored.theme.brightness, 100);
  assert.equal(stored.theme.mode, 'light');
});

test('data from a newer version is neither read nor written', async () => {
  const area = fakeArea();
  await area.set({ schemaVersion: S.SCHEMA_VERSION + 1, settings: { odd: true } });
  const before = area.peek();
  assert.deepEqual(await T.readState(area), { ok: false, code: 'newer' });
  assert.deepEqual(await T.ensureMigrated(area), { ok: false, code: 'newer' });
  assert.deepEqual(area.peek(), before);
});

test('old unversioned data is upgraded in place', async () => {
  const area = fakeArea();
  await area.set({ settings: { enabled: false } });
  await T.ensureMigrated(area);
  const stored = area.peek();
  assert.equal(stored.schemaVersion, S.SCHEMA_VERSION);
  assert.equal(stored.settings.enabled, false);
  assert.equal(stored.settings.theme.brightness, 100);
});

test('writeState checks every section and writes once', async () => {
  const area = fakeArea();
  let calls = 0;
  const set = area.set;
  area.set = async (items) => {
    calls++;
    return set(items);
  };
  const r = await T.writeState(
    area,
    { ui: { locale: 'he', uiTheme: 'dark' }, darkSites: { add: ['a.com'], remove: [] } },
    1234,
  );
  assert.equal(r.ok, true);
  assert.equal(calls, 1);
  const stored = area.peek();
  assert.equal(stored.updatedAt, 1234);
  assert.equal(stored.schemaVersion, S.SCHEMA_VERSION);
  assert.equal(stored.ui.locale, 'he');
});

test('writeState writes nothing when one section is bad', async () => {
  const area = fakeArea();
  const r = await T.writeState(area, {
    ui: { locale: 'fa', uiTheme: 'dark' },
    settings: { theme: { brightness: 1 } },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.deepEqual(area.peek(), {});
});

test('writeState refuses an unknown section and the version key', async () => {
  const area = fakeArea();
  assert.equal((await T.writeState(area, { nope: 1 })).ok, false);
  assert.equal((await T.writeState(area, { schemaVersion: 99 })).ok, false);
  assert.deepEqual(area.peek(), {});
});

test('a written state reads back the same', async () => {
  const area = fakeArea();
  const siteRules = S.sanitizeSection('siteRules', { 'a.com': { enabled: false } }, { strict: true }).value;
  await T.writeState(area, { siteRules }, 99);
  const r = await T.readState(area);
  assert.deepEqual(plain(r.state.siteRules), { 'a.com': { enabled: false } });
  assert.equal(r.state.updatedAt, 99);
});

/* ---------- chunking ---------- */

test('chunks join back to the original text', () => {
  const text = `${'abc"def\\'.repeat(3000)}${'ی'.repeat(2000)}😀${'\n'.repeat(50)}end`;
  const parts = T.splitIntoChunks(text, 1000);
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 5);
});

test('every chunk stays inside the byte budget, escapes and multi-byte text included', () => {
  const samples = ['"'.repeat(5000), '\\'.repeat(5000), 'ی'.repeat(5000), '😀'.repeat(3000), '\u0001'.repeat(2000), 'a'.repeat(5000)];
  for (const text of samples) {
    for (const part of T.splitIntoChunks(text, 997)) {
      assert.ok(Buffer.byteLength(JSON.stringify(part)) - 2 <= 997, text.slice(0, 3));
    }
  }
});

test('no chunk splits a surrogate pair', () => {
  for (const part of T.splitIntoChunks('😀'.repeat(1000), 7)) {
    assert.doesNotThrow(() => encodeURIComponent(part));
  }
});

test('empty text gives no chunks', () => {
  assert.deepEqual(T.splitIntoChunks('', 100), []);
});

/* ---------- sync ---------- */

function stateWith({ sites = false, bulk = 0 } = {}) {
  const state = S.defaultState();
  state.settings.syncEnabled = true;
  state.settings.syncIncludeSites = sites;
  state.settings.theme.brightness = 80;
  state.updatedAt = 1000;
  state.presets = [{ id: 'p1', name: 'One', theme: S.defaultTheme() }];
  const rules = {};
  for (let i = 0; i < bulk; i++) rules[`site${i}.example.com`] = { enabled: false, css: 'a{color:red;background:blue}'.repeat(3) };
  state.siteRules = S.sanitizeSection('siteRules', rules, { strict: true }).value;
  return state;
}

test('the payload leaves out the sync switches and, by default, the site data', () => {
  const p = T.syncPayload(stateWith({ bulk: 3 }));
  assert.ok(!('syncEnabled' in p.settings));
  assert.ok(!('syncIncludeSites' in p.settings));
  assert.ok(!('siteRules' in p));
  assert.ok('siteRules' in T.syncPayload(stateWith({ sites: true, bulk: 3 })));
});

test('sync items respect the per-item limit and reassemble to the same payload', async () => {
  const state = stateWith({ sites: true, bulk: 150 });
  const built = await T.buildSyncItems(state);
  assert.equal(built.ok, true);
  for (const [k, v] of Object.entries(built.items)) assert.ok(k.length + Buffer.byteLength(JSON.stringify(v)) <= SYNC.ITEM_BYTES, k);
  const back = await T.parseSyncItems(built.items);
  assert.equal(back.ok, true);
  assert.deepEqual(back.payload, plain(T.syncPayload(state)));
  assert.equal(back.updatedAt, 1000);
});

test('data that does not fit is refused and nothing is written', async () => {
  const state = stateWith({ sites: true, bulk: 1500 });
  const built = await T.buildSyncItems(state);
  assert.equal(built.ok, false);
  assert.equal(built.code, 'too-large');
  const sync = fakeArea({ quota: true });
  assert.deepEqual((await T.syncPush(sync, state)).code, 'too-large');
  assert.deepEqual(sync.peek(), {});
});

test('push does nothing when sync is off', async () => {
  const state = stateWith();
  state.settings.syncEnabled = false;
  const sync = fakeArea({ quota: true });
  assert.deepEqual(await T.syncPush(sync, state), { ok: false, code: 'disabled' });
  assert.deepEqual(sync.peek(), {});
});

test('a shorter push removes the chunks of the longer one', async () => {
  const sync = fakeArea({ quota: true });
  await T.syncPush(sync, stateWith({ sites: true, bulk: 200 }));
  const many = Object.keys(sync.peek()).length;
  const small = stateWith();
  await T.syncPush(sync, small);
  const keys = Object.keys(sync.peek());
  assert.ok(keys.length < many);
  assert.ok(keys.includes(`${SYNC.PREFIX}meta`));
  assert.equal((await T.parseSyncItems(sync.peek())).ok, true);
});

test('push leaves keys outside the prefix alone', async () => {
  const sync = fakeArea({ quota: true });
  await sync.set({ other: 1 });
  await T.syncPush(sync, stateWith());
  assert.equal(sync.peek().other, 1);
});

test('tampered or missing chunks are detected', async () => {
  const { items } = await T.buildSyncItems(stateWith({ sites: true, bulk: 100 }));
  const flipped = structuredClone(items);
  flipped[`${SYNC.PREFIX}0`] = flipped[`${SYNC.PREFIX}0`].replace('a', 'b');
  assert.deepEqual(await T.parseSyncItems(flipped), { ok: false, code: 'broken' });
  const missing = structuredClone(items);
  delete missing[`${SYNC.PREFIX}1`];
  assert.deepEqual(await T.parseSyncItems(missing), { ok: false, code: 'broken' });
  assert.deepEqual(await T.parseSyncItems({}), { ok: false, code: 'none' });
  const badMeta = structuredClone(items);
  badMeta[`${SYNC.PREFIX}meta`].n = 99999;
  assert.deepEqual(await T.parseSyncItems(badMeta), { ok: false, code: 'broken' });
});

async function twoDevices() {
  const sync = fakeArea({ quota: true });
  const a = fakeArea();
  const b = fakeArea();
  return { sync, a, b };
}

test('a newer remote state is applied and keeps the local sync switches', async () => {
  const { sync, a, b } = await twoDevices();
  const remote = stateWith({ sites: true, bulk: 5 });
  remote.settings.theme.brightness = 70;
  remote.updatedAt = 5000;
  await T.syncPush(sync, remote);

  const local = S.defaultState();
  local.settings.syncEnabled = true;
  local.settings.syncIncludeSites = true;
  local.updatedAt = 100;
  await b.set({ schemaVersion: S.SCHEMA_VERSION, settings: local.settings, updatedAt: 100 });

  const r = await T.syncPull(sync, b);
  assert.equal(r.applied, true);
  const stored = b.peek();
  assert.equal(stored.settings.theme.brightness, 70);
  assert.equal(stored.settings.syncEnabled, true);
  assert.equal(Object.keys(stored.siteRules).length, 5);
  assert.equal(stored.updatedAt, 5000);
  void a;
});

test('an older remote state is not applied', async () => {
  const { sync, b } = await twoDevices();
  const remote = stateWith();
  remote.updatedAt = 50;
  await T.syncPush(sync, remote);
  const local = S.defaultState();
  local.settings.syncEnabled = true;
  await b.set({ schemaVersion: S.SCHEMA_VERSION, settings: local.settings, updatedAt: 900 });
  const before = b.peek();
  assert.deepEqual(await T.syncPull(sync, b), { ok: true, applied: false, reason: 'local-newer' });
  assert.deepEqual(b.peek(), before);
});

test('pull keeps local site data when the user does not sync it', async () => {
  const { sync, b } = await twoDevices();
  const remote = stateWith({ sites: true, bulk: 4 });
  remote.updatedAt = 9000;
  await T.syncPush(sync, remote);
  const siteRules = S.sanitizeSection('siteRules', { 'mine.com': { enabled: false } }, { strict: true }).value;
  const settings = S.defaultSettings();
  settings.syncEnabled = true;
  await b.set({ schemaVersion: S.SCHEMA_VERSION, settings, siteRules, updatedAt: 1 });
  const r = await T.syncPull(sync, b);
  assert.equal(r.applied, true);
  assert.deepEqual(Object.keys(b.peek().siteRules), ['mine.com']);
});

test('pull does nothing when sync is off locally', async () => {
  const { sync, b } = await twoDevices();
  await T.syncPush(sync, stateWith());
  assert.deepEqual(await T.syncPull(sync, b), { ok: false, code: 'disabled' });
});

test('a remote payload with bad data is refused and local data stays', async () => {
  const { sync, b } = await twoDevices();
  const remote = stateWith();
  remote.updatedAt = 7000;
  const payload = T.syncPayload(remote);
  payload.settings.theme.brightness = 9999;
  const text = JSON.stringify(payload);
  const chunks = T.splitIntoChunks(text, 3000);
  const items = {};
  chunks.forEach((c, i) => (items[`${SYNC.PREFIX}${i}`] = c));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  items[`${SYNC.PREFIX}meta`] = { v: 1, n: chunks.length, hash, updatedAt: 7000 };
  await sync.set(items);
  const settings = S.defaultSettings();
  settings.syncEnabled = true;
  await b.set({ schemaVersion: S.SCHEMA_VERSION, settings, updatedAt: 1 });
  const before = b.peek();
  const r = await T.syncPull(sync, b);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'broken');
  assert.deepEqual(b.peek(), before);
});

test('a remote payload cannot change the local sync switches', async () => {
  const { sync, b } = await twoDevices();
  const remote = stateWith();
  remote.updatedAt = 8000;
  const payload = T.syncPayload(remote);
  payload.settings.syncEnabled = false;
  payload.settings.syncIncludeSites = true;
  const text = JSON.stringify(payload);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  await sync.set({ [`${SYNC.PREFIX}0`]: text, [`${SYNC.PREFIX}meta`]: { v: 1, n: 1, hash, updatedAt: 8000 } });
  const settings = S.defaultSettings();
  settings.syncEnabled = true;
  settings.syncIncludeSites = false;
  await b.set({ schemaVersion: S.SCHEMA_VERSION, settings, updatedAt: 1 });
  const r = await T.syncPull(sync, b);
  assert.equal(r.applied, true);
  const stored = b.peek().settings;
  assert.equal(stored.syncEnabled, true);
  assert.equal(stored.syncIncludeSites, false);
});
