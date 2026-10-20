// @ts-check
// The slice of the stored site data that one page needs. The gate of a page used to read every site rule, fix and dark-list entry at each
// page and frame load (about 130 ms of reading at 2 000 rules and 2 000 fixes). The worker keeps a copy of that data cut into buckets by the
// last two labels of the host, in keys of their own, and a page reads the bucket of its host: the keys that can match a page are all in
// its bucket. The copy is derived data: the stored sections stay the source, the copy is made again after each change, and a page uses it
// only when it was made for the revision of the data it reads in the same call (`rev`), else it reads the sections as before.

export const META = 'gb.meta';
export const LIST = 'gb.list';
export const PREFIX = 'gb:';
export const VERSION = 1;

/**
 * The bucket of a host or of the host part of a key. Every key that can match a page (the host with or without its port, each parent domain,
 * `*.parent`, with or without a path) has the bucket of that page: they share the last two labels, and a host of one or two labels is
 * its own bucket. The twin of `bucketOf` in `content/core/prefetch.js`; a test keeps them equal.
 * @param {string} host
 */
export function bucketOf(host) {
  let h = String(host).toLowerCase().replace(/:\d+$/, '');
  if (h.startsWith('*.')) h = h.slice(2);
  const labels = h.split('.');
  return labels.length <= 2 ? h : labels.slice(-2).join('.');
}

/** The host part of a stored pattern. @param {string} key */
const hostPart = (key) => {
  const slash = key.indexOf('/');
  return slash < 0 ? key : key.slice(0, slash);
};

const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @typedef {{ r?: Record<string, any>, f?: Record<string, any>, a?: string[], d?: string[] }} Bucket
 */

/**
 * Cut the three sections into buckets.
 * @param {any} siteRules @param {any} userFixes @param {any} darkSites
 * @returns {Map<string, Bucket>}
 */
export function buildBuckets(siteRules, userFixes, darkSites) {
  /** @type {Map<string, Bucket>} */
  const buckets = new Map();
  const get = (/** @type {string} */ key) => {
    const name = bucketOf(hostPart(key));
    let b = buckets.get(name);
    if (!b) buckets.set(name, (b = {}));
    return b;
  };
  if (isObject(siteRules)) for (const [key, rule] of Object.entries(siteRules)) (get(key).r ??= {})[key] = rule;
  if (isObject(userFixes)) for (const [key, fix] of Object.entries(userFixes)) (get(key).f ??= {})[key] = fix;
  if (isObject(darkSites)) {
    for (const [field, name] of /** @type {const} */ ([['add', 'a'], ['remove', 'd']])) {
      const list = darkSites[field];
      if (Array.isArray(list)) for (const key of list) if (typeof key === 'string') (get(key)[name] ??= []).push(key);
    }
  }
  return buckets;
}

/** A short hash of a text, to tell whether a bucket changed. @param {string} text */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${(h >>> 0).toString(36)}.${text.length}`;
}

const SECTIONS = ['siteRules', 'userFixes', 'darkSites'];

/**
 * @param {{ local: { get(keys: any): Promise<Record<string, any>>, set(items: Record<string, any>): Promise<void>, remove(keys: string | string[]): Promise<void> }, warn?: (e: unknown) => void }} deps
 */
export function createGate({ local, warn = () => {} }) {
  /** The hash of each bucket as it is stored, or null before this worker has looked. @type {Record<string, string> | null} */
  let written = null;
  let chain = Promise.resolve();
  let dirty = { sections: false, rev: false };
  let running = false;

  /** Write the buckets that changed, with the revision they were made for, in one call. */
  async function pass() {
    const flags = dirty;
    dirty = { sections: false, rev: false };
    const head = await local.get(['updatedAt', META, LIST]);
    const rev = typeof head.updatedAt === 'number' ? head.updatedAt : null;
    const meta = head[META];
    const right = isObject(meta) && meta.v === VERSION && meta.rev === rev;
    if (written === null) {
      const list = head[LIST];
      written = isObject(meta) && meta.v === VERSION && isObject(list) ? /** @type {Record<string, string>} */ (list) : {};
      // The copy of an earlier run of the worker is right when it was made for this revision.
      if (right && isObject(list)) return;
      flags.sections = true;
    }
    // The copy was taken away from outside: it is made again.
    if (!isObject(head[LIST])) {
      written = {};
      flags.sections = true;
    }
    if (!flags.sections) {
      if (!right) await local.set({ [META]: { v: VERSION, rev } });
      return;
    }
    const raw = await local.get(SECTIONS);
    const buckets = buildBuckets(raw.siteRules, raw.userFixes, raw.darkSites);
    /** @type {Record<string, any>} */
    const items = {};
    /** @type {Record<string, string>} */
    const next = {};
    for (const [name, content] of buckets) {
      const h = hash(JSON.stringify(content));
      next[name] = h;
      if (written[name] !== h) items[PREFIX + name] = content;
    }
    // A bucket that is gone is written empty in the same call, then removed: a page never reads old rules next to the new revision.
    const gone = Object.keys(written).filter((name) => !(name in next));
    for (const name of gone) items[PREFIX + name] = {};
    items[LIST] = next;
    items[META] = { v: VERSION, rev };
    try {
      await local.set(items);
    } catch (error) {
      // The storage is full: pages read the sections as before.
      written = {};
      await local.remove([META, LIST, ...[...buckets.keys(), ...gone].map((n) => PREFIX + n)]).catch(() => {});
      throw error;
    }
    written = next;
    if (gone.length) await local.remove(gone.map((n) => PREFIX + n)).catch(() => {});
  }

  /** @param {{ sections?: boolean, rev?: boolean }} what */
  function request(what) {
    dirty.sections ||= what.sections === true;
    dirty.rev ||= what.rev === true;
    if (running) return chain;
    running = true;
    const run = async () => {
      try {
        while (dirty.sections || dirty.rev) await pass().catch(warn);
      } finally {
        running = false;
      }
    };
    chain = chain.then(run, run);
    return chain;
  }

  return {
    /** At the start of the worker and after an install: look at the copy and make it right. */
    start: () => request({ rev: true }),
    /** A change of the stored data (`chrome.storage.onChanged`). The keys of the copy itself are not a change. @param {Record<string, unknown>} changes */
    follow(changes) {
      const keys = Object.keys(changes);
      const sections = keys.some((k) => SECTIONS.includes(k));
      const rev = keys.some((k) => k === 'updatedAt' || k === 'settings');
      if (sections || rev) return request({ sections, rev: true });
      return Promise.resolve();
    },
    settled: () => chain,
  };
}
