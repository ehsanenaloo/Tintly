// @ts-check
import { h, icon } from './dom.js';
import { radioGroup } from './widgets.js';

/**
 * Three icon buttons for the look of the extension pages: same as the system, light, dark.
 * The group fills `mount`; the caller applies and saves the choice.
 * @param {{
 *   mount: HTMLElement,
 *   t: (key: string) => string,
 *   theme: string,
 *   onTheme: (value: 'system' | 'light' | 'dark') => void,
 * }} options
 */
export function mountThemeSwitch({ mount, t, theme, onTheme }) {
  /** @type {Array<{ value: 'system' | 'light' | 'dark', icon: string, label: string }>} */
  const looks = [
    { value: 'system', icon: 'monitor', label: t('menu.themeSystem') },
    { value: 'light', icon: 'sun', label: t('menu.themeLight') },
    { value: 'dark', icon: 'moon', label: t('menu.themeDark') },
  ];
  const group = h('div', { class: 'seg seg-slide seg-icons', role: 'radiogroup', id: 'uiThemeSwitch', 'aria-label': t('menu.theme') },
    ...looks.map((look) =>
      h('button', { type: 'button', role: 'radio', id: `theme-${look.value}`, 'aria-checked': 'false', 'aria-label': look.label, title: look.label, data: { value: look.value } }, icon(look.icon, 15)),
    ),
  );
  mount.replaceChildren(group);
  const api = radioGroup(group, (value) => onTheme(/** @type {'system' | 'light' | 'dark'} */ (value)));
  api.select(theme);
  document.addEventListener('dk-uitheme', (event) => api.select(/** @type {CustomEvent<string>} */ (event).detail));
  return api;
}
