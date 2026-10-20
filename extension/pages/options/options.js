// @ts-check
import { numberFormat } from '../../shared/numbers.js';
import { initI18n, applyUiTheme } from '../../shared/i18n.js';
import { L } from '../../shared/limits.js';
import { cssProblem } from '../../shared/css-check.js';
import { hydrateIcons, openUrl } from '../../shared/dom.js';
import { LINKS, loadInstallType } from '../../shared/footer-config.js';
import { mountFooter } from '../../shared/footer.js';
import { mountMenu } from '../../shared/menu.js';
import { mountThemeSwitch } from '../../shared/theme-switch.js';
import { buildAbout } from '../../shared/about.js';
import { confirmClick, engineHints, syncRange, tabList } from '../../shared/widgets.js';
import { EINK_FIELDS, EINK_RESET, cssReachesOut, defaultTheme, fixCss, heldCss, ruleCss } from '../../shared/settings.js';
import { createSay } from '../../shared/say.js';
import { saveErrorKind, sendWithRetry } from '../../shared/save-error.js';
import { mountEink } from './eink.js';
import { mountColorVision } from './color-vision.js';
import { mountPalettes } from './palettes.js';

const RANGES = /** @type {Record<string, { min: number, max: number }>} */ ({
  'theme.brightness': L.BRIGHTNESS,
  'theme.contrast': L.CONTRAST,
  'theme.sepia': L.SEPIA,
  'theme.grayscale': L.GRAYSCALE,
  'theme.warmth': L.WARMTH,
  'theme.textStroke': L.TEXT_STROKE,
  'theme.cvdSeverity': L.CVD_SEVERITY,
  'theme.cvdBoost': L.CVD_BOOST,
});
const SITE_NUMBERS = /** @type {const} */ (['brightness', 'contrast', 'sepia', 'grayscale', 'warmth']);
const SAVE_DELAY_MS = 250;
const RESET_WINDOW_MS = 5000;
const MAX_IMPORT_BYTES = 1024 * 1024 + 4096;
const TABS = ['general', 'appearance', 'sites', 'schedule', 'advanced', 'data', 'about'];

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ ($(id));
const send = (/** @type {Record<string, unknown>} */ message) => chrome.runtime.sendMessage(message);

/** @type {any} */
let state = null;
/** @type {(key: string, params?: Record<string, string | number>) => string} */
let t = (key) => key;
let numbers = numberFormat();

/* ----- small helpers ----- */

const getPath = (/** @type {any} */ obj, /** @type {string} */ path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function patchFor(/** @type {string} */ path, /** @type {unknown} */ value) {
  const keys = path.split('.');
  /** @type {any} */
  const out = {};
  let at = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) at[k] = value;
    else at = at[k] = {};
  });
  return out;
}

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

let fieldErrors = 0;

/**
 * Mark a number that is outside its range, or clear the mark. The message sits under the field and the field points to it.
 * True when the value can be saved. An empty field is allowed: it means "the general value".
 * @param {HTMLInputElement} el @param {{ min: number, max: number }} range @param {boolean} whole
 */
function checkNumber(el, range, whole) {
  const n = Number(el.value);
  const bad = el.value !== '' && (!Number.isFinite(n) || n < range.min || n > range.max || (whole && !Number.isInteger(n)));
  let box = el.dataset.errorId ? document.getElementById(el.dataset.errorId) : null;
  if (bad && !box) {
    box = document.createElement('p');
    box.className = 'error';
    box.id = el.id ? `${el.id}-error` : `field-error-${fieldErrors++}`;
    box.setAttribute('role', 'alert');
    el.dataset.errorId = box.id;
    // On a site card the message follows the row of fields: inside the label it would become part of the name of the field.
    const row = el.closest('.fields');
    if (row) row.insertAdjacentElement('afterend', box);
    else (el.closest('.item') ?? el).append(box);
    el.setAttribute('aria-describedby', [el.getAttribute('aria-describedby'), box.id].filter(Boolean).join(' '));
  }
  if (box) {
    box.hidden = !bad;
    if (bad) {
      const limits = { min: numbers.format(range.min), max: numbers.format(range.max) };
      box.textContent = whole ? t('opt.numberWhole', limits) : t('opt.numberAny', limits);
    }
  }
  el.setAttribute('aria-invalid', String(bad));
  return !bad;
}

let say = /** @type {(text: string, action?: import('../../shared/say.js').SayAction) => void} */ (() => {});

/* ----- saving ----- */

/** @type {Record<string, any>} */
let pending = {};
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;

/** @type {{ render: () => void } | null} */
let einkUi = null;
/** @type {{ render: () => void } | null} */
let paletteUi = null;
/** @type {{ render: () => void } | null} */
let colorVisionUi = null;

/** The E-ink section and the dark and light controls show for their own mode (CSS reads the attribute). */
function syncMode() {
  document.body.dataset.themeMode = state?.settings?.theme?.mode ?? 'dark';
  syncDependents();
  colorVisionUi?.render();
}

/** A field that has no effect while its switch is off is disabled and says why. Its value stays stored. */
function syncDependents() {
  const on = state?.settings?.theme?.fontEnabled === true;
  input('fontFamily').disabled = !on;
  $('fontFamilyHint').hidden = on;
}

function queue(/** @type {Record<string, any>} */ patch, immediate = false) {
  merge(pending, patch);
  merge(state.settings, patch);
  syncMode();
  paletteUi?.render();
  clearTimeout(timer);
  if (immediate) void flush();
  else timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
}

/** Saves run one after the other, so a retry of an older change never lands after a newer one. */
let saving = Promise.resolve();

function flush() {
  clearTimeout(timer);
  saving = saving.then(saveNow).catch(() => undefined);
  return saving;
}

async function saveNow() {
  const patch = pending;
  pending = {};
  if (Object.keys(patch).length === 0) return;
  await tracked(async () => {
    const reply = await sendWithRetry(() => send({ type: 'dk.settings.patch', patch }));
    if (reply?.ok) say(t('opt.saved'));
    else {
      say(saveErrorText(reply));
      await load();
      renderAll();
    }
  });
}

