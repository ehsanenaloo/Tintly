// @ts-check
// Keeps an engine's own nodes in the page. A script that rebuilds the head, or a framework that replaces the children of
// the root, removes style elements that are not its own. This puts them back where the engine says. A node comes back at
// most three times in two seconds; a page that keeps removing it is left alone until it goes quiet.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  const MAX_RESTORES = 3;
  const WINDOW_MS = 2000;
  const RETRY_MAX_MS = 32000;

  /** One keeper for each engine that runs. */
  function create() {
    const doc = document;
    /** The nodes to keep, each with the function that puts it back. @type {Map<Node, () => void>} */
    const tracked = new Map();
    /** When each node was put back. @type {WeakMap<Node, number[]>} */
    const times = new WeakMap();
    const stats = { restored: 0, gaveUp: 0 };
    let dead = false;
    let refused = false;
    let wait = WINDOW_MS;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {Element | null} */
    let watchedHead = null;

    /** @param {Node} node */
    function allow(node) {
      const now = performance.now();
      const list = (times.get(node) ?? []).filter((t) => now - t < WINDOW_MS);
      if (list.length >= MAX_RESTORES) {
        times.set(node, list);
        stats.gaveUp += 1;
        refused = true;
        return false;
      }
      list.push(now);
      times.set(node, list);
      stats.restored += 1;
      return true;
    }

    function check() {
      timer = undefined;
      if (dead) return;
      refused = false;
      for (const [node, place] of tracked) {
        if (node.isConnected || !allow(node)) continue;
        try {
          place();
        } catch {
          // The place is gone for now; the next removal looks again.
        }
      }
      // A page that stopped removing gets its node back once the window has passed; no removal comes to ask for it.
      if (refused) {
        timer = setTimeout(check, wait);
        wait = Math.min(wait * 2, RETRY_MAX_MS);
      } else wait = WINDOW_MS;
      watchHead();
    }

    const mo = new MutationObserver((records) => {
      if (dead || !records.some((r) => r.removedNodes.length > 0)) return;
      // A removal now outranks a waiting retry.
      clearTimeout(timer);
      timer = setTimeout(check, 0);
    });
    mo.observe(doc.documentElement, { childList: true });

    function watchHead() {
      if (doc.head && doc.head !== watchedHead) {
        watchedHead = doc.head;
        mo.observe(doc.head, { childList: true });
      }
    }
    watchHead();

    return {
      /** Keep `node`. `place` puts it back into the page. @param {Node} node @param {() => void} place */
      track(node, place) {
        tracked.set(node, place);
        watchHead();
      },
      /** @param {Node} node */
      untrack(node) {
        tracked.delete(node);
      },
      stop() {
        dead = true;
        mo.disconnect();
        if (timer !== undefined) clearTimeout(timer);
        tracked.clear();
      },
      stats: () => ({ ...stats }),
    };
  }

  dk.keep = Object.freeze({ create });
})();
