// @ts-check
import { h, icon, openUrl } from './dom.js';
import { LINKS, NUDGE, reviewUrl } from './footer-config.js';

const DAY_MS = 86_400_000;

/**
 * The support reminder state kept in `ui.support`. `installedAt` is 0 until the first time a page asks.
 * @typedef {{ installedAt: number, lastShownAt: number, shownCount: number, optOut: boolean }} SupportState
 */

/**
 * Is it time to show the reminder? Never without a support address, after an opt-out, or before the grace period ends.
 * @param {SupportState} support
 * @param {number} now
 */
export function nudgeDue(support, now) {
  if (LINKS.support === '' || support.optOut || support.installedAt === 0) return false;
  if (support.lastShownAt === 0) return now >= support.installedAt + NUDGE.initialDelayDays * DAY_MS;
  return now - support.lastShownAt >= NUDGE.intervalDays * DAY_MS;
}

/**
 * Show the reminder in `mount` when it is due. The first call only records the install time, so a new
 * user gets the whole grace period. Showing it starts the interval, so it comes back at most once a month.
 * @param {{
 *   support: SupportState,
 *   mount: HTMLElement,
 *   cover?: HTMLElement[],
 *   t: (key: string) => string,
 *   save: (support: SupportState) => Promise<unknown>,
 *   now?: number,
 * }} options
 */
export async function runNudge({ support, mount, cover = [], t, save, now = Date.now() }) {
  mount.replaceChildren();
  if (support.installedAt === 0) {
    await save({ ...support, installedAt: now });
    return;
  }
  if (!nudgeDue(support, now)) return;
  const shown = { ...support, lastShownAt: now, shownCount: support.shownCount + 1 };
  await save(shown);

  // What the reminder floats over cannot be reached while it shows, so the keyboard never lands on a hidden control.
  const setCovered = (/** @type {boolean} */ on) => cover.forEach((el) => el.toggleAttribute('inert', on));
  const close = () => {
    mount.replaceChildren();
    setCovered(false);
  };
  const x = h('button', { class: 'icon-btn nudge-x', type: 'button', 'aria-label': t('nudge.close'), title: t('nudge.close') }, icon('close', 16));
  x.addEventListener('click', close);
  const give = h('button', { class: 'btn btn-primary btn-sm', type: 'button', id: 'nudge-support' }, icon('coffee', 15), t('nudge.support'));
  give.addEventListener('click', () => {
    openUrl(LINKS.support);
    close();
  });
  const actions = h('div', { class: 'nudge-actions' }, give);
  const review = reviewUrl();
  if (review !== '') {
    const rate = h('button', { class: 'btn btn-sm', type: 'button', id: 'nudge-rate' }, icon('star', 15), t('nudge.rate'));
    rate.addEventListener('click', () => {
      openUrl(review);
      close();
    });
    actions.append(rate);
  }
  const later = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', id: 'nudge-later' }, t('nudge.later'));
  later.addEventListener('click', close);
  const never = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', id: 'nudge-never' }, t('nudge.never'));
  never.addEventListener('click', () => {
    void save({ ...shown, optOut: true });
    close();
  });
  actions.append(later, never);

  const card = h('section', { class: 'nudge', id: 'nudge', 'aria-labelledby': 'nudge-title' },
      x,
      h('div', { class: 'nudge-head' }, h('span', { class: 'nudge-badge' }, icon('coffee', 16)), h('strong', { id: 'nudge-title', text: t('nudge.title') })),
      h('p', { class: 'nudge-copy', text: t('nudge.copy') }),
      actions);
  card.addEventListener('keydown', (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Escape') close();
  });
  setCovered(true);
  mount.append(card);
}