/** Saves that have been sent and not answered. A change the worker reports meanwhile is shown when the last one ends. */
let inFlight = 0;
let missed = false;
/** False until the first render is done: a change that arrives before is shown when it is. */
let started = false;

/** @template T @param {() => Promise<T>} job @returns {Promise<T>} */
async function tracked(job) {
  inFlight += 1;
  try {
    return await job();
  } finally {
    inFlight -= 1;
    if (inFlight === 0 && missed) {
      missed = false;
      void refresh();
    }
  }
}

/** Drop the changes that wait for their save and let the saves that are running end, before a reset or an import replaces everything. */
async function dropPending() {
  clearTimeout(timer);
  pending = {};
  await saving;
}

/** The text for a refused save: a field the worker does not know means the extension needs a reload. @param {any} reply */
function saveErrorText(reply) {
  return saveErrorKind(reply) === 'reload' ? t('popup.saveErrorReload') : t('popup.saveError');
}

// An older answer that arrives after a newer one is dropped.
let loadGeneration = 0;

async function load() {
  const generation = (loadGeneration += 1);
  const reply = await send({ type: 'dk.state.get', fixes: true });
  if (!reply?.ok) throw new Error('state');
  if (generation === loadGeneration) state = reply;
}

/** Show what the worker holds now. While a save runs or waits, it is shown after the save instead. */
async function refresh() {
  if (!started || inFlight > 0 || Object.keys(pending).length) {
    missed = true;
    return;
  }
  try {
    await load();
    renderSettings();
    renderHold();
    renderSchedule();
    if (!document.activeElement?.closest('#site-list')) renderSites();
    if (!document.activeElement?.closest('#preset-list')) renderPresets();
  } catch {
    // Keep what is shown.
  }
}

/* ----- settings bound by `data-setting` ----- */

function bindSetting(/** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */ el) {
  const path = /** @type {string} */ (el.dataset.setting);
  const range = RANGES[path];
  if (range && el instanceof HTMLInputElement) {
    el.min = String(range.min);
    el.max = String(range.max);
  }
  const autoId = el.dataset.auto;
  const read = () => {
    if (autoId) return input(autoId).checked ? 'auto' : /** @type {HTMLInputElement} */ (el).value;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked;
    if (el instanceof HTMLInputElement && (el.type === 'range' || el.type === 'number')) return el.value === '' ? null : Number(el.value);
    return el.value;
  };
  const commit = () => {
    const value = read();
    if (el.id === 'css') {
      const bad = cssProblem(String(value));
      $('css-error').hidden = !bad;
      el.setAttribute('aria-invalid', String(!!bad));
      if (bad) return;
    }
    if (el instanceof HTMLInputElement && el.type === 'number' && el.min !== '' && !checkNumber(el, { min: Number(el.min), max: Number(el.max) }, el.step !== 'any')) return;
    if (el instanceof HTMLInputElement && el.type === 'text' && el.value.trim() === '') return;
    if (el instanceof HTMLInputElement && el.type === 'range') showOutput(el);
    queue(patchFor(path, value));
  };
  el.addEventListener(el instanceof HTMLInputElement && (el.type === 'range' || el.type === 'text' || el.type === 'number') || el instanceof HTMLTextAreaElement ? 'input' : 'change', commit);
  if (autoId) input(autoId).addEventListener('change', commit);
  // An emptied font name goes back to the default one, so the box never shows a name the extension does not use.
  if (path === 'theme.fontFamily' && el instanceof HTMLInputElement) {
    el.placeholder = defaultTheme().fontFamily;
    el.addEventListener('change', () => {
      if (el.value.trim() !== '') return;
      el.value = defaultTheme().fontFamily;
      queue(patchFor(path, el.value));
    });
  }
}

function showOutput(/** @type {HTMLInputElement} */ el) {
  const out = document.querySelector(`output[for="${el.id}"]`);
  if (out) out.textContent = numbers.format(Number(el.value));
  syncRange(el);
}

let showEngineHint = () => {};

function renderSettings() {
  for (const el of /** @type {NodeListOf<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>} */ (document.querySelectorAll('[data-setting]'))) {
    if (el === document.activeElement) continue;
    const value = getPath(state.settings, /** @type {string} */ (el.dataset.setting));
    const autoId = el.dataset.auto;
    if (autoId) {
      input(autoId).checked = value === 'auto';
      el.value = value === 'auto' ? '#808080' : String(value);
    } else if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      el.checked = value === true;
    } else {
      el.value = value === null || value === undefined ? '' : String(value);
    }
    if (el instanceof HTMLInputElement && el.type === 'range') showOutput(el);
  }
  input('contextMenu').checked = state.settings.contextMenu === true;
  showEngineHint();
  $('css-held').hidden = !(state.settings.cssHeld === true && String(state.settings.theme.css).trim() !== '');
  syncMode();
  einkUi?.render();
  paletteUi?.render();
}

/* ----- sites ----- */

function siteRuleFrom(/** @type {HTMLElement} */ card, /** @type {any} */ before = {}) {
  const get = (/** @type {string} */ name) => /** @type {HTMLInputElement} */ (card.querySelector(`[data-f="${name}"]`));
  /** @type {Record<string, any>} */
  const rule = {};
  const enabled = get('enabled').value;
  if (enabled === 'on') rule.enabled = true;
  if (enabled === 'off') rule.enabled = false;
  if (get('engine').value !== '') rule.engine = get('engine').value;
  /** @type {Record<string, any>} */
  const theme = {};
  if (get('mode').value !== '') theme.mode = get('mode').value;
  if (theme.mode === 'eink') {
    // The style of this site starts from its own defaults. A rule that already holds the style keeps what it has.
    const style = get('einkPreset').value;
    if (style !== '') {
      if (before.theme?.einkPreset === style) {
        for (const key of ['einkPreset', ...EINK_FIELDS]) if (before.theme[key] !== undefined) theme[key] = before.theme[key];
      } else Object.assign(theme, { einkPreset: style }, EINK_RESET);
    }
  }
  if (get('cvdType').value !== '') theme.cvdType = get('cvdType').value;
  for (const name of SITE_NUMBERS) if (get(name).value !== '') theme[name] = Number(get(name).value);
  if (Object.keys(theme).length) rule.theme = theme;
  if (get('css').value.trim() !== '') rule.css = get('css').value;
  return rule;
}

