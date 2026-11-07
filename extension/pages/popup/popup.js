// @ts-check
import { numberFormat } from '../../shared/numbers.js';
import { initI18n, applyUiTheme, loadCatalog } from '../../shared/i18n.js';
import { L } from '../../shared/limits.js';
import { hydrateIcons, icon, openUrl } from '../../shared/dom.js';
import { browserBlocks } from '../../shared/blocked.js';
import { LINKS, loadInstallType } from '../../shared/footer-config.js';
import { mountFooter } from '../../shared/footer.js';
import { mountThemeSwitch } from '../../shared/theme-switch.js';
import { engineHints, radioGroup, syncRange } from '../../shared/widgets.js';
import { mountInfo } from '../../shared/info.js';
import { defaultTheme, einkValues, modePatch } from '../../shared/settings.js';
import { isTransient, saveErrorKind, sendWithRetry } from '../../shared/save-error.js';
import { createWriteOrder } from '../../shared/write-order.js';
import { STATE_KEYS, readState } from '../../shared/store.js';
import { candidates, parsePage, patternFor, siteEnabled } from '../../shared/match.js';

const SLIDERS = /** @type {const} */ ({
  brightness: L.BRIGHTNESS,
  contrast: L.CONTRAST,
  sepia: L.SEPIA,
  grayscale: L.GRAYSCALE,
  warmth: L.WARMTH,
});
const SAVE_DELAY_MS = 150;
const PLAIN = new Set(['grayscale', 'grayscaleInverted', 'inverted']);
const STATUS_REFRESH_MS = 500;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ ($(id));
const select = (/** @type {string} */ id) => /** @type {HTMLSelectElement} */ ($(id));

const send = (/** @type {Record<string, unknown>} */ message) => chrome.runtime.sendMessage(message);

/** @type {{ url?: string, tabId?: number }} */
let tab = {};
/** @type {any} */
let state = null;
/** @type {(key: string, params?: Record<string, string | number>) => string} */
let t = (key) => key;
let numbers = numberFormat();
/** @type {{ select: (value: string) => void } | null} */
let modeGroup = null;
// Where the changes of the window go: the settings of all sites, or the rule of this site (`siteRules[pattern]`).
/** @type {'all' | 'site'} */
let scope = 'all';
// The fields of the window a site rule can hold.
const SITE_FIELDS = ['theme', 'engine'];
// The sliders of the E-ink and Paper mode: the setting they write, and its range.
const EINK_SLIDERS = /** @type {const} */ ({ whiteCap: L.WHITE_CAP, einkBlue: L.EINK_BLUE });

/** The status line for a tab, one literal key per status so the key check can see them. */
function statusText(/** @type {string | undefined} */ status) {
  switch (status) {
    case 'on':
      return t('status.on');
    case 'off':
      return t('status.off');
    case 'site-off':
      return t('status.siteOff');
    case 'dark-detected':
      return t('status.darkDetected');
    case 'page-scheme':
      return t('status.pageScheme');
    case 'site-theme':
      return t('status.siteTheme');
    case 'site-theme-repaired':
      return t('status.siteThemeRepaired');
    case 'fallback':
      return t('status.fallback');
    case 'pending':
      return t('status.pending');
    case 'safe-mode':
      return t('status.safeMode');
    case 'start-failed':
      return t('status.startFailed');
    default:
      return t('status.unknown');
  }
}

/** @param {string | undefined} status */
function dotState(status) {
  if (status === 'on') return 'on';
  if (status === 'dark-detected' || status === 'page-scheme' || status === 'site-theme' || status === 'site-theme-repaired') return 'info';
  if (status === 'pending') return 'info';
  if (status === 'fallback') return 'warn';
  if (status === 'safe-mode' || status === 'start-failed') return 'error';
  return '';
}

/** The rule of the site of the tab, or null. */
const ruleOf = () => (state.site?.pattern ? state.siteRules?.[state.site.pattern] ?? null : null);

/** Does the rule of this site hold its own look (a theme field or an engine)? */
function siteHasLook() {
  const rule = ruleOf();
  return !!rule && (typeof rule.engine === 'string' || (!!rule.theme && Object.keys(rule.theme).length > 0));
}

/** The settings the controls show: those of all sites, or with the rule of this site over them. */
function view() {
  const settings = state.settings;
  if (scope !== 'site') return settings;
  const rule = ruleOf() ?? {};
  return { ...settings, engine: typeof rule.engine === 'string' ? rule.engine : settings.engine, theme: { ...settings.theme, ...(rule.theme ?? {}) } };
}

/** The choice of the mode control for a theme: Dark, Light, Paper, E-ink or Original. @param {any} theme */
function choiceOf(theme) {
  if (theme.mode === 'eink') return theme.einkPreset === 'eink' ? 'eink' : 'paper';
  return theme.mode === 'light' || theme.mode === 'original' ? theme.mode : 'dark';
}

/** The change one choice makes, in one patch. @param {string} choice */
const patchFor = (choice) => modePatch(choice, view().theme);

function showError(/** @type {string} */ text) {
  const notice = $('notice');
  notice.textContent = text;
  notice.hidden = text === '';
  $('notice-x').hidden = text === '';
}

