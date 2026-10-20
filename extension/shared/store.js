// @ts-check
import { SYNC } from './limits.js';
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

export const STATE_KEYS = Object.freeze(['schemaVersion', 'updatedAt', ...SECTIONS]);

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

/**
 * Turn the state into `storage.sync` items. Refuses when the data does not fit the limits.
 * @param {any} state
 * @returns {Promise<{ ok: true, items: Record<string, any>, bytes: number } | { ok: false, code: 'too-large', bytes: number }>}
 */
export async function buildSyncItems(state) {
  const text = JSON.stringify(syncPayload(state));
  const chunks = splitIntoChunks(text, SYNC.ITEM_BYTES - SYNC.KEY_RESERVE - 2);
  /** @type {Record<string, any>} */
  const items = {};
  chunks.forEach((chunk, i) => {
    items[`${SYNC.PREFIX}${i}`] = chunk;
  });
  items[META_KEY] = { v: 1, n: chunks.length, hash: await sha256(text), updatedAt: state.updatedAt };
  let bytes = 0;
  for (const [key, value] of Object.entries(items)) bytes += itemBytes(key, value);
  if (bytes > SYNC.TOTAL_BYTES || chunks.length + 1 > SYNC.MAX_ITEMS) return { ok: false, code: 'too-large', bytes };
  return { ok: true, items, bytes };
}

/**
 * Read items back into a checked payload.
 * A snapshot whose revision is more than a day ahead of `now` is `broken`: it is never applied, and the next push replaces it. A
 * missing, negative or non-numeric revision is read as 0.
 * @param {Record<string, any>} items
 * @param {number} [now]
 * @returns {Promise<{ ok: true, payload: Record<string, any>, updatedAt: number } | { ok: false, code: 'none' | 'broken' | 'newer' }>}
 */
export async function parseSyncItems(items, now = Date.now()) {
  const meta = items[META_KEY];
  if (!meta) return { ok: false, code: 'none' };
  // A snapshot of a newer format is not read and must not be replaced.
  if (Number.isInteger(meta.v) && meta.v > 1) return { ok: false, code: 'newer' };
  if (meta.v !== 1 || !Number.isInteger(meta.n) || meta.n < 0 || meta.n >= SYNC.MAX_ITEMS) {
    return { ok: false, code: 'broken' };
  }
  if (typeof meta.updatedAt === 'number' && meta.updatedAt > now + REVISION_SKEW_MS) return { ok: false, code: 'broken' };
  let text = '';
  for (let i = 0; i < meta.n; i++) {
    const part = items[`${SYNC.PREFIX}${i}`];
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
 * Write the state to `storage.sync`, then remove the chunks that the snapshot now in the area does not use. The
 * snapshot is read again after the write, so the chunks of a snapshot that another device wrote meanwhile stay.
 * @param {Area} syncArea
 * @param {any} state
 */
export async function syncPush(syncArea, state) {
  if (!state.settings.syncEnabled) return { ok: false, code: 'disabled' };
  const built = await buildSyncItems(state);
  if (!built.ok) return built;
  await syncArea.set(built.items);
  const all = (await syncArea.get(null)) ?? {};
  const meta = all[META_KEY];
  if (meta && Number.isInteger(meta.n) && meta.n >= 0 && meta.n < SYNC.MAX_ITEMS) {
    const keep = new Set([META_KEY]);
    for (let i = 0; i < meta.n; i++) keep.add(`${SYNC.PREFIX}${i}`);
    const stale = Object.keys(all).filter((k) => k.startsWith(SYNC.PREFIX) && !keep.has(k));
    if (stale.length) await syncArea.remove(stale);
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
