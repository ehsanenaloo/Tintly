// @ts-check
// The one namespace of the isolated world. A frame that already holds the namespace of the same build, with a live extension
// context, keeps it. One from another build (an update or a reload of the extension leaves the old scripts in open tabs) or one
// whose context is gone is retired: its engines stop, its keys are cleared, and the files that follow start clean.
(() => {
  'use strict';
  /**
   * A frame with no namespace but with the marks of a themed page holds what a build left whose world is gone (Firefox gives an updated
   * or reloaded add-on a new world). The gate asks for leftovers.js to clean it before its first decision. A fresh page has none of
   * the marks at this point (the hold sheet carries none), so this costs two attribute reads.
   */
  function marked() {
    try {
      const root = document.documentElement;
      return !!root && (root.hasAttribute('data-dk-go') || root.hasAttribute('data-dk-state'));
    } catch {
      return false;
    }
  }

  let build = '';
  try {
    build = chrome.runtime.getManifest().version;
  } catch {
    // No extension API: the namespace is made without a build.
  }
  const old = /** @type {Record<string, any> | undefined} */ (globalThis.__dk);
  if (old) {
    let live = false;
    try {
      live = old.build === build && (typeof old.alive !== 'function' || old.alive() === true);
    } catch {
      live = false;
    }
    if (live) return;
    try {
      if (typeof old.retire === 'function') old.retire();
      else for (const name of ['dynamic', 'filter', 'staticEngine', 'images', 'backdrop', 'calm', 'extras', 'readability']) old[name]?.stop?.();
    } catch {
      // A broken old instance must not stop the new one.
    }
    for (const key of Reflect.ownKeys(old)) {
      try {
        delete old[/** @type {string} */ (key)];
      } catch {
        // A key that cannot be deleted is overwritten by the file that owns it.
      }
    }
    old.build = build;
    // The page showed the old build's look: the new gate decides at once, also in a hidden tab (boot.js `begin`).
    old.replaced = true;
    return;
  }
  const left = marked();
  const created = Object.create(null);
  created.build = build;
  if (left) created.replaced = created.leftover = true;
  Object.defineProperty(globalThis, '__dk', {
    value: created,
    writable: false,
    enumerable: false,
    configurable: false,
  });
})();