function renderSchedule() {
  const a = state.settings.automation;
  let text = t('popup.scheduleNone');
  if (a.mode === 'time') text = t('popup.scheduleTime', { from: a.time.from, to: a.time.to });
  else if (a.mode === 'system') text = t('popup.scheduleSystem');
  else if (a.mode === 'location') text = t('popup.scheduleLocation');
  $('schedule-text').textContent = text;
}

let showEngineHint = () => {};

/** The title of the main switch says what the switch shows now, one literal key per state. */
function renderMaster() {
  const text = input('master').checked ? t('popup.masterOn') : t('popup.masterOff');
  $('master-label').textContent = text;
  $('master').title = text;
}

function renderControls() {
  const settings = view();
  const theme = settings.theme;
  input('master').checked = settings.enabled;
  renderMaster();
  modeGroup?.select(choiceOf(theme));
  renderEink();
  select('engine').value = settings.engine;
  showEngineHint();
  for (const [name, range] of Object.entries(SLIDERS)) {
    const el = input(name);
    el.min = String(range.min);
    el.max = String(range.max);
    el.value = String(theme[name]);
    syncRange(el);
    $(`${name}-out`).textContent = numbers.format(theme[name]);
  }
  setControlsOff(!settings.enabled);
  renderHero();
  markPresets();
}

/** The switch of the floating button is about this site. All sites have their own switch in Settings. */
function renderFloat() {
  const pattern = state.site?.pattern;
  const can = !!pattern && !browserBlocks(/** @type {any} */ (tab).url);
  $('floatRow').hidden = !can;
  if (!can) return;
  const page = parsePage(tab.url);
  const all = state.settings.floatButton === true;
  const listed = !!page && candidates(page.host, '/').some((c) => state.settings.floatSites.includes(c));
  const on = (all || listed) && state.ui?.float?.[pattern]?.hide !== true;
  input('floatButton').checked = on;
  if (all) $('floatNote').textContent = on ? t('popup.floatAllOn') : t('popup.floatExcept');
  else $('floatNote').textContent = on ? t('popup.floatOnly') : t('popup.floatOff');
}

/** On, the button shows here. Off, it leaves this site, and stays away when all sites are turned on later. @param {boolean} on */
function setFloat(on) {
  const pattern = state.site?.pattern;
  if (!pattern) return;
  const rest = state.settings.floatSites.filter((/** @type {string} */ p) => p !== pattern);
  const next = on && !state.settings.floatButton ? [...rest, pattern].slice(-L.FLOAT_ON_SITES) : rest;
  if (next.length !== state.settings.floatSites.length) {
    state.settings.floatSites = next;
    queue({ floatSites: next });
    void flush();
  }
  const { hide: _gone, ...place } = state.ui?.float?.[pattern] ?? {};
  state.ui.float = { ...state.ui.float, [pattern]: on ? place : { ...place, hide: true } };
  void saveUi({ float: state.ui.float });
  renderFloat();
}

/** The main card shows the site: it is lit when Tintly works here. */
function renderHero() {
  const master = input('master').checked;
  $('hero').toggleAttribute('data-on', master && !!state.site?.enabled);
  input('site').disabled = !master || !state.site?.pattern || browserBlocks(/** @type {any} */ (tab).url);
  const off = !master || !state.site?.enabled;
  input('scopeSite').disabled = off;
  input('floatButton').disabled = off;
}

/** The two sliders of Paper and E-ink replace the five sliders while one of them is chosen. Original colors has no slider, only the engine. */
function renderEink() {
  const theme = view().theme;
  const eink = theme.mode === 'eink';
  const original = theme.mode === 'original';
  $('einkBox').hidden = !eink;
  $('originalBox').hidden = !original;
  $('sliders').hidden = eink || original;
  // The engine select stays in view: it is the last cell of whichever grid shows.
  const home = eink ? $('einkBox').querySelector('.sliders') : original ? $('originalBox') : $('sliders');
  if (home && $('engineField').parentElement !== home) home.append($('engineField'));
  renderCvd();
  if (!eink) return;
  const values = einkValues(theme);
  for (const [name, range] of Object.entries(EINK_SLIDERS)) {
    const el = input(name);
    el.min = String(range.min);
    el.max = String(range.max);
    el.value = String(values[name]);
    syncRange(el);
    $(`${name}-out`).textContent = numbers.format(values[name]);
  }
}

/** E-ink with no color has no color to correct: the select is disabled and says why. */
function renderCvd() {
  const theme = view().theme;
  const el = select('cvd');
  const off = theme.mode === 'eink' && einkValues(theme).einkColorAmount === 0;
  el.value = theme.cvdType ?? 'none';
  el.disabled = off;
  // The plain filters work in the original mode only.
  const original = theme.mode === 'original';
  for (const option of el.options) option.disabled = PLAIN.has(option.value) && !original;
  el.title = off ? t('cvd.noColor') : PLAIN.has(el.value) && !original ? t('cvd.originalOnly') : '';
}

function renderSite() {
  const site = state.site;
  input('site').checked = !!site && site.enabled;
  renderHero();
  $('host').textContent = site && site.pattern ? site.pattern : t('popup.siteNone');
  const fixes = /** @type {HTMLAnchorElement} */ (document.querySelector('a[href*="fixes.html"]'));
  fixes.href = `../fixes/fixes.html${site && site.pattern ? `?site=${encodeURIComponent(site.pattern)}` : ''}`;
}

