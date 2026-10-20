// @ts-check
import { LOCALES } from './i18n.js';
import { L } from './limits.js';
import { DARK_IDS, LIGHT_IDS, paletteLabels } from './palettes.js';

export const SCHEMA_VERSION = 2;
export const ENGINES = Object.freeze(['auto', 'dynamic', 'filter', 'filterPlus', 'static']);
export const SECTIONS = Object.freeze(['settings', 'siteRules', 'presets', 'userFixes', 'darkSites', 'ui']);

/** @typedef {{ errors: string[], strict: boolean }} Ctx */
/** @typedef {{ ok: true, value: any } | { ok: false }} Result */

const HEX6 = /^#[0-9a-f]{6}$/;
const HEX3 = /^#[0-9a-f]{3}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ID = /^[a-z0-9-]+$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?$`);
// A bracketed IPv6 literal with an optional port, as `location.host` writes it. The text between the brackets is only a first filter;
// the URL parser decides whether it is an address and gives its one canonical form.
const IPV6_HOST = /^(\[[0-9a-f:.]{2,45}\])(?::(\d{1,5}))?$/;
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
// Font names go into generated CSS, so only plain name characters are allowed.
const FONT = /^[\p{L}\p{N} _.,'"-]+$/u;
// A part of a style sheet address, with `*` as a wildcard. Only characters that can stand in an address, and at most
// L.URL_PART_STARS stars (the look-ahead refuses a ninth one).
const URL_PART = /^(?!(?:[^*]*\*){9})[A-Za-z0-9._~:/?#@!$&'()*+,;=%\[\]-]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_NO_WS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * The host of a site pattern in the form `location.host` has: lower case, a bracketed IPv6 literal in the URL parser's canonical form
 * (`[0:0:0:0:0:0:0:1]` and `[::1]` are one key), a port of 0 to 65535 without leading zeros. An IPv6 literal is an address: it has no
 * `*.` form. Null when it is not a host name or an address.
 * @param {string} host lower case, no path
 * @returns {string | null}
 */
function canonicalHost(host) {
  let name;
  let port;
  if (host.startsWith('[')) {
    const m = IPV6_HOST.exec(host);
    if (!m) return null;
    try {
      name = new URL(`http://${m[1]}/`).hostname;
    } catch {
      return null;
    }
    port = m[2];
  } else {
    if (!HOST.test(host)) return null;
    const m = /:(\d{1,5})$/.exec(host);
    name = m ? host.slice(0, m.index) : host;
    port = m?.[1];
  }
  if (port === undefined) return name;
  const n = Number(port);
  return n > 65535 ? null : `${name}:${n}`;
}

/** Lower-case host plus optional path prefix, no scheme, query or hash. Null if invalid. */
/** @param {unknown} input @returns {string | null} */
export function normalizePattern(input) {
  if (typeof input !== 'string' || input.length > L.PATTERN_CHARS) return null;
  let s = input.trim();
  if (s === '' || CONTROL.test(s)) return null;
  s = s.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
  s = s.replace(/[?#].*$/, '');
  const slash = s.indexOf('/');
  const raw = (slash < 0 ? s : s.slice(0, slash)).toLowerCase();
  let path = slash < 0 ? '' : s.slice(slash).replace(/\/+$/, '');
  const host = raw === '' || raw.length > L.HOST_CHARS ? null : canonicalHost(raw);
  if (host === null || host.length > L.HOST_CHARS) return null;
  if (path !== '' && !PATH.test(path)) return null;
  if (path === '/') path = '';
  return host + path;
}

/** Selectors that name the whole page. A list that colors or inverts them would not be a per-site fix. @param {string} s */
export function isTooBroad(s) {
  return /^\s*(\*|html|body|:root)\s*(,\s*(\*|html|body|:root)\s*)*$/i.test(s);
}

/** A part of a style sheet address, as a fix may list it. @param {unknown} s */
export function isUrlPart(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= L.URL_PART_CHARS && URL_PART.test(s);
}

/** A conservative check for a CSS selector string. The page-side engine checks again with the browser. */
/** @param {unknown} s */
export function isSafeSelector(s) {
  if (typeof s !== 'string' || s.trim() === '' || s.length > L.SELECTOR_CHARS) return false;
  if (CONTROL.test(s) || /[{};<]/.test(s)) return false;
  /** @type {string[]} */
  const stack = [];
  /** @type {Record<string, string>} */
  const pairs = { ')': '(', ']': '[' };
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      // An escape needs a character after it; a trailing one would swallow the next piece of joined CSS.
      if (i + 1 >= s.length) return false;
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    // Outside a string a selector has no comment mark and no at-rule: either would change the CSS around it.
    if (c === '@' || (c === '/' && s[i + 1] === '*') || (c === '*' && s[i + 1] === '/')) return false;
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') stack.push(c);
    else if (c === ')' || c === ']') {
      if (stack.pop() !== pairs[c]) return false;
    }
  }
  return stack.length === 0 && quote === '';
}

/* ------------------------------------------------------------------ */
/* Spec constructors                                                   */
/* ------------------------------------------------------------------ */

/** @typedef {any} Spec */
const bool = () => ({ kind: 'bool' });
const int = (/** @type {{min:number,max:number}} */ r) => ({ kind: 'int', min: r.min, max: r.max });
const num = (/** @type {number} */ min, /** @type {number} */ max) => ({ kind: 'num', min, max });
const oneOf = (/** @type {readonly string[]} */ values) => ({ kind: 'enum', values });
const intOf = (/** @type {readonly number[]} */ values) => ({ kind: 'intOf', values });
const color = () => ({ kind: 'color' });
const colorAuto = () => ({ kind: 'colorAuto' });
const str = (/** @type {number} */ max, /** @type {RegExp | undefined} */ re = undefined) => ({ kind: 'str', max, re });
const cssText = (/** @type {number} */ max) => ({ kind: 'css', max });
const time = () => ({ kind: 'time' });
const pattern = () => ({ kind: 'pattern' });
const selector = (narrow = false) => ({ kind: 'selector', narrow });
const nullable = (/** @type {Spec} */ spec) => ({ kind: 'nullable', spec });
const arr = (/** @type {Spec} */ spec, /** @type {number} */ max, /** @type {string | undefined} */ uniqueBy = undefined) => ({
  kind: 'arr',
  spec,
  max,
  uniqueBy,
});
const map = (/** @type {Spec} */ spec, /** @type {number} */ max) => ({ kind: 'map', spec, max });
const obj = (/** @type {Record<string, Spec>} */ fields, partial = false) => ({ kind: 'obj', fields, partial });

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const THEME_FIELDS = {
  // `original` keeps the page's own colors: only the correction for color vision and the link underline apply.
  mode: oneOf(['dark', 'light', 'eink', 'original']),
  brightness: int(L.BRIGHTNESS),
  contrast: int(L.CONTRAST),
  sepia: int(L.SEPIA),
  grayscale: int(L.GRAYSCALE),
  warmth: int(L.WARMTH),
  darkBackground: color(),
  darkText: color(),
  lightBackground: color(),
  lightText: color(),
  colorSchemeDark: oneOf(DARK_IDS),
  colorSchemeLight: oneOf(LIGHT_IDS),
  fontEnabled: bool(),
  fontFamily: str(L.FONT_CHARS, FONT),
  textStroke: int(L.TEXT_STROKE),
  scrollbar: colorAuto(),
  selection: colorAuto(),
  systemControls: bool(),
  fade: bool(),
  useSiteDark: bool(),
  // The E-ink and Paper mode. A null value means "the value of the preset" (EINK_PRESETS below).
  einkPreset: oneOf(['eink', 'paper']),
  paperColor: nullable(color()),
  inkColor: nullable(color()),
  // The two words are the old form of the amount of color; they are still read (mono is 0, muted is 40).
  einkColor: nullable(oneOf(['mono', 'muted'])),
  einkColorAmount: nullable(int(L.EINK_COLOR)),
  einkGrayAll: nullable(bool()),
  einkLevels: nullable(intOf(L.EINK_LEVELS)),
  einkContrast: nullable(int(L.EINK_CONTRAST)),
  whiteCap: nullable(int(L.WHITE_CAP)),
  einkBlue: nullable(int(L.EINK_BLUE)),
  einkImages: nullable(oneOf(['gray', 'dim', 'off', 'follow'])),
  einkImageContrast: nullable(int(L.IMAGE_CONTRAST)),
  einkLinks: nullable(bool()),
  einkBorders: nullable(bool()),
  noAnimation: nullable(bool()),
  noTransition: nullable(bool()),
  noSmoothScroll: nullable(bool()),
  noShadow: nullable(bool()),
  reducedMotionHint: nullable(bool()),
  einkFont: nullable(str(L.FONT_CHARS, FONT)),
  einkWeight: nullable(int(L.EINK_WEIGHT)),
  // Color vision: the kind of deficiency the colors are corrected for, how strong it is, and whether pictures are corrected too.
  cvdType: oneOf(['none', 'protan', 'deutan', 'tritan', 'grayscale', 'grayscaleInverted', 'inverted']),
  cvdSeverity: int(L.CVD_SEVERITY),
  cvdBoost: int(L.CVD_BOOST),
  cvdMedia: bool(),
  linkUnderline: bool(),
};

const THEME_FULL = obj(THEME_FIELDS);
const THEME_PARTIAL = obj(THEME_FIELDS, true);

const SETTINGS = obj({
  enabled: bool(),
  listMode: oneOf(['allExcept', 'onlyListed']),
  engine: oneOf(ENGINES),
  detectDark: bool(),
  respectOnlyLight: bool(),
  holdPaint: bool(),
  theme: obj({ ...THEME_FIELDS, css: cssText(L.CSS_CHARS) }),
  automation: obj({
    mode: oneOf(['none', 'time', 'system', 'location']),
    behavior: oneOf(['onOff', 'scheme']),
    // With the behavior `scheme`: the mode inside the active hours and outside them.
    activeMode: oneOf(['dark', 'light', 'eink', 'original']),
    idleMode: oneOf(['dark', 'light', 'eink', 'original']),
    time: obj({ from: time(), to: time() }),
    location: obj({ lat: nullable(num(-90, 90)), lon: nullable(num(-180, 180)) }),
  }),
  contextMenu: bool(),
  pdf: bool(),
  syncEnabled: bool(),
  syncIncludeSites: bool(),
  // True while the global custom CSS arrived by import or sync and is not turned on yet. Set by the worker only.
  cssHeld: bool(),
});

const SITE_RULE = obj(
  { enabled: bool(), engine: oneOf(ENGINES), theme: THEME_PARTIAL, css: cssText(L.CSS_CHARS), cssHeld: bool() },
  true,
);

const FIX = obj(
  {
    note: str(L.NOTE_CHARS),
    engine: oneOf(ENGINES),
    dynamic: obj(
      {
        invert: arr(selector(true), L.SELECTORS),
        css: cssText(L.CSS_CHARS),
        ignoreInline: arr(selector(), L.SELECTORS),
        ignoreImage: arr(selector(), L.SELECTORS),
        ignoreCssUrl: arr(str(L.URL_PART_CHARS, URL_PART), L.URL_PARTS),
        theme: THEME_PARTIAL,
      },
      true,
    ),
    static: obj(
      {
        bg: arr(selector(true), L.SELECTORS),
        fg: arr(selector(true), L.SELECTORS),
        border: arr(selector(true), L.SELECTORS),
        skip: arr(selector(true), L.SELECTORS),
      },
      true,
    ),
    darkHint: arr(selector(), L.DARK_HINTS),
    notDark: bool(),
    cssHeld: bool(),
    verified: obj({ date: str(20), browsers: arr(str(40), 10), test: str(L.NOTE_CHARS) }),
  },
  true,
);

const SECTION_SPECS = {
  settings: SETTINGS,
  siteRules: map(SITE_RULE, L.SITE_RULES),
  presets: arr(
    obj({ id: str(L.ID_CHARS, ID), name: str(L.NAME_CHARS), theme: THEME_FULL }),
    L.PRESETS,
    'id',
  ),
  userFixes: map(FIX, L.USER_FIXES),
  darkSites: obj({
    add: arr(pattern(), L.DARK_SITE_ENTRIES),
    remove: arr(pattern(), L.DARK_SITE_ENTRIES),
  }),
  ui: obj({
    locale: oneOf(['auto', ...LOCALES]),
    uiTheme: oneOf(['system', 'light', 'dark']),
    support: obj({ installedAt: int(L.TIMESTAMP), lastShownAt: int(L.TIMESTAMP), shownCount: int(L.SHOWN_COUNT), optOut: bool() }),
  }),
};

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export function defaultTheme() {
  return {
    mode: 'dark',
    brightness: 100,
    contrast: 100,
    sepia: 0,
    grayscale: 0,
    warmth: 0,
    darkBackground: '#16181d',
    darkText: '#e6e8eb',
    lightBackground: '#eeece8',
    lightText: '#1a1c20',
    colorSchemeDark: 'Default',
    colorSchemeLight: 'Default',
    fontEnabled: false,
    fontFamily: 'system-ui',
    textStroke: 0,
    scrollbar: 'auto',
    selection: 'auto',
    systemControls: true,
    fade: true,
    useSiteDark: true,
    einkPreset: 'paper',
    paperColor: null,
    inkColor: null,
    einkColor: null,
    einkColorAmount: null,
    einkGrayAll: null,
    einkLevels: null,
    einkContrast: null,
    whiteCap: null,
    einkBlue: null,
    einkImages: null,
    einkImageContrast: null,
    einkLinks: null,
    einkBorders: null,
    noAnimation: null,
    noTransition: null,
    noSmoothScroll: null,
    noShadow: null,
    reducedMotionHint: null,
    einkFont: null,
    einkWeight: null,
    cvdType: 'none',
    cvdSeverity: 100,
    cvdBoost: 50,
    cvdMedia: true,
    linkUnderline: false,
  };
}

/** The fields of the E-ink and Paper mode that a preset fills in. */
export const EINK_FIELDS = Object.freeze([
  'paperColor', 'inkColor', 'einkColor', 'einkColorAmount', 'einkGrayAll', 'einkLevels', 'einkContrast', 'whiteCap', 'einkBlue', 'einkImages', 'einkImageContrast',
  'einkLinks', 'einkBorders', 'noAnimation', 'noTransition', 'noSmoothScroll', 'noShadow', 'reducedMotionHint', 'einkFont', 'einkWeight',
]);

/**
 * The two presets of the E-ink and Paper mode. The page side keeps its own copy in content/engine/color.js (a content script
 * cannot import a module); a unit test keeps the two the same.
 */
export const EINK_PRESETS = Object.freeze({
  eink: Object.freeze({
    paperColor: '#ffffff', inkColor: '#000000', einkColor: 'mono', einkColorAmount: 0, einkGrayAll: true, einkLevels: 8, einkContrast: 100, whiteCap: 100, einkBlue: 0,
    einkImages: 'gray', einkImageContrast: 120, einkLinks: true, einkBorders: true,
    noAnimation: true, noTransition: true, noSmoothScroll: true, noShadow: true, reducedMotionHint: true,
    einkFont: 'keep', einkWeight: 0,
  }),
  paper: Object.freeze({
    paperColor: '#f4f1ea', inkColor: '#2b2620', einkColor: 'muted', einkColorAmount: 35, einkGrayAll: false, einkLevels: 0, einkContrast: 100, whiteCap: 84, einkBlue: 12,
    einkImages: 'follow', einkImageContrast: 100, einkLinks: true, einkBorders: false,
    noAnimation: false, noTransition: false, noSmoothScroll: false, noShadow: false, reducedMotionHint: false,
    einkFont: 'keep', einkWeight: 0,
  }),
});

/** A patch that sets every field of the mode to "the value of the preset". */
export const EINK_RESET = Object.freeze(Object.fromEntries(EINK_FIELDS.map((key) => [key, null])));

/** The values of the mode for a theme: what the person set, and the preset's value for every field that is null or missing. @param {any} theme */
export function einkValues(theme) {
  const preset = theme?.einkPreset === 'eink' ? 'eink' : 'paper';
  /** @type {Record<string, any>} */
  const out = { preset };
  for (const key of EINK_FIELDS) {
    const v = theme?.[key];
    out[key] = v === null || v === undefined ? /** @type {Record<string, any>} */ (EINK_PRESETS[preset])[key] : v;
  }
  return out;
}

export function defaultSettings() {
  return {
    enabled: true,
    listMode: 'allExcept',
    engine: 'auto',
    detectDark: true,
    respectOnlyLight: true,
    holdPaint: true,
    theme: { ...defaultTheme(), css: '' },
    automation: {
      mode: 'none',
      behavior: 'onOff',
      activeMode: 'dark',
      idleMode: 'light',
      time: { from: '18:00', to: '07:00' },
      location: { lat: null, lon: null },
    },
    contextMenu: false,
    pdf: false,
    syncEnabled: false,
    syncIncludeSites: false,
    cssHeld: false,
  };
}

const SECTION_DEFAULTS = {
  settings: defaultSettings,
  siteRules: () => Object.create(null),
  presets: () => [],
  userFixes: () => Object.create(null),
  darkSites: () => ({ add: [], remove: [] }),
  ui: () => ({ locale: 'auto', uiTheme: 'system', support: { installedAt: 0, lastShownAt: 0, shownCount: 0, optOut: false } }),
};

export function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: 0,
    settings: defaultSettings(),
    siteRules: SECTION_DEFAULTS.siteRules(),
    presets: SECTION_DEFAULTS.presets(),
    userFixes: SECTION_DEFAULTS.userFixes(),
    darkSites: SECTION_DEFAULTS.darkSites(),
    ui: SECTION_DEFAULTS.ui(),
  };
}

/** Defaults for one object spec, used to fill missing keys and to replace bad values. */
/** @param {string} path */
function defaultsFor(path) {
  // Only the shape of the settings and ui objects needs defaults; partial objects have none.
  const parts = path.split('.');
  let node = /** @type {any} */ (null);
  const root = parts[0];
  if (root === 'settings') node = defaultSettings();
  else if (root === 'ui') node = SECTION_DEFAULTS.ui();
  else if (root === 'darkSites') node = SECTION_DEFAULTS.darkSites();
  else if (root === 'presets') node = { theme: defaultTheme() };
  else return undefined;
  for (const p of parts.slice(1)) {
    if (/^\d+$/.test(p)) continue;
    if (node == null || typeof node !== 'object') return undefined;
    node = node[p];
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Sanitizer                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {any} spec
 * @param {any} value
 * @param {string} path
 * @param {Ctx} ctx
 * @returns {Result}
 */
function run(spec, value, path, ctx) {
  const bad = (/** @type {string} */ msg) => {
    if (ctx.errors.length < L.MAX_ERRORS) ctx.errors.push(`${path}: ${msg}`);
    return /** @type {Result} */ ({ ok: false });
  };
  const good = (/** @type {any} */ v) => /** @type {Result} */ ({ ok: true, value: v });

  switch (spec.kind) {
    case 'bool':
      return typeof value === 'boolean' ? good(value) : bad('must be true or false');
    case 'int':
      return Number.isInteger(value) && value >= spec.min && value <= spec.max
        ? good(value)
        : bad(`must be a whole number from ${spec.min} to ${spec.max}`);
    case 'num':
      return typeof value === 'number' && Number.isFinite(value) && value >= spec.min && value <= spec.max
        ? good(value)
        : bad(`must be a number from ${spec.min} to ${spec.max}`);
    case 'intOf':
      return Number.isInteger(value) && spec.values.includes(value) ? good(value) : bad(`must be one of ${spec.values.join(', ')}`);
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
        ? good(value)
        : bad(`must be one of ${spec.values.join(', ')}`);
    case 'color': {
      const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (HEX6.test(v)) return good(v);
      if (HEX3.test(v)) return good(`#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`);
      return bad('must be a hex color like #112233');
    }
    case 'colorAuto':
      return value === 'auto' ? good('auto') : run({ kind: 'color' }, value, path, ctx);
    case 'str':
      if (typeof value !== 'string') return bad('must be text');
      if (value.length > spec.max) return bad(`is longer than ${spec.max} characters`);
      if (CONTROL.test(value)) return bad('has a control character');
      if (value.trim() === '') return bad('must not be empty');
      if (spec.re && !spec.re.test(value)) return bad('has a character that is not allowed');
      return good(value);
    case 'css':
      if (typeof value !== 'string') return bad('must be text');
      if (value.length > spec.max) return bad(`is longer than ${spec.max} characters`);
      if (CONTROL_NO_WS.test(value)) return bad('has a control character');
      return good(value);
    case 'time': {
      const m = typeof value === 'string' ? TIME.exec(value) : null;
      return m ? good(value) : bad('must be a time like 18:30');
    }
    case 'pattern': {
      const p = normalizePattern(value);
      return p ? good(p) : bad('is not a valid site pattern');
    }
    case 'selector':
      if (!isSafeSelector(value)) return bad('is not an accepted selector');
      return spec.narrow && isTooBroad(value) ? bad('is too broad') : good(value);
    case 'nullable':
      return value === null ? good(null) : run(spec.spec, value, path, ctx);
    case 'arr': {
      if (!Array.isArray(value)) return bad('must be a list');
      if (value.length > spec.max) return bad(`has more than ${spec.max} items`);
      /** @type {any[]} */
      const out = [];
      const seen = new Set();
      for (let i = 0; i < value.length; i++) {
        const r = run(spec.spec, value[i], `${path}.${i}`, ctx);
        if (!r.ok) continue;
        if (spec.uniqueBy) {
          const key = r.value[spec.uniqueBy];
          if (seen.has(key)) {
            bad(`item ${i} repeats ${spec.uniqueBy} "${key}"`);
            continue;
          }
          seen.add(key);
        } else if (spec.spec.kind === 'pattern' || spec.spec.kind === 'selector') {
          if (seen.has(r.value)) continue;
          seen.add(r.value);
        }
        out.push(r.value);
      }
      return good(out);
    }
    case 'map': {
      if (!isPlain(value)) return bad('must be an object');
      const keys = Object.keys(value);
      if (keys.length > spec.max) return bad(`has more than ${spec.max} entries`);
      const out = Object.create(null);
      for (const key of keys) {
        const norm = normalizePattern(key);
        if (!norm) {
          bad(`key "${clip(key)}" is not a valid site pattern`);
          continue;
        }
        if (norm in out) {
          bad(`key "${clip(key)}" repeats "${norm}"`);
          continue;
        }
        const r = run(spec.spec, value[key], `${path}.${norm}`, ctx);
        if (r.ok) out[norm] = r.value;
      }
      return good(out);
    }
    case 'obj': {
      if (!isPlain(value)) return bad('must be an object');
      /** @type {Record<string, any>} */
      const out = {};
      const fields = spec.fields;
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(fields, key)) {
          if (ctx.strict) bad(`${clip(key)} is not a known field`);
        }
      }
      const defaults = spec.partial ? undefined : defaultsFor(path);
      for (const key of Object.keys(fields)) {
        if (Object.hasOwn(value, key)) {
          const r = run(fields[key], value[key], `${path}.${key}`, ctx);
          if (r.ok) out[key] = r.value;
          else if (!ctx.strict && defaults && key in defaults) out[key] = clone(defaults[key]);
        } else if (defaults && key in defaults) {
          out[key] = clone(defaults[key]);
        } else if (!spec.partial) {
          return bad(`${key} is required`);
        }
      }
      return good(out);
    }
    default:
      return bad('has an unknown rule');
  }
}

/** @param {unknown} s */
const clip = (s) => String(s).slice(0, 40);
/** @param {any} v */
const clone = (v) => (v && typeof v === 'object' ? structuredClone(v) : v);

/** @param {any} v */
function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Palette ids follow the colors: a theme whose colors are a palette gets its id, any other gets Custom. @param {string} name @param {any} value */
function labelPalettes(name, value) {
  const label = (/** @type {any} */ theme) => {
    if (isPlain(theme)) Object.assign(theme, paletteLabels(theme));
  };
  if (name === 'settings') label(value?.theme);
  else if (name === 'presets' && Array.isArray(value)) for (const p of value) label(p?.theme);
  else if (name === 'siteRules' && isPlain(value)) for (const r of Object.values(value)) label(/** @type {any} */ (r)?.theme);
  else if (name === 'userFixes' && isPlain(value)) for (const f of Object.values(value)) label(/** @type {any} */ (f)?.dynamic?.theme);
}

/**
 * Check one section.
 * Strict mode (imports, patches, writes): any problem is an error and the value must not be used.
 * Lenient mode (reading storage): bad parts are replaced with defaults or dropped; `errors` says what.
 * @param {string} name
 * @param {any} input
 * @param {{ strict?: boolean }} [options]
 * @returns {{ value: any, errors: string[] }}
 */
export function sanitizeSection(name, input, options = {}) {
  const spec = SECTION_SPECS[/** @type {keyof typeof SECTION_SPECS} */ (name)];
  if (!spec) return { value: undefined, errors: [`${name}: unknown section`] };
  const ctx = { errors: [], strict: options.strict === true };
  const r = run(spec, input, name, ctx);
  if (r.ok) labelPalettes(name, r.value);
  if (r.ok) return { value: ctx.strict && ctx.errors.length ? undefined : r.value, errors: ctx.errors };
  const fallback = SECTION_DEFAULTS[/** @type {keyof typeof SECTION_DEFAULTS} */ (name)]();
  return { value: ctx.strict ? undefined : fallback, errors: ctx.errors };
}

/**
 * Check a whole state document (every section, plus `schemaVersion`).
 * Missing sections get defaults in both modes.
 * @param {any} raw
 * @param {{ strict?: boolean }} [options]
 */
export function sanitizeState(raw, options = {}) {
  /** @type {string[]} */
  const errors = [];
  const state = defaultState();
  if (!isPlain(raw)) return { value: options.strict ? undefined : state, errors: ['state: must be an object'] };
  for (const name of SECTIONS) {
    if (!Object.hasOwn(raw, name)) continue;
    const r = sanitizeSection(name, raw[name], options);
    errors.push(...r.errors);
    if (r.value !== undefined) /** @type {any} */ (state)[name] = r.value;
  }
  if (Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0) state.updatedAt = raw.updatedAt;
  return { value: errors.length && options.strict ? undefined : state, errors };
}

/* ------------------------------------------------------------------ */
/* Patch                                                               */
/* ------------------------------------------------------------------ */

/** @param {any} value @param {number} level @returns {boolean} */
function hasDangerousKey(value, level) {
  if (value === null || typeof value !== 'object' || level > L.MAX_DEPTH) return false;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
    if (hasDangerousKey(value[key], level + 1)) return true;
  }
  return false;
}

