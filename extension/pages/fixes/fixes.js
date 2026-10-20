// @ts-check
import { numberFormat } from '../../shared/numbers.js';
import { initI18n } from '../../shared/i18n.js';
import { confirmClick, engineHints } from '../../shared/widgets.js';
import { L } from '../../shared/limits.js';
import { createSay } from '../../shared/say.js';
import { cssProblem } from '../../shared/css-check.js';
import { fixProblems } from '../../shared/fix-check.js';
import { saveErrorKind } from '../../shared/save-error.js';
import { EINK_FIELDS, EINK_RESET, isTooBroad, isUrlPart, normalizePattern } from '../../shared/settings.js';

const NUMBERS = /** @type {const} */ ({
  brightness: L.BRIGHTNESS,
  contrast: L.CONTRAST,
  sepia: L.SEPIA,
  grayscale: L.GRAYSCALE,
  warmth: L.WARMTH,
});
const LISTS = /** @type {const} */ (['invert', 'ignoreInline', 'ignoreImage']);
// Parts of style sheet addresses, not selectors.
const URLS = /** @type {const} */ (['ignoreCssUrl']);
const STATIC = /** @type {const} */ ({ sBg: 'bg', sFg: 'fg', sBorder: 'border', sSkip: 'skip' });
const NARROW = ['invert', 'sBg', 'sFg', 'sBorder', 'sSkip'];
const SAVE_DELAY_MS = 400;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ ($(id));
const area = (/** @type {string} */ id) => /** @type {HTMLTextAreaElement} */ ($(id));
const select = (/** @type {string} */ id) => /** @type {HTMLSelectElement} */ ($(id));
const send = (/** @type {Record<string, unknown>} */ message) => chrome.runtime.sendMessage(message);

/** @type {(key: string, params?: Record<string, string | number>) => string} */
let t = (key) => key;
let numbers = numberFormat();
/** @type {Record<string, any>} */
let fixes = {};
/** @type {string | null} */
let current = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
// The form holds a change that is not stored yet. `edits` counts changes, so a save only clears what it carried.
let dirty = false;
let edits = 0;
/** The save in flight; a new save starts after it. @type {Promise<boolean>} */
let inflight = Promise.resolve(true);

let say = /** @type {(text: string, action?: import('../../shared/say.js').SayAction) => void} */ (() => {});

const lines = (/** @type {string} */ text) => text.split('\n').map((s) => s.trim()).filter(Boolean);

async function load() {
  const reply = await send({ type: 'dk.state.get', fixes: true });
  if (!reply?.ok) throw new Error('state');
  fixes = reply.userFixes ?? {};
}

function renderList() {
  const box = select('fix-site');
  box.replaceChildren();
  const names = Object.keys(fixes).sort();
  for (const name of names) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    box.append(o);
  }
  $('fix-none').hidden = names.length > 0;
  box.disabled = names.length === 0;
  if (current && fixes[current]) box.value = current;
}

let showEngineHint = () => {};

function show(/** @type {string | null} */ pattern) {
  current = pattern && fixes[pattern] ? pattern : null;
  $('editor').hidden = current === null;
  if (current === null) return;
  const fix = fixes[current];
  const dyn = fix.dynamic ?? {};
  select('fix-site').value = current;
  $('editor-title').textContent = current;
  input('note').value = fix.note ?? '';
  select('engine').value = fix.engine ?? '';
  showEngineHint();
  select('mode').value = dyn.theme?.mode ?? '';
  select('einkPreset').value = dyn.theme?.mode === 'eink' ? dyn.theme?.einkPreset ?? '' : '';
  for (const [name, range] of Object.entries(NUMBERS)) {
    const el = input(name);
    el.min = String(range.min);
    el.max = String(range.max);
    el.value = dyn.theme?.[name] === undefined ? '' : String(dyn.theme[name]);
    $(`${name}-range`).textContent = t('fx.range', { min: numbers.format(range.min), max: numbers.format(range.max) });
  }
  syncStyle();
  area('css').value = dyn.css ?? '';
  for (const name of [...LISTS, ...URLS]) area(name).value = (dyn[name] ?? []).join('\n');
  input('notDark').checked = fix.notDark === true;
  for (const [id, key] of Object.entries(STATIC)) area(id).value = (fix.static?.[key] ?? []).join('\n');
  clearProblems();
}

/** The Style field belongs to the E-ink and Paper mode only, as on the site cards. */
function syncStyle() {
  /** @type {HTMLElement} */ ($('einkPreset').closest('.item')).hidden = select('mode').value !== 'eink';
}

/** Selectors the browser cannot parse. */
function badSelectors(/** @type {string[]} */ list) {
  return list.filter((s) => {
    try {
      return !CSS.supports(`selector(${s})`);
    } catch {
      return true;
    }
  });
}

