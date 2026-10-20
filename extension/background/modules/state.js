// @ts-check
// The one writer of the stored settings. Every change goes through a serial queue, is checked strictly, and is
// written in a single call. Short-lived data (tab status, watchdog marks) lives in `storage.session`.
import { STATE_KEYS, ensureMigrated, planRemote, readState, writeState } from '../../shared/store.js';
import { applyPatch, defaultState, fixCss, heldCss, holdIncoming, keepHold, normalizePattern, parseImport, ruleCss, serializeExport } from '../../shared/settings.js';
import { siteEnabled, switchKey } from '../../shared/match.js';

/**
 * @typedef {import('../../shared/store.js').Area} Area
 */

const isPlainObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * A site rule with some fields changed. A plain object in `patch` (the theme) is merged key by key; any other value replaces the
 * field. `null` is a value: in a site theme it means "not the global setting" (`whiteCap: null`). `remove` names the fields
 * to drop, `"engine"` or `"theme.mode"`; a theme left empty is dropped. The hold flag is never taken from a patch.
 * @param {Record<string, any>} rule @param {Record<string, unknown>} patch @param {string[]} [remove]
 * @returns {Record<string, any>}
 */
export function patchRule(rule, patch, remove = []) {
  const blocked = (/** @type {string} */ k) => k === '__proto__' || k === 'constructor' || k === 'prototype';
  const out = { ...rule };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'cssHeld' || blocked(key)) continue;
    if (isPlainObject(value)) {
      const inner = { ...(isPlainObject(out[key]) ? out[key] : {}) };
      for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) if (!blocked(k)) inner[k] = v;
      out[key] = inner;
    } else out[key] = value;
  }
  for (const path of remove) {
    const [key, sub, ...more] = String(path).split('.');
    if (more.length || key === 'cssHeld' || blocked(key)) continue;
    if (sub === undefined) delete out[key];
    else if (isPlainObject(out[key]) && !blocked(sub)) {
      const inner = { ...out[key] };
      delete inner[sub];
      out[key] = inner;
    }
  }
  for (const [key, value] of Object.entries(out)) if (isPlainObject(value) && Object.keys(value).length === 0) delete out[key];
  return out;
}

