// @ts-check
// Color vision. The model of a color vision deficiency and the correction that moves the part of a color a person cannot see into a
// part they can. Loaded on demand (loader.js) when the correction is on. The settings page loads it too, for its preview.
//
// The model follows Machado, Oliveira and Fernandes (2009): an anomalous cone is a normal cone whose peak sensitivity has moved toward
// the peak of another cone. At 100 percent it sits on that peak and the person has two kinds of cone (protanopia, deuteranopia,
// tritanopia). The cone curves come from a photopigment template, the moved curve is written as the best mix of the three normal
// curves, and the cone is scaled so that white keeps its answer. Everything is computed here, in linear sRGB.
//
// The other filters (grayscale, grayscale inverted, inverted) are plain affine steps on gamma encoded sRGB, like the color filters
// of an operating system. Every filter is one record: `space` ('linear' or 'srgb'), a 3 by 3 `correct`, an `offset` and its inverse.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk || dk.cvd) return;

  /** @typedef {number[][]} M3  3 by 3, rows act on (r, g, b) in linear sRGB */
  /** @typedef {'protan' | 'deutan' | 'tritan'} Kind */
  /** @typedef {'grayscale' | 'grayscaleInverted' | 'inverted'} Plain */

  const TYPES = Object.freeze(['protan', 'deutan', 'tritan', 'grayscale', 'grayscaleInverted', 'inverted']);

  // Linear sRGB to CIE XYZ (D65), and XYZ to the cone space of Hunt, Pointer and Estevez.
  const SRGB_XYZ = [
    [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
    [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
    [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
  ];
  const XYZ_LMS = [
    [0.40024, 0.7076, -0.08081],
    [-0.2263, 1.16532, 0.0457],
    [0, 0, 0.91822],
  ];
  // Relative luminance of linear sRGB.
  const LUMA = [0.2126, 0.7152, 0.0722];
  // Peak sensitivity of the L, M and S cones in nm, and the cone each one moves toward in a deficiency.
  const PEAK = [559, 530, 420];
  const CONE = /** @type {Record<Kind, [number, number]>} */ ({ protan: [0, 1], deutan: [1, 0], tritan: [2, 1] });
  // The template of a photopigment (Lamb 1995): sensitivity at a wavelength for a given peak.
  const T = { a: 70, b: 28.5, c: -14.1, A: 0.88, B: 0.924, C: 1.104, D: 0.655 };
  // The curves are matched from 400 to 700 nm, every nm.
  const FROM = 400;
  const TO = 700;
  // How strongly the lost signal is written back at a Color boost of 50. Each kind is scaled so that its strongest color moves the
  // same amount at 100 percent. The boost scales it from a quarter (0) to 1.75 times (100).
  const STRENGTH = 0.5;
  /** @param {unknown} boost 0 to 100 */
  const boostOf = (boost) => 0.25 + 1.5 * (Number.isFinite(boost) ? Math.min(Math.max(/** @type {number} */ (boost), 0), 100) / 100 : 0.5);
  // Grayscale on gamma encoded sRGB, with the weights of luminance.
  const GRAY = [0.2126, 0.7152, 0.0722];

  /** @param {M3} a @param {M3} b @returns {M3} */
  const mul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
  /** @param {M3} m @param {number[]} v */
  const apply = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
  /** @param {M3} m @returns {M3} */
  function invert(m) {
    const [[a, b, c], [d, e, f], [g, h, i]] = m;
    const A = e * i - f * h;
    const B = f * g - d * i;
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [
      [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
      [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ];
  }
  /** @returns {M3} */
  const identity = () => [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  const RGB_LMS = mul(XYZ_LMS, SRGB_XYZ);
  const LMS_RGB = invert(RGB_LMS);
  const WHITE = apply(RGB_LMS, [1, 1, 1]);

  /** @param {number} peak @param {number} nm */
  function template(peak, nm) {
    const x = peak / nm;
    return 1 / (Math.exp(T.a * (T.A - x)) + Math.exp(T.b * (T.B - x)) + Math.exp(T.c * (T.C - x)) + T.D);
  }

  /** The mix of the normal L, M and S curves that comes closest (least squares) to the curve with this peak. @param {number} peak */
  function mixFor(peak) {
    /** @type {M3} */
    const n = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const b = [0, 0, 0];
    for (let nm = FROM; nm <= TO; nm++) {
      const t = PEAK.map((p) => template(p, nm));
      const y = template(peak, nm);
      for (let i = 0; i < 3; i++) {
        b[i] += t[i] * y;
        for (let j = 0; j < 3; j++) n[i][j] += t[i] * t[j];
      }
    }
    return apply(invert(n), b);
  }

  /** @param {unknown} kind @returns {kind is Kind} */
  const isKind = (kind) => kind === 'protan' || kind === 'deutan' || kind === 'tritan';
  /** @param {unknown} kind @returns {kind is Plain} */
  const isPlain = (kind) => kind === 'grayscale' || kind === 'grayscaleInverted' || kind === 'inverted';
  /** @param {unknown} v 0 to 100 */
  const share = (v) => (Number.isFinite(v) ? Math.min(Math.max(/** @type {number} */ (v), 0), 100) / 100 : 1);

  /**
   * The answer of the anomalous cone as a row over normal L, M and S, scaled so white gives the same answer as the normal cone.
   * @param {Kind} kind @param {number} s 0 to 1
   */
  function anomalous(kind, s) {
    const [i, toward] = CONE[kind];
    const mix = mixFor(PEAK[i] + s * (PEAK[toward] - PEAK[i]));
    const scale = WHITE[i] / (mix[0] * WHITE[0] + mix[1] * WHITE[1] + mix[2] * WHITE[2]);
    return { i, row: mix.map((v) => v * scale) };
  }

  /**
   * The lost signal and where it goes. `q` reads, from a linear color, how much the anomalous cone misses (the normal answer minus the
   * anomalous one). `d` is a direction of no luminance that the person sees well: the S cone for a red-green deficiency, L against M
   * for a blue-yellow one. The sign makes a red (a blue for tritan) move toward +d, so the order of the hues is the same for each kind.
   * @param {Kind} kind @param {number[]} row @param {number} i
   */
  function transfer(kind, row, i) {
    const lost = [0, 1, 2].map((j) => (j === i ? 1 : 0) - row[j]);
    let q = [0, 1, 2].map((c) => lost[0] * RGB_LMS[0][c] + lost[1] * RGB_LMS[1][c] + lost[2] * RGB_LMS[2][c]);
    const reference = kind === 'tritan' ? [0, 0, 1] : [1, 0, 0];
    if (q[0] * reference[0] + q[1] * reference[1] + q[2] * reference[2] < 0) q = q.map((v) => -v);
    const toward = kind === 'tritan' ? [1 / WHITE[0], -1 / WHITE[1], 0] : [0, 0, 1 / WHITE[2]];
    const raw = apply(LMS_RGB, toward);
    const y = LUMA[0] * raw[0] + LUMA[1] * raw[1] + LUMA[2] * raw[2];
    const d = raw.map((v) => v - y);
    const top = Math.max(...d.map(Math.abs));
    return { q, d: d.map((v) => v / top) };
  }

  /** The gain of each kind: STRENGTH over the largest lost signal of a corner of the color cube at 100 percent. @type {Map<Kind, number>} */
  const gains = new Map();
  /** @param {Kind} kind */
  function gainOf(kind) {
    let g = gains.get(kind);
    if (g !== undefined) return g;
    const { i, row } = anomalous(kind, 1);
    const { q } = transfer(kind, row, i);
    let most = 0;
    for (let c = 0; c < 8; c++) most = Math.max(most, Math.abs((c & 1) * q[0] + ((c >> 1) & 1) * q[1] + ((c >> 2) & 1) * q[2]));
    g = STRENGTH / most;
    gains.set(kind, g);
    return g;
  }

  /**
   * @typedef {Readonly<{ kind: Kind | Plain, severity: number, boost: number, key: string, space: 'linear' | 'srgb', simulate: M3 | null,
   *   correct: M3, offset: number[], undo: M3 | null, undoOffset: number[] }>} Vision
   */
  /** @type {Map<string, Vision>} */
  const cache = new Map();

  /** @param {M3} m */
  function det(m) {
    const [[a, b, c], [d, e, f], [g, h, i]] = m;
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  }

  /** A plain filter at a share `s`: the mix of a color and its filtered color, as a matrix and an offset on sRGB. @param {Plain} kind @param {number} s */
  function plainStep(kind, s) {
    const flip = kind !== 'grayscale';
    /** @type {M3} */
    const full = kind === 'inverted' ? [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? -1 : 0))) : [GRAY, GRAY, GRAY].map((r) => r.map((v) => (flip ? -v : v)));
    const correct = full.map((row, r) => row.map((v, c) => (1 - s) * (r === c ? 1 : 0) + s * v));
    return { correct, offset: [0, 1, 2].map(() => (flip ? s : 0)) };
  }

  /**
   * The filter of one type, intensity and boost. A deficiency is in linear sRGB with `simulate` (what the person sees) and `correct`
   * (the correction); a plain filter is on sRGB and has no `simulate`. `undo` and `undoOffset` are the inverse, for frames under a filter
   * engine; `undo` is null where there is none (full grayscale, an inversion at 50 percent). Null for no type or an intensity of 0.
   * @param {unknown} kind @param {unknown} severity 0 to 100 @param {unknown} [boost] 0 to 100, 50 when missing
   * @returns {Vision | null}
   */
  function matrices(kind, severity, boost) {
    if (!isKind(kind) && !isPlain(kind)) return null;
    const s = Math.round(share(severity) * 100) / 100;
    if (s === 0) return null;
    const b = isKind(kind) ? Math.round(boostOf(boost) * 100) / 100 : 1;
    const key = `${kind}:${s}:${b}`;
    let m = cache.get(key);
    if (m) return m;
    if (isPlain(kind)) {
      const { correct, offset } = plainStep(kind, s);
      let undo = Math.abs(det(correct)) < 1e-6 ? null : invert(correct);
      let undoOffset = undo ? apply(undo, offset).map((v) => -v) : [0, 0, 0];
      // A frame shows root(counter(frame(x))), and its own page has the same filter. Full grayscale inverted has no inverse, but the
      // inversion alone brings its output back to gray, and the root keeps gray as it is: the frame then shows the filter once.
      if (!undo && kind === 'grayscaleInverted' && s === 1) {
        undo = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? -1 : 0)));
        undoOffset = [1, 1, 1];
      }
      m = Object.freeze({ kind, severity: s * 100, boost: 50, key, space: /** @type {'srgb'} */ ('srgb'), simulate: null, correct, offset, undo, undoOffset });
    } else {
      const { i, row } = anomalous(kind, s);
      /** @type {M3} */
      const cones = identity();
      cones[i] = row;
      const simulate = mul(LMS_RGB, mul(cones, RGB_LMS));
      const { q, d } = transfer(kind, row, i);
      const k = gainOf(kind) * b;
      /** @type {M3} */
      const correct = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? 1 : 0) + k * d[r] * q[c]));
      if (kind === 'protan') {
        // A red weak person sees reds darker: the L cone carries part of luminance. The lift `p` adds back, as gray, the luminance the
        // person loses of the corrected color, so they see each color as light as a normal viewer does.
        const seenY = (/** @type {M3} */ m) => [0, 1, 2].map((c) => LUMA[0] * m[0][c] + LUMA[1] * m[1][c] + LUMA[2] * m[2][c]);
        const before = seenY(identity());
        const after = seenY(mul(simulate, correct));
        const p = before.map((v, c) => v - after[c]);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) correct[r][c] += p[c];
      }
      const space = /** @type {'linear'} */ ('linear');
      m = Object.freeze({ kind, severity: s * 100, boost: Math.round(((b - 0.25) / 1.5) * 100), key, space, simulate, correct, offset: [0, 0, 0], undo: invert(correct), undoOffset: [0, 0, 0] });
    }
    cache.set(key, m);
    return m;
  }

  // The largest gray shift in linear light at a Color boost of 100, and the luminance (L* 50) that splits light colors from dark ones.
  const SHIFT = 0.12;
  const MIDDLE = 0.1842;
  const toLinear = (/** @type {number} */ v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const toGamma = (/** @type {number} */ v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

  /**
   * A matrix on an sRGB color (channels 0 to 1, gamma encoded), done in linear light. The change the matrix makes is shortened until the
   * color fits the gamut, so its direction stays and a correction that keeps luminance still keeps it. A color that cannot move stays.
   * With `free` above 0 (a Color boost above 50) a strong color may first move as a whole toward lighter or darker, up to `free` times
   * SHIFT, so it has room to change hue. The shift only moves a light color lighter and a dark color darker, so the
   * contrast with a background of the other side does not drop.
   * @param {M3} m @param {number[]} rgb @param {number} [free] 0 to 1 @returns {number[]}
   */
  function onSrgb(m, rgb, free = 0) {
    const lin = rgb.map((v) => toLinear(Math.min(Math.max(v, 0), 1)));
    const out = apply(m, lin);
    const y = LUMA[0] * lin[0] + LUMA[1] * lin[1] + LUMA[2] * lin[2];
    const light = y >= MIDDLE;
    if (free > 0) {
      const lo = Math.min(...out);
      const hi = Math.max(...out);
      let t = 0;
      if (lo < 0 && hi <= 1) t = Math.min(-lo, 1 - hi);
      else if (hi > 1 && lo >= 0) t = -Math.min(hi - 1, lo);
      if (t !== 0 && (t > 0) === light) {
        t = Math.max(Math.min(t, free * SHIFT), -free * SHIFT);
        for (let i = 0; i < 3; i++) out[i] += t;
      }
    }
    let room = 1;
    for (let i = 0; i < 3; i++) {
      const move = out[i] - lin[i];
      if (move > 1e-12) room = Math.min(room, (1 - lin[i]) / move);
      else if (move < -1e-12) room = Math.min(room, lin[i] / -move);
    }
    const short = lin.map((v, i) => Math.min(Math.max(v + (out[i] - v) * room, 0), 1));
    if (free > 0 && room < 1) {
      // A corner of the gamut (a pure red) has no room at all. Above a boost of 50 the move is also cut at the edge of each channel,
      // as the filter engines do, when that keeps the side of the luminance.
      const cut = out.map((v) => Math.min(Math.max(v, 0), 1));
      const yc = LUMA[0] * cut[0] + LUMA[1] * cut[1] + LUMA[2] * cut[2];
      if (light ? yc >= y - 1e-9 : yc <= y + 1e-9) return short.map((v, i) => toGamma(v + (cut[i] - v) * free));
    }
    return short.map(toGamma);
  }

  /** A filter on an sRGB color (channels 0 to 1, gamma encoded). @param {Vision} m @param {number[]} rgb @returns {number[]} */
  function run(m, rgb) {
    if (m.space === 'linear') return onSrgb(m.correct, rgb, Math.max(0, (m.boost - 50) / 50));
    const c = rgb.map((v) => Math.min(Math.max(v, 0), 1));
    return apply(m.correct, c).map((v, i) => Math.min(Math.max(v + m.offset[i], 0), 1));
  }

  const r5 = (/** @type {number} */ v) => Math.round(v * 1e5) / 1e5;
  /** The values of an SVG `feColorMatrix` for a 3 by 3 matrix and an offset. @param {M3} m @param {number[]} [offset] */
  const svgValues = (m, offset = [0, 0, 0]) => [...m.map((row, i) => [...row.map(r5), 0, r5(offset[i])]).flat(), 0, 0, 0, 1, 0].join(' ');

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MEDIA_ID = 'dk-cvd-media';
  // Pictures the page filters itself keep their own filter: the rule has no weight against any page rule.
  const MEDIA = ':where(img, video, canvas)';
  // A CSS background picture gets the filter on a box with no children and no text (an icon, a picture box) and on a pseudo element:
  // there the picture is all the box paints. A box with text keeps it as it is, so its text, already corrected, is not corrected twice.
  const PSEUDO_PART = /::?(?:before|after)\s*$/i;
  /** @type {{ key: string, style: HTMLStyleElement, bg: HTMLStyleElement, svg: SVGSVGElement, keeper: any, url: string, boxes: string[], pseudos: string[], timer: number } | null} */
  let layer = null;

  /** The rules of the CSS picture filter. @param {{ url: string, boxes: string[], pseudos: string[] }} l */
  const bgText = (l) =>
    `@media screen{${l.boxes.length ? `:where(${l.boxes.join(',')}):empty{filter:${l.url}}` : ''}${l.pseudos.map((p) => `${p}{filter:${l.url}}`).join('')}}`;

  /** A selector list of a rule that paints a background picture. @param {string} selector */
  function notePicture(selector) {
    const l = layer;
    if (!l || typeof selector !== 'string' || selector.length > 400) return;
    const parts = /** @type {any} */ (dk).sitedark?.splitList?.(selector) ?? selector.split(',');
    for (const raw of parts) {
      const part = String(raw).trim();
      if (part === '' || part.includes('{') || part.includes('}')) continue;
      if (PSEUDO_PART.test(part)) l.pseudos.push(part);
      else if (!part.includes('::')) l.boxes.push(part);
    }
    if (l.timer) return;
    l.timer = /** @type {any} */ (setTimeout(() => {
      l.timer = 0;
      if (layer === l) l.bg.textContent = bgText(l);
    }, 50));
  }

  /** A hidden SVG element to hold filters. @param {Document} doc @param {string} mark */
  function defs(doc, mark) {
    const svg = /** @type {SVGSVGElement} */ (doc.createElementNS(SVG_NS, 'svg'));
    svg.setAttribute('data-dk', mark);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none');
    return svg;
  }

  /** @typedef {[space: string, type: string, values: string]} Step  one `feColorMatrix` with its own color space */
  /** The `feColorMatrix` step of a filter. @param {Vision} m @returns {Step} */
  const stepOf = (m) => [m.space === 'linear' ? 'linearRGB' : 'sRGB', 'matrix', svgValues(m.correct, m.offset)];

  /** Add color matrix steps to a filter. @param {Element} f @param {Step[]} steps */
  function steps(f, steps) {
    for (const [space, type, values] of steps) {
      const fe = f.ownerDocument.createElementNS(SVG_NS, 'feColorMatrix');
      fe.setAttribute('color-interpolation-filters', space);
      fe.setAttribute('type', type);
      fe.setAttribute('values', values);
      f.append(fe);
    }
  }

  /** A new filter of color matrix steps in `svg`, over the box of the element it is on. @param {Element} svg @param {string} id @param {Step[]} list */
  function filter(svg, id, list) {
    const f = svg.ownerDocument.createElementNS(SVG_NS, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('x', '0');
    f.setAttribute('y', '0');
    f.setAttribute('width', '100%');
    f.setAttribute('height', '100%');
    steps(f, list);
    svg.append(f);
    return f;
  }

  /**
   * The correction in the Filter engines (theme-engines.md 11.2). Chrome takes CSS filter functions that follow an SVG filter in
   * the wrong color space, so an SVG filter ends each list: the correction is the last step of the Filter+ filter or the last filter
   * of the root, and the counter of frames is one SVG filter that starts with the inverse. Pictures keep the correction: a clamped
   * inverse turns strong colors into others.
   * @param {Vision} m @param {Element} svg @param {string} root the root filter
   * @param {boolean} plus the root filter is the Filter+ filter `dk-fp`
   * @param {string | null} back the counter after the inverse: '' none, 'plain' the inversion, or matrix values; null for no counter
   * @returns {{ root: string, frame: string | null }}
   */
  function chain(m, svg, root, plus, back) {
    const here = svg.ownerDocument.URL.split('#')[0];
    const fix = stepOf(m);
    const fp = plus ? svg.querySelector('#dk-fp') : null;
    if (fp) steps(fp, [fix]);
    else {
      filter(svg, 'dk-cvd', [fix]);
      root = `${root === 'none' ? '' : `${root} `}url("${here}#dk-cvd")`;
    }
    // A filter with no inverse cannot be taken off a frame: the frame keeps the counter it had.
    if (back === null || !m.undo) return { root, frame: null };
    /** @type {Step[]} */
    const rest = back === 'plain' ? [['sRGB', 'matrix', '-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0'], ['sRGB', 'hueRotate', '180']] : back === '' ? [] : [['sRGB', 'matrix', back]];
    filter(svg, 'dk-cvd-undo', [[m.space === 'linear' ? 'linearRGB' : 'sRGB', 'matrix', svgValues(m.undo, m.undoOffset)], ...rest]);
    return { root, frame: `url("${here}#dk-cvd-undo")` };
  }

  /**
   * The picture layer of the Dynamic and static engines: one SVG filter on pictures, video and canvas. Null removes it.
   * @param {Record<string, any> | null} theme
   */
  function media(theme) {
    const m = theme ? matrices(theme.cvdType, theme.cvdSeverity, theme.cvdBoost) : null;
    const key = m ? m.key : '';
    if (layer && layer.key === key) return;
    if (layer) {
      layer.keeper?.stop();
      clearTimeout(layer.timer);
      layer.style.remove();
      layer.bg.remove();
      layer.svg.remove();
      layer = null;
    }
    if (!m || typeof document === 'undefined') return;
    const doc = document;
    const root = doc.documentElement;
    const svg = defs(doc, 'cvd-defs');
    filter(svg, MEDIA_ID, [stepOf(m)]);
    const url = `url("${doc.URL.split('#')[0]}#${MEDIA_ID}")`;
    const style = doc.createElement('style');
    style.setAttribute('data-dk', 'cvd-media');
    // The variable lets the picture marks of the theme (images.js) keep the filter after their own.
    // A picture box set in an inline style often has an inline filter that does nothing (`brightness(1)`), which no rule without
    // `!important` can pass. The zero weight lets the calm filter of E-ink and Paper win, as it does on `<img>`.
    const inline = /** @type {any} */ (dk).color?.INLINE_PICTURE;
    style.textContent = `@media screen{:root{--dk-cvd-media:${url}}${MEDIA}{filter:${url}}${inline ? `:where(${inline}){filter:${url}!important}` : ''}}`;
    const bg = doc.createElement('style');
    bg.setAttribute('data-dk', 'cvd-bg');
    (doc.head ?? root).append(style, bg);
    root.append(svg);
    const keeper = /** @type {any} */ (dk).keep?.create() ?? null;
    keeper?.track(style, () => (doc.head ?? root).append(style));
    keeper?.track(bg, () => (doc.head ?? root).append(bg));
    keeper?.track(svg, () => root.append(svg));
    layer = { key, style, bg, svg, keeper, url, boxes: [], pseudos: [], timer: 0 };
    for (const selector of /** @type {any} */ (dk).dynamic?.pictureRules?.() ?? []) notePicture(selector);
  }

  const api = {
    TYPES,
    matrices,
    onSrgb,
    run,
    apply,
    svgValues,
    media,
    notePicture,
    defs,
    chain,
  };
  dk.cvd = Object.freeze(api);
  /** @type {any} */ (dk).color?.useCvd?.(api);
})();
