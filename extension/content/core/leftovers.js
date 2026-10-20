// @ts-check
// What a build left in a frame whose world is gone. Firefox gives an updated or reloaded add-on a new world, where the old namespace
// cannot be seen and its `retire` cannot run. namespace.js finds the marks of a themed page in a frame with no namespace; the gate then
// asks for this file and cleans the frame before its first decision.
(() => {
  'use strict';
  const dk = /** @type {Record<string, any> | undefined} */ (globalThis.__dk);
  if (!dk || dk.leftovers) return;
  /** Attributes that only the engines write on page elements (a test keeps this list equal to the ones the files use). */
  const MARKS = ['data-dk-go', 'data-dk-state', 'data-dk-i', 'data-dk-j', 'data-dk-k', 'data-dk-ph', 'data-dk-bw', 'data-dk-img', 'data-dk-bg', 'data-dk-r'];
  /** Elements that the engines make and tag with `data-dk`. */
  const MADE = 'style[data-dk],svg[data-dk],span[data-dk="probe"]';

  /**
   * The marks and the elements of the old build are removed, in the document and in its shadow roots, and the page-world hook is told
   * that no scheme or motion is asked for. False when there was nothing to remove.
   */
  function sweep() {
    try {
      const root = document.documentElement;
      if (!root || !(root.hasAttribute('data-dk-go') || root.hasAttribute('data-dk-state'))) return false;
      const marked = MARKS.map((name) => `[${name}]`).join(',');
      /** @param {Document | ShadowRoot} scope */
      const clean = (scope) => {
        for (const el of scope.querySelectorAll(MADE)) el.remove();
        for (const el of scope.querySelectorAll(marked)) for (const name of MARKS) el.removeAttribute(name);
      };
      /** @param {Document | ShadowRoot} scope */
      const visit = (scope) => {
        clean(scope);
        for (const el of scope.querySelectorAll('*')) {
          // Firefox lets the content script reach closed roots too.
          const shadow = /** @type {any} */ (el).openOrClosedShadowRoot ?? el.shadowRoot;
          if (shadow) visit(shadow);
        }
      };
      visit(document);
      for (const name of ['dk:scheme-off', 'dk:motion-off']) document.dispatchEvent(new Event(name));
      return true;
    } catch {
      // A page that cannot be cleaned keeps the old look until it is loaded again.
      return false;
    }
  }

  dk.leftovers = Object.freeze({ sweep });
})();
