// @ts-check
// The palette pickers of the settings page (Appearance, Colors). One radio group for the dark mode and one for the light
// mode. Each entry shows its own two colors. The chosen entry comes from the color fields, so a color edited by hand
// moves the choice to Custom without any extra work here.
import { CUSTOM, palettesFor, paletteIdFor, paletteFields } from '../../shared/palettes.js';

/** @typedef {'dark' | 'light'} Kind */

const GROUPS = /** @type {const} */ ([
  { kind: 'dark', id: 'paletteDark', background: 'darkBackground', text: 'darkText' },
  { kind: 'light', id: 'paletteLight', background: 'lightBackground', text: 'lightText' },
]);

/**
 * @param {{ theme: () => any, queue: (patch: Record<string, any>, immediate?: boolean) => void, t: (key: string) => string, changed: () => void }} deps
 */
export function mountPalettes({ theme, queue, t, changed }) {
  const names = () => ({
    Default: t('pal.default'),
    Graphite: t('pal.graphite'),
    AMOLED: t('pal.amoled'),
    Midnight: t('pal.midnight'),
    Solarized: t('pal.solarized'),
    Nord: t('pal.nord'),
    Gruvbox: t('pal.gruvbox'),
    WarmPaper: t('pal.warmPaper'),
    CoolGray: t('pal.coolGray'),
    HighContrast: t('pal.highContrast'),
    [CUSTOM]: t('pal.custom'),
  });

  /** @param {HTMLElement} group @param {{ kind: Kind }} spec */
  function build(group, spec) {
    const label = /** @type {Record<string, string>} */ (names());
    group.textContent = '';
    for (const p of [...palettesFor(spec.kind), { id: CUSTOM, background: '#808080', text: '#ffffff' }]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', 'false');
      button.dataset.id = p.id;
      const swatch = document.createElement('span');
      swatch.className = 'palette-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      swatch.style.setProperty('--pal-bg', p.background);
      swatch.style.setProperty('--pal-fg', p.text);
      swatch.textContent = 'Aa';
      swatch.dir = 'ltr';
      const name = document.createElement('span');
      name.className = 'palette-name';
      name.textContent = label[p.id] ?? p.id;
      button.append(swatch, name);
      if (p.id === CUSTOM) button.hidden = true;
      group.append(button);
    }
  }

  /** @param {Kind} kind @param {string} id */
  function choose(kind, id) {
    const fields = paletteFields(kind, id);
    if (!fields) return;
    queue({ theme: fields }, true);
    render();
    changed();
  }

  for (const spec of GROUPS) {
    const group = /** @type {HTMLElement} */ (document.getElementById(spec.id));
    group.addEventListener('click', (event) => {
      const button = /** @type {HTMLElement | null} */ ((/** @type {HTMLElement} */ (event.target)).closest('.palette'));
      if (button?.dataset.id) choose(spec.kind, button.dataset.id);
    });
    group.addEventListener('keydown', (event) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      const buttons = /** @type {HTMLElement[]} */ ([...group.querySelectorAll('.palette')]).filter((b) => !b.hidden);
      const at = buttons.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (at < 0) return;
      const rtl = getComputedStyle(group).direction === 'rtl';
      let to = at;
      if (event.key === 'Home') to = 0;
      else if (event.key === 'End') to = buttons.length - 1;
      else {
        const forward = event.key === 'ArrowDown' || event.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
        to = (at + (forward ? 1 : -1) + buttons.length) % buttons.length;
      }
      event.preventDefault();
      buttons[to].focus();
      const id = buttons[to].dataset.id;
      if (id && id !== CUSTOM) choose(spec.kind, id);
    });
  }

  /** Rebuild the names (the language may have changed) and show the choice. */
  function render() {
    const current = theme();
    for (const spec of GROUPS) {
      const group = /** @type {HTMLElement} */ (document.getElementById(spec.id));
      if (group.childElementCount === 0 || group.dataset.names !== t('pal.default')) {
        build(group, spec);
        group.dataset.names = t('pal.default');
      }
      const active = paletteIdFor(spec.kind, current?.[spec.background], current?.[spec.text]);
      const buttons = /** @type {HTMLElement[]} */ ([...group.querySelectorAll('.palette')]);
      for (const b of buttons) {
        const on = b.dataset.id === active;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        if (b.dataset.id === CUSTOM) b.hidden = !on;
      }
    }
  }

  return { render };
}
