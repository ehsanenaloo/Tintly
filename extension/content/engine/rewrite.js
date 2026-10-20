// @ts-check
// Rewrites the value of one CSS declaration for the theme. Strings in, strings out, no DOM.
// The rewritten declarations go into an override sheet that sits right after the original one.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  const CHANNEL_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);
  /** `var(--x)`, optionally followed by an alpha after a slash or a comma. */
  const CHANNEL_USE = /^\s*var\(\s*(--[\w-]+)\s*\)\s*(?:(\/|,)\s*(.+?))?\s*$/;
  /** A literal list of channels as a custom property can hold it: `255 255 255`, `0, 0, 0` or `210 8% 50%`. */
  const PLAIN_NUMBER = /^\s*(\d*\.?\d+)\s*$/;
  const CHANNEL_LIST = /^\s*(\d{1,3}(?:\.\d+)?)(\s*,\s*|\s+)(\d{1,3}(?:\.\d+)?)(%?)\2(\d{1,3}(?:\.\d+)?)(%?)\s*$/;
  const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix']);
  const GRADIENT = /^(?:-webkit-|-moz-)?(?:repeating-)?(?:linear|radial|conic)-gradient$/;
  /** Other picture functions that hold colors: the old `-webkit-gradient()` with its color stops, a blend of pictures, a plain color picture. */
  const PICTURE_COLORS = new Set(['-webkit-gradient', 'from', 'to', 'color-stop', 'cross-fade', '-webkit-cross-fade', 'image']);
  const MAX_NAME = 200;

  /** @type {Record<string, string>} */
  const ROLES = Object.assign(Object.create(null), {
    color: 'foreground',
    'background-color': 'background',
    'background-image': 'background',
    background: 'background',
    // A focus indicator must stay visible (WCAG 2.4.7, 1.4.11), so it keeps a contrast floor.
    outline: 'edge',
    'outline-color': 'edge',
    'column-rule': 'border',
    'column-rule-color': 'border',
    '-webkit-column-rule': 'border',
    '-webkit-column-rule-color': 'border',
    'text-decoration': 'foreground',
    'text-decoration-color': 'foreground',
    'text-emphasis': 'foreground',
    'text-emphasis-color': 'foreground',
    '-webkit-text-fill-color': 'foreground',
    '-webkit-text-stroke-color': 'foreground',
    '-webkit-text-stroke': 'foreground',
    'caret-color': 'foreground',
    'accent-color': 'foreground',
    fill: 'foreground',
    stroke: 'foreground',
    'stop-color': 'background',
    'flood-color': 'background',
    'lighting-color': 'background',
    // A shadow keeps its edge on a dark page: a neutral one stays black with a stronger alpha, a colored one keeps its hue.
    'box-shadow': 'shadow',
    '-webkit-box-shadow': 'shadow',
    'text-shadow': 'shadow',
    // Only the colors inside drop-shadow() are touched; a filter without one is left out of the copy.
    filter: 'shadow',
    '-webkit-filter': 'shadow',
  });
  for (const side of ['', '-top', '-right', '-bottom', '-left', '-block', '-inline', '-block-start', '-block-end', '-inline-start', '-inline-end']) ROLES[`border${side}`] = ROLES[`border${side}-color`] = 'border';

  /** The bits of the roles in the demand for a derived variable: background, foreground, border, shadow (a shadow falls back to the background one). @type {Record<string, number>} */
  const ROLE_BITS = Object.assign(Object.create(null), { background: 1, foreground: 2, border: 4, edge: 4, shadow: 9 });

  /** @type {Record<string, string>} */
  const LETTER = Object.assign(Object.create(null), { background: 'bg', foreground: 'fg', border: 'bd', edge: 'bd', shadow: 'sh' });

  /** Shorthands that the CSSOM cannot expand when they hold `var()`. */
  const SHORTHANDS = new Set([
    'background',
    'border',
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'border-block',
    'border-inline',
    'border-block-start',
    'border-block-end',
    'border-inline-start',
    'border-inline-end',
    'border-color',
    'outline',
    'column-rule',
    'text-decoration',
    'text-emphasis',
    '-webkit-text-stroke',
  ]);

  const isHex = (/** @type {number} */ c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
  const isIdentStart = (/** @type {number} */ c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 45 || c === 95;
  const isIdentChar = (/** @type {number} */ c) => isIdentStart(c) || (c >= 48 && c <= 57);

  /** @param {string} s @param {number} i index of the opening quote @returns {number} index after the closing quote */
  function skipString(s, i) {
    const q = s.charCodeAt(i);
    let j = i + 1;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 92) j += 2;
      else if (c === q) return j + 1;
      else j++;
    }
    return s.length;
  }

  /** @param {string} s @param {number} open index of "(" @returns {number} index of the matching ")" or -1 */
  function matchParen(s, open) {
    let depth = 0;
    for (let j = open; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 34 || c === 39) j = skipString(s, j) - 1;
      else if (c === 40) depth++;
      else if (c === 41 && --depth === 0) return j;
    }
    return -1;
  }

  /** Split on top-level whitespace; a string is one piece. @param {string} s */
  function splitSpaces(s) {
    /** @type {string[]} */
    const out = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 39) {
        if (start < 0) start = i;
        i = skipString(s, i) - 1;
        continue;
      }
      const space = c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
      if (c === 40) depth++;
      else if (c === 41) depth--;
      if (!space && start < 0) start = i;
      if (space && depth === 0 && start >= 0) {
        out.push(s.slice(start, i));
        start = -1;
      }
    }
    if (start >= 0) out.push(s.slice(start));
    return out;
  }

  /** Split on commas that are not inside parentheses or strings. @param {string} s @returns {string[]} */
  function splitTopLevel(s) {
    /** @type {string[]} */
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 34 || c === 39) i = skipString(s, i) - 1;
      else if (c === 40) depth += 1;
      else if (c === 41) depth -= 1;
      else if (c === 44 && depth === 0) {
        out.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(s.slice(start).trim());
    return out;
  }

  /** The shorthands that hold a color next to other parts, with the longhand of the color. */
  const COLOR_PART = Object.create(null);
  for (const name of ['border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-block', 'border-inline', 'border-block-start', 'border-block-end', 'border-inline-start', 'border-inline-end', 'outline', 'column-rule', 'text-decoration', 'text-emphasis', '-webkit-text-stroke']) COLOR_PART[name] = `${name}-color`;
  /** The parts (w width, s style, l line) that the literal words must fill before a lone `var()` can only be the color. */
  const NEEDS = Object.assign(Object.create(null), { 'text-decoration': 'ls', 'text-emphasis': 's', '-webkit-text-stroke': 'w' });
  /** The longhands a shorthand resets, by prefix: when it is copied whole, a later declaration of such a name in the same rule is written again after it. */
  const FAMILY = Object.assign(Object.create(null), { background: 'background-' });
  for (const name of Object.keys(COLOR_PART)) FAMILY[name] = `${name}-`;
  const NOT_RESET = /radius|collapse|spacing|image/;
  const WIDTH_WORD = /^(?:thin|medium|thick|from-font)$/i;
  const STYLE_WORD = /^(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset|auto|filled|open|dot|circle|double-circle|triangle|sesame|wavy)$/i;
  const LINE_WORD = /^(?:none|underline|overline|line-through|blink|spelling-error|grammar-error)$/i;
  const NUMERIC = /^(?:[+-]?(?:\d|\.\d)|(?:calc|min|max|clamp)\()/i;
  const GLOBAL = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
  const VAR_START = /^var\(/i;
  /** The border colors the CSSOM prints as `currentcolor` when a shorthand leaves them out (the logical ones print `initial`). */
  const PHYSICAL_BORDER = /^border(?:-(?:top|right|bottom|left))?-color$/;
  const IMAGE = /^(?:(?:-webkit-|-moz-)?(?:repeating-)?(?:linear|radial|conic)-gradient|-webkit-gradient|url|image-set|-webkit-image-set|cross-fade|-webkit-cross-fade|image|element|-moz-element|paint)\(/i;
  const BACKGROUND_WORD = /^(?:repeat|repeat-x|repeat-y|no-repeat|space|round|scroll|fixed|local|border-box|padding-box|content-box|text|top|bottom|left|right|center|auto|cover|contain)$/i;

  /** The color token of a shorthand without `var()`, or the word the CSSOM prints for an omitted one. @param {string} value @param {string} longhand */
  function colorOfShorthand(value, longhand) {
    if (GLOBAL.test(value)) return value;
    let found = PHYSICAL_BORDER.test(longhand) ? 'currentcolor' : 'initial';
    for (const token of splitSpaces(value)) {
      if (WIDTH_WORD.test(token) || STYLE_WORD.test(token) || LINE_WORD.test(token) || NUMERIC.test(token) || token.charCodeAt(0) === 34 || token.charCodeAt(0) === 39) continue;
      found = token;
    }
    return found;
  }

  /** The color token of a shorthand with `var()`, or null when its place is uncertain: a lone `var()` is the color only when literal words fill the other places. @param {string} name @param {string} value @returns {string | null} */
  function varColor(name, value) {
    let have = '';
    let literal = null;
    let lone = '';
    let vars = 0;
    for (const token of splitSpaces(value)) {
      const c = token.charCodeAt(0);
      if (VAR_START.test(token)) {
        vars++;
        lone = token;
      } else if (NUMERIC.test(token) || WIDTH_WORD.test(token)) have += 'w';
      else if (c === 34 || c === 39) have += 's';
      else if (LINE_WORD.test(token) || STYLE_WORD.test(token)) {
        if (LINE_WORD.test(token)) have += 'l';
        if (STYLE_WORD.test(token)) have += 's';
      } else if (GLOBAL.test(token) || literal !== null) return null;
      else literal = token;
    }
    if (literal !== null) return literal;
    return vars === 1 && [...(NEEDS[name] ?? 'ws')].every((p) => have.includes(p)) ? lone : null;
  }

  /** @param {string} token */
  function isLayerWord(token) {
    if (NUMERIC.test(token)) return true;
    if (token.indexOf('(') >= 0) return false;
    return token.split('/').every((p) => p === '' || BACKGROUND_WORD.test(p) || NUMERIC.test(p));
  }

  /** The color of a `background` shorthand that paints no picture, or null (a picture, a bare `var()`, no color). @param {string} value @returns {string | null} */
  function plainBackgroundColor(value) {
    const parts = backgroundParts(value);
    if (parts === null || parts.color === 'initial' || GLOBAL.test(parts.color)) return null;
    return parts.images === 'initial' || parts.images.split(',').every((image) => image.trim().toLowerCase() === 'none') ? parts.color : null;
  }

  /** The images of all layers of `background` and the color of the last; null when a layer holds a bare `var()`. @param {string} value @returns {{ images: string, color: string } | null} */
  function backgroundParts(value) {
    if (GLOBAL.test(value)) return { images: value, color: value };
    const layers = splitTopLevel(value);
    /** @type {string[]} */
    const images = [];
    let color = 'initial';
    let any = false;
    for (let index = 0; index < layers.length; index++) {
      let image = 'none';
      for (const token of splitSpaces(layers[index])) {
        if (VAR_START.test(token)) return null;
        if (IMAGE.test(token)) {
          image = token;
          any = true;
        } else if (token.toLowerCase() === 'none') {
          image = 'none';
          any = true;
        } else if (index === layers.length - 1 && !isLayerWord(token)) color = token;
      }
      images.push(image);
    }
    return { images: any ? images.join(',') : 'initial', color };
  }

  const round = (/** @type {number} */ v) => Math.round(v * 10000) / 10000;

  /** A curve sampled at equal steps from 0 to 1 as a `calc()` sum in `l`: the value at 0 and a `max(0, l - knot)` term for each change of slope, with the fewest knots that keep every sample within `tol`. @param {number[]} ys @param {number} tol */
  function pwl(ys, tol) {
    const n = ys.length - 1;
    const at = [0, n];
    const stack = [[0, n]];
    while (stack.length) {
      const [a, b] = /** @type {number[]} */ (stack.pop());
      let worst = tol;
      let split = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(ys[i] - (ys[a] + ((ys[b] - ys[a]) * (i - a)) / (b - a)));
        if (d > worst) {
          worst = d;
          split = i;
        }
      }
      if (split >= 0) {
        at.push(split);
        stack.push([a, split], [split, b]);
      }
    }
    at.sort((x, y) => x - y);
    let text = String(round(ys[0]));
    let slope = 0;
    for (let k = 1; k < at.length; k++) {
      const x0 = at[k - 1] / n;
      const s = (ys[at[k]] - ys[at[k - 1]]) / (at[k] / n - x0);
      const d = round(s - slope);
      slope = s;
      if (d === 0) continue;
      text += ` ${d < 0 ? '-' : '+'} ${Math.abs(d)} * ${x0 === 0 ? 'l' : `max(0, l - ${round(x0)})`}`;
    }
    return text;
  }

  /** Does the shorthand `whole`, copied whole, reset this property? @param {string} whole @param {string} prop */
  function resets(whole, prop) {
    const prefix = FAMILY[whole];
    return prefix !== undefined && (prop === whole || (prop.startsWith(prefix) && !NOT_RESET.test(prop)));
  }

  /**
   * @param {{ transform(input: string, role: 'background' | 'foreground' | 'border' | 'edge' | 'shadow'): string | null, setRepair?: (on: boolean) => void, pair?: (fg: string, bg: string) => { fg: string, bg: string } | null, plain?: (input: string, role: any) => string | null, cvd?: { space: string, correct: number[][], offset?: number[] } | null, original?: boolean }} transformer
   * @param {{ resolve?: (color: string) => string | null, rootValue?: (name: string) => string, flatGradients?: boolean, onUse?: (name: string, roles: number) => void, relativeColor?: boolean }} [options]  `rootValue` gives the value a custom property has on the root (repair mode: see `varLook` in `sitetheme.js`); `relativeColor` tells whether the browser reads `oklch(from ...)` (asked of `CSS.supports` when left out); `resolve` turns a relative color (`rgb(from ...)`) into a plain one; `flatGradients` (the E-ink and Paper mode) turns a gradient into one solid color, or drops it when it fades; `onUse` hears each `var()` that a declaration reads, with the roles it is read for (the bits of `ROLE_BITS`)
   */
  function createRewriter(transformer, options = {}) {
    /** @typedef {{ changed: boolean, moved?: boolean, flat?: boolean }} State */

    // Repair mode (the page's own dark theme shows): a color that is right for a dark page comes back from the transformer as
    // the same text. `var()` is left alone, because the page's dark theme sets those variables; a declaration in which no color
    // moved is dropped from the copy.
    let repair = false;
    const MAX_NEST = 24;
    let nest = 0;
    /** While a custom property is turned into its variants, the variables its value reads are collected here, not reported. @type {Array<string | number> | null} */
    let collect = null;

    /** A `var()` is read for a role: the derived variable of that role is the one it needs. @param {string} name @param {string} role */
    function used(name, role) {
      const bits = ROLE_BITS[role];
      if (bits === undefined) return;
      if (collect !== null) collect.push(name, bits);
      else if (options.onUse) options.onUse(name, bits);
    }

    /** The look of a `var()` in repair mode, made by `sitetheme.js` when repair starts; without that module a `var()` is left as the page wrote it. @type {((whole: string, first: string, role: string) => string) | null} */
    let repairLook = null;

    /** @param {string} text @param {string} role */
    const colorOf = (text, role) => transformer.transform(text, /** @type {any} */ (role));

    /**
     * A color function whose only `var()` is the alpha, like `rgb(255 255 255 / var(--o))`.
     * @param {string} name @param {string} inner @param {string} role @returns {string | null}
     */
    function colorWithVarAlpha(name, inner, role) {
      const slash = inner.lastIndexOf('/');
      if (slash < 0) return null;
      const head = inner.slice(0, slash);
      const alpha = inner.slice(slash + 1).trim();
      if (head.includes('var(') || !alpha.startsWith('var(')) return null;
      const css = colorOf(`${name}(${head})`, role);
      if (css === null || !/^#[0-9a-f]{6}$/.test(css)) return null;
      const n = parseInt(css.slice(1), 16);
      return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
    }

    /** The alpha of a shadow whose color comes from channel variables: a plain number gets the same boost as a literal color. @param {string} text */
    function shadowAlpha(text) {
      const m = PLAIN_NUMBER.exec(text);
      if (m) {
        const a = Number(m[1]);
        if (a > 0 && a < 1) return String(Math.round(Math.max(a, Math.min(0.8, a * 1.6)) * 1000) / 1000);
      }
      const pct = /^\s*(\d*\.?\d+)%\s*$/.exec(text);
      if (pct) {
        const a = Number(pct[1]) / 100;
        if (a > 0 && a < 1) return `${Math.round(Math.max(a, Math.min(0.8, a * 1.6)) * 100000) / 1000}%`;
      }
      return text.trim();
    }

    /**
     * @param {string} value
     * @param {string} role
     * @param {string} base  URL that relative `url()` values resolve against
     * @param {State} state
     * @returns {string}
     */
    function scan(value, role, base, state) {
      // Real values nest a handful of functions. A hostile one nests thousands, which costs time at every level and ends in a stack overflow.
      if (nest >= MAX_NEST) return value;
      nest++;
      try {
        return scanValue(value, role, base, state);
      } finally {
        nest--;
      }
    }

    /** @param {string} value @param {string} role @param {string} base @param {State} state @returns {string} */
    function scanValue(value, role, base, state) {
      let out = '';
      let i = 0;
      const n = value.length;
      while (i < n) {
        const c = value.charCodeAt(i);
        if (c === 34 || c === 39) {
          const end = skipString(value, i);
          out += value.slice(i, end);
          i = end;
          continue;
        }
        if (c === 35) {
          let j = i + 1;
          while (j < n && isHex(value.charCodeAt(j))) j++;
          const token = value.slice(i, j);
          const css = colorOf(token, role);
          if (css === null) out += token;
          else {
            out += css;
            state.changed = true;
            if (css !== token) state.moved = true;
          }
          i = j;
          continue;
        }
        if (isIdentStart(c)) {
          let j = i + 1;
          while (j < n && isIdentChar(value.charCodeAt(j))) j++;
          const name = value.slice(i, j);
          const lower = name.toLowerCase();
          if (value.charCodeAt(j) === 40) {
            const end = matchParen(value, j);
            if (end < 0) {
              out += value.slice(i);
              break;
            }
            const inner = value.slice(j + 1, end);
            const whole = value.slice(i, end + 1);
            out += call(lower, name, inner, whole, role, base, state);
            i = end + 1;
            continue;
          }
          if (name.length >= 3 && name.length <= 20) {
            const css = colorOf(lower, role);
            if (css !== null) {
              out += css;
              state.changed = true;
              if (css !== lower) state.moved = true;
              i = j;
              continue;
            }
          }
          out += name;
          i = j;
          continue;
        }
        out += value[i];
        i++;
      }
      return out;
    }

    /** The themed text of a custom property by role and value, whether it held a color, and the variables it reads. @type {Map<string, { v: string, changed: boolean, uses: Array<string | number> | null }>} */
    const scanned = new Map();
    /** The relative-color text for a color built from channels, by role (`##` is the color); '' where the browser cannot read it. @type {Map<string, string>} */
    const looks = new Map();
    /** @type {boolean | null} */
    let relativeOk = null;

    /** `oklch(from ## L C H)` with the curves of the theme as sums of `max(0, l - knot)` terms fitted to the transformer, so a color built from channels comes out as a literal one. Reads in Chrome 119 and Firefox 128 (no `pow()`). @param {string} role */
    function relativeLook(role) {
      let text = looks.get(role);
      if (text !== undefined) return text;
      text = '';
      relativeOk ??= typeof options.relativeColor === 'boolean' ? options.relativeColor : typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('color', 'oklch(from red calc(l + max(0, l - 0.5) * clamp(0, c / 0.02, 1)) c h)');
      const color = /** @type {any} */ (dk).color;
      if (relativeOk && color) text = transformer.original ? '##' : buildLook(role, color);
      if (text !== '' && transformer.cvd) text = corrected(text, transformer.cvd);
      else if (transformer.original) text = '';
      looks.set(role, text);
      return text;
    }

    /** @type {boolean | null} */
    let linearOk = null;
    /**
     * The color vision filter on a relative color: the matrix and offset on the linear or the sRGB channels. '' where the browser cannot read it.
     * @param {string} inner @param {{ space: string, correct: number[][], offset?: number[] }} m
     */
    function corrected(inner, m) {
      linearOk ??= typeof options.relativeColor === 'boolean' ? options.relativeColor : typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('color', 'color(from red srgb-linear calc(0.5 * r + 0.1 * g) g b)');
      if (!linearOk) return '';
      const o = m.offset ?? [0, 0, 0];
      const row = (/** @type {number[]} */ r, /** @type {number} */ i) => `calc(${round(r[0])} * r + ${round(r[1])} * g + ${round(r[2])} * b${o[i] ? ` + ${round(o[i])}` : ''})`;
      return `color(from ${inner} ${m.space === 'srgb' ? 'srgb' : 'srgb-linear'} ${row(m.correct[0], 0)} ${row(m.correct[1], 1)} ${row(m.correct[2], 2)})`;
    }

    /** @param {string} role @param {any} color @returns {string} */
    function buildLook(role, color) {
      const N = 32;
      const hues = [30, 120, 250, 320];
      // The fit is made without the correction for color vision, which goes around the result (corrected()).
      const themed = transformer.cvd && transformer.plain ? transformer.plain : colorOf;
      /** @param {number} l @param {number} c @param {number} h @returns {number[] | null} */
      const run = (l, c, h) => {
        const css = themed(`oklch(${l} ${c} ${h})`, role);
        const out = css === null ? null : color.parseColor(css);
        return out ? color.toOklch(out) : null;
      };
      const base = [];
      const lift = [];
      const keep = [];
      const extra = [];
      let ta = 0;
      let tb = 0;
      let tn = 0;
      for (let i = 0; i <= N; i++) {
        const l = i / N;
        const gray = run(l, 0, 0);
        if (!gray) return '';
        base.push(gray[0]);
        if (l >= 0.2 && l <= 0.8 && gray[1] > 0 && !Number.isNaN(gray[2])) {
          ta += gray[1] * Math.cos((gray[2] * Math.PI) / 180);
          tb += gray[1] * Math.sin((gray[2] * Math.PI) / 180);
          tn++;
        }
        let accentL = 0;
        let accentC = 0;
        let plainC = 0;
        for (const h of hues) {
          const a = run(l, 0.2, h);
          const p = run(l, 0.04, h);
          if (!a || !p) return '';
          accentL += a[0];
          accentC += a[1] / 0.2;
          plainC += p[1] / 0.04;
        }
        lift.push(accentL / hues.length - gray[0]);
        keep.push(plainC / hues.length);
        extra.push(accentC / hues.length - plainC / hues.length);
      }
      const tint = tn ? Math.hypot(ta, tb) / tn : 0;
      const tintHue = tn ? (((Math.atan2(tb, ta) * 180) / Math.PI) + 360) % 360 : 0;
      const t = 'clamp(0, (c - 0.05) / 0.07, 1)';
      const smooth = `(${t} * ${t} * (3 - 2 * ${t}))`;
      const w = 'clamp(0, c / 0.02, 1)';
      return `oklch(from ## calc(${pwl(base, 0.004)} + (${pwl(lift, 0.004)}) * ${smooth}) calc(c * (${pwl(keep, 0.03)} + (${pwl(extra, 0.03)}) * ${smooth}) * ${w} + ${round(tint)} * (1 - ${w})) calc(h + ${round(tintHue)} * (1 - clamp(0, c * 1000, 1))))`;
    }

    /** @type {((inner: string, kind: string) => string | null) | null | undefined} */
    let flatten;

    /** @param {string} lower @param {string} name @param {string} inner @param {string} whole @param {string} role @param {string} base @param {State} state */
    function call(lower, name, inner, whole, role, base, state) {
      if (CHANNEL_FUNCTIONS.has(lower) && inner.includes('var(') && !repair) {
        const m = CHANNEL_USE.exec(inner);
        if (m && m[1].length <= MAX_NAME && (m[3] === undefined || splitTopLevel(m[3]).length === 1)) {
          state.changed = true;
          const own = m[1].slice(2);
          used(m[1], role);
          // A shadow takes its own channels when the page's list differs for it, and the background ones otherwise.
          const derived = role === 'shadow' ? `--dk-sh-ch--${own},var(--dk-bg-ch--${own},var(${m[1]}))` : `--dk-${LETTER[role]}-ch--${own},var(${m[1]})`;
          const tail = m[3] === undefined ? '' : `${m[2] === ',' ? ', ' : ' / '}${role === 'shadow' ? shadowAlpha(m[3]) : scan(m[3], role, base, state)}`;
          return `${name}(var(${derived})${tail})`;
        }
      }
      if (COLOR_FUNCTIONS.has(lower)) {
        const css = colorOf(whole, role);
        if (css !== null) {
          state.changed = true;
          if (css !== whole) state.moved = true;
          return css;
        }
        if (options.resolve && /\bfrom\b/i.test(inner) && !whole.includes('var(')) {
          // A relative color depends on the browser to be read; the browser gives back the plain color it stands for.
          const plain = options.resolve(whole);
          const themed = plain === null ? null : colorOf(plain, role);
          if (themed !== null) {
            state.changed = true;
            if (themed === plain) return whole;
            state.moved = true;
            return themed;
          }
        }
        if (repair) return whole;
        if (lower === 'color-mix' && whole.includes('var(')) {
          const parts = splitTopLevel(inner).map((part, i) => (i === 0 && /^\s*in(?![\w-])/i.test(part) ? part : scan(part, role, base, state)));
          state.changed = true;
          return `${name}(${parts.join(',')})`;
        }
        if (whole.includes('var(')) {
          const alpha = colorWithVarAlpha(lower, inner, role);
          if (alpha !== null) {
            state.changed = true;
            return alpha;
          }
          // Channels and literals mixed (`hsl(var(--h) 100% 95%)`): the browser moves the resolved color.
          const look = relativeLook(role);
          if (look !== '') {
            state.changed = true;
            state.moved = true;
            return look.replace('##', () => whole);
          }
        }
        return whole;
      }
      if (lower === 'var') {
        const comma = inner.indexOf(',');
        const first = (comma < 0 ? inner : inner.slice(0, comma)).trim();
        if (repair) {
          if (!first.startsWith('--') || first.length > MAX_NAME) return whole;
          const look = repairLook ? repairLook(whole, first, role) : whole;
          if (look !== whole) {
            state.changed = true;
            state.moved = true;
            return look;
          }
          if (comma < 0) return whole;
          /** @type {State} */
          const inFallback = { changed: false };
          const fallback = scan(inner.slice(comma + 1), role, base, inFallback);
          if (!inFallback.moved) return whole;
          state.changed = true;
          state.moved = true;
          return `var(${first},${fallback})`;
        }
        if (!first.startsWith('--') || first.length > MAX_NAME) return whole;
        state.changed = true;
        used(first, role);
        if (comma < 0) return role === 'shadow' ? `var(--dk-sh--${first.slice(2)},var(--dk-bg--${first.slice(2)},${whole}))` : `var(--dk-${LETTER[role]}--${first.slice(2)},${whole})`;
        // The fallback is a value too: literal colors and nested var() in it are themed the same way.
        const fallback = scan(inner.slice(comma + 1), role, base, state);
        return role === 'shadow' ? `var(--dk-sh--${first.slice(2)},var(--dk-bg--${first.slice(2)},var(${first},${fallback})))` : `var(--dk-${LETTER[role]}--${first.slice(2)},var(${first},${fallback}))`;
      }
      if (lower === 'url') {
        let target = inner.trim();
        if (target.length >= 2 && (target[0] === '"' || target[0] === "'")) target = target.slice(1, -1);
        if (target === '' || target.startsWith('#') || /^(?:data|blob|about):/i.test(target)) return whole;
        try {
          return `url("${new URL(target, base).href}")`;
        } catch {
          return whole;
        }
      }
      if (lower === 'light-dark') {
        const parts = splitTopLevel(inner);
        if (parts.length === 2 && repair) {
          const dark = scan(parts[1], role, base, state);
          if (dark === parts[1]) return whole;
          state.moved = true;
          return `${name}(${parts[0]},${dark})`;
        }
        if (parts.length === 2) return `${name}(${scan(parts[0], role, base, state)},${scan(parts[1], role, base, state)})`;
        return whole;
      }
      if (lower === 'drop-shadow') return `${name}(${scan(inner, 'shadow', base, state)})`;
      if (GRADIENT.test(lower)) {
        if (state.flat) {
          flatten ??= /** @type {any} */ (dk).einkpalette?.flatten({ splitTopLevel, splitSpaces, colorOf }) ?? null;
          const flat = flatten ? flatten(inner, lower) : null;
          if (flat !== null) {
            state.changed = true;
            return flat;
          }
        }
        return `${name}(${scan(inner, role, base, state)})`;
      }
      if (PICTURE_COLORS.has(lower)) return `${name}(${scan(inner, role, base, state)})`;
      return whole;
    }

    /**
     * Rewrite the value of a color-bearing property.
     * Returns null when the property is not handled or the value must not be copied.
     * @param {string} property lower-case name
     * @param {string} value
     * @param {string} base
     * @param {boolean} [control]  the rule styles a form control: its border keeps a contrast floor
     * @param {boolean} [textClip]  the background is clipped to the text, so its gradient colors the letters: it is themed like text
     * @returns {string | null}
     */
    function declaration(property, value, base, control = false, textClip = false) {
      let role = control && ROLES[property] === 'border' ? 'edge' : ROLES[property];
      if (textClip && (property === 'background' || property === 'background-image')) role = 'foreground';
      if (role === undefined && property !== 'scrollbar-color') return null;
      let text = value.trim();
      if (text === '') return null;
      if ((property === 'filter' || property === '-webkit-filter') && !/drop-shadow\(/i.test(text)) return null;
      // The CSSOM prints a layer that only sets a color as `initial` in a list of images; that is not valid.
      if (property === 'background-image' && text.includes(',') && text.includes('initial')) text = splitTopLevel(text).map((layer) => (layer === 'initial' ? 'none' : layer)).join(', ');
      if (/\b(?:image-set|src)\(/i.test(text) || /^-webkit-image-set\(/i.test(text)) return null;
      const state = { changed: false, moved: false, flat: options.flatGradients === true && !textClip && (property === 'background' || property === 'background-image') && text.includes('gradient(') && !/\b(?:url|element)\(/i.test(text) };
      if (property === 'scrollbar-color') {
        const parts = splitSpaces(text);
        if (parts.length !== 2) return null;
        const pair = `${scan(parts[0], 'border', base, state)} ${scan(parts[1], 'background', base, state)}`;
        return repair && !state.moved ? null : pair;
      }
      const result = scan(text, role, base, state);
      return repair && !state.moved ? null : result;
    }

    /** The registered derived variables of a registered color, one per role, with its inheritance and the themed initial value. @param {string} name `--x` @param {string} syntax @param {boolean | string} inherits @param {string | null} initial */
    function registered(name, syntax, inherits, initial) {
      if (repair || !initial || !/^--[\w-]+$/.test(name) || name.length > MAX_NAME || initial.includes('var(') || syntax.replace(/["'\s]/g, '') !== '<color>') return '';
      let out = '';
      for (const role of ['background', 'foreground', 'border']) {
        const value = scan(initial, role, '', { changed: false });
        out += `@property --dk-${LETTER[role]}--${name.slice(2)}{syntax:"<color>";inherits:${inherits === true || inherits === 'true'};initial-value:${value}}`;
      }
      return out;
    }

    /** @param {string} name `--x` @param {string} body the declarations of an `@property` rule */
    function registeredText(name, body) {
      /** @type {Record<string, string>} */
      const found = {};
      for (const part of body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
        const colon = part.indexOf(':');
        if (colon > 0) found[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim();
      }
      return registered(name.trim(), found.syntax ?? '', (found.inherits ?? '').toLowerCase() === 'true', found['initial-value'] ?? null);
    }

    /**
     * A shorthand cut to what the theme touches: the color longhand, or the picture and color longhands of a background. Where the
     * place of the color is uncertain the whole shorthand is copied and `whole` tells the caller to write the later declarations of its family again.
     * @param {string} name a shorthand @param {string} value @param {string} base @param {boolean} [control] @param {boolean} [clip]
     * @param {string} [colorAs]  the property whose rule themes the background color (a mask or a mark box)
     * @returns {{ list: string[][], whole: boolean }}
     */
    function shorthand(name, value, base, control = false, clip = false, colorAs = '') {
      const text = value.trim();
      const longhand = COLOR_PART[name];
      if (longhand !== undefined) {
        const token = text.includes('var(') ? varColor(name, text) : colorOfShorthand(text, longhand);
        if (token !== null) {
          const v = declaration(longhand, token, base, control);
          return { list: v === null && repair ? [] : [[longhand, v ?? token]], whole: false };
        }
      } else if (name === 'background') {
        const parts = backgroundParts(text);
        if (parts !== null) {
          const image = declaration('background-image', parts.images, base, false, clip);
          const v = colorAs ? declaration(colorAs, parts.color, base) : declaration('background-color', parts.color, base, control);
          /** @type {string[][]} */
          const list = [];
          if (image !== null) list.push(['background-image', image]);
          if (v !== null || !repair) list.push(['background-color', v ?? parts.color]);
          return { list, whole: false };
        }
      }
      const v = declaration(name, text, base, control, clip);
      return { list: v === null ? [] : [[name, v]], whole: v !== null && name !== 'border-color' };
    }

    /**
     * The two declarations that go after a rule whose letters are filled by a clipped background (gradient text) in the E-ink and
     * Paper mode: no picture, and the ink as the fill. Other modes need nothing (the gradient is themed like text).
     * @returns {string}
     */
    function textClipRules() {
      if (options.flatGradients !== true) return '';
      const ink = colorOf('#000000', 'foreground');
      return ink === null ? '' : `background-image:none!important;-webkit-text-fill-color:${ink}!important;`;
    }

    /** @param {string} hex `#rrggbb` @returns {[number, number, number]} h 0 to 360, s and l 0 to 100 */
    function hexToHsl(hex) {
      const n = parseInt(hex.slice(1, 7), 16);
      const r = ((n >> 16) & 255) / 255;
      const g = ((n >> 8) & 255) / 255;
      const b = (n & 255) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      if (d === 0) return [0, 0, Math.round(l * 100)];
      const s = d / (1 - Math.abs(2 * l - 1));
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
    }

    /**
     * A custom property that holds a plain list of channels (`--rgb: 255 255 255`) is used as `rgb(var(--rgb))`.
     * For each role this makes a sibling list with the themed channels, in the same notation.
     * @param {string} name @param {string} text @param {string} suffix @param {number} want  the roles to make, as the bits of `ROLE_BITS`
     * @returns {string[]} the four declarations (background, foreground, border, shadow), each empty when it does not apply or is not wanted
     */
    function channelVariables(name, text, suffix, want) {
      const out = ['', '', '', ''];
      const m = CHANNEL_LIST.exec(text);
      if (!m) return out;
      const sep = m[2];
      const percent = m[4] === '%' && m[6] === '%';
      const [x, y, z] = [Number(m[1]), Number(m[3]), Number(m[5])];
      if (!percent && (m[4] || m[6])) return out;
      if (!percent && (x > 255 || y > 255 || z > 255)) return out;
      if (percent && (x > 360 || y > 100 || z > 100)) return out;
      let backgroundList = '';
      ['background', 'foreground', 'border', 'shadow'].forEach((role, at) => {
        // The shadow list is judged against the background one, which is made for that even when it is not wanted.
        if (!(want & (1 << at)) && !(at === 0 && want & 8)) return;
        const css = colorOf(percent ? `hsl(${x} ${y}% ${z}%)` : `rgb(${x} ${y} ${z})`, role);
        if (css === null || !/^#[0-9a-f]{6}$/.test(css)) return;
        let list;
        if (percent) {
          const [h, s, l] = hexToHsl(css);
          list = `${h}${sep}${s}%${sep}${l}%`;
        } else {
          const n = parseInt(css.slice(1), 16);
          list = `${(n >> 16) & 255}${sep}${(n >> 8) & 255}${sep}${n & 255}`;
        }
        if (role === 'background') backgroundList = list;
        // The channels hold no alpha, so a shadow list differs only when the shadow color is not the background one.
        if ((role === 'shadow' && list === backgroundList) || !(want & (1 << at))) return;
        out[at] = `--dk-${LETTER[role]}-ch--${name.slice(2)}:${list}${suffix};`;
      });
      return out;
    }

    /**
     * The derived declarations of a custom property, one set for each role, or null when the value holds no color and no `var()`.
     * `uses[role]` lists the variables (name, role bits, name, role bits ...) the variant of that role reads, so a caller that
     * writes only the variants in demand can ask for those variables.
     * @param {string} name `--x`
     * @param {string} value
     * @param {string} base
     * @param {string} [priority]
     * @param {number} [want]  the roles to make (bits of `ROLE_BITS`); a color costs a transform for each, so a caller makes the ones in demand
     * @returns {{ channels: string[], values: string[], uses: Array<Array<string | number> | null>, free?: boolean } | null}  `free`: the value holds no color; the declarations reset the derived variables (written for the roles in demand only)
     */
    function customVariants(name, value, base, priority = '', want = 15) {
      const text = value.trim();
      if (repair || text === '' || name.length > MAX_NAME || text.length > 4000) return null;
      const suffix = priority === 'important' ? '!important' : '';
      const channels = channelVariables(name, text, suffix, want);
      const values = ['', '', '', ''];
      /** @type {Array<Array<string | number> | null>} */
      const uses = [null, null, null, null];
      const roles = ['background', 'foreground', 'border'];
      for (let at = 0; at < roles.length; at++) {
        if (!(want & (1 << at))) continue;
        // The same value in many variables (a palette repeats its colors) is themed once.
        const key = `${at}\u0001${text.includes('url(') ? base : ''}\u0001${text}`;
        let hit = scanned.get(key);
        if (hit === undefined) {
          const state = { changed: false };
          const saved = collect;
          collect = [];
          try {
            hit = { v: scan(text, roles[at], base, state), changed: state.changed, uses: collect.length ? collect : null };
          } finally {
            collect = saved;
          }
          if (scanned.size >= 3000) scanned.clear();
          scanned.set(key, hit);
        }
        uses[at] = hit.uses;
        if (!hit.changed) {
          if (channels.some((c) => c !== '')) return { channels, values, uses };
          // A value with no color overrides the variable in its scope: the derived ones of an outer scope must not reach through it.
          if (/^(?:inherit|unset|revert|revert-layer)$/i.test(text)) return null;
          const reset = (/** @type {string} */ infix) => ['bg', 'fg', 'bd', 'sh'].map((l) => `--dk-${l}${infix}--${name.slice(2)}:initial${suffix};`);
          return { channels: reset('-ch'), values: reset(''), uses, free: true };
        }
        values[at] = `--dk-${LETTER[roles[at]]}--${name.slice(2)}:${hit.v}${suffix};`;
      }
      // A shadow color that differs from the background one has its own variable, which `var()` in a shadow reads first. A value
      // that only points at other variables is left out: the variable it points at has the shadow version.
      const shadow = !(want & 8) || text.includes('var(') ? '' : scan(text, 'shadow', base, { changed: false });
      if (shadow !== '' && shadow !== scan(text, 'background', base, { changed: false })) values[3] = `--dk-sh--${name.slice(2)}:${shadow}${suffix};`;
      return { channels, values, uses };
    }

    /**
     * For a custom property: the derived declarations of every role, or '' when the value holds no color and no `var()`.
     * @param {string} name `--x`
     * @param {string} value
     * @param {string} base
     * @param {string} [priority]
     * @returns {string}
     */
    function customProperty(name, value, base, priority = '') {
      const v = customVariants(name, value, base, priority);
      return v === null || v.free ? '' : v.channels.join('') + v.values.join('');
    }

    /**
     * A white or near white `fill`, or a near black translucent one, on a shape with an area (rect, circle, ellipse, polygon) is a
     * cover, plate or scrim (the veil that fades a chart legend entry). As a text-like color it would turn light, so it follows
     * the page color. Icons and text (paths, text) keep the foreground rule.
     * @param {string} selector @param {string} value @param {boolean} [important]
     * @returns {string} an extra rule, or an empty string
     */
    function shapeFill(selector, value, important = false) {
      if (selector.length > 400 || selector.includes('::') || value.includes('var(')) return '';
      const c = /** @type {any} */ (dk).color.parseColor(value.trim());
      if (!c || c.a <= 0) return '';
      if (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > 0.06) return '';
      const y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      // A near black translucent fill is a scrim or a shadow: it must stay a dark veil. An opaque black shape keeps the foreground rule.
      if (!(y >= 0.8 || (y <= 0.2 && c.a < 1))) return '';
      const themed = colorOf(value.trim(), 'background');
      if (repair && themed === value.trim()) return '';
      return themed ? `:is(${selector}):is(rect,circle,ellipse,polygon){fill:${themed}${important ? '!important' : ''}}` : '';
    }

    /** Text colors of rules that also set their background: the moved text color, or '' when the pair keeps the plain one. @type {Map<string, string>} */
    const pairs = new Map();
    const MAX_PAIRS = 4000;
    /**
     * The text color of a rule that also sets an opaque background color, moved so the two keep their contrast (the pair
     * floor), or null when the plain themed text color already does. Both values as the page wrote them.
     * @param {string} fg @param {string} bg @returns {string | null}
     */
    function pairColor(fg, bg) {
      if (repair || typeof transformer.pair !== 'function') return null;
      const key = `${fg}\u0001${bg}`;
      let out = pairs.get(key);
      if (out === undefined) {
        const plain = colorOf(fg, 'foreground');
        const pair = plain === null || !transformer.pair ? null : transformer.pair(fg, bg);
        out = pair && pair.fg !== plain ? pair.fg : '';
        if (pairs.size >= MAX_PAIRS) pairs.clear();
        pairs.set(key, out);
      }
      return out === '' ? null : out;
    }

    return Object.freeze({
      declaration,
      shorthand,
      pairColor,
      registered,
      registeredText,
      textClipRules,
      customProperty,
      customVariants,
      shapeFill,
      isRelevant: (/** @type {string} */ name) => name in ROLES || name === 'scrollbar-color' || name.startsWith('--'),
      isShorthand: (/** @type {string} */ name) => SHORTHANDS.has(name),
      /** Switch repair mode on or off (the transformer switches with it). @param {boolean} on */
      setRepair: (on) => {
        repair = on;
        scanned.clear();
        repairLook = on ? /** @type {any} */ (dk).sitetheme?.varLook({ rootValue: options.rootValue, relativeColor: options.relativeColor, colorOf, themeText: (/** @type {string} */ t, /** @type {string} */ r) => scan(t, /** @type {any} */ (r), '', { changed: false }) }) ?? null : null;
        transformer.setRepair?.(on);
      },
      isRepairing: () => repair,
      scan: (/** @type {string} */ value, /** @type {'background' | 'foreground' | 'border'} */ role, /** @type {string} */ base) =>
        scan(value, role, base, { changed: false }),
    });
  }

  /** The selector the way the browser prints it, so the text of a sheet and its CSSOM rule can be matched. @param {string} s */
  function normalizeSelector(s) {
    return s
      .replace(/\s+/g, ' ')
      .replace(/\s*([>+~,])\s*/g, '$1')
      .replace(/(^|[^:]):(after|before|first-line|first-letter)\b/g, '$1::$2')
      .replace(/["']/g, '"')
      .trim();
  }

  const VAR_OPEN = /var\(/gi;
  const DECLARATION_END = /[;}]/g;
  const SHORTHAND_NAME =/(^|[;{\s])(?:background|border(?:-[a-z-]+)?|outline|column-rule|text-decoration|text-emphasis|-webkit-text-stroke)\s*:/gi;

  /**
   * Does a shorthand declaration hold `var(`? The three cursors only move forward, so time stays linear (one regular expression
   * with `[^;}]*` would rescan the rest of the declaration from every candidate).
   * @param {string} text
   */
  function hasShorthandVar(text) {
    const names = SHORTHAND_NAME;
    const vars = VAR_OPEN;
    const stops = DECLARATION_END;
    let from = 0;
    let nextVar = -2;
    let nextStop = -2;
    for (;;) {
      names.lastIndex = from;
      const m = names.exec(text);
      if (!m) return false;
      const after = m.index + m[0].length;
      if (nextVar !== -1 && nextVar < after) {
        vars.lastIndex = after;
        const v = vars.exec(text);
        nextVar = v ? v.index : -1;
      }
      if (nextVar === -1) return false;
      if (nextStop !== -1 && nextStop < after) {
        stops.lastIndex = after;
        const e = stops.exec(text);
        nextStop = e ? e.index : -1;
      }
      if (nextStop === -1 || nextVar < nextStop) return true;
      from = nextStop;
    }
  }

  /**
   * The CSSOM drops the text of a shorthand that holds `var()` when a longhand of the same group follows it in the rule.
   * This reads the source text and keeps those declarations, rule by rule, in source order.
   * @param {string} text the source of a style sheet
   * @returns {Map<string, string[]>} normalized selector to the declaration text of each such rule, in order
   */
  function parseVarShorthands(text) {
    /** @type {Map<string, string[]>} */
    const out = new Map();
    if (!hasShorthandVar(text)) return out;
    const n = text.length;
    /** Index after a comment, string or the end of a block that starts at i, or -1 when none starts there. @param {number} i */
    const skipQuoted = (i) => {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 39) return skipString(text, i);
      if (c === 47 && text.charCodeAt(i + 1) === 42) {
        const end = text.indexOf('*/', i + 2);
        return end < 0 ? n : end + 2;
      }
      return -1;
    };
    /** @param {number} from @param {number} to @param {number} depth */
    const walk = (from, to, depth) => {
      let i = from;
      while (i < to) {
        const start = i;
        let j = i;
        let paren = 0;
        while (j < to) {
          const skip = skipQuoted(j);
          if (skip >= 0) {
            j = skip;
            continue;
          }
          const c = text.charCodeAt(j);
          if (c === 40) paren += 1;
          else if (c === 41) paren = Math.max(0, paren - 1);
          else if (paren === 0 && (c === 123 || c === 59 || c === 125)) break;
          j += 1;
        }
        if (j >= to) return;
        const stop = text.charCodeAt(j);
        if (stop === 59 || stop === 125) {
          i = j + 1;
          continue;
        }
        // A block: find its end.
        let k = j + 1;
        let level = 1;
        while (k < to && level > 0) {
          const skip = skipQuoted(k);
          if (skip >= 0) {
            k = skip;
            continue;
          }
          const c = text.charCodeAt(k);
          if (c === 123) level += 1;
          else if (c === 125) level -= 1;
          k += 1;
        }
        const prelude = text.slice(start, j).replace(/\/\*[\s\S]*?\*\//g, '').trim();
        const inner = [j + 1, k - 1];
        if (prelude.startsWith('@')) {
          if (depth < 8 && /^@(media|supports|layer|container|scope|document|-moz-document)\b/i.test(prelude)) walk(inner[0], inner[1], depth + 1);
        } else if (prelude !== '') {
          const body = text.slice(inner[0], inner[1]);
          if (hasShorthandVar(` ${body}`)) {
            const key = normalizeSelector(prelude);
            const list = out.get(key);
            if (list) list.push(body);
            else out.set(key, [body]);
          }
        }
        i = k;
      }
    };
    walk(0, n, 0);
    return out;
  }

  /**
   * Layer names for the copy of one sheet. The copy sits after its sheet, so a copied anonymous `@layer {}` would be a new
   * layer after every layer the sheet declares later, and its rules would beat theirs. In the copy each anonymous layer
   * gets a name of its own, and a layer that a sheet declares for the first time after an anonymous one, at the same
   * level, gets a stand-in name kept for the tree (`scope`), so every copy uses it and the copies keep the order of the
   * originals. Inside a layer of our own every name is new already and is printed as it is.
   * @param {{ names: Map<string, string>, next: number, tag: string }} scope  the stand-in names of a document or a shadow root
   * @param {(path: string) => boolean} known  a sheet before this one declares the layer (or that cannot be told)
   */
  function layerNamer(scope, known) {
    /** @typedef {{ path: string | null, anon: boolean, seen: Set<string> }} Level  path null: a layer of our own */
    /** @type {Map<string, Level>} */
    const levels = new Map();
    /** @param {string | null} path @returns {Level} */
    const levelOf = (path) => {
      if (path === null) return { path: null, anon: false, seen: new Set() };
      let level = levels.get(path);
      if (!level) {
        level = { path, anon: false, seen: new Set() };
        levels.set(path, level);
      }
      return level;
    };
    /** @type {Level[]} */
    const stack = [levelOf('')];
    /** How many levels each open block pushed. @type {number[]} */
    const opened = [];
    /** The layer paths this sheet declares, by their own names. @type {Set<string>} */
    const paths = new Set();
    const fresh = () => `dk-l${scope.tag}-${++scope.next}`;

    /** One name at a level: what the copy prints and the level inside it. @param {Level} level @param {string} name */
    function step(level, name) {
      if (level.path === null) return { print: name, inner: levelOf(null), own: true };
      const full = level.path === '' ? name : `${level.path}.${name}`;
      let stand = scope.names.get(full);
      if (stand === undefined && level.anon && !level.seen.has(name) && !known(full)) {
        stand = fresh();
        scope.names.set(full, stand);
      }
      if (stand !== undefined) return { print: stand, inner: levelOf(null), own: true };
      level.seen.add(name);
      paths.add(full);
      return { print: name, inner: levelOf(full), own: false };
    }

    /** @param {string} name a dotted name, '' for an anonymous layer @returns {{ print: string, own: boolean, levels: Level[] }} */
    function walk(name) {
      let level = stack[stack.length - 1];
      if (name.trim() === '') {
        if (level.path !== null) level.anon = true;
        return { print: fresh(), own: true, levels: [levelOf(null)] };
      }
      const printed = [];
      const pushed = [];
      let own = false;
      for (const part of name.split('.')) {
        const r = step(level, part.trim());
        printed.push(r.print);
        if (r.own) own = true;
        level = r.inner;
        pushed.push(level);
      }
      return { print: printed.join('.'), own, levels: pushed };
    }

    return {
      /** A layer block or a layered import opens. @param {string} name @returns {string} the name the copy prints */
      open(name) {
        const r = walk(name);
        stack.push(...r.levels);
        opened.push(r.levels.length);
        return r.print;
      },
      close() {
        const n = opened.pop() ?? 0;
        stack.length = Math.max(1, stack.length - n);
      },
      /** A layer statement. @param {string[]} names @returns {string} the statement the copy needs, or '' when the page's own one keeps the order */
      statement(names) {
        /** @type {string[]} */
        const out = [];
        for (const name of names) {
          if (name.trim() === '') continue;
          const r = walk(name);
          if (r.own) out.push(r.print);
        }
        return out.length ? `@layer ${out.join(',')};` : '';
      },
      paths,
    };
  }

  dk.rewrite = Object.freeze({ createRewriter, parseVarShorthands, normalizeSelector, resets, plainBackgroundColor, layerNamer, FAMILY });
})();