/** The name of a mode for the notice: Dark, Light, Paper, E-ink or Original colors. @param {string} mode @param {string | null} preset */
function modeName(mode, preset) {
  if (mode === 'light') return t('mode.light');
  if (mode === 'original') return t('mode.original');
  if (mode === 'eink') return preset === 'eink' ? t('mode.eink') : t('eink.presetPaper');
  return t('mode.dark');
}

/** A site rule, a fix or a schedule fixes the mode of this page: say so, and offer to let the popup decide. */
function renderPin() {
  const pin = state.pin;
  const blocked = browserBlocks(/** @type {any} */ (tab).url);
  // In the scope of this site the window writes the rule itself, so the mode field shows.
  const show = !!pin && !blocked && !!state.site?.pattern && scope !== 'site';
  $('pin').hidden = !show;
  // The notice takes the place of the mode buttons only: the box under it stays, so this site can still be given its own mode.
  $('mode').hidden = show;
  if (!show) return;
  const schedule = pin.kind === 'schedule';
  $('pin-text').textContent = schedule ? t('popup.pinSchedule') : t('popup.pinned', { mode: modeName(pin.mode, pin.preset ?? null) });
  $('pin-use').hidden = schedule;
  $('pin-schedule').hidden = !schedule;
}

/** The page uses the site's own dark theme, or the person turned it off for this site: say so, with the button for the other choice. */
function renderSiteTheme() {
  const status = state.tab?.status;
  const using = status === 'site-theme' || status === 'site-theme-repaired';
  const off = !using && status === 'on' && state.siteDark?.off === true && (state.pin ? state.pin.mode === 'dark' : state.settings.theme.mode === 'dark');
  const blocked = browserBlocks(/** @type {any} */ (tab).url);
  // Before the worker answers, the status alone shows the row; its button waits for the rules of the site.
  const show = (using || off) && !blocked && !!state.site?.pattern && (!!state.siteDark || using) && state.settings.enabled;
  $('stheme').hidden = !show;
  // The window has no spare height: the row takes the place of the presets while it shows.
  $('presets-box').hidden = show;
  if (!show) return;
  $('stheme-text').textContent = using ? t('popup.siteThemeUsed') : t('popup.siteThemeNotUsed');
  $('stheme-btn').textContent = using ? t('popup.siteThemeOff') : t('popup.siteThemeOn');
  /** @type {HTMLButtonElement} */ ($('stheme-btn')).disabled = !state.siteDark;
}

/** Turn the site's own dark theme off, or on again, for this site only: the rule of the site holds `theme.useSiteDark`. */
async function toggleSiteTheme() {
  const info = state.siteDark;
  if (!info) return;
  const turnOff = !info.off;
  await flush();
  // Only the flag changes; the worker merges it into the rule as it is now. `onRule` keeps the flag only when a fix turns the theme off.
  const flag = turnOff ? false : info.onRule?.theme?.useSiteDark === true ? true : null;
  const edit = flag === null ? { patch: {}, remove: ['theme.useSiteDark'] } : { patch: { theme: { useSiteDark: flag } } };
  const reply = /** @type {any} */ (await sendWithRetry(() => send({ type: 'dk.site.patch', pattern: info.key, ...edit })));
  if (reply?.ok) {
    if (reply.rule === null) delete state.siteRules[info.key];
    else state.siteRules[info.key] = reply.rule;
    showError('');
    // The page restarts its theme; until the new status arrives the row shows the other state.
    state.tab = { ...(state.tab ?? {}), status: turnOff ? 'on' : state.tab?.status };
    state.siteDark = { ...info, off: turnOff };
    renderStatus();
    renderSiteTheme();
  } else showError(saveErrorText(reply));
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS);
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS * 3);
}

/** Take the mode out of the site rule or the fix that holds it, so the choice of the popup applies on this page. */
async function releasePin() {
  const pin = state.pin;
  if (!pin || pin.kind === 'schedule') return;
  await flush();
  const key = `mode:${pin.key}`;
  const id = writeOrder.begin(key);
  // The worker decides about the empty record by the order of the matches of this page.
  const pageUrl = typeof tab.url === 'string' && tab.url.length <= 4096 ? { url: tab.url } : {};
  // A rule loses only its mode, merged by the worker into the rule as it is now.
  const release = () =>
    pin.kind === 'rule'
      ? send({ type: 'dk.site.patch', pattern: pin.key, patch: {}, remove: ['theme.mode'], keepEmpty: pin.keep === true, ...pageUrl })
      : send({ type: 'dk.fix.release', pattern: pin.key, fallback: pin.clear, keepEmpty: pin.keep === true, ...pageUrl });
  const reply = /** @type {any} */ (await sendWithRetry(writeOrder.guard(key, id, release)));
  if (reply?.code === 'superseded') return;
  if (reply?.ok) {
    if (pin.kind === 'rule') {
      if (reply.rule === null) delete state.siteRules[pin.key];
      else state.siteRules[pin.key] = reply.rule;
    }
    state.pin = null;
    renderPin();
    showError('');
  } else showError(saveErrorText(reply));
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS);
}

