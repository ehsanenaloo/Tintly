// @ts-check
// Is the page already dark? The answer comes from the real cascade: the engines' own style elements are switched off for
// the length of one task, the page's computed colors are read, and the elements are switched on again. No frame is drawn
// in between, so nothing flickers. The gate's driver (`createDriver`) decides when to look: once the page has loaded, and again
// when it changed or was not finished.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  const DARK_BACKGROUND = 0.12;
  const MIN_TEXT_GAP = 0.15;
  // A light box this size or larger at the middle of the window makes the dark page a frame around a light page.
  const LIGHT_BOX_Y = 0.4;
  const LIGHT_BOX_SHARE = 0.35;
  // The first look on a big page waits for an idle moment, because a probe restyles the whole page.
  const HUGE_PAGE = 20000;
  const RECHECK_MS = 1000;
  const AFTER_FRAME_MS = 300;
  let probes = 0;

  /** @param {number} c 0 to 255 */
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };

  /** @param {string} css @returns {{ y: number, a: number } | null} relative luminance and alpha of an `rgb()` or `rgba()` value */
  function parse(css) {
    const m = /^rgba?\(([^)]+)\)$/.exec(css.trim());
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.slice(0, 3).some((v) => !Number.isFinite(v))) return null;
    return { y: 0.2126 * channel(p[0]) + 0.7152 * channel(p[1]) + 0.0722 * channel(p[2]), a: p.length > 3 && Number.isFinite(p[3]) ? p[3] : 1 };
  }

  /**
   * Is the middle of the window a large light box? Dark colors on the body can be a frame around a white page. The
   * elements under the point are asked from the top: the first one that paints a solid color decides.
   * @param {Element} root @param {Element | null} body @param {(el: Element) => CSSStyleDeclaration} [styleOf]
   */
  function lightBoxAtCenter(root, body, at = 0.5, styleOf = getComputedStyle) {
    const w = innerWidth;
    const h = innerHeight;
    if (!(w > 0 && h > 0)) return false;
    for (const el of document.elementsFromPoint(w / 2, h * at)) {
      if (el === root || el === body) return false;
      const c = parse(styleOf(el).backgroundColor);
      if (!c || c.a < 0.5) continue;
      if (c.y < LIGHT_BOX_Y) return false;
      const r = el.getBoundingClientRect();
      return (r.width * r.height) / (w * h) >= LIGHT_BOX_SHARE;
    }
    return false;
  }

  /**
   * Read the signals. Runs with the engines' elements disabled and always puts them back.
   * @returns {{ dark: boolean, signals: { scheme: boolean, background: number | null, text: number | null } }}
   */
  function probe() {
    probes += 1;
    const root = document.documentElement;
    // A frame whose core is older than this module has no `cascade`: the call throws and the page is themed as usual.
    return /** @type {any} */ (dk).scheme.cascade((/** @type {any} */ r) => {
      // An older core passes no reader.
      const styleOf = r?.style ?? getComputedStyle;
      const rootStyle = styleOf(root);
      // The meta tag counts too; the browser does not always show it in the computed value of the root.
      const meta = document.querySelector('meta[name="color-scheme" i]');
      const scheme = `${rootStyle.colorScheme} ${meta ? meta.getAttribute('content') ?? '' : ''}`.toLowerCase().split(/[\s,]+/).filter(Boolean);
      // `dark` alone means the page asks for a dark canvas. `light dark` follows the system and is judged by its colors.
      const schemeDark = scheme.includes('dark') && !scheme.includes('light');
      const body = document.body;
      const bodyStyle = body ? styleOf(body) : null;
      const layers = [bodyStyle && parse(bodyStyle.backgroundColor), parse(rootStyle.backgroundColor)];
      const solid = layers.find((c) => c && c.a >= 0.5);
      // With no background anywhere, the canvas is white, or dark when the page asks for a dark scheme.
      const background = solid ? solid.y : schemeDark ? 0.01 : 1;
      const text = bodyStyle ? parse(bodyStyle.color) : null;
      const textY = text ? text.y : null;
      let dark = background < DARK_BACKGROUND && (textY === null || textY - background > MIN_TEXT_GAP);
      if (dark && lightBoxAtCenter(root, body, 0.5, styleOf)) dark = false;
      return { dark, signals: { scheme: schemeDark, background, text: textY } };
    });
  }

  /**
   * The gate's look at the page's own colors on a page that is themed while the dark-page check is on. @param {{ watching: () => boolean, dark: () => boolean, setDark: (v: boolean) => void, rechecking: () => boolean, apply: () => void }} gate
   */
  function createDriver(gate) {
    let probes = 0;
    // The root or body changed its attributes since the last probe, or a style sheet was still arriving when it ran.
    let changedSinceProbe = false;
    let sheetsPending = false;
    /** @type {MutationObserver | null} */
    let rootWatcher = null;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let recheckTimer;
    let lastProbeAt = 0;
    let watchedBody = /** @type {Element | null} */ (null);
    let deferred = false;
    let queued = false;
    // The listeners the driver adds on the window and the document, so a stopped driver leaves none behind.
    let stopped = false;
    /** @type {(() => void)[]} */
    const undo = [];
    /** @param {EventTarget} target @param {string} type @param {() => void} fn */
    const listen = (target, type, fn) => {
      target.addEventListener(type, fn, { once: true });
      undo.push(() => target.removeEventListener(type, fn));
    };

    function sheetsStillArriving() {
      for (const link of document.querySelectorAll('link[rel~="stylesheet" i]')) {
        if (link instanceof HTMLLinkElement && !link.sheet && !link.disabled && link.getAttribute('href')) return true;
      }
      return false;
    }

    /** Run the probe now (the module is loaded first). Resolves to true when the verdict is dark. */
    async function probeNow() {
      probes += 1;
      lastProbeAt = performance.now();
      changedSinceProbe = false;
      sheetsPending = sheetsStillArriving();
      try {
        return probe().dark === true;
      } catch {
        // A page that cannot be read is themed as usual.
        return false;
      }
    }

    /** @param {() => void} fn */
    function whenIdle(fn) {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 3000 });
      else setTimeout(fn, 200);
    }

    /** Look at the page's own colors once it has loaded; if it is dark, the gate stops the engine and leaves it as it is. */
    function arm() {
      watchRoot();
      const run = (/** @type {boolean} */ second) => {
        if (!gate.watching() || gate.dark()) return;
        // The second look is only for a page that was not finished at the first or has changed its root since. A first look
        // that is still waiting for its task sees the loaded page anyway.
        if (second && (deferred || queued || (probes > 0 && !sheetsPending && !changedSinceProbe))) return;
        const go = async () => {
          queued = false;
          if (stopped || !gate.watching() || gate.dark()) return;
          if (await probeNow()) {
            if (!gate.watching() || gate.dark()) return;
            gate.setDark(true);
            gate.apply();
          }
        };
        // The first look on a big page waits until the page is loaded and quiet.
        if (!second && document.getElementsByTagName('*').length > HUGE_PAGE) {
          deferred = true;
          const idle = () => whenIdle(go);
          if (document.readyState === 'complete') idle();
          else listen(window, 'load', idle);
          return;
        }
        // Its own task, right after a drawn frame: other readers of the page's cascade run at the same event, and the frame
        // takes the page's own pending restyle out of the read. A hidden tab draws no frames.
        queued = true;
        let ran = false;
        const once = () => {
          if (ran) return;
          ran = true;
          void go();
        };
        requestAnimationFrame(() => setTimeout(once, 0));
        setTimeout(once, AFTER_FRAME_MS);
      };
      if (document.readyState === 'loading') listen(document, 'DOMContentLoaded', () => run(false));
      else run(false);
      listen(window, 'load', () => run(true));
    }

    /** Watch the root and the body for the attributes a page changes when it switches theme. */
    function watchRoot() {
      if (stopped) return;
      if (rootWatcher) {
        if (document.body && watchedBody !== document.body) {
          watchedBody = document.body;
          rootWatcher.observe(document.body, { attributes: true });
        }
        return;
      }
      rootWatcher = new MutationObserver((records) => {
        // The engine's own markers (`data-dk-*`) are not the page's change.
        const ours = (/** @type {Node} */ n) => n instanceof Element && n.hasAttribute('data-dk');
        const page = (/** @type {MutationRecord} */ r) =>
          r.type === 'childList' ? [...r.addedNodes, ...r.removedNodes].some((n) => !ours(n)) : !(r.attributeName ?? '').startsWith('data-dk');
        if (!records.some(page)) return;
        changedSinceProbe = true;
        recheck();
        watchRoot();
      });
      rootWatcher.observe(document.documentElement, { attributes: true, childList: true });
      if (document.body) {
        watchedBody = document.body;
        rootWatcher.observe(document.body, { attributes: true });
      }
    }

    /** A page that was found dark can turn light later (its own theme button, the system scheme). Look again, at most once a second. */
    function recheck() {
      if (stopped || !gate.dark() || !gate.rechecking() || recheckTimer !== undefined) return;
      const wait = Math.max(250, lastProbeAt + RECHECK_MS - performance.now());
      recheckTimer = setTimeout(async () => {
        recheckTimer = undefined;
        if (stopped || !gate.dark()) return;
        if (!(await probeNow()) && !stopped && gate.dark()) {
          gate.setDark(false);
          gate.apply();
        }
      }, wait);
    }

    /** Leave nothing behind: the root watcher, the recheck timer and the waiting listeners go. The driver is not used again. */
    function stop() {
      stopped = true;
      rootWatcher?.disconnect();
      rootWatcher = null;
      watchedBody = null;
      clearTimeout(recheckTimer);
      recheckTimer = undefined;
      for (const f of undo.splice(0)) f();
    }

    return { arm, watchRoot, recheck, stop };
  }

  dk.detect = Object.freeze({ probe, createDriver, kit: Object.freeze({ parse, lightBoxAtCenter, DARK_BACKGROUND, LIGHT_BOX_Y }), stats: () => ({ probes }) });
})();
