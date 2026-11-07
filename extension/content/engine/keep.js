// @ts-check
// Keeps an engine's own nodes in the page. A script that rebuilds the head, or a framework that replaces the children of
// the root, removes style elements that are not its own. This puts them back where the engine says, in the frame callback:
// the page never paints without them, a script that looks at the page right after it removed them sees what it expects,
// and all removals of a frame cost one put-back. The limit on put-backs only holds a page at a very high frame rate.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  const MAX_RESTORES = 300;
  const WINDOW_MS = 2000;
  const RETRY_MAX_MS = 32000;
  /** A hidden page runs no frames. */
  const HIDDEN_WAIT_MS = 100;

  /** Run `fn` before the next paint. Returns the call that cancels it. @param {() => void} fn */
  function beforePaint(fn) {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer;
    const frame = requestAnimationFrame(() => {
      clearTimeout(timer);
      fn();
    });
    timer = setTimeout(() => {
      cancelAnimationFrame(frame);
      fn();
    }, HIDDEN_WAIT_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }

  const SEAL = '/**/';
  /** The full text of each sealed style element. @type {WeakMap<HTMLStyleElement, string>} */
  const sealedText = new WeakMap();

  /** The rules a style element stands for, sealed or not. @param {HTMLStyleElement} el */
  function textOf(el) {
    const text = el.textContent ?? '';
    return text === SEAL ? sealedText.get(el) ?? text : text;
  }

  /**
   * Put back a style element that the page removed. A page that sweeps style elements by their text would make the browser
   * restyle the whole page twice for each sweep, so the rules go into the CSSOM and a sweep passes them by. Rules that change how
   * a picture is drawn stay in the text: a page that checks its pictures after a sweep must find them gone.
   * @param {HTMLStyleElement} el @param {() => void} place
   */
  function put(el, place) {
    const text = textOf(el);
    /** @type {CSSStyleSheet | null} */
    let parsed = null;
    if (!/filter|@import|@namespace|@charset/i.test(text)) {
      try {
        parsed = new CSSStyleSheet();
        parsed.replaceSync(text);
      } catch {
        parsed = null;
      }
    }
    el.textContent = parsed ? SEAL : text;
    place();
    if (!parsed) return;
    sealedText.set(el, text);
    try {
      const sheet = /** @type {CSSStyleSheet} */ (el.sheet);
      for (const rule of parsed.cssRules) sheet.insertRule(rule.cssText, sheet.cssRules.length);
    } catch {
      el.textContent = text;
    }
  }

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
    /** @type {(() => void) | null} */
    let cancelPaint = null;
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
      cancelPaint = null;
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
      timer = undefined;
      cancelPaint ??= beforePaint(check);
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
        cancelPaint?.();
        tracked.clear();
      },
      stats: () => ({ ...stats }),
    };
  }

  dk.keep = Object.freeze({ create, beforePaint, put, textOf });
})();