/** The switch of a mode for this site: only a page with a site of its own can have a rule. */
function renderScope() {
  const can = !!state.site?.pattern && !browserBlocks(/** @type {any} */ (tab).url);
  if (!can) scope = 'all';
  $('scopeRow').hidden = !can;
  input('scopeSite').checked = scope === 'site';
  $('scopeNote').textContent = scope === 'site' ? t('popup.ownOn') : t('popup.ownOff');
}

/** On, this site takes the mode it shows now into its rule. Off, the look leaves the rule and the site follows all sites again. @param {boolean} own */
async function setScope(own) {
  await flush();
  const pattern = state.site?.pattern;
  if (!pattern) return;
  if (own) {
    const choice = choiceOf(view().theme);
    scope = 'site';
    queue(patchFor(choice));
    await flush();
  } else {
    const rule = ruleOf() ?? {};
    const look = Object.keys(rule.theme ?? {}).filter((k) => k !== 'useSiteDark').map((k) => `theme.${k}`);
    if (typeof rule.engine === 'string') look.push('engine');
    const key = `mode:${pattern}`;
    const id = writeOrder.begin(key);
    const pageUrl = typeof tab.url === 'string' && tab.url.length <= 4096 ? { url: tab.url } : {};
    const reply = /** @type {any} */ (await sendWithRetry(writeOrder.guard(key, id, () => send({ type: 'dk.site.patch', pattern, patch: {}, remove: look, ...pageUrl }))));
    if (reply?.code === 'superseded') return;
    if (!reply?.ok) {
      input('scopeSite').checked = true;
      showError(saveErrorText(reply));
      return;
    }
    if (reply.rule === null) delete state.siteRules[pattern];
    else state.siteRules[pattern] = reply.rule;
    scope = 'all';
    state.pin = null;
    showError('');
  }
  renderScope();
  renderControls();
  renderPin();
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS);
}

function render() {
  renderScope();
  renderControls();
  renderSite();
  renderFloat();
  renderPin();
  renderSiteTheme();
  renderPresets();
  renderStatus();
  renderSchedule();
}

function renderStatus() {
  const blocked = browserBlocks(/** @type {any} */ (tab).url);
  const protectedPage = blocked || !state.site || !state.site.pattern;
  $('status').textContent = blocked ? t('popup.blocked') : protectedPage ? t('popup.protected') : statusText(state.tab?.status);
  $('status-dot').dataset.state = protectedPage ? '' : dotState(state.tab?.status);
}

/** @type {Record<string, string>} */
const PRESET_ICONS = { dark: 'moon', light: 'sun', paper: 'book', eink: 'tablet', original: 'drop' };
/** @type {Record<string, string[]>} */
const PRESET_COLORS = { paper: ['#f5f0e6', '#2b251e'], eink: ['#ffffff', '#000000'] };

