// @ts-check
// What a page says about its color scheme. `only light` or `only dark` means the page supports one scheme and wants no other.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  /** `light` or `dark` when a `color-scheme` value says `only` with exactly one of them, else null. @param {string | null | undefined} value */
  function only(value) {
    const v = (value ?? '').toLowerCase();
    const light = /\blight\b/.test(v);
    return /\bonly\b/.test(v) && light !== /\bdark\b/.test(v) ? (light ? 'light' : 'dark') : null;
  }

  /** What the style attribute of the root or the body, or the meta tag `color-scheme`, says. A value on the root is the page's choice. */
  function declared() {
    try {
      const rootValue = document.documentElement.style.getPropertyValue('color-scheme');
      if (rootValue.trim() !== '') return only(rootValue);
      return only(document.body?.style.getPropertyValue('color-scheme')) ?? only(document.head?.querySelector('meta[name="color-scheme" i]')?.getAttribute('content'));
    } catch {
      return null;
    }
  }

  const holdSheet = () => /** @type {CSSStyleSheet | undefined} */ (/** @type {any} */ (globalThis).__dkHold);

  /** Switch the first-paint hold (a constructed sheet, early/sheet.js) off for a read. `disabled` leaves no record a page can see. Returns the call that puts it back. */
  function holdOff() {
    const sheet = holdSheet();
    if (!sheet || sheet.disabled) return () => {};
    sheet.disabled = true;
    return () => {
      sheet.disabled = false;
    };
  }

  // Set when the page was released or left, so the frame watch stops.
  let released = false;

  /** The hold sheet leaves the document. */
  function dropHold() {
    const sheet = holdSheet();
    if (!sheet) return;
    sheet.disabled = true;
    try {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
    } catch {
      // The sheet is off anyway.
    }
  }

  /** The page stays as the page wrote it: the hold leaves and the root attribute is not left behind (the site is off, or the document is not one that is themed). */
  function clear() {
    released = true;
    dropHold();
    try {
      document.documentElement.removeAttribute('data-dk-go');
    } catch {
      // The root is gone.
    }
  }

  /** Release the page for the theme: the root attribute is set once, and the hold sheet leaves the document. */
  function release() {
    released = true;
    const root = document.documentElement;
    if (!root.hasAttribute('data-dk-go')) root.setAttribute('data-dk-go', '');
    const sheet = holdSheet();
    if (!sheet) return;
    sheet.disabled = true;
    try {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
    } catch {
      // The sheet is off anyway.
    }
  }

  /**
   * Run `fn` on the page's own cascade, in one task: engine styles (not those `skip` names) and the hold off, `css` added.
   * Transitions that the switch starts end at once (no fade in the read or after); the page's running ones are left alone.
   * `fn` reads through `read.style(el)`, which ends the new transitions of `el` first; `read.settle()` takes in those of a
   * switch made inside `fn`. The others end after the read: ending them all before it made the browser restyle each element
   * that had one, thousands on a page with `transition: all` everywhere.
   * @template T @param {(read: { style: (el: Element) => CSSStyleDeclaration, settle: () => void }) => T} fn
   * @param {((el: HTMLStyleElement) => boolean) | null} [skip] @param {string} [css]
   */
  function cascade(fn, skip, css = '') {
    const ours = /** @type {HTMLStyleElement[]} */ ([...document.querySelectorAll('style[data-dk]')].filter((el) => el instanceof HTMLStyleElement && !el.disabled && !skip?.(el)));
    const holdBack = holdOff();
    /** @type {CSSStyleSheet | null} */
    let extra = null;
    /** @type {Set<Animation> | null} */
    let known = null;
    const fresh = () => (known && typeof CSSTransition !== 'undefined' ? document.getAnimations().filter((a) => a instanceof CSSTransition && !known?.has(a)) : []);
    /** The new transitions of each element, not ended yet. @type {Map<Element, Animation[]>} */
    const open = new Map();
    const settle = () => {
      open.clear();
      for (const a of fresh()) {
        const target = /** @type {any} */ (a.effect)?.target;
        if (target instanceof Element) open.set(target, [...(open.get(target) ?? []), a]);
      }
    };
    const style = (/** @type {Element} */ el) => {
      const list = open.get(el);
      if (list) {
        open.delete(el);
        for (const a of list) a.cancel();
      }
      return getComputedStyle(el);
    };
    try {
      known = new Set(document.getAnimations());
    } catch {
      known = null;
    }
    try {
      if (css) {
        extra = new CSSStyleSheet();
        extra.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, extra];
      }
    } catch {
      extra = null;
    }
    try {
      for (const el of ours) el.disabled = true;
      settle();
      return fn({ style, settle });
    } finally {
      for (const el of ours) el.disabled = false;
      holdBack();
      if (extra) {
        try {
          const gone = extra;
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== gone);
        } catch {
          // The sheet leaves with the page.
        }
      }
      try {
        for (const a of fresh()) a.cancel();
      } catch {
        // The page is gone.
      }
    }
  }

  /** `light` or `dark` when the page keeps one scheme (`color-scheme` with `only`) on its root or body or in its meta tag, read from the real cascade. @returns {'light' | 'dark' | null} */
  function read() {
    try {
      return cascade((r) => {
        const rootScheme = r.style(document.documentElement).colorScheme;
        if (rootScheme && rootScheme !== 'normal') return only(rootScheme);
        const meta = document.querySelector('meta[name="color-scheme" i]');
        return only(meta ? meta.getAttribute('content') : '') ?? (document.body ? only(r.style(document.body).colorScheme) : null);
      });
    } catch {
      return null;
    }
  }

  /** Does the marker in the registered style (`--dk-respect`) say a page that keeps one scheme is left alone? The settings are not read yet in the first frames. @type {boolean | null} */
  let respectMark = null;
  function respecting() {
    if (respectMark === null) {
      try {
        respectMark = getComputedStyle(document.documentElement).getPropertyValue('--dk-respect').trim() === '1';
      } catch {
        respectMark = false;
      }
    }
    return respectMark;
  }

  // A page that keeps one scheme must not get the quick dark version, not for one frame. While the hold is up each frame (before
  // its paint) looks at the cheap signs and at new sheets (`read`, SHEET_READ_MS in all). `dk.schemeSink` (the gate) answers true
  // when it released the page. Before the settings are known only the marker may release; the gate takes `dk.schemeEarly` later.
  const SHEET_READ_MS = 30;
  let sheetReadMs = 0;
  let sheetCount = -1;
  function watchFrames() {
    const root = document.documentElement;
    const start = performance.now();
    const tick = () => {
      if (released || root.hasAttribute('data-dk-go') || performance.now() - start > 60000) return;
      let kind = declared();
      const count = document.styleSheets.length;
      if (kind === null && count !== sheetCount && sheetReadMs < SHEET_READ_MS) {
        sheetCount = count;
        const t0 = performance.now();
        kind = read();
        sheetReadMs += performance.now() - t0;
      }
      if (kind !== null) {
        const sink = /** @type {any} */ (dk).schemeSink;
        if (typeof sink === 'function') {
          if (sink(kind) === true) return;
        } else {
          // The gate is not there yet: it takes this note when it starts.
          /** @type {any} */ (dk).schemeEarly = kind;
          if (respecting()) {
            release();
            return;
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  try {
    if (/** @type {any} */ (dk).initialReadyState === 'loading' && document.documentElement instanceof HTMLElement && typeof requestAnimationFrame === 'function') watchFrames();
  } catch {
    // The page is left to the gate.
  }

  dk.scheme = Object.freeze({ only, declared, read, respecting, holdOff, release, clear, cascade });
})();
