// @ts-check
// The color vision card: the controls that have no effect in the current mode are disabled, and a band of common colors shows
// the page colors, how a person with the chosen type sees them, the corrected colors and how the corrected colors are seen.
import { einkValues } from '../../shared/settings.js';

const COLORS = ['#d93025', '#f57c00', '#f9ab00', '#7cb342', '#188038', '#00897b', '#1a73e8', '#3f51b5', '#8e24aa', '#d81b60'];

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {string} hex */
const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
/** @param {number[]} rgb */
const css = (rgb) => `rgb(${rgb.map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255)).join(' ')})`;
const toLinear = (/** @type {number} */ v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (/** @type {number} */ v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** The filters that work in the original mode only. */
export const PLAIN = new Set(['grayscale', 'grayscaleInverted', 'inverted']);

/** True when the mode has no color to correct: E-ink with no color. @param {any} theme */
export function noColor(theme) {
  return theme?.mode === 'eink' && einkValues(theme).einkColorAmount === 0;
}

// The Intensity and Color boost of a new setting.
const RESET = Object.freeze({ cvdSeverity: 100, cvdBoost: 50 });
const DEFICIENCY = new Set(['protan', 'deutan', 'tritan']);

/** @param {{ theme: () => any, queue: (patch: Record<string, any>, now?: boolean) => void, changed: () => void }} deps */
export function mountColorVision({ theme, queue, changed }) {
  /** @type {any} */
  let cvd = null;
  const rows = /** @type {Record<string, HTMLElement>} */ ({});
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#cvdPreview .cvd-row'))) {
    const band = /** @type {HTMLElement} */ (row.querySelector('.cvd-band'));
    band.replaceChildren(...COLORS.map(() => document.createElement('span')));
    rows[/** @type {string} */ (row.dataset.row)] = row;
  }

  /** @param {string} name @param {number[][]} colors */
  function paint(name, colors) {
    const cells = /** @type {HTMLElement[]} */ ([...rows[name].querySelectorAll('.cvd-band > span')]);
    cells.forEach((cell, i) => {
      cell.style.background = css(colors[i]);
    });
  }

  // One switch for link underlines: in E-ink and Paper it is the style's own `einkLinks`, in the other modes `linkUnderline`.
  const underline = /** @type {HTMLInputElement} */ ($('linkUnderline'));
  underline.addEventListener('change', () => {
    const eink = theme()?.mode === 'eink';
    queue({ theme: eink ? { einkLinks: underline.checked } : { linkUnderline: underline.checked } });
  });

  function render() {
    const t = theme() ?? {};
    underline.checked = t.mode === 'eink' ? einkValues(t).einkLinks === true : t.linkUnderline === true;
    const off = noColor(t);
    const type = /** @type {HTMLSelectElement} */ ($('cvdType'));
    const severity = /** @type {HTMLInputElement} */ ($('cvdSeverity'));
    type.disabled = off;
    const original = t.mode === 'original';
    for (const option of type.options) option.disabled = PLAIN.has(option.value) && !original;
    // A plain filter chosen in another mode stays stored and does nothing until the mode is Original.
    const idle = PLAIN.has(t.cvdType) && !original;
    $('cvdOriginalOnly').hidden = !idle && original;
    const none = !t.cvdType || t.cvdType === 'none';
    // The stored value stays, so going back to Original brings the filter back as it was.
    severity.disabled = off || none || idle;
    const why = off ? 'cvdNoColor' : idle ? 'cvdOriginalOnly' : '';
    if (why) severity.setAttribute('aria-describedby', why);
    else severity.removeAttribute('aria-describedby');
    const boost = /** @type {HTMLInputElement} */ ($('cvdBoost'));
    // The boost moves the colors of a deficiency only; a plain filter has none.
    boost.disabled = off || !DEFICIENCY.has(t.cvdType);
    $('cvdBoostItem').hidden = !none && !DEFICIENCY.has(t.cvdType);
    $('cvdNoColor').hidden = !off;
    const base = COLORS.map(parse);
    paint('page', base);
    const m = !off && !idle && cvd ? cvd.matrices(t.cvdType, Number.isFinite(t.cvdSeverity) ? t.cvdSeverity : 100, t.cvdBoost) : null;
    rows.corrected.hidden = !m;
    // A plain filter has no model of what a person sees.
    for (const name of ['seen', 'correctedSeen']) rows[name].hidden = !m?.simulate;
    if (!m) return;
    const corrected = base.map((rgb) => cvd.run(m, rgb));
    paint('corrected', corrected);
    if (!m.simulate) return;
    const seen = (/** @type {number[]} */ rgb) => cvd.apply(m.simulate, rgb.map(toLinear)).map((/** @type {number} */ v) => toGamma(Math.min(Math.max(v, 0), 1)));
    paint('seen', base.map(seen));
    paint('correctedSeen', corrected.map(seen));
  }

  // The model is the one the pages use. It is a classic script that needs the shared namespace before it runs.
  const dk = /** @type {any} */ (globalThis);
  dk.__dk ??= {};
  // @ts-ignore The file is a classic script with no exports; importing it runs it once.
  import('../../content/engine/cvd.js')
    .then(() => {
      cvd = dk.__dk.cvd ?? null;
      render();
    })
    .catch(() => undefined);

  $('cvdReset').addEventListener('click', () => {
    queue({ theme: { ...RESET } }, true);
    changed();
  });

  return { render };
}
