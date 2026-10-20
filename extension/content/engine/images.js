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
  const SAMPLE = 32;
  const MIN_SIDE = 12;
  const MAX_SIDE = 6000;
  const MAX_CACHE = 500;
  const MAX_ELEMENTS = 1500;
  const CONCURRENT = 2;
  // E-ink and Paper (`flip`): pictures up to FLIP_SIDE that are light marks wait, FLIP_BATCH at a time, for a read of the page's own filter.
  const FLIP_SIDE = 400;
  const FLIP_BATCH = 24;
  const FLIP_LIGHTS = 80;

  const FLAT_COLORS = 40;
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

  const HIDE = 'background-image:none!important';
  const WALL = 'background-color:var(--dk-ground,#888)!important;background-blend-mode:difference!important';
  const TILE_CSS = `[${BG_ATTR}="tile"]{${HIDE}}[${BG_ATTR}="wall"]{${WALL}}[${ATTR}="wall"],[${BG_ATTR}="overlay"]{mix-blend-mode:difference}[${BG_ATTR}="lines"]{background-blend-mode:difference}`;
  const CSS = `@media screen{${TILE_CSS}[${ATTR}="invert"],[${BG_ATTR}="invert"]{filter:invert(1) hue-rotate(180deg) var(--dk-cvd-media,)!important}[${ATTR}="dim"],[${BG_ATTR}="dim"]{filter:brightness(.9) var(--dk-cvd-media,)!important}[${ATTR}="plate"]{background-color:#fff!important}[${ATTR}="flip"]{filter:var(--dk-cvd-media,none)!important}}`;

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

  /** With `eink` only CSS pictures are marked here and `<img>` is calm.js's; with `light` only surfaces. @param {{ ignore?: string[], eink?: boolean, light?: boolean, einkMark?: boolean, fetchImage?: (url: string) => Promise<{ mime: string, base64?: string, sample?: string } | null> }} [options] */
  function start(options = {}) {
    const doc = document;
    /** @type {Map<string, 'keep' | 'dim' | 'invert' | 'plate' | 'flip'>} */
    const cache = kept.cache;
    /** @type {Set<HTMLImageElement>} */
    const queue = new Set();
    /** @type {Set<HTMLImageElement>} */
    const marked = new Set();
    const stats = { analyzed: 0, fetched: 0, failed: 0, invert: 0, dim: 0, keep: 0, plate: 0, flip: 0, batches: 0, bgInvert: 0, bgDim: 0, bgGray: 0, bgTile: 0, bgSkipped: 0, bgPhotos: 0, bgCapped: 0 };
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
    const keeper = keepApi ? keepApi.create() : null;
    keeper?.track(style, () => (doc.head ?? doc.documentElement).append(style));

    /** @type {{ el: Element, url: string, key: string, legacy?: boolean }[]} */
    const bgJobs = [];
    /** @type {any} */
    const session = {
      doc, dark, eink, options, skip, cache, surfaces: kept.surfaces, stats, keeper, sheet, jobs: bgJobs,
      read: (/** @type {HTMLImageElement} */ img, /** @type {string} */ src) => read(img, src),
      pixelsOf: (/** @type {ImageBitmapSource} */ source, /** @type {number} */ width, /** @type {number} */ height) => pixelsOf(source, width, height),
      pump: () => pump(),
      setStyle: (/** @type {string} */ text) => {
        style.textContent = text;
      },
      dead: () => dead,
      runJob: null,
      bg: null,
    };

    /** @param {ImageBitmapSource} source @returns {Uint8ClampedArray} */
    function pixelsOf(source, width = SAMPLE, height = SAMPLE) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
      ctx.drawImage(/** @type {CanvasImageSource} */ (source), 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height).data;
    }

    /** @param {HTMLImageElement} img @param {string} src */
    async function read(img, src) {
      try {
        return pixelsOf(img);
      } catch {
        // An image of another origin taints the canvas: the worker sends a copy.
      }
      if (!options.fetchImage || /^(data|blob):/i.test(src)) return null;
      const file = await options.fetchImage(src);
      if (!file) return null;
      stats.fetched += 1;
      // The worker sends the 32 by 32 copy when it can make one, else the file.
      if (typeof file.sample === 'string') {
        const px = bytesOf(file.sample);
        return px.length === SAMPLE * SAMPLE * 4 ? new Uint8ClampedArray(px.buffer) : null;
      }
      if (typeof file.base64 !== 'string') return null;
      const bytes = bytesOf(file.base64);
      if (file.mime === 'image/svg+xml') return svgPixels(bytes);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: file.mime }), { resizeWidth: SAMPLE, resizeHeight: SAMPLE });
      try {
        return pixelsOf(bitmap);
      } finally {
        bitmap.close();
      }
    }

    /** @param {Uint8Array} bytes @returns {Promise<Uint8ClampedArray | null>} */
    async function svgPixels(bytes) {
      const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (bytes)], { type: 'image/svg+xml' }));
      try {
        const copy = new Image();
        copy.src = url;
        await copy.decode();
        return pixelsOf(copy);
      } catch {
        return null;
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    /** @param {HTMLImageElement} img */
    async function analyze(img) {
      if (dead || !img.isConnected) return;
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
            return;
          }
          const shape = { square: Math.abs(w - h) <= 0.04 * Math.max(w, h) };
          // A light mark on a clear ground is the candidate of `flip`.
          action = flip ? (classify(/** @type {Uint8ClampedArray} */ (filtered(pixels, 'invert(1)')), shape) === 'invert' ? 'flip' : 'keep') : classify(pixels, shape);
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
        if (action === 'keep') img.removeAttribute(ATTR);
        else img.setAttribute(ATTR, action);
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

    function pump() {
      while (!dead && running < CONCURRENT && (queue.size || (bgJobs.length && session.runJob))) {
        running += 1;
        let job;
        if (queue.size) {
          const img = /** @type {HTMLImageElement} */ (queue.values().next().value);
          queue.delete(img);
          job = analyze(img);
        } else job = session.runJob(/** @type {{ el: Element, url: string, key: string, legacy?: boolean }} */ (bgJobs.shift()));
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
    const onWindowLoad = () => scan(doc);
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
      if (performance.now() - lookAt > 1500) lookForPictures();
    };
    addEventListener('scroll', onScrollLook, { passive: true });
    addEventListener('resize', onScrollLook, { passive: true });
    addEventListener('load', lookForPictures, { once: true });
    const lookTimers = [500, 1500, 4000, 9000].map((t) => setTimeout(lookForPictures, t));
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
        for (const img of marked) img.removeAttribute(ATTR);
        for (const img of doc.querySelectorAll(`[${ATTR}]`)) img.removeAttribute(ATTR);
        marked.clear();
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
    kit: Object.freeze({ ATTR, BG_ATTR, MIN_SIDE, MAX_SIDE, MAX_CACHE, HIDE, WALL, TILE_CSS, classify, toneOf, kindOf }),
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
