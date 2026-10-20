// @ts-check
import { h, icon, openUrl } from './dom.js';
import { LINKS, reviewUrl } from './footer-config.js';
import { feedbackUrl, thisBrowser } from './site-pages.js';

/**
 * The About content: name and version, what the extension is, the privacy statement, links and the support card.
 * Used inside the dialog of the toolbar window and as the About tab of the settings page.
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 */
export function buildAbout(t) {
  const version = chrome.runtime.getManifest().version;
  const browser = thisBrowser();
  const facts = { version, browser: browser.name, major: browser.major };
  /** @param {string} name @param {string} text @param {string} url */
  const link = (name, text, url) =>
    url === ''
      ? null
      : h('li', {}, h('button', { class: 'link-row', type: 'button', id: `about-${name}`, on: { click: () => openUrl(url) } }, h('span', { text }), icon('external', 15)));
  const links = [
    link('site', t('about.website'), LINKS.site),
    link('help', t('menu.help'), LINKS.help),
    link('bug', t('about.reportBug'), feedbackUrl('bug', facts)),
    link('feature', t('about.suggestFeature'), feedbackUrl('feature', facts)),
    link('github', t('footer.github'), LINKS.github),
    link('rate', t('footer.rateCta'), reviewUrl()),
  ].filter((x) => x !== null);

  const support = LINKS.support === ''
    ? null
    : h('section', { class: 'about-support' },
        h('strong', { text: t('about.supportTitle') }),
        h('p', { text: t('about.supportCopy') }),
        h('button', { class: 'btn btn-primary', type: 'button', id: 'about-support', on: { click: () => openUrl(LINKS.support) } }, icon('heart', 16), t('about.supportCta')));

  return h('div', { class: 'about' },
    h('div', { class: 'about-head' },
      h('img', { class: 'about-mark', src: new URL('../icons/icon-128.png', import.meta.url).href, width: 56, height: 56, alt: '' }),
      h('div', {}, h('h3', { class: 'about-name', text: t('popup.title') }), h('p', { class: 'about-version', id: 'version', dir: 'ltr', text: t('opt.version', { version }) }))),
    h('p', { class: 'about-tagline', text: t('about.tagline') }),
    h('section', { class: 'about-privacy' },
      h('div', { class: 'about-privacy-title' }, icon('shield', 16), h('strong', { text: t('about.privacyTitle') })),
      h('p', { text: t('opt.privacy') })),
    links.length ? h('ul', { class: 'link-list' }, ...links) : null,
    support,
    h('p', { class: 'about-legal' }, h('bdi', { text: t('about.legal') })),
  );
}

/**
 * Fill a `<dialog>` with the About content and open it as a modal.
 * The browser keeps focus inside and closes it on Escape.
 * @param {HTMLDialogElement} dialog
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 */
export function openAbout(dialog, t) {
  const close = h('button', { class: 'icon-btn dialog-close', type: 'button', id: 'about-close', 'aria-label': t('nudge.close'), title: t('nudge.close'), on: { click: () => dialog.close() } }, icon('close', 18));
  dialog.replaceChildren(close, buildAbout(t));
  dialog.setAttribute('aria-label', t('menu.about'));
  if (!dialog.open) dialog.showModal();
  close.focus();
}