/** @param {string} hex @returns {number} relative luminance */
function luminance(hex) {
  const full = hex.length === 4 ? hex.replace(/[^#]/g, '$&$&') : hex;
  const part = (/** @type {number} */ at) => {
    const v = parseInt(full.slice(at, at + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * part(1) + 0.7152 * part(3) + 0.0722 * part(5);
}

/** @param {number} a @param {number} b */
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The colors a preset gives its chip. Text the user chose too faint on that background becomes black or white. @param {any} theme */
function presetColors(theme) {
  const choice = choiceOf(theme);
  if (choice === 'original') return null;
  const now = view().theme;
  const dark = choice === 'dark';
  const [bg, ink] = PRESET_COLORS[choice] ?? [theme[dark ? 'darkBackground' : 'lightBackground'] ?? now[dark ? 'darkBackground' : 'lightBackground'], theme[dark ? 'darkText' : 'lightText'] ?? now[dark ? 'darkText' : 'lightText']];
  const back = luminance(bg);
  if (contrast(back, luminance(ink)) >= 4.5) return { bg, ink };
  return { bg, ink: contrast(back, 0) >= contrast(back, 1) ? '#000000' : '#ffffff' };
}

const sameValue = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(a) === JSON.stringify(b);

// The Default chip puts the look back. The chosen mode, the person's own CSS and the switch for a site's own dark theme stay.
const DEFAULT_LOOK = Object.fromEntries(Object.entries(defaultTheme()).filter(([key]) => !['mode', 'einkPreset', 'css', 'useSiteDark'].includes(key)));

/** A chip shows that its look is the one in use. */
function markPresets() {
  const now = view().theme;
  const holds = (/** @type {Record<string, unknown>} */ theme) => Object.entries(theme).every(([key, value]) => sameValue(value, now[key]));
  state.presets.forEach((/** @type {any} */ preset, /** @type {number} */ i) => {
    $('presets').children[i]?.firstElementChild?.setAttribute('aria-pressed', String(holds(preset.theme)));
  });
  $('preset-default').setAttribute('aria-pressed', String(holds(DEFAULT_LOOK)));
}

/** A site keeps only what the preset changes from all sites, so a later change in Settings still reaches the site. @param {Record<string, any>} theme */
async function applyPreset(theme) {
  const pattern = state.site?.pattern;
  if (scope !== 'site' || !pattern) {
    queue({ theme });
    renderControls();
    void flush();
    return;
  }
  await flush();
  const own = Object.fromEntries(Object.entries(theme).filter(([key, value]) => key === 'mode' || !sameValue(value, state.settings.theme[key])));
  const remove = Object.keys(ruleOf()?.theme ?? {}).filter((key) => key !== 'useSiteDark' && !(key in own)).map((key) => `theme.${key}`);
  const key = `mode:${pattern}`;
  const id = writeOrder.begin(key);
  const reply = /** @type {any} */ (await sendWithRetry(writeOrder.guard(key, id, () => send({ type: 'dk.site.patch', pattern, patch: { theme: own }, remove }))));
  if (reply?.code === 'superseded') return;
  showError(reply?.ok ? '' : saveErrorText(reply));
  if (!reply?.ok) return;
  state.siteRules[pattern] = reply.rule;
  renderControls();
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS);
}

/** On a site with its own look, Default gives the site back to all sites. @returns {void} */
function applyDefault() {
  if (scope === 'site') {
    void setScope(false);
    return;
  }
  queue({ theme: DEFAULT_LOOK });
  renderControls();
  void flush();
}

function renderPresets() {
  const list = $('presets');
  list.replaceChildren();
  for (const preset of state.presets) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const name = document.createElement('span');
    name.textContent = preset.name;
    button.append(icon(PRESET_ICONS[choiceOf(preset.theme)], 13), name);
    button.dir = 'auto';
    const look = presetColors(preset.theme);
    if (look) {
      button.style.setProperty('--chip-bg', look.bg);
      button.style.setProperty('--chip-ink', look.ink);
    }
    button.addEventListener('click', () => void applyPreset(preset.theme));
    item.append(button);
    list.append(item);
  }
  $('presets-none').hidden = state.presets.length > 0;
  renderPresetNav();
  markPresets();
}

/** The row of presets is wider than the window when there are many: the arrows show only then. */
function renderPresetNav() {
  const list = $('presets');
  const end = list.scrollWidth - list.clientWidth;
  const at = Math.abs(list.scrollLeft);
  $('presets-nav').hidden = end <= 1;
  list.toggleAttribute('data-scrolled', at > 1);
  /** @type {HTMLButtonElement} */ ($('presets-prev')).disabled = at <= 1;
  /** @type {HTMLButtonElement} */ ($('presets-next')).disabled = at >= end - 1;
}

/** @param {number} way 1 toward the end of the row, -1 toward its start @param {number} by */
function movePresets(way, by) {
  const list = $('presets');
  const rtl = getComputedStyle(list).direction === 'rtl';
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  list.scrollBy({ left: (rtl ? -way : way) * by, behavior: calm ? 'auto' : 'smooth' });
}

function wirePresets() {
  const list = $('presets');
  list.addEventListener('scroll', renderPresetNav, { passive: true });
  new ResizeObserver(renderPresetNav).observe(list);
  $('presets-prev').addEventListener('click', () => movePresets(-1, list.clientWidth * 0.8));
  $('presets-next').addEventListener('click', () => movePresets(1, list.clientWidth * 0.8));
  list.addEventListener('wheel', (e) => {
    if (list.scrollWidth <= list.clientWidth || e.deltaY === 0) return;
    e.preventDefault();
    const rtl = getComputedStyle(list).direction === 'rtl';
    list.scrollLeft += rtl ? -e.deltaY : e.deltaY;
  }, { passive: false });
}

/* ----- saving: changes apply at once in the page and are saved after a short pause ----- */

/** @type {Record<string, any>} */
let pending = {};
// The changes waiting for the rule of this site, and the key of that rule.
/** @type {Record<string, any>} */
let sitePending = {};
/** @type {string | null} */
let sitePattern = null;
// Changes made to the rule of this site, and how many of them the worker has taken: a reply about older rules must not undo newer ones.
let siteEdits = 0;
let siteTaken = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;

function merge(/** @type {any} */ into, /** @type {any} */ from) {
  for (const [key, value] of Object.entries(from)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      into[key] = merge(into[key] && typeof into[key] === 'object' ? into[key] : {}, value);
    } else {
      into[key] = value;
    }
  }
  return into;
}

function queue(/** @type {Record<string, any>} */ patch) {
  const pattern = state.site?.pattern;
  if (scope === 'site' && pattern) {
    /** @type {Record<string, any>} */
    const local = {};
    /** @type {Record<string, any>} */
    const global = {};
    for (const [key, value] of Object.entries(patch)) (SITE_FIELDS.includes(key) ? local : global)[key] = value;
    if (Object.keys(local).length) {
      if (sitePattern !== pattern) sitePending = {};
      sitePattern = pattern;
      merge(sitePending, local);
      siteEdits++;
      state.siteRules[pattern] = merge({ ...(state.siteRules[pattern] ?? {}) }, local);
    }
    patch = global;
  }
  merge(pending, patch);
  merge(state.settings, patch);
  markPresets();
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
}

/**
 * Writes of this window that may change the same field of a record. A retry of an older one gives up when a newer one has started,
 * so it never reverses it. The keys are `switch` (the site switch) and `mode:<pattern>` (the mode of a rule or a fix).
 */
const writeOrder = createWriteOrder();

/** Saves run one after the other, so a retry of an older change never lands after a newer one. */
let saving = Promise.resolve();

function flush() {
  clearTimeout(timer);
  saving = saving.then(save).catch(() => undefined);
  return saving;
}

/** The text for a refused save. */
const saveErrorText = (/** @type {any} */ reply) => (saveErrorKind(reply) === 'reload' ? t('popup.saveErrorReload') : t('popup.saveError'));

// Set when the window closes: a failed save is tried again at once, because there is no time to wait.
let closing = false;

async function save() {
  const patch = pending;
  pending = {};
  const pattern = sitePattern;
  const sitePatch = sitePending;
  const hasSite = pattern !== null && Object.keys(sitePatch).length > 0;
  sitePending = {};
  const edits = siteEdits;
  if (Object.keys(patch).length === 0 && !hasSite) return;
  // Only the fields changed here are sent: the worker merges them into the rule as it is now, so a change made in another window stays.
  /** @type {import('../../shared/save-error.js').SaveReply[]} */
  const replies = await Promise.all([
    Object.keys(patch).length ? sendWithRetry(() => send({ type: 'dk.settings.patch', patch }), closing ? 0 : undefined) : { ok: true },
    hasSite ? sendWithRetry(guardMode(pattern, sitePatch, () => send({ type: 'dk.site.patch', pattern, patch: sitePatch })), closing ? 0 : undefined) : { ok: true },
  ]);
  // A write that a newer one replaced is not an error; the newer one decides.
  if (hasSite && (replies[1]?.ok || replies[1]?.code === 'superseded')) siteTaken = Math.max(siteTaken, edits);
  // A change that failed for a reason that may pass waits for the next save, under the changes made since. One the worker refused
  // for its content would only be refused again.
  if (Object.keys(patch).length && isTransient(replies[0])) pending = merge(patch, pending);
  if (hasSite && isTransient(replies[1]) && sitePattern === pattern) sitePending = merge(sitePatch, sitePending);
  const reply = replies.find((r) => !r?.ok && r?.code !== 'superseded') ?? replies[0];
  showError(reply?.ok || reply?.code === 'superseded' ? '' : saveErrorText(reply));
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS);
}

/** A site save that sets the mode of a rule is ordered with the button that takes the mode out. @param {string} pattern @param {Record<string, any>} sitePatch @param {() => Promise<any>} sendIt */
function guardMode(pattern, sitePatch, sendIt) {
  if (sitePatch.theme?.mode === undefined) return sendIt;
  const key = `mode:${pattern}`;
  return writeOrder.guard(key, writeOrder.begin(key), sendIt);
}

/** Ask the worker for the parts only it can tell: the pin, the rules for the site's own dark theme and the status of the tab. Returns false when it refuses. */
async function refreshStatus() {
  try {
    const reply = await send({ type: 'dk.state.get', ...tab });
    if (!reply?.ok) return false;
    state.tab = reply.tab;
    state.site = reply.site;
    state.pin = reply.pin ?? null;
    const mine = sitePattern && siteEdits > siteTaken ? state.siteRules[sitePattern] : undefined;
    state.siteRules = reply.siteRules ?? state.siteRules;
    if (mine) state.siteRules[/** @type {string} */ (sitePattern)] = mine;
    state.siteDark = reply.siteDark ?? null;
    renderStatus();
    renderPin();
    renderSiteTheme();
    return true;
  } catch {
    // The window may be closing.
    return false;
  }
}

async function setSite(/** @type {boolean} */ enabled) {
  const pattern = state.site?.pattern;
  if (!pattern) return;
  await flush();
  // The worker sets the rule that decides for this page (a path rule can decide below the site) and answers with the page's state.
  const id = writeOrder.begin('switch');
  const reply = /** @type {any} */ (await sendWithRetry(writeOrder.guard('switch', id, () => send({ type: 'dk.site.switch', url: /** @type {string} */ (tab.url), enabled }))));
  // A newer choice of the switch is on its way and shows its own result.
  if (reply?.code === 'superseded') return;
  if (reply?.ok) {
    state.siteRules[reply.pattern] = { ...(state.siteRules[reply.pattern] ?? {}), enabled };
    if (state.site) state.site.enabled = reply.enabled;
    input('site').checked = reply.enabled;
    renderHero();
    showError('');
  } else {
    input('site').checked = !enabled;
    showError(saveErrorText(reply));
  }
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS);
}

