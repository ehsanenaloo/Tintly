// @ts-check
import { SYNC } from './limits.js';
import { STATE_KEYS } from './sections.js';
import { SCHEMA_VERSION, SECTIONS, holdIncoming, migrate, sanitizeSection, sanitizeState, withoutHold } from './settings.js';

/**
 * The part of a storage area that this module needs. `chrome.storage.local`
 * and `chrome.storage.sync` fit it, and so does a fake in a test.
 * @typedef {{
 *   get(keys: string[] | string | null): Promise<Record<string, any>>,
 *   set(items: Record<string, any>): Promise<void>,
 *   remove(keys: string | string[]): Promise<void>,
 * }} Area
 */

export { STATE_KEYS };

/** How far ahead of this device's clock a revision may be and still count as a real one (clocks differ by hours, not by days). */
export const REVISION_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * A revision that can be trusted: a finite number from 0 to a day past `now`. A value far ahead would win every compare for
 * good, because each new revision is above the one before it.
 * @param {unknown} value @param {number} [now]
 * @returns {number} 0 for a missing or negative value, `now` for one too far ahead
 */
export function clampRevision(value, now = Date.now()) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value > now + REVISION_SKEW_MS ? now : value;
}

/* ------------------------------------------------------------------ */
/* Local state                                                         */
/* ------------------------------------------------------------------ */

/**
 * Read the whole state, migrate it in memory and repair bad parts with defaults.
 * A revision more than a day ahead of `now` is read as `now`; that counts as a repair (`changed`, `revisionFixed`).
 * @param {Area} area
 * @param {number} [now]
 * @returns {Promise<{ ok: true, state: any, warnings: string[], changed: boolean, revisionFixed: boolean } | { ok: false, code: string }>}
 */
export async function readState(area, now = Date.now()) {
  const raw = (await area.get([...STATE_KEYS])) ?? {};
  const moved = migrate(raw);
  if (!moved.ok) return { ok: false, code: moved.code };
  const { value, errors } = sanitizeState(moved.raw, { strict: false });
  const revision = clampRevision(value?.updatedAt, now);
  const revisionFixed = revision !== value?.updatedAt;
  if (value) value.updatedAt = revision;
  const changed = raw.schemaVersion !== SCHEMA_VERSION || errors.length > 0 || revisionFixed;
  return { ok: true, state: value, warnings: errors, changed, revisionFixed };
}

/**
 * Run at install and update. Writes defaults on first run and writes back repaired or migrated data.
 * Data written by a newer version is never touched.
 * @param {Area} area
 * @param {number} [now]
 */
export async function ensureMigrated(area, now = Date.now()) {
  const read = await readState(area, now);
  if (!read.ok) return read;
  const stored = await area.get(['schemaVersion']);
  const fresh = stored.schemaVersion === undefined;
  if (fresh || read.changed) await area.set(stateToItems(read.state));
  return { ok: true, fresh, repaired: read.warnings.length > 0 };
}

/** @param {any} state */
function stateToItems(state) {
  /** @type {Record<string, any>} */
  const items = { schemaVersion: SCHEMA_VERSION, updatedAt: state.updatedAt };
  for (const name of SECTIONS) items[name] = state[name];
  return items;
}

/**
 * Check the given sections strictly, then write them in one call together with the version and time.
 * Nothing is written when any section has an error. A change of the page look (`ui`) alone is not part of the
 * synchronized data and does not move the revision.
 * @param {Area} area
 * @param {Record<string, any>} changes
 * @param {number} [now]
 * @returns {Promise<{ ok: true, written: Record<string, any> } | { ok: false, errors: string[] }>}
 */
export async function writeState(area, changes, now = Date.now()) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, any>} */
  const checked = {};
  for (const key of Object.keys(changes)) {
    if (!SECTIONS.includes(key)) {
      errors.push(`${key.slice(0, 40)}: is not a known section`);
      continue;
    }
    const r = sanitizeSection(key, changes[key], { strict: true });
    errors.push(...r.errors);
    checked[key] = r.value;
  }
  if (errors.length) return { ok: false, errors };
  const uiOnly = Object.keys(checked).every((key) => key === 'ui');
  await area.set({ ...checked, schemaVersion: SCHEMA_VERSION, ...(uiOnly ? {} : { updatedAt: now }) });
  return { ok: true, written: checked };
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

