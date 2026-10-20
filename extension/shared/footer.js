// @ts-check
import { h, icon, openUrl } from './dom.js';
import { FOOTER } from './footer-config.js';
import { roving } from './widgets.js';

/**
 * Text of one footer item. One literal key per line so the key check can see each of them.
 * @param {string} id
 * @param {(key: string) => string} t
 */
function copy(id, t) {
  switch (id) {
    case 'about':
      return { label: t('footer.about'), message: t('footer.aboutCopy'), cta: t('footer.aboutCta') };
    case 'github':
      return { label: t('footer.github'), message: t('footer.githubCopy'), cta: t('footer.githubCta') };
    case 'rate':
      return { label: t('footer.rate'), message: t('footer.rateCopy'), cta: t('footer.rateCta') };
    default:
      return { label: t('footer.support'), message: t('footer.supportCopy'), cta: t('footer.supportCta') };
  }
}

/**
 * A strip with a message and one button, and a tab for each item. It moves to the next item on its own
 * until the pointer or the keyboard is on it, a tab is chosen, or the system asks for less motion.
 * Items without an address are left out.
 * @param {{ root: HTMLElement, t: (key: string) => string }} options
 */
export function mountFooter({ root, t }) {
  const items = FOOTER.items.map((item) => ({ id: item.id, url: item.url() })).filter((item) => item.url !== '');
  root.replaceChildren();
  if (items.length === 0) {
    root.hidden = true;
    return;
  }
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let rotating = items.length > 1 && !reduce.matches;
  let active = 0;

  const message = h('span', { class: 'footer-message' });
  const cta = h('button', { class: 'btn btn-primary btn-sm footer-cta', type: 'button', id: 'footer-cta' });
  cta.addEventListener('click', () => openUrl(items[active].url));
  const panel = h('div', { class: 'footer-panel', role: 'tabpanel', id: 'footer-panel' }, h('p', { class: 'footer-text' }, message), cta);

  const tabs = items.map((item) => {
    const bar = h('span', { class: 'footer-bar' });
    const name = h('span', { class: 'footer-name' });
    const tab = h('button', { class: 'footer-tab', type: 'button', role: 'tab', id: `footer-tab-${item.id}`, 'aria-controls': 'footer-panel' }, name, bar);
    bar.addEventListener('animationend', () => {
      const next = (active + 1) % items.length;
      // After one round the footer stays on the first item: text that changes by itself without end cannot be read in peace.
      if (next === 0) rotating = false;
      go(next, false);
    });
    return { tab, name };
  });
  const list = h('div', { class: 'footer-tabs', role: 'tablist' }, ...tabs.map((x) => x.tab));
  list.style.setProperty('--footer-cols', String(items.length));
  list.style.setProperty('--footer-ms', `${FOOTER.rotateEveryMs}ms`);
  // The control that stops the moving text (WCAG 2.2.2): shown while the footer moves or is paused, gone when nothing moves.
  let paused = false;
  const pause = h('button', { class: 'footer-pause', type: 'button', 'aria-pressed': 'false', 'aria-label': t('footer.pause'), title: t('footer.pause') });
  const pauseIcon = () => pause.replaceChildren(icon(paused ? 'play' : 'pause', 14));
  pauseIcon();
  const syncPause = () => {
    pause.hidden = !(rotating || paused);
  };
  pause.addEventListener('click', () => {
    paused = !paused;
    rotating = !paused;
    pause.setAttribute('aria-pressed', String(paused));
    pauseIcon();
    go(active, false);
  });
  const strip = h('div', { class: 'footer-strip' }, list, pause);
  const shell = h('div', { class: 'footer' }, panel);
  if (items.length > 1) shell.append(strip);
  root.append(shell);
  root.hidden = false;

  /** @param {number} index @param {boolean} byUser */
  function go(index, byUser) {
    if (byUser) {
      rotating = false;
      paused = false;
      pause.setAttribute('aria-pressed', 'false');
      pauseIcon();
    }
    active = index;
    const text = copy(items[index].id, t);
    // A line in another script is isolated, so its full stop stays at its own end in a right-to-left page.
    message.replaceChildren(h('bdi', { text: text.message }));
    cta.textContent = text.cta;
    panel.setAttribute('aria-labelledby', `footer-tab-${items[index].id}`);
    tabs.forEach((x, i) => {
      x.name.textContent = copy(items[i].id, t).label;
      x.tab.setAttribute('aria-selected', String(i === index));
      x.tab.tabIndex = i === index ? 0 : -1;
    });
    shell.classList.toggle('is-rotating', rotating);
    syncPause();
  }

  tabs.forEach((x, i) => x.tab.addEventListener('click', () => go(i, true)));
  roving(tabs.map((x) => x.tab), (tab) => go(tabs.findIndex((x) => x.tab === tab), true));
  reduce.addEventListener('change', () => {
    if (reduce.matches) {
      rotating = false;
      paused = false;
      shell.classList.remove('is-rotating');
      syncPause();
    }
  });
  go(0, false);
}