/** Build the fix from the form, starting from the stored one so fields this page does not show are kept. */
function build() {
  const fix = structuredClone(fixes[/** @type {string} */ (current)]);
  const set = (/** @type {any} */ obj, /** @type {string} */ key, /** @type {unknown} */ value, /** @type {boolean} */ empty) => {
    if (empty) delete obj[key];
    else obj[key] = value;
  };
  set(fix, 'note', input('note').value.trim(), input('note').value.trim() === '');
  set(fix, 'engine', select('engine').value, select('engine').value === '');
  const dyn = fix.dynamic ?? {};
  const theme = dyn.theme ?? {};
  set(theme, 'mode', select('mode').value, select('mode').value === '');
  // A style set for the site starts from its own defaults; the same style as before keeps what the fix already holds.
  const style = select('mode').value === 'eink' ? select('einkPreset').value : '';
  if (style === '') {
    for (const key of ['einkPreset', ...EINK_FIELDS]) delete theme[key];
  } else if (theme.einkPreset !== style) {
    Object.assign(theme, { einkPreset: style }, EINK_RESET);
  }
  for (const name of Object.keys(NUMBERS)) set(theme, name, Number(input(name).value), input(name).value === '');
  set(dyn, 'theme', theme, Object.keys(theme).length === 0);
  set(dyn, 'css', area('css').value, area('css').value.trim() === '');
  for (const name of [...LISTS, ...URLS]) set(dyn, name, lines(area(name).value), lines(area(name).value).length === 0);
  set(fix, 'dynamic', dyn, Object.keys(dyn).length === 0);
  set(fix, 'notDark', true, !input('notDark').checked);
  const stat = fix.static ?? {};
  for (const [id, key] of Object.entries(STATIC)) set(stat, key, lines(area(id).value), lines(area(id).value).length === 0);
  set(fix, 'static', stat, Object.keys(stat).length === 0);
  return fix;
}

async function save(/** @type {string} */ pattern, /** @type {any} */ fix) {
  /** @type {{ ok?: boolean, code?: string } | null} */
  const reply = await send({ type: 'dk.fix.set', pattern, fix }).catch(() => null);
  if (!reply?.ok) return reply ?? { ok: false };
  if (fix === null) delete fixes[pattern];
  else fixes[pattern] = fix;
  return reply;
}

const FIELDS = [...LISTS, ...URLS, ...Object.keys(STATIC), 'css', 'note', 'engine', 'mode', 'einkPreset', ...Object.keys(NUMBERS)];

/** The problems of the last check, by field, and whether one has no field to show it. */
let found = /** @type {Map<string, string>} */ (new Map());
let looseProblem = false;

/** The message for the bad lines of a list. One literal key per line so the key check sees each. @param {string} id @param {string[]} list */
function listError(id, list) {
  const joined = list.join(' , ');
  if (URLS.includes(/** @type {any} */ (id))) return t('fx.badUrls', { list: joined });
  return t('fx.badSelectors', { list: joined });
}

/** Note a wrong field. Nothing changes on the page until `showFound`. */
function mark(/** @type {string} */ id, /** @type {string} */ message) {
  found.set(id, message);
}

/** Bring the marks on the page to the problems found. A message that stays is left alone, so a screen reader does not say it again. */
function showFound() {
  for (const id of FIELDS) {
    const el = $(id);
    const message = found.get(id);
    const boxId = id === 'css' ? 'css-error' : `${id}-error`;
    let box = document.getElementById(boxId);
    if (message === undefined) {
      if (el.getAttribute('aria-invalid') !== 'false') el.setAttribute('aria-invalid', 'false');
      if (box && !box.hidden) box.hidden = true;
      const kept = (el.getAttribute('aria-describedby') ?? '').split(' ').filter((x) => x && x !== boxId);
      if (kept.length) el.setAttribute('aria-describedby', kept.join(' '));
      else el.removeAttribute('aria-describedby');
      continue;
    }
    el.setAttribute('aria-invalid', 'true');
    if (!box) {
      box = document.createElement('p');
      box.id = boxId;
      box.className = 'error';
      box.setAttribute('role', 'alert');
      box.hidden = true;
      (id in NUMBERS ? $(`${id}-range`) : el).insertAdjacentElement('afterend', box);
    }
    if (id !== 'css' && box.textContent !== message) box.textContent = message;
    if (box.hidden) box.hidden = false;
    const ids = new Set((el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean));
    ids.add(boxId);
    el.setAttribute('aria-describedby', [...ids].join(' '));
  }
  const loose = $('selector-error');
  if (looseProblem) {
    if (loose.textContent !== t('fx.notStored')) loose.textContent = t('fx.notStored');
    if (loose.hidden) loose.hidden = false;
  } else if (!loose.hidden) loose.hidden = true;
}

