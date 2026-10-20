// @ts-check
// Site data for one host: the built-in fixes from the shard that holds the host, and the user's own fixes.
// Content scripts get a few hundred bytes for their own page, never the whole set.
import { candidates, find } from '../../shared/match.js';

/** The host part of every key that names a path, built once per set of rules (a shard, the dark list). @type {WeakMap<object, Set<string>>} */
const pathHosts = new WeakMap();

/** Does a key that covers this host name a path? Such a host is asked again when the page changes its route. @param {Record<string, any> | null} rules @param {string} host */
function hasPathKey(rules, host) {
  if (!rules || typeof rules !== 'object') return false;
  let index = pathHosts.get(rules);
  if (!index) {
    index = new Set();
    for (const k of Object.keys(rules)) {
      const i = k.indexOf('/');
      if (i > 0) index.add(k.slice(0, i));
    }
    pathHosts.set(rules, index);
  }
  return index.size > 0 && candidates(host, '/').some((name) => /** @type {Set<string>} */ (index).has(name));
}

// A file that could not be read, or is missing, is read again after this wait; one that was read is kept for the life of the worker.
const RETRY_MS = 30_000;

/** 32-bit FNV-1a of a string. @param {string} text */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The shard number (two hex digits) for a host. The key is the last two labels of the name, which is wrong for
 * names such as `site.co.uk`; the exact rule comes with the data tooling and changes the shard files with it.
 * @param {string} host
 */
export function shardOf(host) {
  const labels = host.toLowerCase().replace(/:\d+$/, '').split('.');
  const key = labels.slice(-2).join('.');
  return (fnv1a(key) % 256).toString(16).padStart(2, '0');
}

/**
 * @param {{ readJson: (path: string) => Promise<any>, now?: () => number }} deps  reads a file of the extension, or returns null
 */
export function createData({ readJson, now = () => Date.now() }) {
  /**
   * A file read that is shared by everyone who asks while it runs. A value is kept for good; a failure (null or an error) only
   * for `RETRY_MS`, so one bad read does not remove the built-in data until the worker restarts.
   * @template T
   * @param {(path: string) => Promise<T | null>} read
   * @returns {(path: string) => Promise<T | null>}
   */
  function remembered(read) {
    /** @type {Map<string, { at: number, value: Promise<T | null>, ok: boolean | null }>} */
    const files = new Map();
    return (path) => {
      const held = files.get(path);
      if (held && (held.ok !== false || now() - held.at < RETRY_MS)) return held.value;
      const entry = { at: now(), ok: /** @type {boolean | null} */ (null), value: /** @type {any} */ (null) };
      entry.value = read(path).then(
        (value) => {
          entry.ok = value !== null;
          entry.at = now();
          return value;
        },
        () => {
          entry.ok = false;
          entry.at = now();
          return null;
        },
      );
      files.set(path, entry);
      return entry.value;
    };
  }

  const readShard = remembered((path) => readJson(path));
  /** @param {string} name */
  const shard = (name) => readShard(`data/fixes/${name}.json`);

  /** The built-in list of hosts that are already dark, as a map from pattern to true. @type {(path: string) => Promise<Record<string, true> | null>} */
  const readDark = remembered(async (path) => {
    const list = await readJson(path);
    return Array.isArray(list) ? Object.fromEntries(list.filter((p) => typeof p === 'string').map((p) => [p, true])) : null;
  });
  const dark = () => readDark('data/dark-sites.json');

  return {
    /**
     * @param {string} host @param {string} pathname @param {Record<string, any> | undefined} userFixes
     * @returns {Promise<{ builtin: any, user: any, dark: boolean, paths: boolean }>}
     */
    async forHost(host, pathname, userFixes) {
      const data = await shard(shardOf(host));
      const builtin = data && typeof data === 'object' ? find(data, host, pathname) : undefined;
      const user = userFixes ? find(userFixes, host, pathname) : undefined;
      const list = await dark();
      return { builtin: builtin ?? null, user: user ?? null, dark: !!list && find(list, host, pathname) === true, paths: hasPathKey(data, host) || hasPathKey(list, host) };
    },
  };
}
