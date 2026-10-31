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

  /** Reads of the page's cascade, and the animations they listed: each one listed is a cost the read pays. */
  const counts = { reads: 0, listed: 0 };
  const list = () => {
    const all = document.getAnimations();
    counts.listed += all.length;
    return all;
  };

  /** Elements that draw no box, so no transition runs on them (the engine's own style elements sit next to the body). */
  const NO_BOX = new Set(['head', 'style', 'script', 'link', 'meta', 'title', 'base', 'template', 'noscript']);

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
   * With `rootOnly` the body is held with `content-visibility: hidden` until `fn` calls `read.reveal()` (or returns): while it is held
   * `fn` may read the root and the body, and the browser restyles those two, not the page below them, when the engine's elements go off
   * and on. The body is held before the first style update, so the page below is restyled once, when the body is let go, with
   * what changed there just before the read. A transition that starts below the body then is the page's own and runs; without a
   * `reveal` only the transitions of the root, the body and what is outside the body end. Nothing is drawn in between (it is one task), the running
   * animations of the page go on, and no layout is read. `reveal` is what a read of anything below the body calls first.
   * @template T @param {(read: { style: (el: Element) => CSSStyleDeclaration, settle: () => void, reveal: () => void }) => T} fn
   * @param {((el: HTMLStyleElement) => boolean) | null} [skip] @param {string} [css] @param {boolean} [rootOnly]
   */
  function cascade(fn, skip, css = '', rootOnly = false) {
    counts.reads += 1;
    const ours = /** @type {HTMLStyleElement[]} */ ([...document.querySelectorAll('style[data-dk]')].filter((el) => el instanceof HTMLStyleElement && !el.disabled && !skip?.(el)));
    const holdBack = holdOff();
    /** @type {CSSStyleSheet | null} */
    let extra = null;
    /** The sheet that holds the body, while it is held. @type {CSSStyleSheet | null} */
    let hider = null;
    /** @type {Set<Animation> | null} */
    let known = null;
    /** The sheet that keeps the switch from starting transitions below the body, while it is on. @type {CSSStyleSheet | null} */
    let still = null;
    // A page with `transition-behavior: allow-discrete` may start one on the hold itself: it counts as ours and ends with the read.
    const isHold = (/** @type {Animation} */ a) => typeof CSSTransition !== 'undefined' && a instanceof CSSTransition && a.transitionProperty === 'content-visibility';
    const fresh = () => (known && typeof CSSTransition !== 'undefined' ? list().filter((a) => a instanceof CSSTransition && !known?.has(a)) : []);
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
    // The body is held before the first look at the running transitions: that look brings the style up to date, and what the
    // page or the engine changed below the body just before is then restyled once, with the switch back, not twice.
    try {
      if (rootOnly) {
        hider = new CSSStyleSheet();
        hider.replaceSync('body{content-visibility:hidden!important}');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, hider];
      }
    } catch {
      hider = null;
    }
    // A switch of the whole page on `transition: all` everywhere starts one transition per element and property (14 000 on
    // 2 400 elements), and listing and ending them cost more than the read. A zero duration starts none; the transitions that
    // run keep their own timing. Only what is restyled with the engine off needs it: everything, the root and the body while the body is held,
    // or the body after a reveal.
    const stillOn = () => {
      try {
        still = new CSSStyleSheet();
        still.replaceSync('*,::before,::after{transition-duration:0s!important;transition-delay:0s!important}');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, still];
      } catch {
        still = null;
      }
    };
    const stillOff = () => {
      if (!still) return;
      const gone = still;
      still = null;
      try {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== gone);
      } catch {
        // The sheet leaves with the page.
      }
    };
    /** Bring the root and the body up to date: while the body is held, that restyles nothing below it. */
    const touch = () => {
      getComputedStyle(document.documentElement).transitionDuration;
      if (document.body) getComputedStyle(document.body).transitionDuration;
    };
    /** No transition can start on `el`: every duration is zero and no delay is above zero. @param {Element} el */
    const none = (el) => {
      const cs = getComputedStyle(el);
      return cs.transitionDuration.split(',').every((v) => parseFloat(v) === 0) && cs.transitionDelay.split(',').every((v) => !(parseFloat(v) > 0));
    };
    // While the body is held only the root, the body and what is outside the body restyle. When the sheet stops every
    // transition there, the read starts none and the page's running ones need not be listed: on a page that fades thousands
    // of elements, each list cost 0.3 s. The page's own changes to the root and the body start theirs before the sheet.
    let quiet = false;
    if (hider) {
      try {
        touch();
        stillOn();
        const root = document.documentElement;
        const body = document.body;
        quiet = !!still && !!body && [...root.children].every((c) => c === body || NO_BOX.has(c.localName)) && none(root) && none(body);
      } catch {
        quiet = false;
      }
    }
    if (!quiet) {
      try {
        known = new Set(list().filter((a) => !isHold(a)));
      } catch {
        known = null;
      }
    }
    if (!rootOnly) stillOn();
    try {
      if (css) {
        extra = new CSSStyleSheet();
        extra.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, extra];
      }
    } catch {
      extra = null;
    }
    const letGo = () => {
      if (!hider) return;
      const gone = hider;
      hider = null;
      try {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== gone);
      } catch {
        // The sheet leaves with the page.
      }
    };
    /** Only what is not below the body was restyled with the engine off, so only its new transitions can be ours. @param {Animation} a */
    const onTop = (a) => {
      const target = /** @type {any} */ (a.effect)?.target;
      const body = document.body;
      return target instanceof Element && (!body || target === body || !body.contains(target));
    };
    let hold = holdBack;
    /** @param {boolean} off */
    const switchAll = (off) => {
      for (const el of ours) el.disabled = off;
      if (off) hold = holdOff();
      else hold();
      if (extra) {
        try {
          const sheet = extra;
          const rest = document.adoptedStyleSheets.filter((x) => x !== sheet);
          document.adoptedStyleSheets = off ? [...rest, sheet] : rest;
        } catch {
          // The sheet leaves with the page.
        }
      }
    };
    const reveal = () => {
      if (!hider) return;
      // What changed below the body while it was held is restyled in the page's look as it was before the read, so the
      // transitions the page started there are known as the page's own; the ones of the root and the body are ours.
      try {
        if (quiet) {
          // The page below the body restyles now, so its transitions are listed as before. Root and body are up to date, so
          // the sheet leaving changes durations only.
          quiet = false;
          known = new Set(list().filter((a) => !isHold(a)));
          stillOff();
        }
        switchAll(false);
        letGo();
        for (const a of fresh()) {
          if (onTop(a)) a.cancel();
          else known?.add(a);
        }
        if (!still) stillOn();
        switchAll(true);
      } catch {
        letGo();
      }
      settle();
    };
    let revealed = !rootOnly;
    try {
      for (const el of ours) el.disabled = true;
      settle();
      return fn({
        style,
        settle,
        reveal: () => {
          revealed = true;
          reveal();
        },
      });
    } finally {
      for (const el of ours) el.disabled = false;
      hold();
      if (extra) {
        try {
          const gone = extra;
          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== gone);
        } catch {
          // The sheet leaves with the page.
        }
      }
      if (quiet) {
        // The root and the body take the engine back while the body is still held and the sheet is on; nothing was listed.
        try {
          touch();
        } catch {
          // The page is gone.
        }
        stillOff();
      }
      letGo();
      try {
        // Without a reveal the page below the body kept its look; a transition that starts there now is the page's own.
        for (const a of fresh()) if (revealed || onTop(a)) a.cancel();
      } catch {
        // The page is gone.
      }
      // The look above brought the style up to date with the engine back on, so the sheet leaving changes durations only.
      stillOff();
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
      }, null, '', true);
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

  dk.scheme = Object.freeze({ only, declared, read, respecting, holdOff, release, clear, cascade, stats: () => ({ ...counts }) });
})();
