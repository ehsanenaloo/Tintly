// @ts-check
// Images of a themed page, sorted from a 32 by 32 copy: keep, dim, invert, plate (scan codes), flip (a white icon the page turns dark).
// CSS pictures, canvases and the legacy `background` attribute are imagebg.js, which joins a run of this module.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;
  const keepApi = /** @type {any} */ (dk.keep);
  const ns = /** @type {Record<string, any>} */ (dk);

  const ATTR = 'data-dk-img';
  const BG_ATTR = 'data-dk-bg';
  /** A picture that the page multiplies over a light tile, and the boxes around it that do the same: shown as they are on a dark page. */
  const BLEND_ATTR = 'data-dk-bl';
  /** The empty layer of a rating (a light shape under a colored layer of about its size) is muted: an SVG of it, or a masked box (the BG mark `empty`). */
  const EMPTY_ATTR = 'data-dk-empty';
  const TILE_MIN = 4;
  // A dark logo with a bright colored part. The share is of the visible pixels; a bright part is at least half of the colored ones.
  const GLARE_TONES = 0.4;
  const GLARE_TONES_MIN = 24;
  const READ_RETRY_MS = 1500;
  const READ_RETRIES = 2;
  const MIXED_FILTER = 'dk-mixed';
  const MIXED_CHROMA = 64;
  const MIXED_SHARE = 0.015;
  const MIXED_LUM = 0.4;
  const MIXED_BRIGHT = 0.5;
  const MIXED_MASK = 6;
  const EMPTY_FALLBACK = '#4a4d54';
  const STAR_MAX_SVG = 400;
  const STAR_MAX_SIDE = 64;
  const STAR_HOST_MAX = 12;
  const STAR_BUDGET_MS = 6;
  const STAR_LOOKS = 4;
  const STAR_SHAPES = 'path,circle,ellipse,rect,polygon,use';
  const SAMPLE = 32;
  const MIN_SIDE = 12;
  const MAX_SIDE = 6000;
  const MAX_CACHE = 500;
  const MAX_ELEMENTS = 1500;
  const CONCURRENT = 2;
  // The cropped copy of a file of another origin is decoded here: the same pixel cap as the worker's copy, and a time limit.
  const CROP_PIXELS = 16_000_000;
  const CROP_MS = 3000;
  // E-ink and Paper (`flip`): pictures up to FLIP_SIDE that are light marks wait, FLIP_BATCH at a time, for a read of the page's own filter.
  const FLIP_SIDE = 400;
  const FLIP_BATCH = 24;
  const FLIP_LIGHTS = 80;

  const FLAT_COLORS = 40;
  const GLARE_LUM = 0.7;
  const GLARE_SHARE = 0.5;
  const GLARE_GROUND = 0.5;
  const GLARE_OPAQUE = 0.9;
  const GLARE_WIDTH = 0.5;
  const GLARE_HEIGHT = 200;
  const ALPHA_SHARE = 0.1;
  const CODE_STEPS = 0.22;

  /** @param {Uint8ClampedArray | number[]} rgba */
  function looksLikeCode(rgba) {
    const side = Math.round(Math.sqrt(rgba.length >> 2));
    if (side * side * 4 !== rgba.length || side < 8) return false;
    /** @param {number} i pixel index @returns {boolean} */
    const dark = (i) => rgba[i * 4 + 3] >= 128 && (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255 < 0.4;
    let marks = 0;
    let steps = 0;
    let pairs = 0;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const d = dark(y * side + x);
        if (d) marks += 1;
        if (x + 1 < side) {
          pairs += 1;
          if (d !== dark(y * side + x + 1)) steps += 1;
        }
      }
    }
    const share = marks / (side * side);
    return share >= 0.2 && share <= 0.7 && steps / pairs >= CODE_STEPS;
  }

  /**
   * A map is cut into placed pictures of one size. Judged one by one, the plain ones would show as squares of another shade.
   * @param {HTMLImageElement} img
   */
  function isTile(img) {
    const parent = img.parentElement;
    if (!parent || getComputedStyle(img).position !== 'absolute') return false;
    let same = 0;
    for (let n = parent.firstElementChild, seen = 0; n && seen < 64; n = n.nextElementSibling, seen++) {
      if (n.tagName === 'IMG' && /** @type {HTMLElement} */ (n).offsetWidth === img.offsetWidth && /** @type {HTMLElement} */ (n).offsetHeight === img.offsetHeight) same++;
    }
    return same >= TILE_MIN;
  }

  /** @param {Uint8ClampedArray | number[]} rgba @param {{ square?: boolean }} [shape] @returns {'keep' | 'dim' | 'invert' | 'plate'} */
  function classify(rgba, shape = {}) {
    const n = rgba.length >> 2;
    if (n === 0) return 'keep';
    let clear = 0;
    let opaque = 0;
    let lumSum = 0;
    let satSum = 0;
    let white = 0;
    const hues = [0, 0, 0, 0, 0, 0];
    let colored = 0;
    /** @type {Set<number>} */
    const bins = new Set();
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      if (a < 32) {
        clear += 1;
        continue;
      }
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      opaque += 1;
      lumSum += lum;
      satSum += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      if (lum > 0.9) white += 1;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma > 64) {
        const h = r === Math.max(r, g, b) ? ((g - b) / chroma + 6) % 6 : g === Math.max(r, g, b) ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
        hues[Math.min(5, Math.floor(h))] += 1;
        colored += 1;
      }
      bins.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
    if (opaque < n * 0.02) return 'keep';
    const meanLum = lumSum / opaque;
    const meanSat = satSum / opaque;
    const flat = bins.size <= FLAT_COLORS;
    const hasAlpha = clear / n >= ALPHA_SHARE;
    if (flat) {
      if (hasAlpha && shape.square === true && looksLikeCode(rgba)) return 'plate';
      const manyHues = colored > 0 && Math.max(...hues) / colored < 0.75;
      if (hasAlpha) return meanLum < 0.4 && (meanSat < 0.25 || meanLum < 0.3) && white / opaque < 0.1 && !manyHues ? 'invert' : 'keep';
      return white / opaque >= 0.5 ? 'dim' : 'keep';
    }
    return 'keep';
  }

  /**
   * A big picture that is mostly bright is a lamp on a dark page. A drawing turns dark and keeps its hues; a photo is dimmed.
   * @param {Uint8ClampedArray | number[]} rgba @returns {'night' | 'glare' | ''}
   */
  function glareOf(rgba) {
    let opaque = 0;
    let bright = 0;
    /** @type {Set<number>} */
    const bins = new Set();
    /** @type {Map<number, number>} */
    const fine = new Map();
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] < 250) continue;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      opaque += 1;
      if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > GLARE_LUM) bright += 1;
      bins.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      const tone = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      fine.set(tone, (fine.get(tone) ?? 0) + 1);
    }
    if (opaque < (rgba.length >> 2) * GLARE_OPAQUE || bright / opaque < GLARE_SHARE) return '';
    // A drawing has one ground color. A pale photo has few colors at this coarse grid too, but its tones are spread.
    const [first = 0, second = 0] = [...fine.values()].sort((a, b) => b - a);
    // A photo on a white ground has one ground color too. What stands on the ground has many fine tones in a photo and few in a drawing.
    const figure = opaque - first - second;
    const tones = fine.size - 2;
    const drawn = tones < GLARE_TONES_MIN || tones / figure < GLARE_TONES;
    return drawn && bins.size <= FLAT_COLORS && (first + second) / opaque >= GLARE_GROUND ? 'night' : 'glare';
  }

  /** Inverting turns a bright color dark, so such a picture needs the `mixed` filter. @param {Uint8ClampedArray | number[]} rgba */
  function mixedOf(rgba) {
    let opaque = 0;
    let colored = 0;
    let bright = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] < 32) continue;
      opaque += 1;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) <= MIXED_CHROMA) continue;
      colored += 1;
      if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 >= MIXED_LUM) bright += 1;
    }
    return opaque > 0 && colored / opaque >= MIXED_SHARE && bright / colored >= MIXED_BRIGHT;
  }

  /** @param {Element} img */
  function isWide(img) {
    const box = img.getBoundingClientRect();
    return box.width >= innerWidth * GLARE_WIDTH && box.height >= GLARE_HEIGHT;
  }

  const HIDE = 'background-image:none!important';
  const WALL = 'background-color:var(--dk-ground,#888)!important;background-blend-mode:difference!important';
  const TILE_CSS = `[${BG_ATTR}="tile"]{${HIDE}}[${BG_ATTR}="wall"]{${WALL}}[${ATTR}="wall"],[${BG_ATTR}="overlay"]{mix-blend-mode:difference}[${BG_ATTR}="lines"]{background-blend-mode:difference}`;
  const CSS = `@media screen{${TILE_CSS}[${ATTR}="invert"],[${ATTR}="night"],[${BG_ATTR}="invert"]{filter:invert(1) hue-rotate(180deg) var(--dk-cvd-media,)!important}[${ATTR}="mixed"],[${BG_ATTR}="mixed"]{filter:url("#${MIXED_FILTER}") var(--dk-cvd-media,)!important}[${BG_ATTR}="veil"]{box-shadow:inset 0 0 0 100vmax rgb(0 0 0/.7)!important}[${ATTR}="glare"]{filter:brightness(.7) var(--dk-cvd-media,)!important}[${BG_ATTR}="dusk"]{background-color:#4d4d4d!important;background-blend-mode:multiply!important}[${ATTR}="dim"],[${BG_ATTR}="dim"]{filter:brightness(.9) var(--dk-cvd-media,)!important}[${ATTR}="plate"]{background-color:#fff!important}[${ATTR}="flip"]{filter:var(--dk-cvd-media,none)!important}[${BLEND_ATTR}]{mix-blend-mode:normal!important}[${EMPTY_ATTR}][${EMPTY_ATTR}] :is(${STAR_SHAPES}):is(${STAR_SHAPES}){fill:var(--dk-empty,${EMPTY_FALLBACK})!important}[${BG_ATTR}="empty"]{background-color:var(--dk-empty,${EMPTY_FALLBACK})!important}}`;

  /** @param {Uint8ClampedArray | number[]} rgba @param {string} filter */
  function filtered(rgba, filter) {
    const fns = [...filter.matchAll(/([\w-]+)\(([^)]*)\)/g)];
    if (!fns.length || fns.some((m) => m[1] !== 'invert' && m[1] !== 'brightness')) return null;
    const out = Uint8ClampedArray.from(rgba);
    for (const [, name, arg] of fns) {
      const k = parseFloat(arg) / (arg.includes('%') ? 100 : 1);
      for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = name === 'invert' ? out[i + c] + k * (255 - 2 * out[i + c]) : out[i + c] * k;
    }
    return out;
  }

  /** @param {Uint8ClampedArray | number[]} rgba */
  function toneOf(rgba) {
    let opaque = 0;
    let sum = 0;
    let sq = 0;
    let sat = 0;
    /** @type {Map<number, number>} */
    const bins = new Map();
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] < 128) continue;
      const lum = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
      opaque += 1;
      sum += lum;
      sq += lum * lum;
      sat += (Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) - Math.min(rgba[i], rgba[i + 1], rgba[i + 2])) / 255;
      const bin = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
    const mean = sum / (opaque || 1);
    return { solid: opaque > 0 && opaque >= (rgba.length >> 2) * 0.9, share: opaque / (rgba.length >> 2), mean, sd: Math.sqrt(Math.max(0, sq / (opaque || 1) - mean * mean)), sat: sat / (opaque || 1), colors: bins.size, top: Math.max(0, ...bins.values()) / (opaque || 1) };
  }

  /** @param {ReturnType<typeof toneOf>} t @param {number} [how] @returns {'pale' | 'deep' | 'wall' | 'lines' | 'none'} */
  function kindOf(t, how = 0) {
    // Light marks on a clear ground: line art that vanishes when the color under it turns light.
    if (!t.solid) return t.share >= 0.02 && t.mean >= 0.7 && t.sat < 0.25 && t.colors <= FLAT_COLORS ? 'lines' : 'none';
    if (how === 2 ? t.colors <= FLAT_COLORS || t.sd < 0.12 : how ? t.sd < 0.08 && (t.colors <= 64 || t.sd < 0.04) : t.sd < 0.02) return t.mean >= 0.5 ? 'pale' : 'deep';
    return t.mean < 0.3 && t.sat < 0.25 && t.colors <= FLAT_COLORS && t.top >= 0.45 ? 'wall' : 'none';
  }

  /** @param {Uint8ClampedArray | number[]} rgba @returns {'light' | 'dark' | 'none'} */
  function tileOf(rgba) {
    const k = kindOf(toneOf(rgba), 2);
    return k === 'pale' ? 'light' : k === 'deep' ? 'dark' : 'none';
  }

  /** Base64 to bytes: the engine's decoder (2 ms a MB), else a loop (a callback for each byte takes 300 ms a MB). @param {string} text @returns {Uint8Array<ArrayBuffer>} */
  function bytesOf(text) {
    const native = /** @type {any} */ (Uint8Array).fromBase64;
    if (typeof native === 'function') return native.call(Uint8Array, text);
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < out.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /** Verdicts and tones by address, kept over a restart (a mode switch). */
  const kept = { cache: new Map(), surfaces: new Map() };

  /** With `eink` only CSS pictures are marked here and `<img>` is calm.js's; with `light` only surfaces. @param {{ ignore?: string[], eink?: boolean, light?: boolean, einkMark?: boolean, fetchImage?: (url: string, sample?: boolean) => Promise<{ mime: string, base64?: string, sample?: string } | null> }} [options] */
  function start(options = {}) {
    const doc = document;
    /** @type {Map<string, 'night' | 'glare'>} */
    const glares = new Map();
    /** @type {Map<string, 'keep' | 'dim' | 'invert' | 'mixed' | 'plate' | 'flip'>} */
    const cache = kept.cache;
    /** @type {Set<HTMLImageElement>} */
    const queue = new Set();
    /** @type {Set<HTMLImageElement>} */
    const marked = new Set();
    /** @type {Set<Element>} */
    const blended = new Set();
    /** @type {Set<Element>} */
    const emptied = new Set();
    /** @type {WeakMap<Element, number>} how often the star pass has judged an SVG */
    const judged = new WeakMap();
    let tone = '';
    const stats = { analyzed: 0, fetched: 0, failed: 0, invert: 0, mixed: 0, night: 0, glare: 0, dim: 0, keep: 0, plate: 0, flip: 0, batches: 0, bgInvert: 0, bgDim: 0, bgDusk: 0, bgGray: 0, bgTile: 0, bgSkipped: 0, bgPhotos: 0, bgCapped: 0 };
    const eink = options.eink === true;
    const dark = !eink && options.light !== true;
    const flip = eink && options.einkMark === true;
    let running = 0;
    let dead = false;
    /** @type {Map<string, Uint8ClampedArray>} */
    const lights = new Map();
    /** @type {Map<HTMLImageElement, Uint8ClampedArray>} */
    const pending = new Map();
    /** @type {ReturnType<typeof setTimeout> | 0} */
    let flipTimer = 0;
    const skip = (options.ignore ?? [])
      .filter((s) => {
        try {
          doc.createDocumentFragment().querySelector(s);
          return true;
        } catch {
          return false;
        }
      })
      .join(',');

    const style = doc.createElement('style');
    style.setAttribute('data-dk', 'images');
    const sheet = dark ? CSS : `@media screen{${TILE_CSS}${flip ? `[${ATTR}="flip"]{filter:brightness(0)!important}` : ''}}`;
    style.textContent = sheet;
    (doc.head ?? doc.documentElement).append(style);

    /** The muted tone of an empty layer: the page color, a little lighter. It is read from the themed page, so it follows the person's tones. */
    function setTone() {
      const c = /** @type {any} */ (dk).color;
      let parsed = null;
      for (const el of [doc.documentElement, doc.body]) {
        if (!el) continue;
        const p = c.parseColor(getComputedStyle(el).backgroundColor);
        if (p && p.a > 0.5) {
          parsed = p;
          break;
        }
      }
      if (!parsed) return;
      const hex = [parsed.r, parsed.g, parsed.b].map((v) => Math.round((v * 0.78 + 0.22) * 255).toString(16).padStart(2, '0')).join('');
      if (tone === hex) return;
      tone = hex;
      style.textContent = `${sheet}:root{--dk-empty:#${hex}}`;
    }

    /** @param {Element} svg @returns {boolean} every shape is a light neutral fill */
    function lightNeutralShapes(svg) {
      const c = /** @type {any} */ (dk).color;
      let seen = 0;
      for (const shape of svg.querySelectorAll(STAR_SHAPES)) {
        // A shape that is not looked at could be colored, and the empty-layer fill reaches every shape: more than the bound is no.
        if (++seen > 8) return false;
        const p = c.parseColor(getComputedStyle(shape).fill);
        if (!p || p.a < 0.5) return false;
        const [l, chroma] = c.toOklch(p);
        if (l < 0.6 || chroma > 0.03) return false;
      }
      return seen > 0;
    }

    /** @param {Element} svg @returns {boolean} some shape has a color */
    function coloredShapes(svg) {
      const c = /** @type {any} */ (dk).color;
      let seen = 0;
      for (const shape of svg.querySelectorAll(STAR_SHAPES)) {
        if (++seen > 8) break;
        const p = c.parseColor(getComputedStyle(shape).fill);
        if (p && p.a >= 0.5 && c.toOklch(p)[1] > 0.06) return true;
      }
      return false;
    }

    /** @param {DOMRect} a @param {DOMRect} b @returns {boolean} the two boxes lie on each other and are about as big */
    function stacked(a, b) {
      const area = (/** @type {DOMRect} */ r) => r.width * r.height;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w <= 0 || h <= 0) return false;
      const ratio = area(a) / Math.max(area(b), 1);
      return ratio >= 0.4 && ratio <= 2.5 && w * h >= 0.5 * Math.min(area(a), area(b));
    }

    /**
     * The empty layer of a rating: a small SVG with only light neutral shapes that another SVG of about its size, with colored shapes,
     * lies on (the filled stars, cut to a width). It would show as a pale halo on the dark page, so it takes a muted tone. Only
     * SVGs that share a box with one to eleven others are looked at, and a pass has a time limit.
     */
    function starPass() {
      if (dead || !dark || !doc.body || doc.documentElement.getAttribute('data-dk-state') !== 'ready') return;
      const svgs = doc.getElementsByTagName('svg');
      if (svgs.length < 2) return;
      const began = performance.now();
      let count = 0;
      for (const svg of svgs) {
        if (++count > STAR_MAX_SVG || performance.now() - began > STAR_BUDGET_MS) break;
        const looks = judged.get(svg) ?? 0;
        if (looks >= STAR_LOOKS || svg.hasAttribute(EMPTY_ATTR) || (skip !== '' && svg.matches(skip))) continue;
        judged.set(svg, looks + 1);
        let host = svg.parentElement;
        for (let hop = 0; host && hop < 3 && host.getElementsByTagName('svg').length < 2; hop++) host = host.parentElement;
        if (!host) continue;
        const near = host.getElementsByTagName('svg');
        if (near.length < 2 || near.length > STAR_HOST_MAX) continue;
        const mine = svg.getBoundingClientRect();
        if (mine.width < 4 || mine.height < 4 || Math.max(mine.width, mine.height) > STAR_MAX_SIDE) {
          if (mine.width === 0) judged.set(svg, looks);
          continue;
        }
        if (!lightNeutralShapes(svg)) continue;
        for (const other of near) {
          if (other === svg || !stacked(mine, other.getBoundingClientRect()) || !coloredShapes(other)) continue;
          setTone();
          svg.setAttribute(EMPTY_ATTR, '');
          emptied.add(svg);
          break;
        }
      }
    }

    const keeper = keepApi ? keepApi.create() : null;
    keeper?.track(style, () => (doc.head ?? doc.documentElement).append(style));

    /** @type {{ el: Element, url: string, key: string, legacy?: boolean, blend?: boolean }[]} */
    const bgJobs = [];
    /** @type {SVGSVGElement | null} */
    let mixedDefs = null;
    /** Neutral pixels are inverted and colored pixels stay. The filter is found by a fragment, so a shadow tree gets the plain mark. @param {Element} el */
    function mixedMark(el) {
      if (el.getRootNode() !== doc) return 'invert';
      if (mixedDefs) return 'mixed';
      const k = MIXED_MASK;
      const NS = 'http://www.w3.org/2000/svg';
      /** @param {string} name @param {Record<string, string>} attrs @param {Element[]} [kids] */
      const node = (name, attrs, kids = []) => {
        const e = doc.createElementNS(NS, name);
        for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value);
        e.append(...kids);
        return e;
      };
      /** @param {string} result @param {string} alpha */
      const mask = (result, alpha) => node('feColorMatrix', { in: 'SourceGraphic', type: 'matrix', values: `1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 ${alpha} 0 0`, result });
      /** @param {string[]} layers @param {string} [result] */
      const merge = (layers, result) => node('feMerge', result ? { result } : {}, layers.map((name) => node('feMergeNode', { in: name })));
      const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (node('svg', { 'data-dk': 'mixed-defs', 'aria-hidden': 'true', width: '0', height: '0', style: 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none' }, [
        node('filter', { id: MIXED_FILTER, 'color-interpolation-filters': 'sRGB', x: '0', y: '0', width: '100%', height: '100%' }, [
          node('feColorMatrix', { in: 'SourceGraphic', type: 'matrix', values: '-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0', result: 'flip' }),
          mask('a', `${k} 0 ${-k}`),
          mask('b', `${-k} 0 ${k}`),
          mask('c', `${-k} ${k} 0`),
          mask('d', `${k} ${-k} 0`),
          merge(['a', 'b', 'c', 'd'], 'all'),
          node('feComposite', { in: 'all', in2: 'SourceAlpha', operator: 'in', result: 'color' }),
          merge(['flip', 'color']),
        ]),
      ])));
      mixedDefs = svg;
      keeper?.track(svg, () => doc.documentElement.append(svg));
      doc.documentElement.append(svg);
      return 'mixed';
    }
    /** @type {any} */
    const session = {
      mixedMark,
      doc, dark, eink, options, skip, cache, surfaces: kept.surfaces, stats, keeper, sheet, jobs: bgJobs,
      read: (/** @type {HTMLImageElement} */ img, /** @type {string} */ src, /** @type {Crop | null} */ crop) => read(img, src, crop),
      pixelsOf: (/** @type {ImageBitmapSource} */ source, /** @type {number} */ width, /** @type {number} */ height) => pixelsOf(source, width, height),
      pump: () => pump(),
      emptyTone: () => setTone(),
      setStyle: (/** @type {string} */ text) => {
        style.textContent = text;
      },
      dead: () => dead,
      runJob: null,
      bg: null,
    };

    /** @typedef {{ sx: number, sy: number, sw: number, sh: number }} Crop  a part of a picture, in its own pixels */

    /** @param {ImageBitmapSource} source @param {Crop | null} [crop] @returns {Uint8ClampedArray} */
    function pixelsOf(source, width = SAMPLE, height = SAMPLE, crop = null) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
      if (crop) ctx.drawImage(/** @type {CanvasImageSource} */ (source), crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
      else ctx.drawImage(/** @type {CanvasImageSource} */ (source), 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height).data;
    }

    /** @param {HTMLImageElement} img @param {string} src @param {Crop | null} [crop] */
    async function read(img, src, crop = null) {
      try {
        return pixelsOf(img, SAMPLE, SAMPLE, crop);
      } catch {
        // An image of another origin taints the canvas: the worker sends a copy.
      }
      if (!options.fetchImage || /^(data|blob):/i.test(src)) return null;
      // A part of the file is decoded here: a source too big to decode safely is refused before the fetch.
      if (crop && !(img.naturalWidth > 0 && img.naturalHeight > 0 && img.naturalWidth * img.naturalHeight <= CROP_PIXELS)) return null;
      const file = await options.fetchImage(src, crop === null);
      if (!file) return null;
      stats.fetched += 1;
      // The worker sends the 32 by 32 copy when it can make one, else the file.
      if (typeof file.sample === 'string') {
        if (crop) return null;
        const px = bytesOf(file.sample);
        return px.length === SAMPLE * SAMPLE * 4 ? new Uint8ClampedArray(px.buffer) : null;
      }
      if (typeof file.base64 !== 'string') return null;
      const bytes = bytesOf(file.base64);
      if (file.mime === 'image/svg+xml') return svgPixels(bytes, crop);
      const blob = new Blob([bytes], { type: file.mime });
      const resize = { resizeWidth: SAMPLE, resizeHeight: SAMPLE };
      if (!crop) {
        const bitmap = await createImageBitmap(blob, resize);
        try {
          return pixelsOf(bitmap);
        } finally {
          bitmap.close();
        }
      }
      const made = createImageBitmap(blob, Math.floor(crop.sx), Math.floor(crop.sy), Math.max(1, Math.round(crop.sw)), Math.max(1, Math.round(crop.sh)), resize);
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const bitmap = await Promise.race([made, new Promise((resolve) => (timer = setTimeout(() => resolve(null), CROP_MS)))]).finally(() => clearTimeout(timer));
      if (!bitmap) {
        // A decode that comes in late is closed when it arrives.
        made.then((late) => late.close(), () => {});
        return null;
      }
      try {
        return bitmap.width === SAMPLE && bitmap.height === SAMPLE ? pixelsOf(bitmap) : null;
      } finally {
        bitmap.close();
      }
    }

    /** @param {Uint8Array} bytes @param {Crop | null} [crop] @returns {Promise<Uint8ClampedArray | null>} */
    async function svgPixels(bytes, crop = null) {
      const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (bytes)], { type: 'image/svg+xml' }));
      try {
        const copy = new Image();
        copy.src = url;
        await copy.decode();
        return pixelsOf(copy, SAMPLE, SAMPLE, crop);
      } catch {
        return null;
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    /**
     * A product photo on a white ground that the page multiplies over a light tile makes the white vanish. Over the dark tile of the
     * dark mode the same multiplication makes the photo black, so the picture and each box around it that multiplies are shown as they are.
     * A box that multiplies blends its whole group, so a picture that does not multiply itself is looked at too.
     * @param {HTMLImageElement} img
     */
    function unblend(img) {
      const own = getComputedStyle(img).mixBlendMode === 'multiply';
      let depth = 0;
      for (let el = /** @type {HTMLElement | null} */ (img); el && el !== doc.body && depth < 6; el = el.parentElement, depth += 1) {
        if (el === img ? !own : blended.has(el) || getComputedStyle(el).mixBlendMode !== 'multiply') continue;
        el.setAttribute(BLEND_ATTR, '');
        blended.add(el);
      }
    }

    /** @param {HTMLImageElement} img */
    async function analyze(img) {
      if (dead || !img.isConnected) return;
      if (dark && !blended.has(img)) unblend(img);
      const src = img.currentSrc || img.src;
      if (!src) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (Math.min(w, h) < MIN_SIDE || Math.max(w, h) > (flip ? FLIP_SIDE : MAX_SIDE)) return;
      if (skip !== '' && img.matches(skip)) return;
      // The page's own filter: read without our mark.
      const had = img.getAttribute(ATTR);
      if (had) img.removeAttribute(ATTR);
      const filter = flip ? 'none' : getComputedStyle(img).filter;
      if (had) img.setAttribute(ATTR, had);
      const key = flip ? `f|${src}` : filter === 'none' ? src : `${src}|${filter}`;
      let action = cache.get(key);
      if (action === undefined || (flip && action === 'flip' && !lights.has(src))) {
        try {
          const pixels = await read(img, src);
          if (dead) return;
          if (!pixels) {
            stats.failed += 1;
            const tries = readRetries.get(src) ?? 0;
            if (tries < READ_RETRIES && readRetries.size < MAX_CACHE) {
              readRetries.set(src, tries + 1);
              setTimeout(() => {
                if (!dead && img.isConnected) consider(img);
              }, READ_RETRY_MS);
            }
            return;
          }
          const shape = { square: Math.abs(w - h) <= 0.04 * Math.max(w, h) };
          if (dark && !eink && !flip && filter === 'none') {
            const glare = glareOf(pixels);
            if (glare) {
              if (glares.size >= MAX_CACHE) glares.delete(/** @type {string} */ (glares.keys().next().value));
              glares.set(key, glare);
            }
          }
          // A light mark on a clear ground is the candidate of `flip`.
          action = flip ? (classify(/** @type {Uint8ClampedArray} */ (filtered(pixels, 'invert(1)')), shape) === 'invert' ? 'flip' : 'keep') : classify(pixels, shape);
          if (action === 'invert' && dark && !eink && filter === 'none' && mixedOf(pixels)) action = 'mixed';
          if (flip && action === 'flip') {
            if (lights.size >= FLIP_LIGHTS) lights.delete(/** @type {string} */ (lights.keys().next().value));
            lights.set(src, pixels);
          }
          const seen = filter === 'none' ? null : filtered(pixels, filter);
          if (seen) {
            // Our filter replaces the page's: a dark look is inverted when the file is dark too, else the page's filter is dropped.
            action = classify(seen, shape) === 'invert' ? (action === 'invert' ? 'invert' : 'flip') : 'keep';
          }
        } catch {
          stats.failed += 1;
          return;
        }
        stats.analyzed += 1;
        if (cache.size >= MAX_CACHE) cache.delete(/** @type {string} */ (cache.keys().next().value));
        cache.set(key, action);
      }
      stats[action] += 1;
      if (flip) {
        const px = lights.get(src);
        if (action === 'flip' && px && img.isConnected) {
          pending.set(img, px);
          flipTimer ||= setTimeout(flushFlip, 400);
        }
      } else if (img.isConnected && (img.currentSrc || img.src) === src) {
        const glare = action === 'keep' || action === 'dim' ? glares.get(key) : undefined;
        if (glare && isWide(img) && !isTile(img)) {
          img.setAttribute(ATTR, glare);
          stats[glare] += 1;
          // Text on a picture that turned dark is themed like any text on a dark page.
          if (glare === 'night') ns.backdrop?.release?.();
        } else if (action === 'keep' || (action === 'dim' && isTile(img))) img.removeAttribute(ATTR);
        else img.setAttribute(ATTR, action === 'mixed' ? session.mixedMark(img) : action);
        marked.add(img);
      }
    }

    /** Read the page's own filter of the candidates (two restyles for a batch) and show black those that it turns dark. */
    function flushFlip() {
      flipTimer = 0;
      if (dead) return;
      const batch = [...pending].slice(0, FLIP_BATCH).filter(([img]) => (pending.delete(img), img.isConnected));
      /** @type {string[] | null} */
      let filters = null;
      try {
        if (batch.length) filters = (stats.batches++, ns.calm.pageFilters(batch.map(([img]) => img)));
      } catch {
        // No call in an older core.
      }
      batch.forEach(([img, px], i) => {
        const f = filters?.[i];
        const seen = f && f !== 'none' ? filtered(px, f) : null;
        if (seen && classify(seen) === 'invert') {
          img.setAttribute(ATTR, 'flip');
          marked.add(img);
        } else img.removeAttribute(ATTR);
      });
      if (pending.size) flipTimer = setTimeout(flushFlip, 400);
    }

    let bgTurn = false;
    /** @type {Map<string, number>} */
    const readRetries = new Map();
    function pump() {
      while (!dead && running < CONCURRENT && (queue.size || (bgJobs.length && session.runJob))) {
        running += 1;
        let job;
        // Taking turns: a page with many pictures must not hold back the CSS pictures, a logo among them.
        bgTurn = !bgTurn;
        if (queue.size && !(bgTurn && bgJobs.length && session.runJob)) {
          const img = /** @type {HTMLImageElement} */ (queue.values().next().value);
          queue.delete(img);
          job = analyze(img);
        } else job = session.runJob(/** @type {{ el: Element, url: string, key: string, legacy?: boolean, blend?: boolean }} */ (bgJobs.shift()));
        void job.finally(() => {
          running -= 1;
          pump();
        });
      }
    }

    /** @param {HTMLImageElement} img */
    function consider(img) {
      if (dead) return;
      if (img.complete && img.naturalWidth > 0) {
        queue.add(img);
        pump();
      }
    }

    /** @param {ParentNode} root */
    function scan(root) {
      let count = 0;
      for (const img of root.querySelectorAll('img')) {
        if (++count > MAX_ELEMENTS) break;
        consider(img);
      }
    }

    /** @type {MutationObserver | null} */
    let observer = null;
    const onLoad = (/** @type {Event} */ event) => {
      if (event.target instanceof HTMLImageElement) consider(event.target);
    };
    const onWindowLoad = () => {
      scan(doc);
      starPass();
    };
    const onContentLoaded = () => scan(doc);
    if (dark || flip) {
      doc.addEventListener('load', onLoad, true);
      observer = new MutationObserver((records) => {
        for (const r of records) if (r.target instanceof HTMLImageElement) consider(r.target);
      });
      observer.observe(doc, { attributes: true, subtree: true, attributeFilter: ['src', 'srcset'] });
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', onContentLoaded, { once: true });
      else scan(doc);
      if (doc.readyState !== 'complete') addEventListener('load', onWindowLoad, { once: true });
    }

    let lookAt = 0;
    const lookForPictures = () => {
      if (dead || session.bg) return;
      lookAt = performance.now();
      try {
        if (doc.querySelector('canvas,[style*="url("],[style*="image-set("]')) ns.optional?.wantBackgrounds?.();
      } catch {
        // Nothing to find.
      }
    };
    const onScrollLook = () => {
      if (performance.now() - lookAt > 1500) {
        lookForPictures();
        starPass();
      }
    };
    addEventListener('scroll', onScrollLook, { passive: true });
    addEventListener('resize', onScrollLook, { passive: true });
    addEventListener('load', lookForPictures, { once: true });
    const lookTimers = [500, 1500, 4000, 9000].map((t) =>
      setTimeout(() => {
        lookForPictures();
        starPass();
      }, t),
    );
    ns.imagebg?.attach(session);

    return {
      session,
      stats: () => ({ ...stats, cached: cache.size, bgSelectors: ns.imagebg?.selectors() ?? 0, bgFound: 0, bgMarked: 0, ...(session.bg ? session.bg.extra() : {}) }),
      end() {
        dead = true;
        session.bg?.end();
        session.bg = null;
        for (const t of lookTimers) clearTimeout(t);
        clearTimeout(flipTimer);
        pending.clear();
        removeEventListener('scroll', onScrollLook);
        removeEventListener('resize', onScrollLook);
        removeEventListener('load', lookForPictures);
        removeEventListener('load', onWindowLoad);
        doc.removeEventListener('DOMContentLoaded', onContentLoaded);
        observer?.disconnect();
        doc.removeEventListener('load', onLoad, true);
        queue.clear();
        bgJobs.length = 0;
        keeper?.stop();
        style.remove();
        mixedDefs?.remove();
        for (const img of marked) img.removeAttribute(ATTR);
        for (const img of doc.querySelectorAll(`[${ATTR}]`)) img.removeAttribute(ATTR);
        marked.clear();
        for (const el of blended) el.removeAttribute(BLEND_ATTR);
        for (const el of doc.querySelectorAll(`[${BLEND_ATTR}]`)) el.removeAttribute(BLEND_ATTR);
        blended.clear();
        for (const el of emptied) el.removeAttribute(EMPTY_ATTR);
        for (const el of doc.querySelectorAll(`[${EMPTY_ATTR}]`)) el.removeAttribute(EMPTY_ATTR);
        emptied.clear();
      },
    };
  }

  /** @type {ReturnType<typeof start> | null} */
  let active = null;
  dk.images = Object.freeze({
    classify,
    filtered,
    tileOf,
    kindOf,
    toneOf,
    bytesOf,
    kit: Object.freeze({ ATTR, BG_ATTR, MIN_SIDE, MAX_SIDE, MAX_CACHE, HIDE, WALL, TILE_CSS, classify, toneOf, kindOf, glareOf, mixedOf, isWide }),
    session: () => active?.session ?? null,
    start(/** @type {Parameters<typeof start>[0]} */ options) {
      active?.end();
      active = start(options);
    },
    stop() {
      active?.end();
      active = null;
    },
    isActive: () => active !== null,
    stats: () => (active ? active.stats() : null),
  });
})();