const META_KEY = `${SYNC.PREFIX}meta`;
const SITE_SECTIONS = ['siteRules', 'userFixes', 'darkSites'];
const encoder = new TextEncoder();

/** Bytes that one code point takes inside a JSON string, escapes included. */
/** @param {number} cp */
function jsonBytes(cp) {
  if (cp === 0x22 || cp === 0x5c) return 2;
  if (cp < 0x20) return cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d ? 2 : 6;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/**
 * Split text into pieces whose JSON form stays under `maxBytes`. Never cuts a code point.
 * @param {string} text
 * @param {number} maxBytes
 */
export function splitIntoChunks(text, maxBytes) {
  /** @type {string[]} */
  const chunks = [];
  let start = 0;
  let size = 0;
  let index = 0;
  for (const ch of text) {
    const cost = jsonBytes(/** @type {number} */ (ch.codePointAt(0)));
    if (size + cost > maxBytes && index > start) {
      chunks.push(text.slice(start, index));
      start = index;
      size = 0;
    }
    size += cost;
    index += ch.length;
  }
  if (index > start) chunks.push(text.slice(start, index));
  return chunks;
}

/** @param {string} text */
async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {string} key @param {any} value */
function itemBytes(key, value) {
  return key.length + encoder.encode(JSON.stringify(value)).length;
}

/**
 * What goes to the other devices: settings (without the sync switches), presets,
 * and the site parts only when the user turned that on.
 * @param {any} state
 */
export function syncPayload(state) {
  const { syncEnabled, syncIncludeSites, ...settings } = state.settings;
  void syncEnabled;
  void syncIncludeSites;
  /** @type {Record<string, any>} */
  const payload = { settings, presets: state.presets };
  if (state.settings.syncIncludeSites) for (const name of SITE_SECTIONS) payload[name] = state[name];
  // Whether custom CSS is held is a fact about one device.
  return withoutHold(payload);
}

/** Format 2 names every snapshot's chunks after the snapshot: `dk.sync.<id>.<index>`. Format 1 used `dk.sync.<index>`. */
const SNAPSHOT_ID = /^[0-9a-z]{1,13}-[0-9a-f]{4}$/;
const ORPHAN_AGE_MS = 60 * 60 * 1000;

/** The id carries the time it was made, so a clean-up can tell how long ago a snapshot was written. @param {number} time */
function newSnapshotId(time) {
  const salt = crypto.getRandomValues(new Uint16Array(1))[0].toString(16).padStart(4, '0');
  return `${Math.max(0, Math.floor(time) || 0).toString(36)}-${salt}`;
}

/** The meta of one snapshot, next to its chunks. The shared `dk.sync.meta` points at the last one written, for readers of older versions. */
/** @param {string} id */
const snapshotMetaKey = (id) => `${SYNC.PREFIX}${id}.meta`;

/** What one snapshot may take: two must fit at once, because the one being replaced stays until the new one is committed. */
const SNAPSHOT_BYTES = Math.floor(SYNC.TOTAL_BYTES / 2);
const SNAPSHOT_ITEMS = Math.floor(SYNC.MAX_ITEMS / 2);

/** @param {string} id @param {number} index */
const chunkKey = (id, index) => `${SYNC.PREFIX}${id}.${index}`;

/**
 * Which snapshot a `dk.sync.` key belongs to: its id, `''` for a format 1 chunk, null for the meta and anything else.
 * @param {string} key
 * @returns {string | null}
 */
function snapshotOfKey(key) {
  if (!key.startsWith(SYNC.PREFIX) || key === META_KEY) return null;
  const rest = key.slice(SYNC.PREFIX.length);
  if (/^\d+$/.test(rest)) return '';
  if (rest.endsWith('.meta')) return SNAPSHOT_ID.test(rest.slice(0, -5)) ? rest.slice(0, -5) : null;
  const dot = rest.lastIndexOf('.');
  if (dot < 1 || !/^\d+$/.test(rest.slice(dot + 1))) return null;
  const id = rest.slice(0, dot);
  return SNAPSHOT_ID.test(id) ? id : null;
}

/**
 * Turn the state into `storage.sync` items. Refuses when the data does not fit the limits.
 * `id` names the snapshot; by default a new one.
 * @param {any} state
 * @param {{ id?: string }} [options]
 * @returns {Promise<{ ok: true, items: Record<string, any>, bytes: number, id: string } | { ok: false, code: 'too-large', bytes: number }>}
 */
export async function buildSyncItems(state, { id = newSnapshotId(Date.now()) } = {}) {
  const text = JSON.stringify(syncPayload(state));
  const chunks = splitIntoChunks(text, SYNC.ITEM_BYTES - SYNC.KEY_RESERVE - 2);
  /** @type {Record<string, any>} */
  const items = {};
  chunks.forEach((chunk, i) => {
    items[chunkKey(id, i)] = chunk;
  });
  const meta = { v: 2, id, n: chunks.length, hash: await sha256(text), updatedAt: state.updatedAt };
  items[META_KEY] = meta;
  items[snapshotMetaKey(id)] = meta;
  let bytes = 0;
  for (const [key, value] of Object.entries(items)) bytes += itemBytes(key, value);
  if (bytes > SNAPSHOT_BYTES || Object.keys(items).length > SNAPSHOT_ITEMS) return { ok: false, code: 'too-large', bytes };
  return { ok: true, items, bytes, id };
}

/**
 * Read one snapshot, the one a meta describes, into a checked payload.
 * @param {Record<string, any>} items @param {any} meta @param {number} now
 * @returns {Promise<{ ok: true, payload: Record<string, any>, updatedAt: number } | { ok: false, code: 'broken' }>}
 */
async function readSnapshot(items, meta, now) {
  if (meta === null || typeof meta !== 'object') return { ok: false, code: 'broken' };
  const named = meta.v === 2;
  if ((meta.v !== 1 && !named) || (named && !(typeof meta.id === 'string' && SNAPSHOT_ID.test(meta.id)))) {
    return { ok: false, code: 'broken' };
  }
  if (!Number.isInteger(meta.n) || meta.n < 0 || meta.n >= SYNC.MAX_ITEMS) return { ok: false, code: 'broken' };
  if (typeof meta.updatedAt === 'number' && meta.updatedAt > now + REVISION_SKEW_MS) return { ok: false, code: 'broken' };
  let text = '';
  for (let i = 0; i < meta.n; i++) {
    const part = items[named ? chunkKey(meta.id, i) : `${SYNC.PREFIX}${i}`];
    if (typeof part !== 'string') return { ok: false, code: 'broken' };
    text += part;
  }
  if ((await sha256(text)) !== meta.hash) return { ok: false, code: 'broken' };
  try {
    const payload = JSON.parse(text, (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, code: 'broken' };
    return { ok: true, payload, updatedAt: clampRevision(meta.updatedAt, now) };
  } catch {
    return { ok: false, code: 'broken' };
  }
}

/**
 * Read items back into a checked payload.
 * The newest readable snapshot wins: the shared meta and the meta of every snapshot are read, so a snapshot that was written
 * while another device published the shared meta is not lost when the shared meta goes back to an older one. A shared meta
 * that names a newer revision than any readable snapshot makes the account `broken`.
 * A snapshot whose revision is more than a day ahead of `now` is `broken`: it is never applied, and the next push replaces it. A
 * missing, negative or non-numeric revision is read as 0.
 * @param {Record<string, any>} items
 * @param {number} [now]
 * @returns {Promise<{ ok: true, payload: Record<string, any>, updatedAt: number, id: string } | { ok: false, code: 'none' | 'broken' | 'newer' }>}
 */
export async function parseSyncItems(items, now = Date.now()) {
  const pointer = items[META_KEY];
  // A snapshot of a newer format is not read and must not be replaced.
  if (pointer && Number.isInteger(pointer.v) && pointer.v > 2) return { ok: false, code: 'newer' };
  /** @type {{ meta: any, id: string }[]} */
  const candidates = [];
  const pointerId = pointer && pointer.v === 2 && typeof pointer.id === 'string' ? pointer.id : '';
  if (pointer) candidates.push({ meta: pointer, id: pointerId });
  for (const key of Object.keys(items)) {
    const owner = snapshotOfKey(key);
    if (!owner || key !== snapshotMetaKey(owner) || owner === pointerId) continue;
    const meta = items[key];
    if (meta?.v === 2 && meta.id === owner) candidates.push({ meta, id: owner });
  }
  if (candidates.length === 0) return { ok: false, code: 'none' };
  /** @type {{ ok: true, payload: Record<string, any>, updatedAt: number, id: string } | null} */
  let best = null;
  /** @type {any} */
  let first = null;
  for (const [index, { meta, id }] of candidates.entries()) {
    const r = await readSnapshot(items, meta, now);
    if (index === 0 && pointer) first = r;
    if (r.ok && (!best || r.updatedAt > best.updatedAt)) best = { ...r, id };
  }
  if (best && !(first && !first.ok && typeof pointer.updatedAt === 'number' && pointer.updatedAt > best.updatedAt)) return best;
  return first ?? { ok: false, code: 'broken' };
}

/**
 * Write the state to `storage.sync`. A readable snapshot in the area that is newer than the state is left alone, and so
 * is a snapshot of a newer format.
 * The chunks and the metas go out in one write, under keys named after the new snapshot, so they never collide with the
 * chunks of the snapshot they replace or of one that another device writes at the same time. If that write fails (write
 * rate, quota) or the push is cancelled first, the old snapshot is still whole. After the write only the keys of the
 * snapshots that were replaced are removed (and format 1 chunks, and orphans of a lost race that were written over an hour ago): a clean-up never touches the chunks of a head it did not read. Readers go by the metas and ignore
 * other keys, so a failed or skipped clean-up is harmless.
 * Capacity: two snapshots must fit at once, so one snapshot may take half of the area (`too-large` above that). The old
 * snapshot is never removed to make room. An old format 1 snapshot that leaves no room for the new one answers
 * `too-large` and stays readable. Chunks of old lost races that block the write are removed first; recent ones answer
 * `quota` (a later push finds them old enough).
 * `storage.sync` has no compare-and-set: the head is read right before the write, and a newer snapshot that lands in the
 * gap between that read and the write is overwritten in the shared meta only; its own meta and chunks stay and readers
 * take the newest readable snapshot, so nothing is lost. A head that cannot be read is never written over, unless the
 * caller says so (`allowBroken`: the person confirmed it, or the caller found the head's revision to be its own and is
 * repairing it, sync.js).
 * @param {Area} syncArea
 * @param {any} state
 * @param {{ live?: () => boolean, allowBroken?: boolean, now?: number }} [options]  `live` is asked after the account was read and right before the write; false ends the push
 */
export async function syncPush(syncArea, state, { live = () => true, allowBroken = false, now = Date.now() } = {}) {
  if (!state.settings.syncEnabled) return { ok: false, code: 'disabled' };
  const built = await buildSyncItems(state, { id: newSnapshotId(now) });
  if (!built.ok) return built;
  if (!live()) return { ok: false, code: 'disabled' };
  const all = (await syncArea.get(null)) ?? {};
  // Snapshots this push replaces: format 1 chunks (''), the one the shared meta names and the newest readable one.
  /** @type {Set<string>} */
  const replaced = new Set(['']);
  if (all[META_KEY]) {
    const head = await parseSyncItems(all, now);
    if (head.ok && head.updatedAt > state.updatedAt) return { ok: true, skipped: true };
    if (!head.ok && head.code === 'newer') return { ok: false, code: 'newer' };
    if (!head.ok && head.code === 'broken' && !allowBroken) return { ok: false, code: 'broken' };
    if (head.ok) replaced.add(head.id);
    if (all[META_KEY].v === 2 && typeof all[META_KEY].id === 'string') replaced.add(all[META_KEY].id);
  }
  const horizon = now - ORPHAN_AGE_MS;
  const owned = (/** @type {string} */ key) => {
    const owner = snapshotOfKey(key);
    return owner !== null && owner !== built.id && replaced.has(owner);
  };
  const old = (/** @type {string} */ key) => {
    const owner = snapshotOfKey(key);
    return owner !== null && owner !== built.id && !replaced.has(owner) && parseInt(owner.slice(0, owner.indexOf('-')), 36) < horizon;
  };
  let free = SYNC.TOTAL_BYTES - built.bytes;
  let slots = SYNC.MAX_ITEMS - Object.keys(built.items).length;
  let heldReplaced = 0;
  /** @type {string[]} */
  const sweep = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(SYNC.PREFIX) || Object.hasOwn(built.items, key)) continue;
    const size = itemBytes(key, value);
    free -= size;
    slots -= 1;
    if (owned(key)) heldReplaced += size;
    else if (old(key)) sweep.push(key);
  }
  if (free < 0 || slots < 0) {
    // The replaced snapshot has to stay until the new one is committed; old lost races can go now.
    const swept = sweep.reduce((n, key) => n + itemBytes(key, all[key]), 0);
    if (free + swept < 0 || slots + sweep.length < 0) {
      // Only the replaced snapshot is in the way: that cannot change. Anything else is recent and will have aged.
      const permanent = heldReplaced + built.bytes > SYNC.TOTAL_BYTES;
      return permanent ? { ok: false, code: 'too-large', bytes: built.bytes } : { ok: false, code: 'quota', retry: true };
    }
    if (!live()) return { ok: false, code: 'disabled' };
    await syncArea.remove(sweep);
  }
  if (!live()) return { ok: false, code: 'disabled' };
  await syncArea.set(built.items);
  const stale = Object.keys(all).filter((key) => !Object.hasOwn(built.items, key) && (owned(key) || old(key)));
  if (stale.length && live()) {
    try {
      await syncArea.remove(stale);
    } catch {
      // The new snapshot is already committed; the surplus keys are ignored by readers.
    }
  }
  return { ok: true, bytes: built.bytes };
}