/**
 * The fields that differ between two rules, for `dk.site.patch`: the new values (`null` is a value) and the fields to drop. The
 * theme is compared key by key, also when one side has none; the worker drops a theme that ends up empty.
 * @param {Record<string, any>} before @param {Record<string, any>} after @returns {{ patch: Record<string, any>, remove: string[] }}
 */
function ruleDiff(before, after) {
  const plain = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(a) === JSON.stringify(b);
  /** @type {Record<string, any>} */
  const patch = {};
  /** @type {string[]} */
  const remove = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'cssHeld') continue;
    // A theme the fields no longer show is an empty projection, not a removal: the stored theme may hold fields this editor does
    // not show, or that another window added. Only the shown keys that were cleared are removed.
    const a = before[key] === undefined && plain(after[key]) ? {} : before[key];
    const b = after[key] === undefined && plain(before[key]) ? {} : after[key];
    if (plain(a) && plain(b)) {
      /** @type {Record<string, any>} */
      const inner = {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (same(a[k], b[k])) continue;
        if (b[k] === undefined) remove.push(`${key}.${k}`);
        else inner[k] = b[k];
      }
      if (Object.keys(inner).length) patch[key] = inner;
    } else if (!same(a, b)) {
      if (b === undefined) remove.push(key);
      else patch[key] = b;
    }
  }
  return { patch, remove };
}

/** Save the fields of a site that the editor changed; a change made in another window to other fields stays. */
function saveSiteFields(/** @type {string} */ pattern, /** @type {any} */ before, /** @type {any} */ after) {
  return tracked(async () => {
    const { patch, remove } = ruleDiff(before ?? {}, after ?? {});
    if (Object.keys(patch).length === 0 && remove.length === 0) return true;
    const reply = /** @type {any} */ (await sendWithRetry(() => send({ type: 'dk.site.patch', pattern, patch, remove })));
    if (!reply?.ok) {
      say(saveErrorText(reply));
      return false;
    }
    if (reply.rule === null) delete state.siteRules[pattern];
    else state.siteRules[pattern] = reply.rule;
    say(t('opt.saved'));
    return true;
  });
}

function saveSite(/** @type {string} */ pattern, /** @type {any} */ rule) {
  return tracked(async () => {
    const reply = await sendWithRetry(() => send({ type: 'dk.site.set', pattern, rule }));
    if (!reply?.ok) {
      say(saveErrorText(reply));
      return false;
    }
    if (rule === null) delete state.siteRules[pattern];
    else state.siteRules[pattern] = state.siteRules[pattern]?.cssHeld === true && rule.css !== undefined ? { ...rule, cssHeld: true } : rule;
    say(t('opt.saved'));
    return true;
  });
}

function option(/** @type {string} */ value, /** @type {string} */ text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

function field(/** @type {string} */ label, /** @type {HTMLElement} */ control) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(span, control);
  return wrap;
}

let cssProblemCount = 0;

// The rows of the site list are closed until opened, and the list shows SITE_PAGE rows at a time: a long list stays short and fast.
// The fields of a row are made when it is first opened.
const SITE_PAGE = 50;
let sitesShown = SITE_PAGE;
/** The rows that are open, kept over a new render. @type {Set<string>} */
const openSites = new Set();

/** One line that says what a rule sets: state, mode, style, filter, engine, numbers and CSS. @param {any} rule */
function siteSummary(rule) {
  const parts = [];
  if (rule.enabled === true) parts.push(t('opt.siteOn'));
  else if (rule.enabled === false) parts.push(t('opt.siteOff'));
  const th = rule.theme ?? {};
  if (th.mode === 'eink') parts.push(th.einkPreset === 'paper' ? t('eink.presetPaper') : t('mode.eink'));
  else if (th.mode) parts.push(t(`mode.${th.mode}`));
  if (th.cvdType) parts.push(t(`cvd.${th.cvdType}`));
  if (rule.engine) parts.push(t(rule.engine === 'auto' ? 'engine.auto' : `engine.${rule.engine}`));
  if (SITE_NUMBERS.some((key) => th[key] !== undefined)) parts.push(t('opt.siteNumbers'));
  if (typeof rule.css === 'string' && rule.css.trim() !== '') parts.push(t('opt.siteHasCss'));
  return parts.length ? parts.join(' · ') : t('opt.siteDefault');
}

function siteCard(/** @type {string} */ pattern, /** @type {any} */ rule) {
  const li = document.createElement('li');
  li.className = 'site-row';
  const head = document.createElement('div');
  head.className = 'head';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'site-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  const name = document.createElement('span');
  name.className = 'site-name';
  name.textContent = pattern;
  name.dir = 'ltr';
  const summary = document.createElement('span');
  summary.className = 'site-summary';
  summary.textContent = siteSummary(rule);
  toggle.append(name, summary);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-sm btn-danger site-remove';
  remove.textContent = t('opt.siteRemove');
  head.append(toggle, remove);
  const body = document.createElement('div');
  body.className = 'site-body';
  body.hidden = true;
  body.id = `site-body-${cssProblemCount++}`;
  toggle.setAttribute('aria-controls', body.id);
  let built = false;
  const open = (/** @type {boolean} */ on) => {
    if (on && !built) {
      built = true;
      body.append(...siteFields(li, pattern, state.siteRules[pattern] ?? rule, summary));
    }
    body.hidden = !on;
    toggle.setAttribute('aria-expanded', String(on));
    li.toggleAttribute('data-open', on);
    if (on) openSites.add(pattern);
    else openSites.delete(pattern);
  };
  toggle.addEventListener('click', () => open(body.hidden === true));
  /** @type {any} */ (li).dkOpen = () => open(true);
  confirmClick(remove, t('opt.deleteConfirm'), async () => {
    const kept = structuredClone(state.siteRules[pattern]);
    if (!(await saveSite(pattern, null))) return;
    openSites.delete(pattern);
    renderSites();
    deleted(t('opt.deletedSite', { name: pattern }), kept, () => restoreItem({ type: 'dk.site.set', pattern, rule: kept, ifAbsent: true }, () => renderSites(), '#site-list', pattern));
  }, { announce: (m) => say(m) });
  li.setAttribute('role', 'group');
  li.setAttribute('aria-label', pattern);
  li.append(head, body);
  if (openSites.has(pattern)) open(true);
  return li;
}

