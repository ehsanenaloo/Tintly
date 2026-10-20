// @ts-check
import { REPO_URL, storeReviewUrl } from './store-link.js';

/**
 * Every outside link of the interface. An empty address hides the item that uses it.
 * The review page is built at run time from the manifest (see store-link.js).
 */
export const LINKS = Object.freeze(/** @type {{ site: string, help: string, support: string, github: string }} */ ({
  site: 'https://www.enaloo.com',
  help: 'https://enaloo.com/apps/tintly/',
  support: 'https://buymeacoffee.com/enaloo',
  github: REPO_URL,
}));

let installType = '';

/** Learn how this copy was installed. Call once before the footer is built; it needs no permission and may fail. */
export async function loadInstallType() {
  try {
    const self = await chrome.management.getSelf();
    installType = typeof self?.installType === 'string' ? self.installType : '';
  } catch {
    installType = '';
  }
}

/** The store page for a review, or the public repository for a copy that is not from a store. */
export function reviewUrl() {
  return storeReviewUrl({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest(), userAgent: navigator.userAgent, installType });
}

/** Rotating footer: the items in order, and how long each one stays. */
export const FOOTER = Object.freeze({
  rotateEveryMs: 6000,
  items: Object.freeze([
    Object.freeze({ id: 'about', url: () => LINKS.site }),
    Object.freeze({ id: 'github', url: () => LINKS.github }),
    Object.freeze({ id: 'rate', url: reviewUrl }),
    Object.freeze({ id: 'support', url: () => LINKS.support }),
  ]),
});

/** Support reminder timing, in days. The first one comes after the grace period; then at most one per interval. */
export const NUDGE = Object.freeze({ initialDelayDays: 14, intervalDays: 30 });
