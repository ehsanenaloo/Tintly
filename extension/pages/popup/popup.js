// @ts-check
import { numberFormat } from '../../shared/numbers.js';
import { initI18n, applyUiTheme, loadCatalog } from '../../shared/i18n.js';
import { L } from '../../shared/limits.js';
import { hydrateIcons, openUrl } from '../../shared/dom.js';
import { browserBlocks } from '../../shared/blocked.js';
import { LINKS, loadInstallType } from '../../shared/footer-config.js';
import { mountFooter } from '../../shared/footer.js';
import { mountThemeSwitch } from '../../shared/theme-switch.js';
import { engineHints, radioGroup, syncRange } from '../../shared/widgets.js';
import { EINK_RESET, einkValues } from '../../shared/settings.js';
import { isTransient, saveErrorKind, sendWithRetry } from '../../shared/save-error.js';
import { readState } from '../../shared/store.js';
import { patternFor, siteEnabled } from '../../shared/match.js';

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
/** @type {{ select: (value: string) => void } | null} */
let scopeGroup = null;
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

/** The change one choice makes, in one patch: the mode and, for Paper and E-ink, the style. A new style starts from its own defaults. @param {string} choice */
function patchFor(choice) {
  if (choice === 'dark' || choice === 'light' || choice === 'original') return { theme: { mode: choice } };
  const same = view().theme.einkPreset === choice;
  return { theme: { mode: 'eink', einkPreset: choice, ...(same ? {} : EINK_RESET) } };
}

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
  $('master-label').textContent = input('master').checked ? t('popup.masterOn') : t('popup.masterOff');
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
  $('controls').toggleAttribute('data-off', !settings.enabled);
  $('hero').toggleAttribute('data-on', settings.enabled);
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
  const siteSwitch = input('site');
  siteSwitch.disabled = !site || !site.pattern || browserBlocks(/** @type {any} */ (tab).url);
  siteSwitch.checked = !!site && site.enabled;
  select('listMode').value = state.settings.listMode === 'onlyListed' ? 'onlyListed' : 'allExcept';
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
  // The notice takes the place of the mode buttons only: the scope switch above it stays, so this site can still be chosen.
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
  const rule = turnOff ? info.offRule : info.onRule;
  const reply = await sendWithRetry(() => send({ type: 'dk.site.set', pattern: info.key, rule }));
  if (reply?.ok) {
    if (rule === null) delete state.siteRules[info.key];
    else state.siteRules[info.key] = rule;
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
  const reply = await sendWithRetry(() =>
    pin.kind === 'rule' ? send({ type: 'dk.site.set', pattern: pin.key, rule: pin.clear }) : send({ type: 'dk.fix.set', pattern: pin.key, fix: pin.clear }),
  );
  if (reply?.ok) {
    if (pin.kind === 'rule') {
      if (pin.clear === null) delete state.siteRules[pin.key];
      else state.siteRules[pin.key] = pin.clear;
    }
    state.pin = null;
    renderPin();
    showError('');
  } else showError(saveErrorText(reply));
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS);
}

/** The scope switch: only a page with a site of its own can have a rule. */
function renderScope() {
  const can = !!state.site?.pattern && !browserBlocks(/** @type {any} */ (tab).url);
  if (!can) scope = 'all';
  $('scope').hidden = !can;
  scopeGroup?.select(scope);
}

