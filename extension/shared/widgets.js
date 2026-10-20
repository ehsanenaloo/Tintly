// @ts-check

/** Paint the filled part of a slider. The track reads `--pct`. @param {HTMLInputElement} el */
export function syncRange(el) {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--pct', `${Math.min(100, Math.max(0, pct))}%`);
}

/**
 * Move through a set of buttons with the arrow keys and keep one of them in the tab order.
 * @param {HTMLElement[]} items
 * @param {(item: HTMLElement) => void} choose called when an arrow key, Home or End picks an item
 */
export function roving(items, choose) {
  const rtl = () => document.documentElement.dir === 'rtl';
  for (const item of items) {
    item.addEventListener('keydown', (event) => {
      const e = /** @type {KeyboardEvent} */ (event);
      const at = items.indexOf(item);
      let next = -1;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else if (e.key === 'ArrowDown') next = (at + 1) % items.length;
      else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const forward = (e.key === 'ArrowRight') !== rtl();
        next = (at + (forward ? 1 : -1) + items.length) % items.length;
      }
      if (next < 0) return;
      e.preventDefault();
      items[next].focus();
      choose(items[next]);
    });
  }
}

/**
 * A group of buttons where one is selected (`role="radiogroup"` with `role="radio"` buttons).
 * @param {HTMLElement} group
 * @param {(value: string) => void} onChange
 */
export function radioGroup(group, onChange) {
  const items = /** @type {HTMLElement[]} */ ([...group.querySelectorAll('[role="radio"]')]);
  const slide = group.classList.contains('seg-slide');
  if (slide) group.style.setProperty('--seg-n', String(items.length));
  const select = (/** @type {string} */ value) => {
    items.forEach((item, index) => {
      const on = item.dataset.value === value;
      item.setAttribute('aria-checked', String(on));
      item.tabIndex = on ? 0 : -1;
      if (on && slide) group.style.setProperty('--seg-i', String(index));
    });
    // The first placement must not slide in from the start.
    if (slide && !group.hasAttribute('data-anim')) requestAnimationFrame(() => requestAnimationFrame(() => group.setAttribute('data-anim', '')));
  };
  for (const item of items) item.addEventListener('click', () => {
    select(/** @type {string} */ (item.dataset.value));
    onChange(/** @type {string} */ (item.dataset.value));
  });
  roving(items, (item) => {
    select(/** @type {string} */ (item.dataset.value));
    onChange(/** @type {string} */ (item.dataset.value));
  });
  return { select };
}

/**
 * Tabs with one panel each. Arrow keys move and activate; the selected tab alone is in the tab order.
 * @param {HTMLElement[]} tabs buttons with `role="tab"` and `aria-controls`
 * @param {(tab: HTMLElement) => void} onSelect
 */
export function tabList(tabs, onSelect) {
  const select = (/** @type {HTMLElement} */ tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(/** @type {string} */ (t.getAttribute('aria-controls')));
      if (panel) panel.hidden = !on;
    }
    onSelect(tab);
  };
  for (const tab of tabs) tab.addEventListener('click', () => select(tab));
  roving(tabs, select);
  return { select };
}

/**
 * A short hint for the engine select: written under the select when there is an element for it, and always set as its tooltip.
 * Call the returned function after the value was set from code.
 * @param {HTMLSelectElement} select
 * @param {(key: string) => string} t
 * @param {HTMLElement | null} [out]
 */
export function engineHints(select, t, out = null) {
  /** @param {string} value */
  const hint = (value) => {
    switch (value) {
      case 'auto':
        return t('engine.hintAuto');
      case 'dynamic':
        return t('engine.hintDynamic');
      case 'filter':
        return t('engine.hintFilter');
      case 'filterPlus':
        return t('engine.hintFilterPlus');
      case 'static':
        return t('engine.hintStatic');
      default:
        return '';
    }
  };
  const show = () => {
    const text = hint(select.value);
    if (out) out.textContent = text;
    select.title = text;
  };
  select.addEventListener('change', show);
  show();
  return show;
}

/**
 * A button that needs a second press to act: the first press changes its text to `armedText` (and says it through `announce`),
 * the second runs `run`. Moving focus away or waiting disarms it again.
 * @param {HTMLElement} button
 * @param {string} armedText
 * @param {() => void | Promise<unknown>} run
 * @param {{ announce?: (text: string) => void, ms?: number }} [options]
 */
export function confirmClick(button, armedText, run, { announce, ms = 5000 } = {}) {
  const idleText = button.textContent ?? '';
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const disarm = () => {
    clearTimeout(timer);
    delete button.dataset.armed;
    button.textContent = idleText;
  };
  button.addEventListener('click', () => {
    if (button.dataset.armed === undefined) {
      button.dataset.armed = '1';
      button.textContent = armedText;
      announce?.(armedText);
      timer = setTimeout(disarm, ms);
      return;
    }
    disarm();
    void run();
  });
  button.addEventListener('blur', disarm);
}
