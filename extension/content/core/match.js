// @ts-check
// Find the rule for the current page in a map of site patterns. Same rules as `normalizePattern` in shared/settings.js.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  /**
   * Patterns to try, most specific first:
   * 1. the host with the longest path prefix first, then the host alone (with the port, then without it),
   * 2. each parent domain, longest first (a rule for `example.com` also covers `www.example.com`),
   * 3. `*.parent` for each parent domain, longest first (subdomains only).
   * @param {string} host  `location.host`, so it can carry a port
   * @param {string} pathname
   * @returns {string[]}
   */
  function candidates(host, pathname) {
    const lowerHost = String(host).toLowerCase();
    const bare = lowerHost.replace(/:\d+$/, '');
    // An IPv6 literal (`[::1]`) is an address: it has no parent domains and no `*.` form.
    const address = bare.startsWith('[');
    /** @type {string[]} */
    const out = [];
    // Stored paths have no trailing slash; an empty segment inside a path (`/a//b`) is kept, since `/a//b` and `/a/b` can be different pages.
    const path = String(pathname).replace(/\/+$/, '');
    const segments = path.startsWith('/') ? path.slice(1).split('/') : [];
    for (const name of bare === lowerHost ? [lowerHost] : [lowerHost, bare]) {
      for (let n = segments.length; n > 0; n--) if (segments[n - 1] !== '') out.push(`${name}/${segments.slice(0, n).join('/')}`);
      out.push(name);
    }
    if (address) return out;
    const labels = bare.split('.');
    /** @type {string[]} */
    const parents = [];
    // The last label alone (the top-level domain) is never a parent.
    for (let i = 1; i < labels.length - 1; i++) parents.push(labels.slice(i).join('.'));
    for (const parent of parents) out.push(parent);
    for (const parent of parents) out.push(`*.${parent}`);
    return out;
  }

  /**
   * @param {Record<string, any> | null | undefined} rules  map from pattern to rule
   * @param {string} host
   * @param {string} pathname
   * @returns {any}
   */
  function find(rules, host, pathname) {
    if (!rules || typeof rules !== 'object') return undefined;
    for (const key of candidates(host, pathname)) {
      if (Object.hasOwn(rules, key)) return rules[key];
    }
    return undefined;
  }

  /**
   * The most specific rule that turns the extension on or off; a rule that only sets a theme does not hide the switch of its site.
   * @param {Record<string, any> | null | undefined} rules
   * @param {string} host
   * @param {string} pathname
   * @returns {{ key: string, enabled: boolean } | null}
   */
  function findEnabled(rules, host, pathname) {
    if (!rules || typeof rules !== 'object') return null;
    for (const key of candidates(host, pathname)) {
      const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
      if (rule && typeof rule === 'object' && typeof rule.enabled === 'boolean') return { key, enabled: rule.enabled };
    }
    return null;
  }

  // Style sheet address patterns (`ignoreCssUrl`): literal text and `*` (any run of characters). A pattern matches when its
  // literal parts appear in the address in order, case ignored. No regular expression is built; each part is searched once.
  const ADDRESS_PATTERNS = 50;
  const ADDRESS_PATTERN_CHARS = 200;
  const ADDRESS_STARS = 8;
  const ADDRESS_INPUT_CHARS = 2048;

  /**
   * @param {unknown} patterns
   * @returns {(address: unknown) => boolean}
   */
  function addressTester(patterns) {
    /** @type {string[][]} */
    const compiled = [];
    const list = Array.isArray(patterns) ? patterns.slice(0, ADDRESS_PATTERNS) : [];
    for (const p of list) {
      if (typeof p !== 'string' || p === '' || p.length > ADDRESS_PATTERN_CHARS) continue;
      const parts = p.toLowerCase().split('*');
      if (parts.length - 1 > ADDRESS_STARS) continue;
      compiled.push(parts.filter((part) => part !== ''));
    }
    return (address) => {
      if (typeof address !== 'string' || address.length > ADDRESS_INPUT_CHARS) return false;
      const text = address.toLowerCase();
      for (const parts of compiled) {
        let from = 0;
        let hit = true;
        for (const part of parts) {
          const at = text.indexOf(part, from);
          if (at < 0) {
            hit = false;
            break;
          }
          from = at + part.length;
        }
        if (hit) return true;
      }
      return false;
    };
  }

  dk.match = Object.freeze({ candidates, find, findEnabled, addressTester });
})();
