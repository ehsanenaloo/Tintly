// @ts-check

// One literal import per language: no dynamic specifier, so a linter and a reviewer can read it.
const LOADERS = Object.freeze({
  fa: () => import('./locales/fa.js'),
  en: () => import('./locales/en.js'),
  ar: () => import('./locales/ar.js'),
  he: () => import('./locales/he.js'),
});
export const LOCALES = Object.freeze(Object.keys(LOADERS));
/** Show a look on the page: 'light' or 'dark' is forced, 'system' follows the browser. @param {string} value */
export function applyUiTheme(value) {
  if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
}

/** Language codes some browsers still send under their old name. */
const LEGACY = Object.freeze({ iw: 'he' });

const RTL_LOCALES = new Set(['fa', 'ar', 'he']);
const FALLBACK = 'en';

/** @type {Map<string, Record<string, string>>} */
const catalogs = new Map();

/**
 * @param {string | undefined} stored
 * @param {readonly string[]} browserLanguages
 */
export function pickLocale(stored, browserLanguages) {
  if (stored && LOCALES.includes(stored)) return stored;
  for (const tag of browserLanguages) {
    const raw = tag.toLowerCase().split(/[-_]/)[0];
    const base = Object.hasOwn(LEGACY, raw) ? LEGACY[/** @type {'iw'} */ (raw)] : raw;
    if (LOCALES.includes(base)) return base;
  }
  return FALLBACK;
}

/** @param {string} code */
export async function loadCatalog(code) {
  const known = catalogs.get(code);
  if (known) return known;
  const load = LOADERS[/** @type {keyof typeof LOADERS} */ (code)] ?? LOADERS[FALLBACK];
  const module = await load();
  catalogs.set(code, module.default);
  return module.default;
}

/**
 * @param {string} message
 * @param {Record<string, string | number>} [params]
 */
export function format(message, params = {}) {
  return message.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/**
 * Set language and direction, then fill every element that has `data-i18n`.
 * @param {Promise<{ ui?: { locale?: string, uiTheme?: string } }>} [stored]  the stored `ui` section, when the page reads the storage itself
 * @param {{ title?: (t: (key: string) => string) => string }} [page]  the title of the page, when it is not the name of the extension
 */
export async function initI18n(stored, page = {}) {
  const { ui } = /** @type {{ ui?: { locale?: string, uiTheme?: string } }} */ (await (stored ?? chrome.storage.local.get('ui')));
  // The language of the browser itself comes first: it is the one the person chose for the interface, not for web pages.
  let browserLanguage = '';
  try {
    browserLanguage = chrome.i18n?.getUILanguage?.() ?? '';
  } catch {
    browserLanguage = '';
  }
  const locale = pickLocale(ui?.locale, [browserLanguage, ...navigator.languages].filter(Boolean));
  const catalog = await loadCatalog(locale);
  const root = document.documentElement;
  root.lang = locale;
  root.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
  if (ui?.uiTheme === 'light' || ui?.uiTheme === 'dark') root.dataset.theme = ui.uiTheme;
  // Resolve the style now, while the page is still marked as loading (no transitions): a transition starts from the last resolved style, which is the other look.
  void root.offsetWidth;
  /** @param {string} key @param {Record<string, string | number>} [params] */
  const t = (key, params) => format(catalog[key] ?? key, params);
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n') ?? '');
  }
  for (const attr of ['aria-label', 'title', 'placeholder']) {
    for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`) ?? ''));
    }
  }
  document.title = page.title ? page.title(t) : t('app.name');
  // A look chosen in one extension page shows in every other open page at once.
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = area === 'local' ? /** @type {{ newValue?: { uiTheme?: string }, oldValue?: { uiTheme?: string } } | undefined} */ (changes.ui) : undefined;
    const next = change?.newValue?.uiTheme;
    if (next === undefined || next === change?.oldValue?.uiTheme) return;
    applyUiTheme(next);
    document.dispatchEvent(new CustomEvent('dk-uitheme', { detail: next }));
  });
  return { t, locale, ui: ui ?? null };
}
