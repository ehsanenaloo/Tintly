// @ts-check
// The E-ink and Paper section of the settings page. Every control shows the value in force (what the person set, or the
// value of the style) and writes a value of its own when it changes. A style change and the reset button put every field
// back to "the value of the style".
import { EINK_RESET, einkValues } from '../../shared/settings.js';
import { L } from '../../shared/limits.js';
import { syncRange } from '../../shared/widgets.js';

const RANGES = /** @type {Record<string, { min: number, max: number }>} */ ({
  whiteCap: L.WHITE_CAP,
  einkBlue: L.EINK_BLUE,
  einkColorAmount: L.EINK_COLOR,
  einkContrast: L.EINK_CONTRAST,
  einkImageContrast: L.IMAGE_CONTRAST,
  einkWeight: L.EINK_WEIGHT,
});
const BUILT_IN_FONTS = ['keep', 'serif', 'sans'];

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ ($(id));
const select = (/** @type {string} */ id) => /** @type {HTMLSelectElement} */ ($(id));

/**
 * @param {{ theme: () => any, queue: (patch: Record<string, any>, immediate?: boolean) => void, numbers: () => Intl.NumberFormat }} deps
 */
export function mountEink({ theme, queue, numbers }) {
  const controls = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-eink]')]);

  function showOutput(/** @type {HTMLInputElement} */ el) {
    const out = document.querySelector(`output[for="${el.id}"]`);
    if (out) out.textContent = numbers().format(Number(el.value));
    syncRange(el);
  }

  /** @param {boolean} [force] show every control, also the one that has the focus (after a button put the values back) */
  function render(force = false) {
    const values = einkValues(theme());
    select('einkPreset').value = values.preset;
    for (const el of controls) {
      if (!force && el === document.activeElement) continue;
      const key = /** @type {string} */ (el.dataset.eink);
      const value = values[key];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = value === true;
      else if (el instanceof HTMLInputElement && el.type === 'range') {
        el.min = String(RANGES[key].min);
        el.max = String(RANGES[key].max);
        el.value = String(value);
        showOutput(el);
      } else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = String(value);
    }
    for (const swatch of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.swatch'))) {
      swatch.setAttribute('aria-pressed', String(String(values.paperColor).toLowerCase() === swatch.dataset.color));
    }
    const font = String(values.einkFont);
    const custom = !BUILT_IN_FONTS.includes(font);
    if (force || select('einkFont') !== document.activeElement) select('einkFont').value = custom ? 'custom' : font;
    if ((force || input('einkFontName') !== document.activeElement) && custom) input('einkFontName').value = font;
    $('einkFontNameRow').hidden = select('einkFont').value !== 'custom';
  }

  /** @param {HTMLElement} el */
  function read(el) {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked;
    if (el instanceof HTMLInputElement && el.type === 'range') return Number(el.value);
    if (el instanceof HTMLSelectElement && el.dataset.type === 'int') return Number(el.value);
    return /** @type {HTMLInputElement | HTMLSelectElement} */ (el).value;
  }

  for (const el of controls) {
    const type = el instanceof HTMLInputElement ? el.type : '';
    el.addEventListener(type === 'range' || type === 'color' ? 'input' : 'change', () => {
      if (el instanceof HTMLInputElement && el.type === 'range') showOutput(el);
      const key = /** @type {string} */ (el.dataset.eink);
      // The amount replaces the old two words, so the old one is cleared.
      queue({ theme: { [key]: read(el), ...(key === 'einkColorAmount' ? { einkColor: null } : {}) } });
    });
  }

  select('einkPreset').addEventListener('change', () => {
    queue({ theme: { einkPreset: select('einkPreset').value, ...EINK_RESET } }, true);
    render(true);
  });

  for (const swatch of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.swatch'))) {
    swatch.style.setProperty('--swatch', /** @type {string} */ (swatch.dataset.color));
    swatch.addEventListener('click', () => {
      queue({ theme: { paperColor: swatch.dataset.color } }, true);
      render(true);
    });
  }

  select('einkFont').addEventListener('change', () => {
    const choice = select('einkFont').value;
    $('einkFontNameRow').hidden = choice !== 'custom';
    if (choice !== 'custom') queue({ theme: { einkFont: choice } });
    else if (input('einkFontName').value.trim() !== '') queue({ theme: { einkFont: input('einkFontName').value.trim() } });
  });
  input('einkFontName').addEventListener('input', () => {
    const name = input('einkFontName').value.trim();
    if (name !== '' && select('einkFont').value === 'custom') queue({ theme: { einkFont: name } });
  });

  $('einkReset').addEventListener('click', () => {
    queue({ theme: { ...EINK_RESET } }, true);
    render(true);
  });

  return { render: () => render() };
}
