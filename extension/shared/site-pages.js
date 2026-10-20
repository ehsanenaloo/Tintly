// @ts-check
// The pages of the app on enaloo.com. They are only opened as links: the extension itself sends nothing.
// Each address carries a few short values, all from a fixed table, and never an ID, an address or other data.

const BASE = 'https://enaloo.com/apps/tintly/';
export const PAGES = Object.freeze({ welcome: `${BASE}welcome/`, uninstall: `${BASE}uninstall/`, feedback: `${BASE}feedback/` });

/** The key in `storage.local` with the time of the first install. Missing for copies installed before 1.0.2. */
export const INSTALLED_AT = 'installedAt';

const DAY = 864e5;
const OS = new Set(['win', 'mac', 'linux', 'cros', 'android']);

/**
 * The browser name and its major version, from the brands of `navigator.userAgentData` or else the user agent.
 * @param {{ userAgent?: string, brands?: readonly { brand: string, version: string }[] }} input
 * @returns {{ name: 'chrome' | 'edge' | 'firefox' | 'other', major: string }}
 */
export function browserOf({ userAgent = '', brands = [] }) {
  const digits = (/** @type {string | undefined} */ v) => (/^\d{1,4}/.exec(v ?? '') ?? [''])[0];
  const brand = (/** @type {string} */ name) => brands.find((b) => b.brand === name);
  const edge = brand('Microsoft Edge');
  if (edge) return { name: 'edge', major: digits(edge.version) };
  const chrome = brand('Google Chrome');
  if (chrome) return { name: 'chrome', major: digits(chrome.version) };
  let m = /Firefox\/(\d+)/.exec(userAgent);
  if (m) return { name: 'firefox', major: digits(m[1]) };
  m = /\bEdg\/(\d+)/.exec(userAgent);
  if (m) return { name: 'edge', major: digits(m[1]) };
  // Other Chromium browsers add their own token (OPR, YaBrowser, ...) to the Chrome one.
  m = /Chrome\/(\d+)/.exec(userAgent);
  if (m && !/\b(OPR|YaBrowser|Vivaldi|SamsungBrowser)\//.test(userAgent)) return { name: 'chrome', major: digits(m[1]) };
  return { name: 'other', major: m ? digits(m[1]) : '' };
}

/** @param {unknown} os the `os` of `runtime.getPlatformInfo()` */
export function osOf(os) {
  return typeof os === 'string' && OS.has(os) ? os : 'other';
}

/** @param {unknown} installedAt @param {number} now */
export function ageOf(installedAt, now) {
  if (typeof installedAt !== 'number' || !Number.isFinite(installedAt) || installedAt <= 0 || installedAt > now) return 'unknown';
  const days = (now - installedAt) / DAY;
  return days < 1 ? 'd1' : days < 7 ? 'w1' : days < 30 ? 'm1' : days < 90 ? 'm3' : 'more';
}

/** A language tag such as `en` or `pt-BR`; anything else is left out. @param {unknown} lang */
const tag = (lang) => (typeof lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(lang) ? lang : '');

/** @param {string} page @param {Record<string, string>} values */
function build(page, values) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== '') q.set(k, v);
  const s = q.toString();
  return s === '' ? page : `${page}?${s}`;
}

/** @param {{ version: string, lang: string, browser: string }} input */
export function welcomeUrl({ version, lang, browser }) {
  return build(PAGES.welcome, { v: version, lang: tag(lang), b: browser });
}

/** @param {{ version: string, lang: string, browser: string, major: string, os: string, age: string }} input */
export function uninstallUrl({ version, lang, browser, major, os, age }) {
  return build(PAGES.uninstall, { v: version, lang: tag(lang), b: browser, bv: major, os, age });
}

/** @param {'bug' | 'feature'} kind @param {{ version: string, browser: string, major: string }} input */
export function feedbackUrl(kind, { version, browser, major }) {
  return kind === 'feature'
    ? build(PAGES.feedback, { kind, v: version })
    : build(PAGES.feedback, { kind: 'bug', v: version, b: browser, bv: major });
}

/** The browser of this copy, read once. */
export function thisBrowser() {
  const nav = /** @type {Navigator & { userAgentData?: { brands?: { brand: string, version: string }[] } }} */ (globalThis.navigator);
  return browserOf({ userAgent: nav?.userAgent ?? '', brands: nav?.userAgentData?.brands ?? [] });
}
