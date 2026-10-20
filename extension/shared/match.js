// @ts-check
// Which rule applies to a page. This is the module twin of `content/core/match.js`; a test keeps them equal.
import { normalizePattern } from './settings.js';

/**
 * Patterns to try, most specific first: the host with the longest path prefix, then the host (with and without a port),
 * each parent domain, then `*.parent` for each parent domain.
 * @param {string} host  `location.host`, so it can carry a port
 * @param {string} pathname
 * @returns {string[]}
 */
export function candidates(host, pathname) {
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
 * @param {Record<string, any> | null | undefined} rules
 * @param {string} host
 * @param {string} pathname
 * @returns {any}
 */
export function find(rules, host, pathname) {
  if (!rules || typeof rules !== 'object') return undefined;
  for (const key of candidates(host, pathname)) {
    if (Object.hasOwn(rules, key)) return rules[key];
  }
  return undefined;
}

/**
 * The rule that turns the extension on or off for a page: the most specific one that says so. A more specific rule that only sets
 * a theme does not hide the switch of its site.
 * @param {Record<string, any> | null | undefined} rules
 * @param {string} host
 * @param {string} pathname
 * @returns {{ key: string, enabled: boolean } | null}
 */
export function findEnabled(rules, host, pathname) {
  if (!rules || typeof rules !== 'object') return null;
  for (const key of candidates(host, pathname)) {
    const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
    if (rule && typeof rule === 'object' && typeof rule.enabled === 'boolean') return { key, enabled: rule.enabled };
  }
  return null;
}

/**
 * The page address split the way the rules are keyed, or null for an address that has no site (about:, chrome:, file:).
 * @param {unknown} url
 * @returns {{ host: string, pathname: string } | null}
 */
export function parsePage(url) {
  if (typeof url !== 'string' || url.length > 4096) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { host: u.host, pathname: u.pathname };
  } catch {
    return null;
  }
}

/**
 * Whether the extension is on for a page, by the same rules the content script uses.
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} siteRules
 * @param {unknown} url
 */
export function siteEnabled(settings, siteRules, url) {
  const page = parsePage(url);
  if (!page) return false;
  const found = findEnabled(siteRules, page.host, page.pathname);
  return found ? found.enabled : settings.listMode !== 'onlyListed';
}

/**
 * The key whose `enabled` turns the extension on or off for this page: the rule that decides now when it is the site's own rule or a
 * path rule below it, else the site's own key (a parent domain rule is left for the other subdomains).
 * @param {Record<string, any> | null | undefined} siteRules
 * @param {unknown} url
 * @returns {string | null}
 */
export function switchKey(siteRules, url) {
  const page = parsePage(url);
  const own = page ? normalizePattern(page.host) : null;
  if (!page || !own) return null;
  const found = findEnabled(siteRules, page.host, page.pathname);
  if (!found) return own;
  const order = candidates(page.host, page.pathname);
  return order.indexOf(found.key) <= order.indexOf(own) ? found.key : own;
}

/**
 * The key for a rule that covers this page: its host (with the port when there is one).
 * @param {unknown} url
 * @returns {string | null}
 */
export function patternFor(url) {
  const page = parsePage(url);
  return page ? normalizePattern(page.host) : null;
}