function clearProblems() {
  found = new Map();
  looseProblem = false;
  showFound();
}

/** Note what the worker refuses, by its own rules. A problem that no field shows goes to the message at the bottom. */
function collect(/** @type {ReturnType<typeof fixProblems>} */ problems) {
  /** @type {Map<string, number[]>} */
  const listed = new Map();
  for (const p of problems) {
    const id = p.field && FIELDS.includes(p.field) ? p.field : null;
    if (id === null) looseProblem = true;
    else if (id === 'css') mark(id, t('opt.cssError'));
    else if (p.index !== null) listed.set(id, [...(listed.get(id) ?? []), p.index]);
    else if (id in NUMBERS) {
      const range = NUMBERS[/** @type {keyof typeof NUMBERS} */ (id)];
      mark(id, t('opt.numberWhole', { min: numbers.format(range.min), max: numbers.format(range.max) }));
    } else mark(id, t('fx.valueBad'));
  }
  for (const [id, at] of listed) {
    const all = lines(area(id).value);
    mark(id, listError(id, [...new Set(at.map((i) => all[i]).filter((x) => x !== undefined))]));
  }
}

/** A refused save shows its reasons on the fields. */
function showProblems(/** @type {ReturnType<typeof fixProblems>} */ problems) {
  found = new Map();
  looseProblem = false;
  collect(problems);
  showFound();
}

/** Put the cursor on the first wrong field that can be seen, so a blocked move shows its reason. */
function focusProblem() {
  const first = FIELDS.map($).find((el) => el.getAttribute('aria-invalid') === 'true' && el.getClientRects().length > 0);
  first?.scrollIntoView({ block: 'center' });
  first?.focus();
}

/** Check the form and show what is wrong. True when it can be saved. */
function validate() {
  found = new Map();
  looseProblem = false;
  const all = [...LISTS, ...Object.keys(STATIC)].flatMap((n) => lines(area(n).value));
  const broad = NARROW.flatMap((n) => lines(area(n).value)).filter(isTooBroad);
  const badUrls = URLS.flatMap((n) => lines(area(n).value)).filter((s) => !isUrlPart(s));
  const bad = [...badSelectors(all), ...broad];
  const cssBad = cssProblem(area('css').value);
  if (cssBad) mark('css', t('opt.cssError'));
  for (const id of [...LISTS, ...URLS, ...Object.keys(STATIC)]) {
    const wrong = lines(area(id).value).filter((s) => bad.includes(s) || badUrls.includes(s));
    if (wrong.length) mark(id, listError(id, wrong));
  }
  // What is left is judged by the rules the worker saves by, so a save it would refuse never leaves the page.
  // A Style that is hidden is reported on the Mode it depends on.
  const rest = fixProblems(build())
    .map((p) => (p.field === 'einkPreset' ? { ...p, field: 'mode' } : p))
    .filter((p) => !(p.field && found.has(p.field)));
  collect(rest);
  const ok = found.size === 0 && !looseProblem;
  showFound();
  return ok;
}

/** Save the form for the record that is open. The form is read now, so a later switch cannot change what is saved. True when stored. */
async function commit() {
  if (current === null) return true;
  if (!validate()) return false;
  const pattern = current;
  const fix = build();
  const seen = edits;
  const run = inflight.then(async () => {
    const reply = await save(pattern, fix);
    const ok = reply.ok === true;
    if (ok && edits === seen) dirty = false;
    if (!ok && current === pattern) showProblems(fixProblems(fix));
    say(ok ? t('opt.saved') : saveErrorKind(reply) === 'reload' ? t('popup.saveErrorReload') : t('fx.notStored'));
    return ok;
  });
  inflight = run.catch(() => false);
  return run;
}

/** Store a change that is waiting. False when it could not be stored, so the caller stays on the record. */
async function flush() {
  clearTimeout(timer);
  timer = undefined;
  if (dirty && !(await commit())) {
    focusProblem();
    return false;
  }
  await inflight;
  return !dirty;
}

function schedule() {
  dirty = true;
  edits += 1;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void commit();
  }, SAVE_DELAY_MS);
}

async function addPattern(/** @type {string} */ raw) {
  const text = raw.trim();
  if (text === '') return;
  if (!(await flush())) return;
  // An entry that exists is opened, not replaced.
  const reply = await send({ type: 'dk.fix.set', pattern: text, fix: {}, ifAbsent: true });
  if (!reply?.ok) {
    say(t('opt.siteBad'));
    return;
  }
  await load();
  current = typeof reply.pattern === 'string' && fixes[reply.pattern] ? reply.pattern : null;
  renderList();
  show(current);
  input('fix-pattern').value = '';
}