/** The fields of an open site row. @param {HTMLElement} li @param {string} pattern @param {any} rule @param {HTMLElement} summary */
function siteFields(li, pattern, rule, summary) {
  const fields = document.createElement('div');
  fields.className = 'fields fields-grid';
  const stateSel = document.createElement('select');
  stateSel.dataset.f = 'enabled';
  stateSel.append(option('', t('opt.siteDefault')), option('on', t('opt.siteOn')), option('off', t('opt.siteOff')));
  stateSel.value = rule.enabled === true ? 'on' : rule.enabled === false ? 'off' : '';
  const engineSel = document.createElement('select');
  engineSel.dataset.f = 'engine';
  engineSel.append(option('', t('opt.siteDefault')), option('auto', t('engine.auto')), option('dynamic', t('engine.dynamic')), option('filter', t('engine.filter')), option('filterPlus', t('engine.filterPlus')), option('static', t('engine.static')));
  engineSel.value = rule.engine ?? '';
  engineHints(engineSel, t);
  const modeSel = document.createElement('select');
  modeSel.dataset.f = 'mode';
  modeSel.append(option('', t('opt.siteDefault')), option('dark', t('mode.dark')), option('light', t('mode.light')), option('eink', t('mode.eink')), option('original', t('mode.original')));
  modeSel.value = rule.theme?.mode ?? '';
  const styleSel = document.createElement('select');
  styleSel.dataset.f = 'einkPreset';
  styleSel.append(option('', t('opt.siteDefault')), option('eink', t('eink.presetEink')), option('paper', t('eink.presetPaper')));
  styleSel.value = rule.theme?.mode === 'eink' ? rule.theme?.einkPreset ?? '' : '';
  const styleField = field(t('eink.preset'), styleSel);
  styleField.hidden = modeSel.value !== 'eink';
  modeSel.addEventListener('change', () => {
    styleField.hidden = modeSel.value !== 'eink';
  });
  const cvdSel = document.createElement('select');
  cvdSel.dataset.f = 'cvdType';
  cvdSel.append(option('', t('opt.siteDefault')), option('none', t('cvd.none')), option('protan', t('cvd.protan')), option('deutan', t('cvd.deutan')), option('tritan', t('cvd.tritan')), option('grayscale', t('cvd.grayscale')), option('grayscaleInverted', t('cvd.grayscaleInverted')), option('inverted', t('cvd.inverted')));
  cvdSel.value = rule.theme?.cvdType ?? '';
  fields.append(field(t('opt.siteState'), stateSel), field(t('popup.engine'), engineSel), field(t('popup.mode'), modeSel), styleField, field(t('cvd.title'), cvdSel));
  const labels = { brightness: t('theme.brightness'), contrast: t('theme.contrast'), sepia: t('theme.sepia'), grayscale: t('theme.grayscale'), warmth: t('theme.warmth') };
  const limits = { brightness: L.BRIGHTNESS, contrast: L.CONTRAST, sepia: L.SEPIA, grayscale: L.GRAYSCALE, warmth: L.WARMTH };
  for (const key of SITE_NUMBERS) {
    const n = document.createElement('input');
    n.type = 'number';
    n.dataset.f = key;
    n.min = String(limits[key].min);
    n.max = String(limits[key].max);
    n.value = rule.theme?.[key] === undefined ? '' : String(rule.theme[key]);
    // An empty field takes the value of the general settings. The gray text says so, so it is not taken for a set value.
    n.placeholder = t('opt.siteDefaultValue', { value: numbers.format(Number(state.settings.theme[key] ?? 0)) });
    n.setAttribute('aria-invalid', 'false');
    // The cards are tight: the range is the tooltip and the description of the field, and shows in full in the fix editor.
    n.title = t('fx.range', { min: numbers.format(limits[key].min), max: numbers.format(limits[key].max) });
    fields.append(field(labels[key], n));
  }
  const css = document.createElement('textarea');
  css.dataset.f = 'css';
  css.rows = 3;
  css.spellcheck = false;
  css.dir = 'ltr';
  css.value = rule.css ?? '';
  css.id = `site-css-${cssProblemCount}`;
  const cssLabel = document.createElement('label');
  cssLabel.className = 'site-css-label';
  cssLabel.htmlFor = css.id;
  cssLabel.textContent = t('opt.siteCss');
  const warn = document.createElement('p');
  warn.className = 'hint';
  warn.textContent = t('opt.cssWarn');
  const problem = document.createElement('p');
  problem.className = 'error';
  problem.setAttribute('role', 'alert');
  problem.hidden = true;
  problem.id = `css-problem-${cssProblemCount++}`;
  css.setAttribute('aria-describedby', problem.id);
  problem.textContent = t('opt.cssError');

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let wait;
  // The rule as the fields showed it, read the same way as a change: only what the person changed here is sent, so a field this
  // editor does not show, or a change made in another window, stays as it is.
  /** @type {Record<string, any> | null} */
  let shown = null;
  queueMicrotask(() => {
    if (li.querySelector('[data-f="enabled"]')) shown = siteRuleFrom(li, rule);
  });
  const change = () => {
    clearTimeout(wait);
    const bad = cssProblem(css.value);
    problem.hidden = !bad;
    css.setAttribute('aria-invalid', String(!!bad));
    let numbersOk = true;
    for (const key of SITE_NUMBERS) numbersOk = checkNumber(/** @type {HTMLInputElement} */ (li.querySelector(`[data-f="${key}"]`)), limits[key], true) && numbersOk;
    if (bad || !numbersOk) return;
    wait = setTimeout(() => {
      const next = siteRuleFrom(li, state.siteRules[pattern]);
      void saveSiteFields(pattern, shown ?? state.siteRules[pattern], next).then((ok) => {
        if (ok) shown = next;
        if (ok) summary.textContent = siteSummary(state.siteRules[pattern] ?? next ?? {});
      });
    }, SAVE_DELAY_MS);
  };
  fields.addEventListener('input', change);
  fields.addEventListener('change', change);
  css.addEventListener('input', change);
  const held = document.createElement('p');
  held.className = 'hint held';
  held.textContent = t('opt.cssHeld');
  held.hidden = rule.cssHeld !== true;
  return [fields, cssLabel, css, warn, held, problem];
}