/** Save a change to the language and look of the pages (this device only). */
const saveUi = (/** @type {Record<string, unknown>} */ ui) => send({ type: 'dk.ui.set', ui });

/** With Tintly off the controls are dimmed and cannot be used: a change would only wait for the switch. */
function setControlsOff(/** @type {boolean} */ off) {
  $('controls').toggleAttribute('data-off', off);
  $('controls').toggleAttribute('inert', off);
}
function wire() {
  $('notice-x').addEventListener('click', () => showError(''));
  input('master').addEventListener('change', (e) => queue({ enabled: /** @type {HTMLInputElement} */ (e.target).checked }));
  input('master').addEventListener('change', () => {
    renderMaster();
    setControlsOff(!input('master').checked);
    renderHero();
  });
  input('site').addEventListener('change', (e) => void setSite(/** @type {HTMLInputElement} */ (e.target).checked));
  $('pin-use').addEventListener('click', () => void releasePin());
  wirePresets();
  $('preset-default').prepend(icon('drop', 13));
  $('preset-default').addEventListener('click', applyDefault);
  mountInfo(() => t);
  input('floatButton').addEventListener('change', (e) => setFloat(/** @type {HTMLInputElement} */ (e.target).checked));
  input('scopeSite').addEventListener('change', (e) => void setScope(/** @type {HTMLInputElement} */ (e.target).checked));
  $('stheme-btn').addEventListener('click', () => void toggleSiteTheme());
  // One choice is one change of settings, saved at once: the page should follow without the pause of a slider.
  modeGroup = radioGroup($('mode'), (value) => {
    queue(patchFor(value));
    renderEink();
    void flush();
  });
  for (const name of Object.keys(EINK_SLIDERS)) {
    input(name).addEventListener('input', (e) => {
      const el = /** @type {HTMLInputElement} */ (e.target);
      $(`${name}-out`).textContent = numbers.format(Number(el.value));
      syncRange(el);
      queue({ theme: { [name]: Number(el.value) } });
    });
  }
  select('engine').addEventListener('change', (e) => queue({ engine: /** @type {HTMLSelectElement} */ (e.target).value }));
  select('cvd').addEventListener('change', (e) => queue({ theme: { cvdType: /** @type {HTMLSelectElement} */ (e.target).value } }));
  for (const name of Object.keys(SLIDERS)) {
    input(name).addEventListener('input', (e) => {
      const el = /** @type {HTMLInputElement} */ (e.target);
      $(`${name}-out`).textContent = numbers.format(Number(el.value));
      syncRange(el);
      queue({ theme: { [name]: Number(el.value) } });
    });
  }
  // Closing the window must not lose the last change.
  addEventListener('pagehide', () => {
    closing = true;
    void flush();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
}

function wireShell() {
  mountThemeSwitch({
    mount: $('themeMount'),
    t,
    theme: state?.ui?.uiTheme ?? 'system',
    onTheme: (value) => {
      applyUiTheme(value);
      void saveUi({ uiTheme: value });
    },
  });
  const heart = $('supportBtn');
  if (LINKS.support) {
    heart.hidden = false;
    heart.addEventListener('click', () => openUrl(LINKS.support));
  }
  mountFooter({ root: $('footerMount'), t });
}

/** The menu, the about dialog and the reminder are not needed for the first paint: they load after it. */
async function wireLater() {
  const [{ mountMenu }, { openAbout }, { runNudge }] = await Promise.all([import('../../shared/menu.js'), import('../../shared/about.js'), import('../../shared/nudge.js')]);
  const about = /** @type {HTMLDialogElement} */ ($('about'));
  const showAbout = () => {
    // The dialog was opened from the menu button, so closing it gives the focus back there.
    about.addEventListener('close', () => $('overflowBtn').focus(), { once: true });
    openAbout(about, t);
  };
  /** @type {Array<{ id: string, icon: string, label: string, run: () => void }>} */
  const items = [{ id: 'settings', icon: 'sliders', label: t('menu.settings'), run: () => void chrome.runtime.openOptionsPage() }];
  if (LINKS.help) items.push({ id: 'help', icon: 'book', label: t('menu.help'), run: () => openUrl(LINKS.help) });
  items.push({ id: 'about', icon: 'info', label: t('menu.about'), run: showAbout });
  if (LINKS.support) items.push({ id: 'support', icon: 'heart', label: t('menu.support'), run: () => openUrl(LINKS.support) });
  mountMenu({ trigger: $('overflowBtn'), menu: $('overflowMenu'), items });
  void runNudge({
    support: state.ui.support,
    mount: $('nudgeMount'),
    cover: [$('more'), document.querySelector('.meta'), $('footerMount')].filter((el) => el instanceof HTMLElement),
    t,
    save: (support) => saveUi({ support }),
  }).catch(() => undefined);
}

/**
 * A page may give a white or a black icon for a tab strip of the other color, and on the tile it would not show.
 * @param {HTMLImageElement} img @param {string} tileColor @returns {boolean} too few of the drawn pixels stand out from the tile
 */
function iconHidden(img, tileColor) {
  const SIZE = 24;
  const MIN_CONTRAST = 1.5;
  const MIN_SHARE = 0.2;
  const ALPHA_MIN = 64;
  try {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.canvas.width = SIZE;
    ctx.canvas.height = SIZE;
    ctx.fillStyle = tileColor;
    ctx.fillRect(0, 0, 1, 1);
    const [tr, tg, tb] = ctx.getImageData(0, 0, 1, 1).data;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const luma = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) => (0.2126 * (r / 255) ** 2.2 + 0.7152 * (g / 255) ** 2.2 + 0.0722 * (b / 255) ** 2.2);
    const tile = luma(tr, tg, tb) + 0.05;
    let drawn = 0;
    let seen = 0;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a < ALPHA_MIN) continue;
      drawn += 1;
      const k = a / 255;
      const own = luma(px[i] * k + tr * (1 - k), px[i + 1] * k + tg * (1 - k), px[i + 2] * k + tb * (1 - k)) + 0.05;
      if (Math.max(own, tile) / Math.min(own, tile) >= MIN_CONTRAST) seen += 1;
    }
    return drawn > 0 && seen / drawn < MIN_SHARE;
  } catch {
    return false;
  }
}