const ENGINE_CYCLE = Object.freeze(['auto', 'dynamic', 'filterPlus', 'filter']);
const MAX_PRESETS = 50;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** A preset id that fits the schema (lowercase letters, digits and dashes, 40 characters at most). */
function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `p-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Freeze a checked state, so a reader that changes it by mistake fails at once and cannot corrupt the copy that others share. @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(/** @type {any} */ (value)[key]);
  return value;
}

/**
 * The checked state is kept in memory, so many readers (every frame of every page load, the popup, the registration) cost one
 * read of the storage and one check between two writes. The copy goes when this worker writes and when the storage reports a
 * change of the stored state (`changes`, `chrome.storage.onChanged`). A read that was under way when it went never fills the copy.
 * A worker that was stopped starts with no copy. The returned state is frozen and is shared: do not change it.
 * @param {{ local: Area, session: Area, now?: () => number, newId?: () => string, changes?: { addListener(fn: (changes: Record<string, unknown>, area: string) => void): void } | null }} deps
 */
export function createState({ local, session, now = () => Date.now(), newId = randomId, changes = globalThis.chrome?.storage?.onChanged ?? null }) {
  let chain = Promise.resolve();
  // Jobs queued or running. A read that finds none and has a copy answers at once; otherwise it waits behind them.
  let pending = 0;
  // The revision of the state that the running job loaded. Jobs run one at a time, so it belongs to that job.
  let revision = 0;
  /** @type {any} */
  let cached = null;
  let generation = 0;
  const invalidate = () => {
    generation++;
    cached = null;
  };
  const stateKeys = new Set(STATE_KEYS);
  changes?.addListener((/** @type {Record<string, unknown>} */ changed, /** @type {string} */ area) => {
    if (area === 'local' && Object.keys(changed).some((key) => stateKeys.has(key))) invalidate();
  });

  /** Run `fn` after everything queued before it. A failing job does not stop the jobs behind it. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  function queue(fn) {
    pending++;
    const job = chain.then(fn);
    const done = () => {
      pending--;
      return undefined;
    };
    chain = job.then(done, done);
    return job;
  }

  async function load() {
    if (cached) {
      revision = cached.updatedAt;
      return cached;
    }
    const started = generation;
    const read = await readState(local, now());
    if (!read.ok) throw Object.assign(new Error('stored data is newer'), { code: read.code });
    // A revision far ahead of the clock is stored again as the clock, so every later compare uses the repaired value.
    if (read.revisionFixed) {
      invalidate();
      await local.set({ updatedAt: read.state.updatedAt });
    }
    revision = read.state.updatedAt;
    const state = deepFreeze(read.state);
    if (started === generation) cached = state;
    return state;
  }

  /** The one place that writes the state; the copy in memory goes before and after the write. @param {Record<string, any>} sections @param {number} at */
  async function write(sections, at) {
    invalidate();
    try {
      return await writeState(local, sections, at);
    } finally {
      invalidate();
    }
  }

  /** @param {Record<string, any>} sections */
  async function save(sections) {
    // Always later than the revision before it, also when the clock of this device went back.
    const written = await write(sections, Math.max(now(), revision + 1));
    if (!written.ok) return { ok: /** @type {const} */ (false), code: 'invalid', errors: written.errors };
    return { ok: /** @type {const} */ (true) };
  }

  /**
   * Set the switch of the rule that decides for this page (`switchKey`), keep its other fields, and answer with the state of the page
   * read back from what was saved. @param {unknown} url @param {boolean} [enabled] omitted flips it
   */
  async function switchSite(url, enabled) {
    const state = await load();
    const key = switchKey(state.siteRules, url);
    if (!key) return { ok: /** @type {const} */ (false), code: 'no-site' };
    const want = typeof enabled === 'boolean' ? enabled : !siteEnabled(state.settings, state.siteRules, url);
    const before = state.siteRules[key];
    const rules = { ...state.siteRules, [key]: { ...(isPlainObject(before) ? before : {}), enabled: want } };
    const r = await save({ siteRules: rules });
    if (!r.ok) return r;
    const after = await load();
    return { ok: /** @type {const} */ (true), enabled: siteEnabled(after.settings, after.siteRules, url), pattern: key };
  }

  /** A failed job answers with a code, not a thrown error. @param {unknown} error */
  function failure(error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(/** @type {any} */ (error).code) : 'error';
    return { ok: /** @type {const} */ (false), code };
  }

  return {
    /** Install and update: write defaults on first run, migrate, repair. */
    init: () =>
      queue(async () => {
        invalidate();
        try {
          return await ensureMigrated(local, now());
        } finally {
          invalidate();
        }
      }),

    /** The stored state, checked. Shared and frozen: copy what you change. */
    read: () => {
      if (pending === 0 && cached) return Promise.resolve({ ok: /** @type {const} */ (true), state: /** @type {any} */ (cached) });
      return queue(async () => ({ ok: /** @type {const} */ (true), state: await load() })).catch(failure);
    },

    /** @param {unknown} patch */
    patchSettings: (patch) =>
      queue(async () => {
        const state = await load();
        const r = applyPatch(state.settings, patch);
        if (r.value === undefined) {
          // Only fields this worker does not know: the page is newer than the worker, which needs a reload of the extension.
          const unknown = r.errors.length > 0 && r.errors.every((/** @type {string} */ e) => e.endsWith(' is not a known field'));
          return { ok: /** @type {const} */ (false), code: unknown ? 'unknown-field' : 'invalid', errors: r.errors };
        }
        // The hold of custom CSS is changed by an import, a sync pull and `enableCss` only. Emptying the CSS ends it.
        const held = state.settings.cssHeld === true && r.value.theme.css.trim() !== '';
        return save({ settings: { ...r.value, cssHeld: held } });
      }).catch(failure),

    /**
     * Set a rule for a site pattern, or remove it with `null`. With `ifAbsent` an existing rule is left as it is and the
     * reply says so (`created: false`), so two pages that add the same site cannot erase each other.
     * @param {unknown} pattern @param {unknown} rule @param {boolean} [ifAbsent]
     */
    setSite: (pattern, rule, ifAbsent = false) =>
      queue(async () => {
        const key = normalizePattern(pattern);
        if (!key) return { ok: /** @type {const} */ (false), code: 'invalid', errors: ['pattern: is not a valid site pattern'] };
        const state = await load();
        if (ifAbsent && rule !== null && Object.hasOwn(state.siteRules, key)) return { ok: /** @type {const} */ (true), created: false, pattern: key };
        const rules = { ...state.siteRules };
        if (rule === null) delete rules[key];
        else rules[key] = isPlainObject(rule) ? keepHold(rules[key], rule, ruleCss) : rule;
        const r = await save({ siteRules: rules });
        return ifAbsent && r.ok ? { ok: /** @type {const} */ (true), created: true, pattern: key } : r;
      }).catch(failure),

    /**
     * Change some fields of a site rule and keep the others as they are now: `null` removes a field, `theme` is merged key by key
     * (`null` removes a theme key). A rule left with no field is removed. Two windows that change different fields keep both.
     * @param {unknown} pattern @param {unknown} patch
     */
    patchSite: (pattern, patch, /** @type {unknown} */ remove = []) =>
      queue(async () => {
        const key = normalizePattern(pattern);
        if (!key) return { ok: /** @type {const} */ (false), code: 'invalid', errors: ['pattern: is not a valid site pattern'] };
        if (!isPlainObject(patch)) return { ok: /** @type {const} */ (false), code: 'invalid', errors: ['patch: must be an object'] };
        if (!Array.isArray(remove) || remove.length > 100 || remove.some((r) => typeof r !== 'string' || r.length > 80))
          return { ok: /** @type {const} */ (false), code: 'invalid', errors: ['remove: must be a list of field names'] };
        const state = await load();
        const before = state.siteRules[key];
        const next = patchRule(isPlainObject(before) ? before : {}, /** @type {Record<string, unknown>} */ (patch), /** @type {string[]} */ (remove));
        const rules = { ...state.siteRules };
        if (Object.keys(next).length === 0) delete rules[key];
        else rules[key] = keepHold(before, next, ruleCss);
        const r = await save({ siteRules: rules });
        return r.ok ? { ok: /** @type {const} */ (true), pattern: key, rule: rules[key] ?? null } : r;
      }).catch(failure),

    /** A preset with an id replaces the preset of that id; without one, it is added under a new id. @param {Record<string, any>} preset `{ id?, name, theme }` */
    savePreset: (preset) =>
      queue(async () => {
        const state = await load();
        const taken = new Set(state.presets.map((/** @type {any} */ p) => p.id));
        let id = preset.id;
        if (typeof id !== 'string') {
          id = newId();
          for (let tries = 0; taken.has(id) && tries < 8; tries++) id = newId();
          if (taken.has(id)) return { ok: /** @type {const} */ (false), code: 'error' };
        }
        const list = state.presets.filter((/** @type {any} */ p) => p.id !== id);
        if (list.length >= MAX_PRESETS) return { ok: /** @type {const} */ (false), code: 'invalid', errors: [`presets: at most ${MAX_PRESETS}`] };
        list.push({ id, name: preset.name, theme: preset.theme });
        const r = await save({ presets: list });
        return r.ok ? { ok: /** @type {const} */ (true), id } : r;
      }).catch(failure),

    /** @param {string} id */
    deletePreset: (id) =>
      queue(async () => {
        const state = await load();
        return save({ presets: state.presets.filter((/** @type {any} */ p) => p.id !== id) });
      }).catch(failure),

    /**
     * Check an import file. It is applied only when `confirmed` is true, after the caller has shown the summary.
     * @param {string} text @param {boolean} confirmed
     */
    importText: (text, confirmed) =>
      queue(async () => {
        const parsed = parseImport(text);
        if (!parsed.ok) return { ok: /** @type {const} */ (false), code: parsed.code, errors: parsed.errors };
        const current = await load();
        // Custom CSS in the file is not applied until the person turns it on; the summary says how many records wait.
        const incoming = holdIncoming(current, { settings: parsed.state.settings, siteRules: parsed.state.siteRules, userFixes: parsed.state.userFixes });
        const held = heldCss({ ...parsed.state, ...incoming });
        const summary = { ...parsed.summary, heldCss: (held.settings ? 1 : 0) + held.siteRules.length + held.userFixes.length };
        if (!confirmed) return { ok: /** @type {const} */ (true), applied: false, summary };
        const { presets, darkSites } = parsed.state;
        // Where the data goes is the person's choice on this device; a file cannot make it.
        const settings = { ...incoming.settings, syncEnabled: current.settings.syncEnabled, syncIncludeSites: current.settings.syncIncludeSites };
        const r = await save({ settings, siteRules: incoming.siteRules, presets, userFixes: incoming.userFixes, darkSites });
        return r.ok ? { ok: /** @type {const} */ (true), applied: true, summary } : r;
      }).catch(failure),

    /** Set the fix of a site pattern, or remove it with `null`. `ifAbsent` works as for `setSite`. @param {unknown} pattern @param {unknown} fix @param {boolean} [ifAbsent] */
    setFix: (pattern, fix, ifAbsent = false) =>
      queue(async () => {
        const key = normalizePattern(pattern);
        if (!key) return { ok: /** @type {const} */ (false), code: 'invalid', errors: ['pattern: is not a valid site pattern'] };
        const state = await load();
        if (ifAbsent && fix !== null && Object.hasOwn(state.userFixes, key)) return { ok: /** @type {const} */ (true), created: false, pattern: key };
        const fixes = { ...state.userFixes };
        if (fix === null) delete fixes[key];
        else fixes[key] = isPlainObject(fix) ? keepHold(fixes[key], fix, fixCss) : fix;
        const r = await save({ userFixes: fixes });
        return ifAbsent && r.ok ? { ok: /** @type {const} */ (true), created: true, pattern: key } : r;
      }).catch(failure),

    /**
     * Commit a remote snapshot (already fetched and checked) inside the writer: the local state is read again, the Sync
     * switches and the revision are compared as they are now, held CSS is decided on the current data, and the write
     * follows without a gap. `adopt` skips the revision compare (a device that has just joined).
     * @param {{ payload: Record<string, any>, updatedAt: number }} remote @param {{ adopt?: boolean }} [options]
     */
    applyRemote: (remote, options = {}) =>
      queue(async () => {
        const plan = planRemote(await load(), remote, options);
        if (!plan.ok || !plan.applied) return plan;
        const written = await write(plan.changes, remote.updatedAt);
        if (!written.ok) return { ok: /** @type {const} */ (false), code: 'broken', errors: written.errors };
        return { ok: /** @type {const} */ (true), applied: /** @type {const} */ (true), sections: plan.sections, updatedAt: remote.updatedAt };
      }).catch(failure),

    /**
     * Turn on held custom CSS after the person has read it. `css` is the text that was shown; if the stored text differs
     * (a sync pull replaced it while the page was open), nothing is turned on.
     * @param {unknown} scope  'settings', 'siteRules' or 'userFixes'
     * @param {unknown} pattern  the key of the rule or the fix; not used for 'settings'
     * @param {unknown} css
     */
    enableCss: (scope, pattern, css) =>
      queue(async () => {
        const bad = { ok: /** @type {const} */ (false), code: 'invalid' };
        if (typeof css !== 'string') return bad;
        const state = await load();
        if (scope === 'settings') {
          if (state.settings.theme.css !== css) return { ok: /** @type {const} */ (false), code: 'changed' };
          return save({ settings: { ...state.settings, cssHeld: false } });
        }
        if (scope !== 'siteRules' && scope !== 'userFixes') return bad;
        const key = normalizePattern(pattern);
        if (!key) return bad;
        const item = state[scope][key];
        if (!item) return bad;
        if ((scope === 'siteRules' ? ruleCss(item) : fixCss(item)) !== css) return { ok: /** @type {const} */ (false), code: 'changed' };
        const { cssHeld, ...rest } = item;
        void cssHeld;
        return save({ [scope]: { ...state[scope], [key]: rest } });
      }).catch(failure),

    /** Language and look of the pages of this device. @param {unknown} ui */
    setUi: (ui) =>
      queue(async () => {
        if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return { ok: /** @type {const} */ (false), code: 'invalid' };
        const state = await load();
        return save({ ui: { ...state.ui, ...ui } });
      }).catch(failure),

    /** Back to the defaults for everything except the language and look of the pages. */
    reset: () =>
      queue(async () => {
        const d = defaultState();
        return save({ settings: d.settings, siteRules: d.siteRules, presets: d.presets, userFixes: d.userFixes, darkSites: d.darkSites });
      }).catch(failure),

    exportText: () =>
      queue(async () => ({ ok: /** @type {const} */ (true), text: serializeExport(await load(), now()) })).catch(failure),

    toggleExtension: () =>
      queue(async () => {
        const state = await load();
        const r = await save({ settings: { ...state.settings, enabled: !state.settings.enabled } });
        return r.ok ? { ok: /** @type {const} */ (true), enabled: !state.settings.enabled } : r;
      }).catch(failure),

    /** Turn the extension on or off for the page at this address; `enabled` omitted flips it. @param {unknown} url @param {boolean} [enabled] */
    toggleSite: (url, enabled) => queue(() => switchSite(url, enabled)).catch(failure),

    cycleEngine: () =>
      queue(async () => {
        const state = await load();
        const at = ENGINE_CYCLE.indexOf(state.settings.engine);
        const next = ENGINE_CYCLE[(at + 1) % ENGINE_CYCLE.length];
        const r = await save({ settings: { ...state.settings, engine: next } });
        return r.ok ? { ok: /** @type {const} */ (true), engine: next } : r;
      }).catch(failure),

    /* ----- short-lived data, in storage.session ----- */

    /** @param {number} tabId @param {string} status */
    setTabStatus: async (tabId, status) => {
      await session.set({ [`tab:${tabId}`]: { status, at: now() } });
    },
    /** @param {number} tabId */
    getTabStatus: async (tabId) => (await session.get(`tab:${tabId}`))[`tab:${tabId}`] ?? null,
    /** @param {number} tabId */
    clearTab: async (tabId) => {
      await session.remove(`tab:${tabId}`);
    },

    /** Remember that a host was dropped to a lighter mode, so the next load starts there. @param {string} host @param {string} mode */
    markHost: async (host, mode) => {
      await session.set({ [`wd:${host}`]: { mode, at: now() } });
    },
    /** A mark that has expired is removed when it is asked for. @param {string} host */
    getHostMark: async (host) => {
      const key = `wd:${host}`;
      const mark = (await session.get(key))[key];
      if (mark && now() - mark.at < SESSION_TTL_MS) return mark;
      if (mark) await session.remove(key);
      return null;
    },
    /** Remove every expired host mark, also those of hosts nobody asks for again. Returns how many were removed. */
    pruneMarks: async () => {
      const all = (await session.get(null)) ?? {};
      const old = Object.keys(all).filter((key) => key.startsWith('wd:') && !(now() - Number(all[key]?.at) < SESSION_TTL_MS));
      if (old.length > 0) await session.remove(old);
      return old.length;
    },
  };
}