/**
 * Say that something was deleted, with an Undo button when a restored copy is safe. Custom CSS that is still off came from an
 * import or sync: a restored copy would turn it on without a review, so that record has no Undo.
 * @param {string} text @param {any} kept the deleted record @param {() => void | Promise<unknown>} undo
 */
function deleted(text, kept, undo) {
  if (kept?.cssHeld === true) say(text);
  else say(text, { label: t('opt.undo'), focus: true, run: undo });
}

/**
 * Put a deleted record back with the message that created it. A record that exists again meanwhile is kept as it is.
 * @param {Record<string, unknown>} message @param {() => void} render @param {string} listSelector @param {string} label the label of the restored group
 */
async function restoreItem(message, render, listSelector, label) {
  try {
    const reply = await send(message);
    if (!reply?.ok) throw new Error('refused');
    await load();
    render();
    const group = [...document.querySelectorAll(`${listSelector} > li`)].find((li) => li.getAttribute('aria-label') === label);
    /** @type {any} */ (group)?.dkOpen?.();
    /** @type {HTMLElement | null | undefined} */ (group?.querySelector('select, input, button'))?.focus();
    say(reply.created === false ? t('opt.undoTaken') : t('opt.undone'));
  } catch {
    say(t('popup.saveError'));
  }
}

/** The note for an empty list. A search in progress narrows it again. @param {HTMLElement} note @param {boolean} none */
function showNone(note, none) {
  note.dataset.none = String(none);
  note.hidden = !none;
  if (input('search').value.trim() !== '') applySearch();
}

function renderSites() {
  const list = $('site-list');
  list.replaceChildren();
  const patterns = Object.keys(state.siteRules).sort();
  // A search looks through every site, so the list is whole while it runs.
  const all = input('search').value.trim() !== '';
  const shown = all ? patterns : patterns.slice(0, sitesShown);
  for (const pattern of shown) list.append(siteCard(pattern, state.siteRules[pattern]));
  const more = /** @type {HTMLButtonElement} */ ($('site-more'));
  const left = patterns.length - shown.length;
  more.hidden = left <= 0;
  more.textContent = t('opt.siteMore', { total: numbers.format(left) });
  showNone($('site-none'), patterns.length === 0);
}

async function addSite() {
  const box = input('site-pattern');
  const raw = box.value.trim();
  if (raw === '') return;
  try {
    // A site that has a rule keeps it.
    const reply = await send({ type: 'dk.site.set', pattern: raw, rule: { enabled: true }, ifAbsent: true });
    if (!reply?.ok) throw new Error('refused');
    box.value = '';
    await load();
    // The new rule opens, and the list shows it even when it is past the rows shown.
    const key = Object.keys(state.siteRules).find((p) => p === raw.toLowerCase()) ?? Object.keys(state.siteRules).sort().find((p) => raw.toLowerCase().includes(p));
    if (key) {
      openSites.add(key);
      sitesShown = Math.max(sitesShown, Object.keys(state.siteRules).sort().indexOf(key) + 1);
    }
    renderSites();
    say(t('opt.saved'));
  } catch {
    say(t('opt.siteBad'));
  }
}

/* ----- custom CSS that waits to be turned on ----- */

/** One row of the notice: where the CSS is, a button to read it, and (after it is shown) a button to turn it on. */
function holdRow(/** @type {string} */ label, /** @type {{ scope: 'settings' | 'siteRules' | 'userFixes', pattern?: string, css: string }} */ item) {
  const li = document.createElement('li');
  const head = document.createElement('div');
  head.className = 'head';
  const name = document.createElement('span');
  name.textContent = label;
  const actions = document.createElement('div');
  actions.className = 'actions';
  const review = document.createElement('button');
  review.type = 'button';
  review.className = 'btn btn-sm';
  review.textContent = t('opt.holdReview');
  review.setAttribute('aria-expanded', 'false');
  const enable = document.createElement('button');
  enable.type = 'button';
  enable.className = 'btn btn-sm btn-primary';
  enable.textContent = t('opt.holdEnable');
  enable.hidden = true;
  actions.append(review, enable);
  head.append(name, actions);

  const body = document.createElement('div');
  body.hidden = true;
  const code = document.createElement('pre');
  code.dir = 'ltr';
  code.tabIndex = 0;
  code.textContent = item.css;
  body.append(code);
  if (cssReachesOut(item.css)) {
    const warn = document.createElement('p');
    warn.className = 'hint';
    warn.textContent = t('opt.cssWarn');
    body.append(warn);
  }
  review.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    enable.hidden = !open;
    review.textContent = open ? t('opt.holdHide') : t('opt.holdReview');
    review.setAttribute('aria-expanded', String(open));
  });
  enable.addEventListener('click', async () => {
    const reply = await send({ type: 'dk.css.enable', scope: item.scope, ...(item.pattern === undefined ? {} : { pattern: item.pattern }), css: item.css });
    if (reply?.ok) say(t('opt.holdDone'));
    else say(reply?.code === 'changed' ? t('opt.holdChanged') : t('popup.saveError'));
    try {
      await load();
      renderAll();
    } catch {
      // Keep what is shown.
    }
  });
  li.append(head, body);
  return li;
}

