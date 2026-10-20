// @ts-check
import { h, icon } from './dom.js';

/**
 * The overflow menu: a list of actions.
 * @param {{
 *   trigger: HTMLElement,
 *   menu: HTMLElement,
 *   items: Array<{ id: string, icon: string, label: string, run: () => void }>,
 * }} options
 */
export function mountMenu({ trigger, menu, items }) {
  menu.replaceChildren();

  const close = (/** @type {boolean} */ refocus) => {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) trigger.focus();
  };
  /** @param {Event} e */
  const outside = (e) => {
    if (!menu.contains(/** @type {Node} */ (e.target)) && !trigger.contains(/** @type {Node} */ (e.target))) close(false);
  };

  for (const item of items) {
    menu.append(
      h('button', { class: 'menu-item', type: 'button', role: 'menuitem', id: `menu-${item.id}`, on: { click: () => { close(false); item.run(); } } }, icon(item.icon, 18), h('span', { text: item.label })),
    );
  }

  const focusables = () => /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]);
  menu.addEventListener('keydown', (event) => {
    const e = /** @type {KeyboardEvent} */ (event);
    const all = focusables();
    const at = all.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      all[e.key === 'Home' ? 0 : all.length - 1].focus();
    }
  });

  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const open = () => {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    focusables()[0]?.focus();
  };
  trigger.addEventListener('click', () => {
    if (!menu.hidden) {
      close(true);
      return;
    }
    open();
  });
  // A menu button also opens with the arrow that points into the menu.
  trigger.addEventListener('keydown', (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'ArrowDown' && menu.hidden) {
      event.preventDefault();
      open();
    }
  });
  return { close: () => close(false) };
}
