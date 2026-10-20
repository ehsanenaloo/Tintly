// @ts-check
// The Filter and Filter+ engines. Both put one filter on the root element and give the media of the page a
// matching filter that undoes it. Neither reads the page's stylesheets, so the cost does not grow with the page.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;
  const color = /** @type {any} */ (dk.color);
  const keepApi = /** @type {any} */ (dk.keep);
  if (!color) return;

  const STATE = 'data-dk-state';
  const CANVAS_TAG = 'dk-canvas';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FILTER_ID = 'dk-fp';
  const COUNTER_ID = 'dk-fp-media';
  const LUMA = [0.2126, 0.7152, 0.0722];
  // How much of the original saturation Filter+ keeps. Less than 1, because a color that gets lighter has less room
  // for chroma, and a matrix cannot reduce chroma only where it is needed. 0.9 gave the lowest worst-case hue error
  // that still keeps media close to the original.
  const CHROMA = 0.9;

  /** @typedef {number[][]} Matrix  4 rows (r, g, b, a) of 5 columns (r, g, b, a, offset), as feColorMatrix reads it */

  /* ---------------------------------------------------------------- */
  /* Matrix math                                                       */
  /* ---------------------------------------------------------------- */

  /** @returns {Matrix} */
  const identity = () => [
    [1, 0, 0, 0, 0],
    [0, 1, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 1, 0],
  ];

  /** Full inversion of the three color channels. @returns {Matrix} */
  const invertColors = () => [
    [-1, 0, 0, 0, 1],
    [0, -1, 0, 0, 1],
    [0, 0, -1, 0, 1],
    [0, 0, 0, 1, 0],
  ];

  /** The matrix that does `first`, then `second`. @param {Matrix} first @param {Matrix} second @returns {Matrix} */
  function compose(first, second) {
    /** @type {Matrix} */
    const out = [];
    for (let r = 0; r < 4; r++) {
      const row = [0, 0, 0, 0, second[r][4]];
      for (let c = 0; c < 5; c++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += second[r][k] * first[k][c];
        row[c] += sum;
      }
      out.push(row);
    }
    return out;
  }

  /**
   * White becomes `bg`, black becomes `fg`, and the colors in between keep their direction away from gray, scaled
   * by `chroma`. In formula: out = fg - (fg - bg) * Y + chroma * (rgb - Y), with Y the luma of the input.
   * @param {number[]} bg @param {number[]} fg @param {number} chroma @returns {Matrix}
   */
  function themeMap(bg, fg, chroma) {
    /** @type {Matrix} */
    const m = [];
    for (let c = 0; c < 3; c++) {
      const row = [0, 0, 0, 0, fg[c]];
      for (let j = 0; j < 3; j++) row[j] = chroma * ((c === j ? 1 : 0) - LUMA[j]) - (fg[c] - bg[c]) * LUMA[j];
      m.push(row);
    }
    m.push([0, 0, 0, 1, 0]);
    return m;
  }

  /** @param {number} s 0 to 1 @returns {Matrix} the CSS `sepia()` filter */
  const sepia = (s) => {
    const k = 1 - s;
    return [
      [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0, 0],
      [0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0, 0],
      [0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k, 0, 0],
      [0, 0, 0, 1, 0],
    ];
  };

  /** @param {number} g 0 to 1 @returns {Matrix} the CSS `grayscale()` filter */
  const grayscale = (g) => {
    const k = 1 - g;
    return [
      [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k, 0, 0],
      [0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k, 0, 0],
      [0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k, 0, 0],
      [0, 0, 0, 1, 0],
    ];
  };

  /** @param {number} c @returns {Matrix} the CSS `contrast()` filter */
  const contrast = (c) => [
    [c, 0, 0, 0, 0.5 - 0.5 * c],
    [0, c, 0, 0, 0.5 - 0.5 * c],
    [0, 0, c, 0, 0.5 - 0.5 * c],
    [0, 0, 0, 1, 0],
  ];

  /** @param {number} b @returns {Matrix} the CSS `brightness()` filter */
  const brightness = (b) => [
    [b, 0, 0, 0, 0],
    [0, b, 0, 0, 0],
    [0, 0, b, 0, 0],
    [0, 0, 0, 1, 0],
  ];

  /**
   * The user's four adjustments in the order the CSS filters apply them.
   * @param {{ sepia: number, grayscale: number, contrast: number, brightness: number, warmth?: number }} t @returns {Matrix}
   */
  function adjustments(t) {
    let m = identity();
    if (t.sepia > 0) m = compose(m, sepia(t.sepia));
    if (t.grayscale > 0) m = compose(m, grayscale(t.grayscale));
    if (t.contrast !== 1) m = compose(m, contrast(t.contrast));
    if (t.brightness !== 1) m = compose(m, brightness(t.brightness));
    if (t.warmth) {
      const warm = { green: 0.12, blue: 0.45 };
      m = compose(m, [
        [1, 0, 0, 0, 0],
        [0, 1 - warm.green * t.warmth, 0, 0, 0],
        [0, 0, 1 - warm.blue * t.warmth, 0, 0],
        [0, 0, 0, 1, 0],
      ]);
    }
    return m;
  }

  /** The inverse of the color part of a matrix, or null when it has none. @param {Matrix} m @returns {Matrix | null} */
  function inverse(m) {
    const [[a, b, c], [d, e, f], [g, h, i]] = m;
    const A = e * i - f * h;
    const B = f * g - d * i;
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-6) return null;
    const inv = [
      [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
      [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ];
    /** @type {Matrix} */
    const out = [];
    for (let r = 0; r < 3; r++) {
      out.push([inv[r][0], inv[r][1], inv[r][2], 0, -(inv[r][0] * m[0][4] + inv[r][1] * m[1][4] + inv[r][2] * m[2][4])]);
    }
    out.push([0, 0, 0, 1, 0]);
    return out;
  }

  /** What a matrix does to one color, as the browser would: clamped to 0..1. @param {Matrix} m @param {number[]} rgb */
  function apply(m, rgb) {
    return [0, 1, 2].map((r) => Math.min(1, Math.max(0, m[r][0] * rgb[0] + m[r][1] * rgb[1] + m[r][2] * rgb[2] + m[r][4])));
  }

  /** @param {Matrix} m */
  const values = (m) => m.flat().map((v) => Math.round(v * 10000) / 10000).join(' ');

  /** Is this the identity matrix? @param {Matrix} m */
  function isIdentity(m) {
    const id = identity();
    return m.every((row, r) => row.every((v, c) => Math.abs(v - id[r][c]) < 1e-9));
  }

  /**
   * The root matrix and its inverse for a theme. Dark inverts the lightness (a filter cannot tell a dark page from a light one):
   * white becomes the theme background, black the theme text. Light applies only the sliders and has no inverse.
   * @param {Record<string, any>} themeSettings
   * @returns {{ matrix: Matrix, counter: Matrix | null, dark: boolean }}
   */
  function themeMatrix(themeSettings) {
    const theme = color.createTheme(themeSettings);
    if (theme.eink) return einkMatrix(theme);
    if (!theme.dark) return { matrix: adjustments(theme), counter: null, dark: false };
    const pick = (/** @type {string} */ key, /** @type {string} */ fallback) => {
      const c = color.parseColor(themeSettings[key]) ?? color.parseColor(fallback);
      return [c.r, c.g, c.b];
    };
    // `themeMap(whiteBecomes, blackBecomes)`.
    const whiteBecomes = theme.dark ? pick('darkBackground', '#16181d') : pick('lightText', '#1a1c20');
    const blackBecomes = theme.dark ? pick('darkText', '#e6e8eb') : pick('lightBackground', '#eeece8');
    const matrix = compose(themeMap(whiteBecomes, blackBecomes, CHROMA), adjustments(theme));
    return { matrix, counter: inverse(matrix), dark: theme.dark };
  }

  /**
   * The E-ink and Paper mode with a filter: white becomes the paper and black the ink (both after the blue and cap steps),
   * the colors in between keep part of their direction away from gray (none in mono), and the pictures are made calm by
   * the media rule. No invert. The number of gray levels is a step function applied before the matrix.
   * @param {ReturnType<typeof color.createTheme>} theme
   * @returns {{ matrix: Matrix, counter: Matrix | null, dark: boolean, levels: number }}
   */
  function einkMatrix(theme) {
    const e = theme.eink;
    const paper = color.transformColor(theme, { r: 1, g: 1, b: 1, a: 1 }, 'background');
    const ink = color.transformColor(theme, { r: 0, g: 0, b: 0, a: 1 }, 'foreground');
    // A matrix with no chroma has no inverse. Pictures that stay as they are need one, so they get a little.
    const amount = e.einkColorAmount / 100;
    const chroma = amount === 0 ? (e.einkImages === 'off' ? 0.2 : 0) : Math.max(0.05, 0.55 * amount);
    let matrix = themeMap([paper.r, paper.g, paper.b], [ink.r, ink.g, ink.b], chroma);
    if (e.k !== 1) matrix = compose(contrast(e.k), matrix);
    return { matrix, counter: inverse(matrix), dark: false, levels: e.einkLevels };
  }

  /* ---------------------------------------------------------------- */
  /* The engine                                                        */
  /* ---------------------------------------------------------------- */

  const MEDIA = 'img, video, canvas, embed, object, iframe, [style*="background-image" i]:not(html):not(body)';
  // A medium inside something that is already restored must not be restored a second time.
  const NESTED = '[style*="background-image" i] :is(img, video, canvas, embed, object, iframe)';

  /** @type {{ end: () => void, stats: () => any } | null} */
  let active = null;

  /**
   * @param {Record<string, any>} themeSettings
   * @param {'filter' | 'filterPlus'} kind
   */
  function createEngine(themeSettings, kind) {
    const doc = document;
    const root = doc.documentElement;
    const startedAt = performance.now();
    const theme = color.createTheme(themeSettings);

    /** @type {string} */
    let rootFilter;
    /** @type {string} */
    let counterFilter;
    /** @type {SVGSVGElement | null} */
    let svg = null;
    let usedMatrix = false;

    const eink = !!theme.eink;
    // The light mode does not invert: only the sliders apply, and the media need no counter filter.
    const light = !theme.dark && !eink;
    // Color vision: theme-engines.md 11.2.
    const cvdApi = /** @type {any} */ (dk)?.cvd;
    const vision = theme.cvd && cvdApi ? theme.cvd : null;
    const plus = kind === 'filterPlus' || eink ? /** @type {ReturnType<typeof themeMatrix> & { levels?: number }} */ (themeMatrix(themeSettings)) : null;
    if (light && !(plus && !isIdentity(plus.matrix))) {
      const parts = [];
      if (!plus) {
        if (theme.brightness !== 1) parts.push(`brightness(${theme.brightness})`);
        if (theme.contrast !== 1) parts.push(`contrast(${theme.contrast})`);
        const warmSepia = Math.min(1, (theme.sepia || 0) + 0.3 * (theme.warmth || 0));
        if (warmSepia > 0) parts.push(`sepia(${warmSepia})`);
        if (theme.grayscale > 0) parts.push(`grayscale(${theme.grayscale})`);
      }
      rootFilter = parts.length ? parts.join(' ') : 'none';
      counterFilter = 'none';
    } else if (plus && (plus.counter || eink || light)) {
      svg = /** @type {SVGSVGElement} */ (doc.createElementNS(SVG_NS, 'svg'));
      svg.setAttribute('data-dk', 'filter-defs');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none');
      /** @param {string} id @param {Matrix} m */
      const define = (id, m) => {
        const f = doc.createElementNS(SVG_NS, 'filter');
        f.setAttribute('id', id);
        f.setAttribute('color-interpolation-filters', 'sRGB');
        f.setAttribute('x', '0');
        f.setAttribute('y', '0');
        f.setAttribute('width', '100%');
        f.setAttribute('height', '100%');
        const fe = doc.createElementNS(SVG_NS, 'feColorMatrix');
        fe.setAttribute('type', 'matrix');
        fe.setAttribute('values', values(m));
        f.append(fe);
        /** @type {SVGSVGElement} */ (svg).append(f);
      };
      define(FILTER_ID, plus.matrix);
      if (plus.counter) define(COUNTER_ID, plus.counter);
      if (eink && plus.levels && plus.levels >= 2) {
        // Gray levels: each channel is cut into steps before the matrix, so white and black stay white and black.
        const n = plus.levels;
        const f = svg.querySelector(`#${FILTER_ID}`);
        const transfer = doc.createElementNS(SVG_NS, 'feComponentTransfer');
        const table = Array.from({ length: n }, (_, i) => Math.round((i / (n - 1)) * 10000) / 10000).join(' ');
        for (const name of ['feFuncR', 'feFuncG', 'feFuncB']) {
          const fn = doc.createElementNS(SVG_NS, name);
          fn.setAttribute('type', 'discrete');
          fn.setAttribute('tableValues', table);
          transfer.append(fn);
        }
        f?.insertBefore(transfer, f.firstChild);
      }
      // The page's own address with a fragment is a reference to this document, even when the page has a <base> element.
      const here = doc.URL.split('#')[0];
      rootFilter = `url("${here}#${FILTER_ID}")`;
      counterFilter = plus.counter ? `url("${here}#${COUNTER_ID}")` : 'none';
      // The sliders of the light mode filter nothing back: the media stay as they are.
      if (eink) {
        // Calm pictures: gray (and a little darker when dimmed) in the filter, or put back as the page has them.
        const e = theme.eink;
        if (e.einkImages !== 'off') counterFilter = `${e.einkImages === 'follow' ? '' : 'grayscale(1) '}contrast(${e.einkImageContrast / 100})${e.einkImages === 'gray' ? '' : ' brightness(.88)'}`;
      }
      usedMatrix = true;
    } else {
      // Plain inversion. It undoes itself, so the media get the same filter again and come out unchanged.
      // Filter+ falls back to this when its matrix has no inverse.
      const parts = ['invert(1)', 'hue-rotate(180deg)'];
      if (theme.brightness !== 1) parts.push(`brightness(${theme.brightness})`);
      if (theme.contrast !== 1) parts.push(`contrast(${theme.contrast})`);
      // The plain filter has no color matrix, so the night shift is a little extra sepia.
      const warmSepia = Math.min(1, (theme.sepia || 0) + 0.3 * (theme.warmth || 0));
      if (warmSepia > 0) parts.push(`sepia(${warmSepia})`);
      if (theme.grayscale > 0) parts.push(`grayscale(${theme.grayscale})`);
      rootFilter = parts.join(' ');
      counterFilter = 'invert(1) hue-rotate(180deg)';
    }
    let frameFilter = counterFilter;
    if (vision) {
      svg ??= cvdApi.defs(doc, 'filter-defs');
      const back = counterFilter === 'none' ? '' : !usedMatrix ? 'plain' : plus?.counter && counterFilter.includes(COUNTER_ID) ? values(plus.counter) : null;
      const out = cvdApi.chain(vision, svg, rootFilter, usedMatrix, back);
      rootFilter = out.root;
      frameFilter = out.frame ?? frameFilter;
    }
    const restoreMedia = !light || frameFilter !== 'none';

    // On a page shorter than the window the canvas is outside the filtered root box. A fixed layer in the root, behind
    // everything, takes the canvas color and is filtered with the page. The plain filter needs it only when the page gives none.
    let fill = rootFilter === 'none' ? '' : '#fff';
    // Reads of the page styles for the layer color (in the stats), and reads allowed after a later change.
    let judged = 0;
    let rejudged = 0;
    const MAX_REJUDGE = 24;
    /** @returns {string} the CSS color of the layer, or '' for no layer */
    function judgeCanvas() {
      // Until the page script sets `data-dk-go` the first-paint sheet colors the root and the body.
      if (rootFilter === 'none' || !root.hasAttribute('data-dk-go')) return fill;
      judged++;
      const html = getComputedStyle(root);
      const body = doc.body ? getComputedStyle(doc.body) : null;
      /** @param {CSSStyleDeclaration} cs */
      const paint = (cs) => {
        if (cs.backgroundImage !== 'none') return 'image';
        const c = color.parseColor(cs.backgroundColor);
        return c && c.a > 0 ? c : null;
      };
      let own = paint(html);
      if (!own && body) own = paint(body);
      if (own === 'image') return '';
      if (!own) return '#fff';
      // An SVG filter on the root does not reach the canvas.
      if (!usedMatrix && !vision) return '';
      const a = own.a;
      return color.toHex({ r: own.r * a + 1 - a, g: own.g * a + 1 - a, b: own.b * a + 1 - a, a: 1 });
    }
    // The layer is an element of ours, since a page may use `html::before` itself. All important, so no page rule reaches it.
    const sheet = () =>
      `@media screen{${rootFilter === 'none' ? '' : `html{filter:${rootFilter}!important}`}` +
      (fill === '' ? '' : `${CANVAS_TAG}[data-dk=canvas]{${`all:initial;position:fixed;inset:0;z-index:-2147483648;pointer-events:none;background:${fill}`.replace(/;|$/g, '!important;')}}`) +
      (restoreMedia ? `${MEDIA}{filter:${counterFilter}!important}iframe{filter:${frameFilter}!important}${NESTED}{filter:none!important}` : '') +
      '}';

    const style = doc.createElement('style');
    style.setAttribute('data-dk', 'filter');
    style.textContent = sheet();
    const canvasLayer = doc.createElement(CANVAS_TAG);
    canvasLayer.setAttribute('data-dk', 'canvas');
    canvasLayer.setAttribute('aria-hidden', 'true');
    // The page may remove these (a script that rebuilds the head); they come back.
    const keeper = keepApi ? keepApi.create() : null;
    const placeLayer = () => {
      if (fill === '') {
        keeper?.untrack(canvasLayer);
        canvasLayer.remove();
      } else if (doc.body) {
        if (!canvasLayer.isConnected) root.append(canvasLayer);
        keeper?.track(canvasLayer, () => root.append(canvasLayer));
      }
    };

    (doc.head ?? root).append(style);
    placeLayer();
    if (svg) root.append(svg);
    root.setAttribute(STATE, 'ready');
    keeper?.track(style, () => (doc.head ?? root).append(style));
    if (svg) keeper?.track(svg, () => root.append(/** @type {SVGSVGElement} */ (svg)));

    // A later sheet may give the canvas color: read again when the body exists, a sheet loads and the page loads.
    function repaintCanvas() {
      const next = judgeCanvas();
      if (next === fill) return;
      fill = next;
      style.textContent = sheet();
      placeLayer();
    }
    // A loaded sheet, or a class or style change of the root or body, is read in the next frame, once for all before it,
    // and at most MAX_REJUDGE times after load.
    let frameId = 0;
    function later() {
      if (frameId !== 0 || rejudged >= MAX_REJUDGE) return;
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        rejudged++;
        repaintCanvas();
      });
    }
    /** @param {Event} e */
    const onLink = (e) => {
      if (e.target instanceof HTMLLinkElement) later();
    };
    /** @type {MutationObserver | null} */
    let attrs = null;
    function watchAttributes() {
      if (!attrs || !doc.body) return;
      attrs.observe(doc.body, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    const onReady = () => {
      repaintCanvas();
      placeLayer();
      watchAttributes();
    };
    if (rootFilter !== 'none') {
      if (typeof MutationObserver === 'function') {
        attrs = new MutationObserver(later);
        attrs.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
      }
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', onReady, { once: true });
      else queueMicrotask(onReady);
      doc.addEventListener('load', onLink, true);
      globalThis.addEventListener('load', repaintCanvas, { once: true });
    }

    return {
      end() {
        doc.removeEventListener('DOMContentLoaded', onReady);
        doc.removeEventListener('load', onLink, true);
        globalThis.removeEventListener('load', repaintCanvas);
        attrs?.disconnect();
        if (frameId !== 0) cancelAnimationFrame(frameId);
        keeper?.stop();
        style.remove();
        canvasLayer.remove();
        svg?.remove();
        root.removeAttribute(STATE);
      },
      stats: () => ({
        kind,
        ready: true,
        usedMatrix,
        restored: keeper ? keeper.stats().restored : 0,
        startedAt,
        readyAt: startedAt,
        filter: rootFilter,
        canvasJudged: judged,
      }),
    };
  }

  /** @param {Record<string, any>} themeSettings @param {'filter' | 'filterPlus'} kind */
  function start(themeSettings, kind) {
    stop();
    active = createEngine(themeSettings ?? {}, kind);
  }

  function stop() {
    if (active) active.end();
    active = null;
  }

  /**
   * A bare SVG document: a dark canvas, and the drawing inverted so black strokes stay visible. One style element on the root.
   * @param {boolean} on @param {string} mode @param {Record<string, any>} themeSettings
   */
  function svgDocument(on, mode, themeSettings) {
    const root = document.documentElement;
    let el = /** @type {Element | null} */ (root.querySelector(':scope > style[data-dk="svg"]'));
    if (!on || mode === 'light' || mode === 'eink' || mode === 'original') {
      el?.remove();
      return;
    }
    const theme = color.createTheme(themeSettings);
    const page = color.toHex(color.transformColor(theme, { r: 1, g: 1, b: 1, a: 1 }, 'background'));
    const parts = ['invert(1)', 'hue-rotate(180deg)'];
    if (theme.brightness !== 1) parts.push(`brightness(${theme.brightness})`);
    if (theme.contrast !== 1) parts.push(`contrast(${theme.contrast})`);
    if (theme.sepia > 0) parts.push(`sepia(${theme.sepia})`);
    if (theme.grayscale > 0) parts.push(`grayscale(${theme.grayscale})`);
    if (!el) {
      el = document.createElementNS(SVG_NS, 'style');
      el.setAttribute('data-dk', 'svg');
      root.append(el);
    }
    el.textContent = `@media screen{:root{background:${page};filter:${parts.join(' ')}}}`;
  }

  dk.filter = Object.freeze({
    start,
    stop,
    svgDocument,
    isActive: () => active !== null,
    stats: () => (active ? active.stats() : null),
    // The matrix functions are exported so the unit tests can check them without a browser.
    matrix: Object.freeze({ identity, isIdentity, compose, themeMap, themeMatrix, adjustments, inverse, apply, values, invertColors }),
  });
})();