/** What the notice shows now; a row that is open stays open unless the held CSS itself changed. */
let holdShown = '';

function renderHold() {
  const held = heldCss(state);
  /** @type {Array<[string, { scope: 'settings' | 'siteRules' | 'userFixes', pattern?: string, css: string }]>} */
  const rows = [];
  if (held.settings) rows.push([t('opt.holdGlobal'), { scope: 'settings', css: state.settings.theme.css }]);
  for (const key of held.siteRules) rows.push([t('opt.holdSite', { site: key }), { scope: 'siteRules', pattern: key, css: ruleCss(state.siteRules[key]) }]);
  for (const key of held.userFixes) rows.push([t('opt.holdFix', { site: key }), { scope: 'userFixes', pattern: key, css: fixCss(state.userFixes[key]) }]);
  const signature = JSON.stringify(rows);
  if (signature === holdShown) return;
  holdShown = signature;
  $('hold-list').replaceChildren(...rows.map(([label, item]) => holdRow(label, item)));
  $('css-hold').hidden = rows.length === 0;
}

/* ----- presets ----- */

function download(/** @type {string} */ name, /** @type {string} */ text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function currentTheme() {
  const { css, ...theme } = state.settings.theme;
  void css;
  return theme;
}

async function savePreset(/** @type {{ id?: string, name: string, theme: any }} */ preset) {
  try {
    const reply = await send({ type: 'dk.preset.save', preset });
    if (!reply?.ok) throw new Error('refused');
    await load();
    renderPresets();
    say(t('opt.saved'));
  } catch {
    say(t('popup.saveError'));
  }
}

function renderPresets() {
  const list = $('preset-list');
  list.replaceChildren();
  for (const preset of state.presets) {
    const li = document.createElement('li');
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 60;
    name.value = preset.name;
    name.dir = 'auto';
    name.setAttribute('aria-label', t('opt.presetName'));
    name.title = preset.name;
    name.addEventListener('input', () => {
      name.title = name.value;
    });
    const button = (/** @type {string} */ text, /** @type {() => void} */ run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm';
      b.textContent = text;
      b.addEventListener('click', run);
      return b;
    };
    const remove = button(t('opt.presetDelete'), () => {});
    remove.classList.add('btn-danger');
    const row = document.createElement('div');
    row.className = 'fields';
    row.append(
      name,
      button(t('opt.presetApply'), () => {
        queue({ theme: preset.theme }, true);
        renderSettings();
      }),
      button(t('opt.presetRename'), () => {
        if (name.value.trim() !== '') void savePreset({ id: preset.id, name: name.value.trim(), theme: preset.theme });
      }),
      button(t('opt.presetExport'), () => download(`tintly-preset-${preset.id}.json`, `${JSON.stringify({ app: 'tintly', preset }, null, 2)}\n`)),
      remove,
    );
    confirmClick(remove, t('opt.deleteConfirm'), async () => {
      const kept = structuredClone(preset);
      const reply = await send({ type: 'dk.preset.delete', id: preset.id });
      if (!reply?.ok) {
        say(t('popup.saveError'));
        return;
      }
      await load();
      renderPresets();
      deleted(t('opt.deletedPreset', { name: kept.name }), kept, () => restoreItem({ type: 'dk.preset.save', preset: kept }, () => renderPresets(), '#preset-list', kept.name));
    }, { announce: (m) => say(m) });
    li.setAttribute('role', 'group');
    li.setAttribute('aria-label', preset.name);
    li.append(row);
    list.append(li);
  }
  showNone($('preset-none'), state.presets.length === 0);
}

/* ----- shortcuts, data, language ----- */

/** The name of a command of the manifest in the language of this page. One literal key per line so the key check sees each. @param {string} name */
function commandName(name) {
  switch (name) {
    case 'toggle_extension':
      return t('cmd.toggle_extension');
    case 'toggle_site':
      return t('cmd.toggle_site');
    case 'switch_engine':
      return t('cmd.switch_engine');
    default:
      return null;
  }
}

async function renderShortcuts() {
  const list = $('shortcut-list');
  list.replaceChildren();
  try {
    for (const c of await chrome.commands.getAll()) {
      if (!c.description) continue;
      const li = document.createElement('li');
      // The name comes from the language of this page. The manifest text is in the language of the browser, so it is only the fallback.
      const what = document.createElement('span');
      what.className = 'shortcut-name';
      const known = commandName(c.name ?? '');
      what.textContent = known ?? c.description ?? c.name ?? '';
      if (known === null) what.dir = 'auto';
      const key = document.createElement(c.shortcut ? 'kbd' : 'span');
      if (c.shortcut) {
        key.dir = 'ltr';
        key.textContent = c.shortcut;
      } else {
        key.className = 'shortcut-none';
        key.textContent = t('opt.shortcutNone');
      }
      li.append(what, key);
      list.append(li);
    }
  } catch {
    // The list is only a convenience.
  }
}

async function importFile(/** @type {File} */ file) {
  const box = $('import-box');
  box.hidden = true;
  if (file.size > MAX_IMPORT_BYTES) {
    say(t('opt.importBad'));
    return;
  }
  const text = await file.text();
  const reply = await send({ type: 'dk.import', text });
  if (!reply?.ok) {
    say(t('opt.importBad'));
    return;
  }
  const s = reply.summary;
  $('import-summary').textContent = `${t('opt.importSummary', { sites: numbers.format(s.siteRules), presets: numbers.format(s.presets), fixes: numbers.format(s.userFixes) })}${s.customCss ? ` ${t('opt.importCss')}` : ''}${s.heldCss > 0 ? ` ${t('opt.importHeld')}` : ''}${s.remoteCss ? ` ${t('opt.cssWarn')}` : ''}`;
  box.hidden = false;
  $('import-apply').onclick = async () => {
    box.hidden = true;
    await dropPending();
    const done = await send({ type: 'dk.import', text, confirmed: true });
    if (!done?.ok) {
      say(t('opt.importBad'));
      return;
    }
    await load();
    renderAll();
    say(done.summary?.heldCss > 0 ? t('opt.importDoneHeld') : t('opt.importDone'));
  };
}

async function resetAll() {
  await dropPending();
  const reply = await send({ type: 'dk.reset', confirmed: true });
  if (reply?.ok) {
    await load();
    renderAll();
    say(t('opt.resetDone'));
  } else {
    say(t('popup.saveError'));
  }
}

async function toggleContextMenu(/** @type {boolean} */ on) {
  if (on) {
    let granted = false;
    try {
      // In Firefox the menu permission is granted at install and cannot be asked for later.
      granted = (chrome.runtime.getManifest().permissions ?? []).includes(/** @type {any} */ ('menus')) || (await chrome.permissions.request({ permissions: ['contextMenus'] }));
    } catch {
      granted = false;
    }
    if (!granted) {
      input('contextMenu').checked = false;
      say(t('opt.permissionDenied'));
      return;
    }
  }
  queue({ contextMenu: on }, true);
}

/* ----- search ----- */

function applySearch() {
  const q = input('search').value.trim().toLowerCase();
  const searching = q !== '';
  let shown = 0;
  for (const section of document.querySelectorAll('[data-section]')) {
    const heading = section.querySelector('h2')?.textContent?.toLowerCase() ?? '';
    let any = false;
    for (const child of /** @type {HTMLElement[]} */ ([...section.children])) {
      if (child.tagName === 'H2') continue;
      const hit = q === '' || heading.includes(q) || (child.textContent ?? '').toLowerCase().includes(q) || [...child.querySelectorAll('input, textarea')].some((e) => /** @type {HTMLInputElement} */ (e).value.toLowerCase().includes(q) && e.getAttribute('type') !== 'color');
      // The "none yet" notes show when their list is empty, and a search only narrows that.
      if (child.hasAttribute('data-empty')) {
        child.hidden = child.dataset.none !== 'true' || !hit;
        if (!child.hidden) any = true;
        continue;
      }
      child.hidden = !hit && !child.id.endsWith('-box');
      if (hit) any = true;
    }
    /** @type {HTMLElement} */ (section).hidden = !any;
    if (any) shown += 1;
  }
  // A search looks through every tab at once; clearing it returns to the chosen tab.
  for (const panel of document.querySelectorAll('.panel')) /** @type {HTMLElement} */ (panel).hidden = !searching && panel.id !== `panel-${currentTab}`;
  $('search-empty').hidden = !searching || shown > 0;
  document.body.toggleAttribute('data-searching', searching);
  // The search shows every row; without a search the rows that depend on the schedule are hidden again.
  if (!searching) renderSchedule();
}

/* ----- start ----- */

/** The permission for exact switching: built in on Firefox, asked for on Chrome and Edge. */
const ALARMS = 'alarms';
const alarmsBuiltIn = () => (chrome.runtime.getManifest().permissions ?? []).includes(/** @type {any} */ (ALARMS));
let alarmRender = 0;

/** The note and the buttons for the `alarms` permission: only for hours and sun times that turn Tintly on and off, the only schedules it can serve. */
async function renderAlarm() {
  const auto = state.settings.automation;
  const relevant = auto.behavior !== 'scheme' && (auto.mode === 'time' || auto.mode === 'location');
  $('alarm-box').hidden = !relevant;
  if (!relevant) return;
  const turn = (alarmRender += 1);
  let granted = false;
  try {
    granted = alarmsBuiltIn() || (await chrome.permissions.contains({ permissions: [/** @type {any} */ (ALARMS)] }));
  } catch {
    granted = false;
  }
  if (turn !== alarmRender) return;
  $('alarm-status').textContent = granted ? t('opt.schedPermOn') : t('opt.schedPermOff');
  $('alarm-allow').hidden = granted;
  $('alarm-remove').hidden = !granted || alarmsBuiltIn();
}

// The request is made from the click on the button, which is the gesture the browser wants. The text above the button says why first.
async function allowAlarms() {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ permissions: [/** @type {any} */ (ALARMS)] });
  } catch {
    granted = false;
  }
  if (!granted) say(t('opt.permissionDenied'));
  await renderAlarm();
}

