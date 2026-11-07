// @ts-check
// The small "i" buttons of the toolbar window and the settings page: a click shows a short text over the page. One text at a time.

const MARGIN = 8;
const GAP = 6;
const REOPEN_MS = 300;

/** @param {() => (key: string) => string} words the translator of the page, read at each click */
export function mountInfo(words) {
  const tip = document.createElement('div');
  tip.className = 'info-tip';
  tip.popover = 'auto';
  tip.setAttribute('role', 'status');
  document.body.append(tip);
  /** @type {HTMLElement | null} */
  let owner = null;
  /** @type {HTMLElement | null} */
  let closed = null;
  let closedAt = 0;

  tip.addEventListener('beforetoggle', (e) => {
    if (/** @type {ToggleEvent} */ (e).newState !== 'closed') return;
    owner?.setAttribute('aria-expanded', 'false');
    closed = owner;
    closedAt = performance.now();
    owner = null;
  });

  /** @param {HTMLElement} button */
  function open(button) {
    tip.textContent = words()(button.dataset.i18nInfo ?? '');
    tip.showPopover();
    owner = button;
    button.setAttribute('aria-expanded', 'true');
    const at = button.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const left = Math.min(innerWidth - box.width - MARGIN, Math.max(MARGIN, at.left + at.width / 2 - box.width / 2));
    const below = at.bottom + GAP + box.height + MARGIN <= innerHeight;
    tip.style.left = `${Math.max(MARGIN, left)}px`;
    tip.style.top = `${Math.max(MARGIN, below ? at.bottom + GAP : at.top - GAP - box.height)}px`;
  }

  document.addEventListener('click', (e) => {
    const button = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.('.info-btn'));
    if (!button) return;
    e.preventDefault();
    if (owner === button) tip.hidePopover();
    // The press outside already closed the text of this button: this click must not open it again.
    else if (closed !== button || performance.now() - closedAt > REOPEN_MS) open(button);
  });
}
