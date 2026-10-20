// @ts-check
// The palette of the E-ink and Paper mode: the page, ink and surface colors from the person's settings, and the transform of one
// color into them. Loaded on demand (loader.js) and only when the mode is used; it adds its three parts to `dk.color`.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  const color = /** @type {any} */ (dk?.color);
  if (!color || color.hasEink()) return;
  const { parseColor, toOklch, fromOklch, luminance, linearToSrgb, srgbToLinear, contrastRatio, smoothstep, maxChroma, lerp, hueLerp, TEXT_MIN, EDGE_MIN } = color.einkKit();
  /** @typedef {{ r: number, g: number, b: number, a: number }} Rgba */
  /** @typedef {'background' | 'foreground' | 'border' | 'edge' | 'shadow'} Role */

  // Depth of a surface below the paper, in OKLab lightness. A mid gray box sits DEPTH below, a black one (which the mode turns
  // light) almost none, and a colored box ACCENT below.
  const EINK_DEPTH = 0.14;
  const EINK_DEPTH_BLACK = 0.012;
  const EINK_DEPTH_ACCENT = 0.2;
  // A light box: text and edges keep their contrast floor against the paper and against a box this much darker.
  const EINK_CARD = 0.07;
  // The most a gray text may fade from the ink, and how much of its chroma a muted color keeps.
  const EINK_FADE = 0.3;
  const EINK_MUTE = 0.6;
  // The blue light reduction at 100 percent: how much blue and green are taken away.
  const EINK_BLUE_B = 0.45;
  const EINK_BLUE_G = 0.1;

  /** @param {Record<string, any>} e */
  function einkPalette(e) {
    const paper = /** @type {Rgba} */ (parseColor(e.paperColor));
    const ink = /** @type {Rgba} */ (parseColor(e.inkColor));
    const [Lp0, Cp, hp] = toOklch(paper);
    const [Li0, Ci, hi] = toOklch(ink);
    // The paper must be light enough for the ink to reach its contrast floor, whatever the person picked.
    const Lp = Math.max(Lp0, 0.8);
    const Li = Math.min(Li0, Lp - 0.3);
    const blue = e.einkBlue / 100;
    const reduce = (/** @type {Rgba} */ c) => ({ r: c.r, g: c.g * (1 - EINK_BLUE_G * blue), b: c.b * (1 - EINK_BLUE_B * blue), a: c.a });
    const paperY = luminance(reduce(fromOklch(Lp, Cp, hp)));
    // The cap is the peak luminance of the page white; the whole palette is scaled in linear light so no color is brighter.
    const scale = Math.min(1, e.whiteCap / 100 / Math.max(paperY, 1e-6));
    const finish = (/** @type {Rgba} */ c) => {
      if (blue === 0 && scale === 1) return c;
      const d = reduce(c);
      if (scale === 1) return d;
      return { r: linearToSrgb(srgbToLinear(d.r) * scale), g: linearToSrgb(srgbToLinear(d.g) * scale), b: linearToSrgb(srgbToLinear(d.b) * scale), a: c.a };
    };
    const textMin = e.preset === 'eink' ? 7 : TEXT_MIN;
    const borderMin = e.preset === 'eink' ? 3 : 1.6;
    const k = e.einkContrast / 100;
    const page = finish(fromOklch(Lp, Cp, hp));
    // The lightest a surface may be made dark: the ink must still read on it.
    const inkY = luminance(finish(fromOklch(Li, Ci, hi)));
    const minY = Math.max(0, (textMin * (inkY + 0.05) - 0.05) / scale);
    const Lfloor = Math.cbrt(minY) + 0.01;
    // The share of an accent's chroma kept. With the root filter the palette keeps all (or none at 0): no double reduction.
    const keep = e.einkGrayAll ? (e.einkColorAmount > 0 ? 1 : 0) : e.einkColorAmount / 100;
    return Object.freeze({ ...e, Lp, Li, Cp, hp, Ci, hi, k, scale, blue, textMin, borderMin, Lfloor, keep, mono: keep === 0, finish, page });
  }

  /** @typedef {Record<string, any>} EinkPalette */

  /** Snap lightness to the gray levels between the ink and the paper. `dir` 0 rounds to the nearest, -1 toward the ink. @param {EinkPalette} e @param {number} L @param {-1 | 0} dir */
  function einkSnap(e, L, dir) {
    const n = e.einkLevels;
    if (n < 2) return L;
    const span = e.Lp - e.Li;
    const x = ((L - e.Li) / span) * (n - 1);
    const k = dir < 0 ? Math.floor(x + 1e-6) : Math.round(x);
    return e.Li + (Math.min(n - 1, Math.max(0, k)) / (n - 1)) * span;
  }

  /**
   * Make `c` (before the blue and cap step) dark enough to keep `target` against every background, after the last step.
   * @param {EinkPalette} e @param {Rgba} c @param {Rgba[]} backs @param {number} target @returns {Rgba}
   */
  function einkContrast(e, c, backs, target) {
    // A small margin: the colors are written as 8-bit values, which moves the ratio a little.
    const enough = (/** @type {Rgba} */ x) => backs.every((b) => contrastRatio(x, b) >= target + 0.1);
    let out = e.finish(c);
    if (enough(out)) return out;
    const [L, C, h] = toOklch(c);
    let lo = 0;
    let hi = L;
    if (!enough(e.finish(fromOklch(0, C, h, c.a)))) return e.finish(fromOklch(0, 0, 0, c.a));
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (enough(e.finish(fromOklch(mid, C, h, c.a)))) lo = mid;
      else hi = mid;
    }
    const snappedOut = e.finish(fromOklch(einkSnap(e, lo, -1), C, h, c.a));
    out = enough(snappedOut) ? snappedOut : e.finish(fromOklch(lo, C, h, c.a));
    return out;
  }

  /** The surfaces text and edges must read on: the paper, and a box a little darker than it. @param {EinkPalette} e */
  function einkSurfaces(e) {
    const L = Math.max(e.Lp - EINK_CARD * e.k, e.Lfloor);
    return { page: e.page, card: e.finish(fromOklch(L, e.Cp, e.hp, 1)) };
  }

  /** @param {EinkPalette} e @param {number} L original lightness @param {number} C @param {number} h @param {Role} role @param {number} a @returns {Rgba} */
  function einkTransform(e, L, C, h, role, a) {
    const acc = smoothstep(0.05, 0.12, C);
    const keepHue = e.keep > 0 && acc > 0;
    const tintOf = (/** @type {number} */ outL, /** @type {number} */ neutralC, /** @type {number} */ neutralH, /** @type {number} */ accentScale) => {
      if (!keepHue) return [neutralC, neutralH];
      // Role scales are relative to the foreground one (0.6). A small floor keeps accents apart at low amounts.
      const accentC = Math.max(Math.min(C * e.keep * (accentScale / 0.6), maxChroma(outL, h)), Math.min(0.018 + 0.06 * e.keep, 0.04, maxChroma(outL, h)));
      return [lerp(neutralC, accentC, acc), Number.isNaN(neutralH) ? h : hueLerp(neutralH, h, acc)];
    };
    if (role === 'background') {
      // A fold around the middle: white and black are the paper, a mid gray is the deepest. A page that is dark keeps its page
      // color for the paper and its lighter boxes become a little deeper, which is how it was ordered before.
      const base = L >= 0.55 ? ((1 - L) / 0.45) * EINK_DEPTH : EINK_DEPTH_BLACK + (EINK_DEPTH - EINK_DEPTH_BLACK) * (L / 0.55) ** 2;
      // A deep chromatic box is a section (a band, a footer) more often than a badge: it follows the dark rule.
      const lead = acc * smoothstep(0.3, 0.55, L);
      const depth = (base + (EINK_DEPTH_ACCENT - base) * lead) * e.k;
      const outL = einkSnap(e, Math.max(e.Lp - depth, e.Lfloor), 0);
      const [c2, h2] = tintOf(outL, e.Cp, e.hp, 0.5);
      return e.finish(fromOklch(outL, c2, h2, a));
    }
    if (role === 'foreground') {
      // Dark text is the strongest the darker it is. Light text is either faded text on a light page or text on a dark box
      // (which the mode turns light): near white it is ink, and in between it is as faded as the contrast floor allows.
      const faded = L < 0.5 ? (L / 0.5) ** 1.5 : L < 0.9 ? 1 : (1 - L) / 0.1;
      const fade = (EINK_FADE * faded * (1 - acc * 0.85)) / e.k;
      const outL = einkSnap(e, Math.min(e.Li + fade, e.Lp - 0.2), -1);
      const [c2, h2] = tintOf(outL, e.Ci, e.hi, EINK_MUTE);
      const { page, card } = einkSurfaces(e);
      return einkContrast(e, fromOklch(outL, c2, h2, a), [page, card], e.textMin);
    }
    // Borders, rules and outlines.
    const t = L >= 0.5 ? (1 - L) / 0.5 : 1 - (0.2 * (0.5 - L)) / 0.5;
    const span = e.Lp - e.Li;
    const depth = Math.min(span, (0.16 + (span - 0.16) * t ** 1.2) * e.k);
    const outL = einkSnap(e, e.Lp - depth, -1);
    const [c2, h2] = tintOf(outL, e.Cp * 1.1, e.hp, 0.7);
    const { page, card } = einkSurfaces(e);
    const target = role === 'edge' ? EDGE_MIN : e.borderMin;
    return einkContrast(e, fromOklch(outL, c2, h2, a), role === 'edge' ? [page, card] : [page], target);
  }


  /**
   * The flattening of a gradient for the rewriter of the mode (it calls this once, with its own helpers).
   * @param {{ splitTopLevel: (text: string) => string[], splitSpaces: (text: string) => string[], colorOf: (text: string, role: string) => string | null }} env
   */
  function flatten(env) {
    const { splitTopLevel, splitSpaces, colorOf } = env;
    /**
     * A gradient of the E-ink and Paper mode. With a translucent or transparent stop it is a glow, a fade or a scrim and is dropped
     * (`none`); with only opaque stops it becomes one solid color, the themed average. Hard stops (a progress bar) are left to the
     * normal path. A stop that is not a plain color (`var()`, `currentcolor`) cannot be judged: a radial or conic gradient with
     * one is a glow or a halo and is dropped, a linear one takes the normal path.
     * @param {string} inner the text between the parentheses @param {string} kind the name of the gradient function, lower case
     * @returns {string | null}
     */
    function flattenGradient(inner, kind) {
      const colors = color;
      /** @type {{ r: number, g: number, b: number, a: number }[]} */
      const stops = [];
      let lastPosition = '';
      let unknown = false;
      for (const part of splitTopLevel(inner)) {
        if (/var\(|env\(|attr\(|currentcolor/i.test(part)) {
          unknown = true;
          continue;
        }
        let found = null;
        let position = '';
        let positions = 0;
        for (const token of splitSpaces(part)) {
          const parsed = colors.parseColor(token);
          if (parsed) found = parsed;
          else if (/^[+-]?(?:\d|\.\d)/.test(token) && !/^[+-]?[\d.]+deg$/i.test(token)) {
            position += `${token} `;
            positions += 1;
          }
        }
        // A direction, a shape or a color hint holds no color.
        if (found === null) continue;
        if (positions > 1 || (position !== '' && position === lastPosition)) return null;
        lastPosition = position;
        stops.push(found);
      }
      if (stops.some((c) => c.a < 0.98)) return 'none';
      if (unknown) return /^(?:-webkit-|-moz-)?(?:repeating-)?(?:radial|conic)-gradient$/.test(kind) ? 'none' : null;
      if (stops.length < 2) return null;
      const n = stops.length;
      const mean = { r: stops.reduce((s, c) => s + c.r, 0) / n, g: stops.reduce((s, c) => s + c.g, 0) / n, b: stops.reduce((s, c) => s + c.b, 0) / n, a: 1 };
      const themed = colorOf(colors.toHex(mean), 'background');
      return themed === null ? null : `linear-gradient(${themed},${themed})`;
    }
    return flattenGradient;
  }

  /**
   * Make the transitions that the page declares end at once. A transition starts only where the page gave it a duration, and
   * `transitionrun` is sent for it; it is finished before the frame is drawn, so `transitionend` still comes and the page ends in
   * its final state, as with a 0.01 ms duration. Elements without a transition cost nothing. Only the elements that sent
   * `transitionrun` are handled, once a frame: `getAnimations`, even on one element, costs time in proportion to every animation
   * of the document, so the document is asked once. All reads come before the finishes, which make the style stale.
   * @returns {() => void} stops it
   */
  function endTransitions() {
    /** The elements whose transitions started since the last frame. @type {Set<Element>} */
    const started = new Set();
    let frame = 0;
    let timer = 0;
    const finish = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = timer = 0;
      const inDocument = new Set();
      /** @type {Animation[]} */
      const found = [];
      for (const target of started) {
        if (!target.isConnected) continue;
        if (target.getRootNode() === document) inDocument.add(target);
        // The document's list may leave out a shadow tree; `subtree` brings in the pseudo-elements.
        else found.push(...target.getAnimations({ subtree: true }));
      }
      started.clear();
      // A pseudo-element's transition has its host as the target of its effect.
      if (inDocument.size > 0) for (const a of document.getAnimations()) if (inDocument.has(/** @type {any} */ (a.effect)?.target)) found.push(a);
      const due = found.filter((a) => typeof (/** @type {any} */ (a).transitionProperty) === 'string' && a.playState !== 'finished');
      for (const a of due) {
        try {
          a.finish();
        } catch {
          // A transition that cannot be finished runs out by itself.
        }
      }
    };
    const onRun = (/** @type {Event} */ event) => {
      if (event.target instanceof Element) started.add(event.target);
      if (frame !== 0) return;
      frame = requestAnimationFrame(finish);
      // A hidden tab draws no frames.
      timer = setTimeout(finish, 100);
    };
    addEventListener('transitionrun', onRun, true);
    return () => {
      removeEventListener('transitionrun', onRun, true);
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = timer = 0;
      started.clear();
    };
  }

  color.useEink({ palette: einkPalette, transform: einkTransform, surfaces: einkSurfaces });
  /** @type {Record<string, any>} */ (dk).einkpalette = Object.freeze({ ready: true, flatten, endTransitions });
})();