async function removeAlarms() {
  try {
    await chrome.permissions.remove({ permissions: [/** @type {any} */ (ALARMS)] });
  } catch {
    say(t('popup.saveError'));
  }
  await renderAlarm();
}

function renderSchedule() {
  const mode = state.settings.automation.mode;
  for (const row of document.querySelectorAll('[data-for]')) /** @type {HTMLElement} */ (row).hidden = /** @type {HTMLElement} */ (row).dataset.for !== mode;
  /** @type {HTMLElement} */ (input('autoBehavior').closest('.item')).hidden = mode === 'none';
  const scheme = mode !== 'none' && state.settings.automation.behavior === 'scheme';
  for (const row of document.querySelectorAll('[data-behavior]')) /** @type {HTMLElement} */ (row).hidden = !scheme;
  void renderAlarm();
}

function renderAll() {
  renderSettings();
  renderHold();
  renderSites();
  renderPresets();
  renderSchedule();
  void renderShortcuts();
  input('locale').value = state.ui?.locale ?? 'auto';
  input('uiTheme').value = state.ui?.uiTheme ?? 'system';
  input('supportNudge').checked = state.ui?.support?.optOut !== true;
}

/** @type {string} */
let currentTab = TABS[0];

function wireShell() {
  hydrateIcons();
  const tabs = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[role="tab"]')]);
  const tabsApi = tabList(tabs, (tab) => {
    currentTab = /** @type {string} */ (tab.dataset.tab);
    document.body.dataset.tab = currentTab;
    history.replaceState(null, '', `#${currentTab}`);
    if (input('search').value.trim() !== '') applySearch();
  });
  const fromHash = () => {
    const name = location.hash.slice(1);
    const tab = tabs.find((x) => x.dataset.tab === name) ?? tabs[0];
    tabsApi.select(tab);
    return tab;
  };
  fromHash();
  addEventListener('hashchange', fromHash);

  /** @type {Array<{ id: string, icon: string, label: string, run: () => void }>} */
  const items = [];
  if (LINKS.help) items.push({ id: 'help', icon: 'book', label: t('menu.help'), run: () => openUrl(LINKS.help) });
  items.push({ id: 'about', icon: 'info', label: t('menu.about'), run: () => { input('search').value = ''; applySearch(); const tab = /** @type {HTMLElement} */ (document.getElementById('tab-about')); tabsApi.select(tab); tab.focus(); } });
  if (LINKS.support) items.push({ id: 'support', icon: 'heart', label: t('menu.support'), run: () => openUrl(LINKS.support) });
  mountMenu({ trigger: $('overflowBtn'), menu: $('overflowMenu'), items });
  mountThemeSwitch({
    mount: $('themeMount'),
    t,
    theme: state.ui?.uiTheme ?? 'system',
    onTheme: async (value) => {
      applyUiTheme(value);
      input('uiTheme').value = value;
      const reply = await send({ type: 'dk.ui.set', ui: { uiTheme: value } });
      if (!reply?.ok) say(t('popup.saveError'));
    },
  });
  if (LINKS.support) {
    $('supportBtn').hidden = false;
    $('supportBtn').addEventListener('click', () => openUrl(LINKS.support));
  }
  document.addEventListener('dk-uitheme', (event) => {
    input('uiTheme').value = /** @type {CustomEvent<string>} */ (event).detail;
  });
  $('about-mount').replaceChildren(buildAbout(t));
  mountFooter({ root: $('footerMount'), t });
}