function render() {
  renderScope();
  renderControls();
  renderSite();
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

function renderPresets() {
  const list = $('presets');
  list.replaceChildren();
  for (const preset of state.presets) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = preset.name;
    button.dir = 'auto';
    button.addEventListener('click', () => {
      queue({ theme: preset.theme });
      renderControls();
      void flush();
    });
    item.append(button);
    list.append(item);
  }
  $('presets-none').hidden = state.presets.length > 0;
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
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
}

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
  const replies = await Promise.all([
    Object.keys(patch).length ? sendWithRetry(() => send({ type: 'dk.settings.patch', patch }), closing ? 0 : undefined) : { ok: true },
    hasSite ? sendWithRetry(() => send({ type: 'dk.site.patch', pattern, patch: sitePatch }), closing ? 0 : undefined) : { ok: true },
  ]);
  if (hasSite && replies[1]?.ok) siteTaken = Math.max(siteTaken, edits);
  // A change that failed for a reason that may pass waits for the next save, under the changes made since. One the worker refused
  // for its content would only be refused again.
  if (Object.keys(patch).length && isTransient(replies[0])) pending = merge(patch, pending);
  if (hasSite && isTransient(replies[1]) && sitePattern === pattern) sitePending = merge(sitePatch, sitePending);
  const reply = replies.find((r) => !r?.ok) ?? replies[0];
  showError(reply?.ok ? '' : saveErrorText(reply));
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS);
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
  const reply = /** @type {any} */ (await sendWithRetry(() => send({ type: 'dk.site.switch', url: /** @type {string} */ (tab.url), enabled })));
  if (reply?.ok) {
    state.siteRules[reply.pattern] = { ...(state.siteRules[reply.pattern] ?? {}), enabled };
    if (state.site) state.site.enabled = reply.enabled;
    input('site').checked = reply.enabled;
    showError('');
  } else {
    input('site').checked = !enabled;
    showError(saveErrorText(reply));
  }
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS);
}

/**
 * Where Tintly works. Choosing "only the sites I turn on" on a site that is on keeps it on: the rule of the site gets `enabled: true`,
 * so the page the person is looking at does not go off.
 * @param {string} value
 */
async function setListMode(value) {
  const listMode = value === 'onlyListed' ? 'onlyListed' : 'allExcept';
  const keep = listMode === 'onlyListed' && !!state.site?.pattern && state.site.enabled && typeof state.siteRules[state.site.pattern]?.enabled !== 'boolean';
  if (keep) await setSite(true);
  queue({ listMode });
  await flush();
  if (state.site && tab.url !== undefined) state.site.enabled = siteEnabled(state.settings, state.siteRules, tab.url);
  renderSite();
  renderStatus();
  setTimeout(() => void refreshStatus(), STATUS_REFRESH_MS);
}

/** Save a change to the language and look of the pages (this device only). */
const saveUi = (/** @type {Record<string, unknown>} */ ui) => send({ type: 'dk.ui.set', ui });

function wire() {
  $('notice-x').addEventListener('click', () => showError(''));
  input('master').addEventListener('change', (e) => queue({ enabled: /** @type {HTMLInputElement} */ (e.target).checked }));
  input('master').addEventListener('change', () => {
    renderMaster();
    $('controls').toggleAttribute('data-off', !input('master').checked);
    $('hero').toggleAttribute('data-on', input('master').checked);
  });
  input('site').addEventListener('change', (e) => void setSite(/** @type {HTMLInputElement} */ (e.target).checked));
  select('listMode').addEventListener('change', (e) => void setListMode(/** @type {HTMLSelectElement} */ (e.target).value));
  $('pin-use').addEventListener('click', () => void releasePin());
  scopeGroup = radioGroup($('scope'), (value) => {
    void flush();
    scope = value === 'site' ? 'site' : 'all';
    renderControls();
    renderPin();
  });
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
    cover: [$('presets-box'), document.querySelector('.meta'), $('footerMount')].filter((el) => el instanceof HTMLElement),
    t,
    save: (support) => saveUi({ support }),
  }).catch(() => undefined);
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
  const stateRead = readState(chrome.storage.local).catch(() => null);
  // An extension page that a frame or an unusual host opens may lack `tabs` or `storage.session`: the window then asks the worker instead.
  const query = (async () => chrome.tabs.query({ active: true, currentWindow: true }))().catch(() => []);
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
    [i18n, active, read, status] = await Promise.all([initI18n(ui), query, stateRead, statusRead, loadInstallType()]);
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