/** Show the icon of the page in the site card; the globe stays when there is none. @param {number} tabId */
async function showSiteIcon(tabId) {
  try {
    const reply = await send({ type: 'dk.favicon', tabId });
    if (!reply?.ok || typeof reply.dataUrl !== 'string') return;
    const tile = $('siteTile');
    const img = document.createElement('img');
    img.alt = '';
    img.width = 20;
    img.height = 20;
    img.className = 'site-icon';
    img.addEventListener(
      'load',
      () => {
        tile.replaceChildren(img);
        tile.classList.add('has-icon');
        tile.classList.toggle('icon-swap', iconHidden(img, getComputedStyle(tile).backgroundColor));
      },
      { once: true },
    );
    img.src = reply.dataUrl;
  } catch {
    // The globe stays.
  }
}

/** The state the page can read without the worker: the stored data, the status the worker kept for the tab, and the site of the tab. */
function localState(/** @type {any} */ read, /** @type {any} */ status) {
  if (!read?.ok) return null;
  const s = read.state;
  const site = tab.url === undefined ? null : { enabled: siteEnabled(s.settings, s.siteRules, tab.url), pattern: patternFor(tab.url) };
  return { ok: true, settings: s.settings, siteRules: s.siteRules, presets: s.presets, darkSites: s.darkSites, ui: s.ui, site, tab: status, pin: null, siteDark: null };
}