function wire() {
  einkUi = mountEink({ theme: () => state.settings.theme, queue, numbers: () => numbers });
  colorVisionUi = mountColorVision({ theme: () => state.settings.theme, queue, changed: () => renderSettings() });
  paletteUi = mountPalettes({ theme: () => state.settings.theme, queue, t: (key) => t(key), changed: () => renderSettings() });
  for (const el of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('[data-setting]'))) bindSetting(el);
  renderSettings();
  $('site-add').addEventListener('click', () => void addSite());
  input('site-pattern').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void addSite();
  });
  $('preset-save').addEventListener('click', () => {
    const name = input('preset-name').value.trim();
    if (name === '') return;
    input('preset-name').value = '';
    void savePreset({ name, theme: currentTheme() });
  });
  input('autoMode').addEventListener('change', () => queueMicrotask(renderSchedule));
  input('autoBehavior').addEventListener('change', () => queueMicrotask(renderSchedule));
  input('supportNudge').addEventListener('change', async () => {
    const support = { ...state.ui.support, optOut: !input('supportNudge').checked };
    const reply = await send({ type: 'dk.ui.set', ui: { support } });
    if (reply?.ok) {
      state.ui.support = support;
      say(t('opt.saved'));
    } else say(t('popup.saveError'));
  });
  $('alarm-allow').addEventListener('click', () => void allowAlarms());
  $('alarm-remove').addEventListener('click', () => void removeAlarms());
  chrome.permissions?.onAdded?.addListener(() => void renderAlarm());
  chrome.permissions?.onRemoved?.addListener(() => void renderAlarm());
  input('contextMenu').addEventListener('change', (e) => void toggleContextMenu(/** @type {HTMLInputElement} */ (e.target).checked));
  $('shortcut-open').addEventListener('click', () => {
    try {
      void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    } catch {
      say(t('popup.saveError'));
    }
  });
  $('export').addEventListener('click', async () => {
    const reply = await send({ type: 'dk.export' });
    if (reply?.ok) download('tintly-settings.json', reply.text);
    else say(t('popup.saveError'));
  });
  input('import').addEventListener('change', (e) => {
    const box = /** @type {HTMLInputElement} */ (e.target);
    const file = box.files?.[0];
    $('import-name').textContent = file ? file.name : t('opt.importNone');
    if (!file) return;
    // The same file chosen again must count as a new choice, so the box is emptied once the file is read.
    void importFile(file).finally(() => {
      box.value = '';
    });
  });
  confirmClick($('reset'), t('opt.resetConfirm'), resetAll, { announce: (m) => say(m), ms: RESET_WINDOW_MS });
  for (const id of ['locale', 'uiTheme']) {
    input(id).addEventListener('change', async () => {
      const reply = await send({ type: 'dk.ui.set', ui: { locale: input('locale').value, uiTheme: input('uiTheme').value } });
      if (reply?.ok) location.reload();
      else say(t('popup.saveError'));
    });
  }
  input('search').addEventListener('input', () => {
    // The site list is whole during a search and short again after it.
    const searching = input('search').value.trim() !== '';
    if (searching !== $('site-list').hasAttribute('data-all')) {
      $('site-list').toggleAttribute('data-all', searching);
      renderSites();
    }
    applySearch();
  });
  $('site-more').addEventListener('click', () => {
    sitesShown += SITE_PAGE;
    renderSites();
  });
  addEventListener('pagehide', () => void flush());
}

/** A change made in the popup shows here at once. It is watched from before the first read, so a change between the read and the first render is not lost. */
function watchStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes.settings || changes.siteRules || changes.presets || changes.userFixes)) return;
    void refresh();
  });
}

async function start() {
  const i18n = await initI18n(undefined, { title: (t) => t('options.title') });
  t = i18n.t;
  say = createSay($('message'), t);
  numbers = numberFormat(i18n.locale);
  showEngineHint = engineHints(/** @type {HTMLSelectElement} */ ($('engine')), t, $('engine-hint'));
  input('search').placeholder = t('opt.search');
  input('search').setAttribute('aria-label', t('opt.search'));
  await loadInstallType();
  watchStorage();
  try {
    await load();
    renderAll();
    wire();
    wireShell();
    started = true;
    if (missed) {
      missed = false;
      await refresh();
    }
  } catch {
    say(t('popup.error'));
  }
  document.body.removeAttribute('data-loading');
}

void start();
