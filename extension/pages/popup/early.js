// @ts-check
// Starts the reads of the window while its other modules are still loading, so the answers are there when it needs them.
// popup.js takes them from `globalThis.__dkEarly` once and asks again by itself when one is missing or failed.
import { STATE_KEYS } from '../../shared/sections.js';

/** @template T @param {() => Promise<T>} start @returns {Promise<T> | null} */
function begin(start) {
  try {
    const pending = start();
    // The window answers a failed read itself; this keeps the browser from reporting it as unhandled.
    pending.catch(() => undefined);
    return pending;
  } catch {
    return null;
  }
}

/** @type {any} */ (globalThis).__dkEarly = {
  state: begin(() => chrome.storage.local.get([...STATE_KEYS])),
  tabs: begin(() => chrome.tabs.query({ active: true, currentWindow: true })),
  self: begin(() => chrome.management.getSelf()),
};