/** @param {any} base @param {any} patch @returns {any} */
function merge(base, patch) {
  if (!isPlain(patch)) return patch;
  const out = isPlain(base) ? { ...base } : {};
  for (const key of Object.keys(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = isPlain(patch[key]) && isPlain(out[key]) ? merge(out[key], patch[key]) : patch[key];
  }
  return out;
}

/**
 * Deep-merge a partial change into settings, then check the whole result strictly.
 * Objects merge by key; every other value replaces. Unknown keys are errors.
 * @param {any} settings
 * @param {any} patch
 */
export function applyPatch(settings, patch) {
  if (!isPlain(patch)) return { value: undefined, errors: ['patch: must be an object'] };
  if (hasDangerousKey(patch, 0)) return { value: undefined, errors: ['patch: has a key that is not allowed'] };
  const merged = merge(settings, patch);
  const r = sanitizeSection('settings', merged, { strict: true });
  return r.errors.length ? { value: undefined, errors: r.errors } : { value: r.value, errors: [] };
}

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

/** Each step takes raw data of version n and returns raw data of version n + 1. */
/** @type {Readonly<Record<number, (raw: any) => any>>} */
export const MIGRATIONS = Object.freeze({
  0: (/** @type {any} */ raw) => raw,
  // Before 0.3.16 pictures did not follow the color vision filter by default, and the first run stored that `false`: it gives way to
  // the new default once.
  1: (/** @type {any} */ raw) => {
    const theme = raw?.settings?.theme;
    if (!isPlain(theme) || theme.cvdMedia !== false) return raw;
    const { cvdMedia, ...rest } = theme;
    void cvdMedia;
    return { ...raw, settings: { ...raw.settings, theme: rest } };
  },
});

/**
 * @param {any} raw  the stored keys as one object
 * @param {Record<number, (raw: any) => any>} [steps]
 * @param {number} [target]
 * @returns {{ ok: true, raw: any } | { ok: false, code: 'newer' | 'no-path' | 'invalid' }}
 */
export function migrate(raw, steps = MIGRATIONS, target = SCHEMA_VERSION) {
  if (!isPlain(raw)) return { ok: false, code: 'invalid' };
  let version = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 0;
  if (version > target) return { ok: false, code: 'newer' };
  let current = raw;
  while (version < target) {
    const step = steps[version];
    if (typeof step !== 'function') return { ok: false, code: 'no-path' };
    current = { ...step(current), schemaVersion: version + 1 };
    version += 1;
  }
  return { ok: true, raw: current };
}

/* ------------------------------------------------------------------ */
/* Export and import                                                   */
/* ------------------------------------------------------------------ */

const EXPORT_SECTIONS = ['settings', 'siteRules', 'presets', 'userFixes', 'darkSites'];

/** Build the export object. `ui` stays out because language and look are per device. */
/** @param {any} state @param {number} [now] */
export function exportState(state, now = Date.now()) {
  /** @type {Record<string, any>} */
  const out = {
    app: 'tintly',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(now).toISOString(),
  };
  for (const name of EXPORT_SECTIONS) out[name] = state[name];
  return withoutHold(out);
}

export const serializeExport = (/** @type {any} */ state, /** @type {number | undefined} */ now = undefined) => `${JSON.stringify(exportState(state, now), null, 2)}\n`;

/** @param {any} value @param {number} limit @param {number} [level] @returns {number} */
function depthOf(value, limit, level = 0) {
  if (level > limit) return level;
  if (value === null || typeof value !== 'object') return level;
  let max = level;
  for (const key of Object.keys(value)) {
    max = Math.max(max, depthOf(value[key], limit, level + 1));
    if (max > limit) return max;
  }
  return max;
}

/* ------------------------------------------------------------------ */
/* Held custom CSS                                                     */
/* ------------------------------------------------------------------ */

// Custom CSS that arrives by import or sync stays off until the person turns it on on this device. The flag `cssHeld`
// sits on the record that owns the CSS: the settings, a site rule or a user fix. It belongs to the device, so it is never
// exported or synced, and a file or a sync item cannot clear it: the worker decides it for every incoming record.

/** @param {any} rule */
export const ruleCss = (rule) => (typeof rule?.css === 'string' ? rule.css : '');
/** @param {any} fix */
export const fixCss = (fix) => (typeof fix?.dynamic?.css === 'string' ? fix.dynamic.css : '');
/** The gate applies CSS that has text after trimming. @param {string} css */
const hasCss = (css) => css.trim() !== '';

/**
 * Set `cssHeld` on incoming records. A record whose CSS equals the CSS this device already trusts stays trusted; any other
 * CSS is held. Only the sections present in `next` are touched. `next` is changed in place.
 * @param {any} prev  the state on this device
 * @param {Record<string, any>} next  checked sections that are about to replace the stored ones
 */
export function holdIncoming(prev, next) {
  if (next.settings) {
    const css = next.settings.theme.css;
    const trusted = prev.settings.theme.css === css && prev.settings.cssHeld !== true;
    next.settings.cssHeld = hasCss(css) && !trusted;
  }
  for (const [name, cssOf] of /** @type {const} */ ([
    ['siteRules', ruleCss],
    ['userFixes', fixCss],
  ])) {
    if (!next[name]) continue;
    for (const key of Object.keys(next[name])) {
      const item = next[name][key];
      const css = cssOf(item);
      const before = Object.hasOwn(prev[name], key) ? prev[name][key] : undefined;
      const trusted = before !== undefined && cssOf(before) === css && before.cssHeld !== true;
      if (hasCss(css) && !trusted) item.cssHeld = true;
      else delete item.cssHeld;
    }
  }
  return next;
}

/**
 * What a local write of a rule or a fix keeps of the hold. The person edits the CSS in the same card, so a held record stays
 * held until it is turned on; a record without CSS holds nothing. A flag in the record the page sent is ignored.
 * @param {any} before  the stored record, if any
 * @param {any} record  the record the page sent
 * @param {(r: any) => string} cssOf
 */
export function keepHold(before, record, cssOf) {
  const { cssHeld, ...rest } = record;
  void cssHeld;
  return before?.cssHeld === true && hasCss(cssOf(rest)) ? { ...rest, cssHeld: true } : rest;
}

/** The records that hold CSS now, for the screens. @param {any} state */
export function heldCss(state) {
  const pick = (/** @type {'siteRules' | 'userFixes'} */ name, /** @type {(r: any) => string} */ cssOf) =>
    Object.keys(state[name])
      .filter((k) => state[name][k]?.cssHeld === true && hasCss(cssOf(state[name][k])))
      .sort();
  return {
    settings: state.settings.cssHeld === true && hasCss(state.settings.theme.css),
    siteRules: pick('siteRules', ruleCss),
    userFixes: pick('userFixes', fixCss),
  };
}

/** A copy without the device flags, for export and sync. @template T @param {T} value @returns {T} */
export function withoutHold(value) {
  const v = /** @type {any} */ (value);
  const out = { ...v };
  if (v.settings) {
    const { cssHeld, ...settings } = v.settings;
    void cssHeld;
    out.settings = settings;
  }
  for (const name of ['siteRules', 'userFixes']) {
    if (!v[name]) continue;
    const map = Object.create(null);
    for (const key of Object.keys(v[name])) {
      const { cssHeld, ...rest } = v[name][key];
      void cssHeld;
      map[key] = rest;
    }
    out[name] = map;
  }
  return out;
}

/** Can this CSS ask for another address (a picture, a font, an imported sheet)? A backslash is read as a possible escape of one of the words. @param {unknown} css */
export function cssReachesOut(css) {
  return typeof css === 'string' && /url\s*\(|@import|image-set\s*\(|src\s*\(|element\s*\(|cross-fade\s*\(|paint\s*\(|\\/i.test(css);
}

/** Count what an import would change, for the confirmation screen. */
/** @param {any} state */
export function summarize(state) {
  const customCss =
    state.settings.theme.css !== '' ||
    Object.values(state.siteRules).some((/** @type {any} */ r) => typeof r.css === 'string' && r.css !== '') ||
    Object.values(state.userFixes).some((/** @type {any} */ f) => typeof f.dynamic?.css === 'string' && f.dynamic.css !== '');
  const sheets = [state.settings.theme.css, ...Object.values(state.siteRules).map((/** @type {any} */ r) => r.css), ...Object.values(state.userFixes).map((/** @type {any} */ f) => f.dynamic?.css)];
  return {
    siteRules: Object.keys(state.siteRules).length,
    presets: state.presets.length,
    userFixes: Object.keys(state.userFixes).length,
    darkSiteEntries: state.darkSites.add.length + state.darkSites.remove.length,
    customCss,
    remoteCss: sheets.some(cssReachesOut),
  };
}

/**
 * Parse and check an import file. Nothing is applied here.
 * @param {string} text
 * @returns {{ ok: true, state: any, summary: ReturnType<typeof summarize> } | { ok: false, code: string, errors: string[] }}
 */
export function parseImport(text) {
  const fail = (/** @type {string} */ code, /** @type {string[]} */ errors = []) =>
    /** @type {{ ok: false, code: string, errors: string[] }} */ ({ ok: false, code, errors });
  if (typeof text !== 'string') return fail('invalid');
  if (new TextEncoder().encode(text).length > L.IMPORT_BYTES) return fail('too-large');

  let data;
  try {
    data = JSON.parse(text, (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
  } catch {
    return fail('not-json');
  }
  if (!isPlain(data)) return fail('invalid');
  if (depthOf(data, L.MAX_DEPTH) > L.MAX_DEPTH) return fail('too-deep');
  if (data.app !== 'tintly') return fail('wrong-app');

  const moved = migrate(data);
  if (!moved.ok) return fail(moved.code === 'newer' ? 'newer-version' : 'invalid');

  const { app, exportedAt, schemaVersion, ...sections } = moved.raw;
  void app;
  void exportedAt;
  void schemaVersion;
  /** @type {string[]} */
  const errors = [];
  for (const key of Object.keys(sections)) {
    if (!EXPORT_SECTIONS.includes(key)) errors.push(`${clip(key)}: is not a known section`);
  }
  const r = sanitizeState(sections, { strict: true });
  errors.push(...r.errors);
  if (errors.length || !r.value) return fail('invalid-data', errors.slice(0, L.MAX_ERRORS));
  return { ok: true, state: r.value, summary: summarize(r.value) };
}