async function pasteFix() {
  if (!(await flush())) return;
  const text = area('pasted').value;
  try {
    const data = JSON.parse(text);
    const pattern = typeof data?.host === 'string' ? data.host : '';
    if (pattern === '' || !data.fix || typeof data.fix !== 'object') throw new Error('shape');
    const reply = await send({ type: 'dk.fix.set', pattern, fix: data.fix });
    if (!reply?.ok) throw new Error('refused');
    await load();
    // The worker stores the fix under the normal form of the host, which the editor must show.
    const stored = normalizePattern(pattern);
    current = stored !== null && fixes[stored] ? stored : current;
    renderList();
    show(current);
    area('pasted').value = '';
    say(t('opt.saved'));
  } catch {
    say(t('fx.pasteBad'));
  }
}

/** Put a deleted fix back. A fix that was added again for the site meanwhile is kept. @param {string} pattern @param {any} fix */
async function restore(pattern, fix) {
  try {
    if (!(await flush())) throw new Error('busy');
    const reply = await send({ type: 'dk.fix.set', pattern, fix, ifAbsent: true });
    if (!reply?.ok) throw new Error('refused');
    await load();
    current = typeof reply.pattern === 'string' && fixes[reply.pattern] ? reply.pattern : null;
    renderList();
    show(current);
    $('fix-site').focus();
    say(reply.created === false ? t('opt.undoTaken') : t('opt.undone'));
  } catch {
    say(t('popup.saveError'));
  }
}

function wire() {
  select('fix-site').addEventListener('change', async () => {
    const want = select('fix-site').value;
    if (!(await flush())) {
      select('fix-site').value = current ?? '';
      return;
    }
    show(want);
  });
  select('mode').addEventListener('change', syncStyle);
  $('fix-add').addEventListener('click', () => void addPattern(input('fix-pattern').value));
  input('fix-pattern').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void addPattern(input('fix-pattern').value);
  });
  for (const id of ['note', 'engine', 'mode', 'einkPreset', ...Object.keys(NUMBERS), 'css', 'invert', 'ignoreInline', 'ignoreImage', 'ignoreCssUrl', 'notDark', ...Object.keys(STATIC)]) {
    $(id).addEventListener('input', schedule);
    $(id).addEventListener('change', schedule);
  }
  $('copy').addEventListener('click', async () => {
    if (current === null || !(await flush())) return;
    try {
      await navigator.clipboard.writeText(`${JSON.stringify({ host: current, fix: fixes[current] }, null, 2)}\n`);
      say(t('fx.copied'));
    } catch {
      say(t('popup.saveError'));
    }
  });
  confirmClick($('delete'), t('opt.deleteConfirm'), async () => {
    if (current === null) return;
    const pattern = current;
    // What the person sees now, also a change that is not stored yet, is what Undo brings back.
    const kept = structuredClone(dirty && validate() ? build() : fixes[pattern]);
    // The draft of a record that is being removed is dropped; a save in flight ends first so it cannot bring the record back.
    clearTimeout(timer);
    timer = undefined;
    dirty = false;
    edits += 1;
    await inflight;
    if (await save(pattern, null)) {
      current = null;
      renderList();
      show(Object.keys(fixes).sort()[0] ?? null);
      // Custom CSS that is still off came from an import or sync: a restored copy would turn it on without a review.
      if (kept.cssHeld === true) say(t('fx.deleted', { site: pattern }));
      else say(t('fx.deleted', { site: pattern }), { label: t('opt.undo'), focus: true, run: () => restore(pattern, kept) });
    } else {
      say(t('popup.saveError'));
    }
  }, { announce: (m) => say(m) });
  $('paste-apply').addEventListener('click', () => void pasteFix());
  addEventListener('pagehide', () => {
    if (dirty) void commit();
  });
}

async function start() {
  const i18n = await initI18n(undefined, { title: (t) => `${t('fixes.title')} - ${t('popup.title')}` });
  t = i18n.t;
  numbers = numberFormat(i18n.locale);
  say = createSay($('message'), t);
  showEngineHint = engineHints(select('engine'), t, $('engine-hint'));
  try {
    await load();
    wire();
    renderList();
    const wanted = new URLSearchParams(location.search).get('site');
    if (wanted) addIfMissing(wanted);
    show(current ?? Object.keys(fixes).sort()[0] ?? null);
  } catch {
    say(t('popup.error'));
  }
  document.body.removeAttribute('data-loading');
}

/** A site opened from the popup is shown at once, and is stored only when the person changes something. */
function addIfMissing(/** @type {string} */ site) {
  const key = site.trim().toLowerCase();
  if (!fixes[key]) fixes[key] = {};
  current = key;
  renderList();
}

void start();
