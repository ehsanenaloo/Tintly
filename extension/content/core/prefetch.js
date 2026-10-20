// @ts-check
// Starts reading the stored settings as the very first thing, before the engine files are even parsed,
// so the answer is ready as soon as the gate asks for it.
(() => {
  'use strict';
  const dk = /** @type {Record<string, any> | undefined} */ (globalThis.__dk);
  if (!dk || dk.stored) return;
  dk.startedAt = performance.now();
  // A script that starts while the document is still loading was injected at document_start. One that starts later
  // was injected into a page that is already shown, and that page must not be hidden.
  dk.initialReadyState = document.readyState;
  /** The bucket of a host: the last two labels (the twin of `bucketOf` in the worker's gate.js; a test keeps them equal). @param {string} host */
  dk.bucketOf = (host) => {
    let h = String(host).toLowerCase().replace(/:\d+$/, '');
    if (h.startsWith('*.')) h = h.slice(2);
    const labels = h.split('.');
    return labels.length <= 2 ? h : labels.slice(-2).join('.');
  };
  try {
    // The settings and the slice of the site data for this host, which the worker keeps in keys of their own; the gate reads the whole data only when that copy is missing or behind.
    const web = location.protocol === 'http:' || location.protocol === 'https:';
    dk.storedKey = web ? `gb:${dk.bucketOf(location.host)}` : '';
    dk.stored = chrome.storage.local.get(web ? ['settings', 'updatedAt', 'gb.meta', dk.storedKey] : ['settings', 'updatedAt', 'gb.meta']);
    // The gate awaits it; this keeps a failed read from being reported as unhandled.
    /** @type {Promise<unknown>} */ (dk.stored).catch(() => {});
    // A change that lands between this read and the gate's own listener would be lost, so it is noted here and the gate reads again.
    dk.changedSince = false;
    const note = (/** @type {Record<string, unknown>} */ changes, /** @type {string} */ area) => {
      if (area === 'local' && ['settings', 'siteRules', 'userFixes', 'darkSites', 'gb.meta'].some((k) => k in changes) || (dk.storedKey && dk.storedKey in changes)) dk.changedSince = true;
    };
    chrome.storage.onChanged.addListener(note);
    dk.dropNote = () => chrome.storage.onChanged.removeListener(note);
  } catch (error) {
    // Fail closed: settings that cannot be read are not empty settings (those would theme a page the person turned off). The gate leaves the page and reads again.
    dk.stored = Promise.reject(error);
    /** @type {Promise<unknown>} */ (dk.stored).catch(() => {});
  }
})();