/**
 * Read and check the snapshot in `storage.sync`. Needs no lock: nothing local is read or written.
 * @param {Area} syncArea
 * @param {number} [now]
 */
export async function fetchRemote(syncArea, now = Date.now()) {
  return parseSyncItems((await syncArea.get(null)) ?? {}, now);
}

/**
 * Decide what a remote snapshot changes in the local state, from the local state as it is now. Pure: the caller
 * writes `changes`, inside the one writer. The local sync switches are never changed by remote data. With `adopt`
 * the revision is not compared (a device that has just turned Sync on takes what the account holds).
 * @param {any} local
 * @param {{ payload: Record<string, any>, updatedAt: number }} remote
 * @param {{ adopt?: boolean }} [options]
 * @returns {{ ok: false, code: string, errors?: string[] } | { ok: true, applied: false, reason: string } | { ok: true, applied: true, changes: Record<string, any>, sections: string[], updatedAt: number }}
 */
export function planRemote(local, remote, { adopt = false } = {}) {
  if (!local.settings.syncEnabled) return { ok: false, code: 'disabled' };
  if (!adopt && remote.updatedAt <= local.updatedAt) return { ok: true, applied: false, reason: 'local-newer' };

  /** @type {Record<string, any>} */
  const changes = {};
  const sections = ['settings', 'presets', ...SITE_SECTIONS];
  for (const name of sections) {
    if (!Object.hasOwn(remote.payload, name)) continue;
    if (SITE_SECTIONS.includes(name) && !local.settings.syncIncludeSites) continue;
    const r = sanitizeSection(name, remote.payload[name], { strict: true });
    if (r.errors.length) return { ok: false, code: 'broken', errors: r.errors };
    changes[name] = r.value;
  }
  if (changes.settings) {
    changes.settings.syncEnabled = local.settings.syncEnabled;
    changes.settings.syncIncludeSites = local.settings.syncIncludeSites;
  }
  // CSS that another device pushed is not applied here until the person turns it on.
  holdIncoming(local, changes);
  return { ok: true, applied: true, changes, sections: Object.keys(changes), updatedAt: remote.updatedAt };
}

/**
 * Read remote data and apply it to local storage when it is newer. Not serialized with other writers: the service
 * worker uses `fetchRemote` and the state's `applyRemote` instead.
 * @param {Area} syncArea
 * @param {Area} localArea
 */
export async function syncPull(syncArea, localArea) {
  const read = await readState(localArea);
  if (!read.ok) return read;
  if (!read.state.settings.syncEnabled) return { ok: false, code: 'disabled' };
  const remote = await fetchRemote(syncArea);
  if (!remote.ok) return remote;
  const plan = planRemote(read.state, remote);
  if (!plan.ok || !plan.applied) return plan;
  const written = await writeState(localArea, plan.changes, remote.updatedAt);
  if (!written.ok) return { ok: false, code: 'broken', errors: written.errors };
  return { ok: true, applied: true, sections: plan.sections, updatedAt: remote.updatedAt };
}