/** The window cannot start at all: show one line in English and no controls. */
async function loadFailed() {
  const catalog = await loadCatalog('en').catch(() => null);
  $('status').textContent = catalog?.['popup.error'] ?? 'Could not load.';
  $('status-dot').dataset.state = 'error';
  $('controls').hidden = true;
  input('master').disabled = true;
  document.body.setAttribute('data-painted', '');
  document.body.removeAttribute('data-loading');
}

async function start() {
  // Every read goes out at once: the page does not wait for the worker, and no read waits for another.
  // early.js has started three of them while the modules loaded; a read it could not start or that failed is made again here.
  const early = /** @type {any} */ (globalThis).__dkEarly;
  delete (/** @type {any} */ (globalThis).__dkEarly);
  const stored = { get: () => (early?.state ?? chrome.storage.local.get([...STATE_KEYS])).catch(() => chrome.storage.local.get([...STATE_KEYS])) };
  const stateRead = readState(/** @type {any} */ (stored)).catch(() => null);
  // An extension page that a frame or an unusual host opens may lack `tabs` or `storage.session`: the window then asks the worker instead.
  const query = (async () => early?.tabs ?? chrome.tabs.query({ active: true, currentWindow: true }))().catch(() => (async () => chrome.tabs.query({ active: true, currentWindow: true }))()).catch(() => []);
  const sessionKey = (/** @type {any[]} */ list) => (typeof list[0]?.id === 'number' ? `tab:${list[0].id}` : null);
  const statusRead = query.then(async (list) => {
    const key = sessionKey(list);
    if (key === null) return null;
    try {
      return (await chrome.storage.session.get(key))[key] ?? null;
    } catch {
      return null;
    }
  });
  const ui = stateRead.then((read) => (read?.ok ? { ui: read.state.ui } : chrome.storage.local.get('ui')));
  /** @type {Awaited<ReturnType<typeof initI18n>>} */
  let i18n;
  /** @type {any[]} */
  let active;
  /** @type {any} */
  let read;
  /** @type {any} */
  let status;
  try {
    [i18n, active, read, status] = await Promise.all([initI18n(ui), query, stateRead, statusRead, loadInstallType(early?.self ?? null)]);
  } catch {
    // Even the language could not be read: the window still says so, in the language that needs no storage.
    await loadFailed();
    return;
  }
  t = i18n.t;
  numbers = numberFormat(i18n.locale);
  showEngineHint = engineHints(select('engine'), t);
  hydrateIcons();
  $('ver').textContent = `v${chrome.runtime.getManifest().version}`;
  const [first] = active;
  tab = first && typeof first.id === 'number' ? { tabId: first.id, ...(first.url ? { url: first.url } : {}) } : {};
  try {
    // The window paints from the stored data at once; the worker, which may have to start first, only adds what it alone knows.
    const local = localState(read, status);
    state = local ?? (await send({ type: 'dk.state.get', ...tab }));
    if (!state?.ok) throw new Error('refused');
    // A site that keeps its own look opens in its own scope, where the window shows and changes that look.
    if (siteHasLook()) scope = 'site';
    wire();
    render();
    document.body.setAttribute('data-painted', '');
    wireShell();
    if (typeof tab.tabId === 'number') void showSiteIcon(tab.tabId);
    const later = wireLater().catch(() => undefined);
    // The page reports what it does when its first pass is done, which can be seconds after the window opened.
    chrome.storage.onChanged.addListener((changes, area) => {
      const change = area === 'session' && typeof tab.tabId === 'number' ? changes[`tab:${tab.tabId}`] : undefined;
      if (!change) return;
      state.tab = change.newValue ?? null;
      renderStatus();
      renderSiteTheme();
    });
    if (local && !(await refreshStatus())) throw new Error('refused');
    await later;
  } catch {
    $('status').textContent = t('popup.error');
    $('status-dot').dataset.state = 'error';
    $('controls').hidden = true;
    // Nothing is wired in this state, so the main switch must not look usable.
    input('master').disabled = true;
    document.body.setAttribute('data-painted', '');
  }
  document.body.removeAttribute('data-loading');
}

void start().catch(() => loadFailed().catch(() => document.body.removeAttribute('data-loading')));
