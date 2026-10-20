// @ts-check
// Listens to the hints of the main-world hook and finds shadow roots, open or closed.
// The hint events can be faked by the page, so each handler only checks what the browser says is true.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  const EVENTS = ['dk:shadow', 'dk:adopt', 'dk:sheet', 'dk:constructed'];
  const RATE_WINDOW_MS = 1000;
  const RATE_LIMIT = 5000;
  // A page with no more elements than this is scanned for closed roots on every element.
  const SCAN_CLOSED_MAX = 4000;
  // Roots whose host left the document are let go at this many roots and at twice the survivors, when older than the grace.
  const PRUNE_FROM = 64;
  const PRUNE_GRACE_MS = 1000;

  // The hints that come before the engine listens (the gate decides a few tens of milliseconds into the load) are lost, so the first one
  // of each kind is noted here. The engine then asks for the module of the roots when it starts, not when its scan has found one.
  const noteSeen = () => {
    dk.shadowSeen = true;
  };
  const NOTED = ['dk:shadow', 'dk:adopt', 'dk:constructed'];
  for (const name of NOTED) document.addEventListener(name, noteSeen, { capture: true, once: true });
  /** The notes are not needed once the page is let go (the gate calls this when it retires). */
  dk.dropShadowNotes = () => {
    for (const name of NOTED) document.removeEventListener(name, noteSeen, true);
  };

  /**
   * The shadow root of an element, open or closed, or null.
   * Content scripts get this from the browser: `chrome.dom` in Chromium, a property in Firefox.
   * @param {Element} element
   * @returns {ShadowRoot | null}
   */
  function shadowRootOf(element) {
    try {
      const direct = /** @type {any} */ (element).openOrClosedShadowRoot;
      if (direct !== undefined) return direct;
      // Chromium has this on `chrome.dom`; Firefox has it as a property of the element (read above).
      const { dom } = /** @type {any} */ (chrome);
      return dom && dom.openOrClosedShadowRoot ? dom.openOrClosedShadowRoot(element) : element.shadowRoot;
    } catch {
      return null;
    }
  }

  /**
   * @param {{
   *   document: Document,
   *   onRoot: (root: ShadowRoot) => void,
   *   onAdopt: (root: Document | ShadowRoot) => void,
   *   onSheet: (node: HTMLStyleElement) => void,
   *   onConstructed: () => void,
   *   onOverflow?: () => void,
   *   onRelease?: (roots: ShadowRoot[]) => void,
   * }} handlers
   */
  function createWatcher(handlers) {
    const doc = handlers.document;
    /** @type {Set<ShadowRoot>} */
    const roots = new Set();
    const stats = { events: 0, dropped: 0, roots: 0, released: 0 };
    /** @type {WeakMap<ShadowRoot, number>} */
    const born = new WeakMap();
    let pruneAt = PRUNE_FROM;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let pruneTimer = null;
    let windowStart = 0;
    let count = 0;
    let stopped = false;
    // When more hints come than we are willing to handle, the surplus is dropped. A genuine hint can be among
    // them, so one catch-up run follows, and a page that keeps flooding gets it less and less often.
    let overflowDelay = 1000;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let overflowTimer = null;

    /** @param {ShadowRoot} root */
    function register(root) {
      if (stopped || roots.has(root)) return false;
      roots.add(root);
      born.set(root, performance.now());
      stats.roots = roots.size;
      for (const name of EVENTS) root.addEventListener(name, onEvent, true);
      if (roots.size >= pruneAt) prune();
      handlers.onRoot(root);
      return true;
    }

    /** Let go of the roots whose host is not in the document. */
    function prune() {
      if (stopped) return;
      if (pruneTimer !== null) clearTimeout(pruneTimer);
      pruneTimer = null;
      const now = performance.now();
      /** @type {ShadowRoot[]} */
      const gone = [];
      let young = false;
      for (const root of roots) {
        if (root.host.isConnected) continue;
        if (now - (born.get(root) ?? 0) < PRUNE_GRACE_MS) young = true;
        else gone.push(root);
      }
      for (const root of gone) {
        roots.delete(root);
        for (const name of EVENTS) root.removeEventListener(name, onEvent, true);
      }
      stats.roots = roots.size;
      stats.released += gone.length;
      pruneAt = Math.max(PRUNE_FROM, roots.size * 2);
      if (young) pruneTimer = setTimeout(prune, PRUNE_GRACE_MS + 50);
      if (gone.length) {
        try {
          handlers.onRelease?.(gone);
        } catch {
        }
      }
    }

    /** @param {Event} event */
    function onEvent(event) {
      if (stopped) return;
      const now = performance.now();
      if (now - windowStart > RATE_WINDOW_MS) {
        if (count <= RATE_LIMIT) overflowDelay = 1000;
        windowStart = now;
        count = 0;
      }
      if (++count > RATE_LIMIT) {
        stats.dropped += 1;
        if (overflowTimer === null) {
          overflowTimer = setTimeout(() => {
            overflowTimer = null;
            if (!stopped) handlers.onOverflow?.();
          }, overflowDelay);
          overflowDelay = Math.min(overflowDelay * 2, 30000);
        }
        return;
      }
      stats.events += 1;
      const target = event.target;
      try {
        switch (event.type) {
          case 'dk:shadow':
            if (target instanceof Element) {
              const root = shadowRootOf(target);
              if (root) register(root);
            }
            break;
          case 'dk:adopt':
            if (target === doc) handlers.onAdopt(doc);
            else {
              const root = target instanceof ShadowRoot ? target : target instanceof Element ? shadowRootOf(target) : null;
              if (root) {
                register(root);
                handlers.onAdopt(root);
              }
            }
            break;
          case 'dk:sheet':
            if (target instanceof HTMLStyleElement) handlers.onSheet(target);
            break;
          case 'dk:constructed':
            handlers.onConstructed();
            break;
          default:
        }
      } catch {
        // A faked event must not be able to stop the engine.
      }
    }

    for (const name of EVENTS) doc.addEventListener(name, onEvent, true);

    return {
      stats,
      roots,
      register,
      prune,
      /**
       * Look for shadow roots that exist without an attach call we saw (declarative ones), inside `container`.
       * @param {ParentNode} container
       * @param {(items: Iterable<Element>, fn: (el: Element) => void, isStopped: () => boolean) => Promise<void>} forEach
       */
      async scan(container, forEach) {
        /** @type {ShadowRoot[]} */
        const found = [];
        const all = container.querySelectorAll('*');
        // An open root is a plain property. The slower call that also sees closed roots is made for custom elements, and for every
        // element of a small page: a closed root made by script is reported by the hook, but not when it was made before the engine
        // listened (the engine starts a few tens of milliseconds into the load).
        const everything = all.length <= SCAN_CLOSED_MAX;
        await forEach(all, (el) => {
          const root = el.shadowRoot ?? (everything || el.localName.indexOf('-') > 0 ? shadowRootOf(el) : null);
          if (root && register(root)) found.push(root);
        }, () => stopped);
        for (const root of found) {
          if (stopped) return;
          await this.scan(root, forEach);
        }
      },
      stop() {
        if (stopped) return;
        stopped = true;
        if (overflowTimer !== null) clearTimeout(overflowTimer);
        if (pruneTimer !== null) clearTimeout(pruneTimer);
        for (const name of EVENTS) doc.removeEventListener(name, onEvent, true);
        for (const root of roots) for (const name of EVENTS) root.removeEventListener(name, onEvent, true);
        roots.clear();
      },
    };
  }

  dk.shadow = Object.freeze({ createWatcher, shadowRootOf });
})();
