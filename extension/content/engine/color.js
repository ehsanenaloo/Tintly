// @ts-check
// Color parsing and the dark and light transform. Pure functions, no DOM.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  /** @typedef {{ r: number, g: number, b: number, a: number }} Rgba  sRGB, gamma encoded, may leave 0..1 for wide-gamut input */
  /** @typedef {[number, number, number]} Vec3 */
  /** `edge` is a border that marks a control or a focus ring: it keeps a contrast floor. `shadow` is the color of a box, text or drop shadow. @typedef {'background' | 'foreground' | 'border' | 'edge' | 'shadow'} Role */

  const MAX_INPUT = 300;
  const MAX_DEPTH = 4;

  /* ---------------------------------------------------------------- */
  /* Basic math                                                        */
  /* ---------------------------------------------------------------- */

  const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) =>
    v < lo ? lo : v > hi ? hi : v;
  const lerp = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ t) => a + (b - a) * t;

  /** @param {number} v */
  const srgbToLinear = (v) => {
    const x = Math.abs(v);
    return Math.sign(v) * (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  };
  /** @param {number} v */
  const linearToSrgb = (v) => {
    const x = Math.abs(v);
    return Math.sign(v) * (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
  };

  /** @typedef {number[][]} Mat3 */
  /** @param {Mat3} m @param {number[]} v @returns {Vec3} */
  const mul = (m, v) => [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
  /** @param {Mat3} m @returns {Mat3} */
  const invert = (m) => {
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
  };

  // Linear RGB to XYZ (D65) for each supported RGB space, and the D50 to D65 adaptation.
  const SRGB_XYZ = [
    [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
    [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
    [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
  ];
  const P3_XYZ = [
    [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
    [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
    [0, 0.04511338185890264, 1.043944368900976],
  ];
  const A98_XYZ = [
    [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
    [0.29734497525053605, 0.6273635662554661, 0.0752914584939978],
    [0.02703136138641234, 0.07068885253582723, 0.9913375368376388],
  ];
  const REC2020_XYZ = [
    [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
    [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
    [0, 0.028072693049087428, 1.060985057710791],
  ];
  const PROPHOTO_XYZ_D50 = [
    [0.7977604896723027, 0.13518583717574031, 0.0313493495815248],
    [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902],
    [0, 0, 0.8251046025104601],
  ];
  const D50_TO_D65 = [
    [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
    [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
    [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
  ];
  const D65_TO_D50 = invert(D50_TO_D65);
  const XYZ_SRGB = invert(SRGB_XYZ);
  const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

  /** @type {Record<string, { m: Mat3, d50?: boolean, decode: (v: number) => number, encode: (v: number) => number }>} */
  const RGB_SPACES = {
    srgb: { m: SRGB_XYZ, decode: srgbToLinear, encode: linearToSrgb },
    'srgb-linear': { m: SRGB_XYZ, decode: (v) => v, encode: (v) => v },
    'display-p3': { m: P3_XYZ, decode: srgbToLinear, encode: linearToSrgb },
    'a98-rgb': { m: A98_XYZ, decode: (v) => Math.sign(v) * Math.abs(v) ** (563 / 256), encode: (v) => Math.sign(v) * Math.abs(v) ** (256 / 563) },
    'prophoto-rgb': {
      m: PROPHOTO_XYZ_D50,
      d50: true,
      decode: (v) => {
        const x = Math.abs(v);
        return Math.sign(v) * (x <= 16 / 512 ? x / 16 : x ** 1.8);
      },
      encode: (v) => {
        const x = Math.abs(v);
        return Math.sign(v) * (x < 1 / 512 ? 16 * x : x ** (1 / 1.8));
      },
    },
    rec2020: {
      m: REC2020_XYZ,
      decode: (v) => {
        const a = 1.09929682680944;
        const b = 0.018053968510807;
        const x = Math.abs(v);
        return Math.sign(v) * (x < b * 4.5 ? x / 4.5 : ((x + a - 1) / a) ** (1 / 0.45));
      },
      encode: (v) => {
        const a = 1.09929682680944;
        const b = 0.018053968510807;
        const x = Math.abs(v);
        return Math.sign(v) * (x < b ? 4.5 * x : a * x ** 0.45 - (a - 1));
      },
    },
  };

  /* ---------------------------------------------------------------- */
  /* Color space conversions. The common form is linear sRGB.          */
  /* ---------------------------------------------------------------- */

  /** @param {Vec3} lin @returns {Vec3} */
  const linearToXyz = (lin) => mul(SRGB_XYZ, lin);
  /** @param {Vec3} xyz @returns {Vec3} */
  const xyzToLinear = (xyz) => mul(XYZ_SRGB, xyz);

  const EPSILON = 216 / 24389;
  const KAPPA = 24389 / 27;

  /** @param {number} L @param {number} a @param {number} b @returns {Vec3} linear sRGB */
  const labToLinear = (L, a, b) => {
    const fy = (L + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    const x = fx ** 3 > EPSILON ? fx ** 3 : (116 * fx - 16) / KAPPA;
    const y = L > KAPPA * EPSILON ? fy ** 3 : L / KAPPA;
    const z = fz ** 3 > EPSILON ? fz ** 3 : (116 * fz - 16) / KAPPA;
    return xyzToLinear(mul(D50_TO_D65, [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]]));
  };

  /** @param {Vec3} lin @returns {Vec3} Lab (D50) */
  const linearToLab = (lin) => {
    const xyz = mul(D65_TO_D50, linearToXyz(lin));
    const f = xyz.map((v, i) => {
      const t = v / D50_WHITE[i];
      return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
    });
    return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
  };

  /** @param {number} L @param {number} a @param {number} b @returns {Vec3} linear sRGB */
  const oklabToLinear = (L, a, b) => {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  };

  /** @param {Vec3} lin @returns {Vec3} OKLab */
  const linearToOklab = (lin) => {
    const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
    const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
    const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };

  const rad = Math.PI / 180;
  /** @param {number} a @param {number} b @param {number} [eps]  chroma below this has no hue (a gray through D50 leaves noise of about 1e-3 in Lab) @returns {[number, number]} chroma and hue in degrees */
  const toPolar = (a, b, eps = 1e-7) => {
    const c = Math.hypot(a, b);
    return [c, c < eps ? NaN : (((Math.atan2(b, a) / rad) % 360) + 360) % 360];
  };
  /** @param {number} c @param {number} h @returns {[number, number]} */
  const fromPolar = (c, h) => [c * Math.cos((Number.isNaN(h) ? 0 : h) * rad), c * Math.sin((Number.isNaN(h) ? 0 : h) * rad)];

  /** @param {number} h @param {number} s @param {number} l @returns {Vec3} gamma sRGB */
  const hslToSrgb = (h, s, l) => {
    const hh = (((h % 360) + 360) % 360) / 30;
    const a = s * Math.min(l, 1 - l);
    /** @param {number} n */
    const f = (n) => {
      const k = (n + hh) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  };

  /** @param {Vec3} rgb @returns {Vec3} hue in degrees (NaN when gray), saturation and lightness 0..1 */
  const srgbToHsl = (rgb) => {
    const [r, g, b] = rgb;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (Math.abs(d) < 1e-7) return [NaN, 0, l];
    const s = l === 0 || l === 1 ? 0 : (max - l) / Math.min(l, 1 - l);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  };

  /** @param {number} h @param {number} w @param {number} b @returns {Vec3} gamma sRGB */
  const hwbToSrgb = (h, w, b) => {
    if (w + b >= 1) {
      const gray = w / (w + b);
      return [gray, gray, gray];
    }
    const rgb = hslToSrgb(h, 1, 0.5);
    return /** @type {Vec3} */ (rgb.map((v) => v * (1 - w - b) + w));
  };

  /** @param {Vec3} rgb @returns {Vec3} */
  const srgbToHwb = (rgb) => {
    const [h] = srgbToHsl(rgb);
    return [h, Math.min(...rgb), 1 - Math.max(...rgb)];
  };

  /* ---------------------------------------------------------------- */
  /* Named colors                                                      */
  /* ---------------------------------------------------------------- */

  const NAMED = Object.assign(Object.create(null), {
    aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4, azure: 0xf0ffff,
    beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000, blanchedalmond: 0xffebcd, blue: 0x0000ff,
    blueviolet: 0x8a2be2, brown: 0xa52a2a, burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00,
    chocolate: 0xd2691e, coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
    cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9,
    darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b, darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f,
    darkorange: 0xff8c00, darkorchid: 0x9932cc, darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f,
    darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1,
    darkviolet: 0x9400d3, deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969,
    dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22, fuchsia: 0xff00ff,
    gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700, goldenrod: 0xdaa520, gray: 0x808080,
    green: 0x008000, greenyellow: 0xadff2f, grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4,
    indianred: 0xcd5c5c, indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa,
    lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6, lightcoral: 0xf08080,
    lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3, lightgreen: 0x90ee90,
    lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a, lightseagreen: 0x20b2aa,
    lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899, lightsteelblue: 0xb0c4de,
    lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32, linen: 0xfaf0e6, magenta: 0xff00ff,
    maroon: 0x800000, mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd, mediumorchid: 0xba55d3,
    mediumpurple: 0x9370db, mediumseagreen: 0x3cb371, mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a,
    mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585, midnightblue: 0x191970, mintcream: 0xf5fffa,
    mistyrose: 0xffe4e1, moccasin: 0xffe4b5, navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6,
    olive: 0x808000, olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500, orchid: 0xda70d6,
    palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee, palevioletred: 0xdb7093,
    papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd,
    powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399, red: 0xff0000, rosybrown: 0xbc8f8f,
    royalblue: 0x4169e1, saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57,
    seashell: 0xfff5ee, sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd,
    slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f, steelblue: 0x4682b4,
    tan: 0xd2b48c, teal: 0x008080, thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0,
    violet: 0xee82ee, wheat: 0xf5deb3, white: 0xffffff, whitesmoke: 0xf5f5f5, yellow: 0xffff00,
    yellowgreen: 0x9acd32,
  });

  /* ---------------------------------------------------------------- */
  /* Parsing                                                           */
  /* ---------------------------------------------------------------- */

  const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/;
  const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;

  /** @param {string} tok @param {number} pct value of 100 percent @returns {number | null} */
  const component = (tok, pct) => {
    if (tok === 'none') return 0;
    const percent = tok.endsWith('%');
    const text = percent ? tok.slice(0, -1) : tok;
    if (!NUMBER.test(text)) return null;
    // A number beyond what a display can show is clamped; one beyond the range of a double is not a color.
    const n = Number(text) * (percent ? pct / 100 : 1);
    return Number.isFinite(n) ? clamp(n, -BIG, BIG) : null;
  };

  /** @param {string} tok @returns {number | null} degrees */
  const hueOf = (tok) => {
    if (tok === 'none') return 0;
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/.exec(tok);
    if (!m) return null;
    const v = Number(m[1]);
    const deg = m[2] === 'rad' ? v / rad : m[2] === 'grad' ? v * 0.9 : m[2] === 'turn' ? v * 360 : v;
    return Number.isFinite(deg) ? deg % 360 : null;
  };

  /** @param {string | null | undefined} tok @returns {number | null} */
  const alphaOf = (tok) => {
    if (tok === null || tok === undefined) return 1;
    const v = component(tok, 1);
    return v === null ? null : clamp(v, 0, 1);
  };

  /**
   * The arguments of a color function the way a browser accepts them, or null (the browser ignores the rest, so a copy must not make it live).
   * Modern: spaces and an alpha after a slash. Legacy (rgb, rgba, hsl, hsla only): commas, the alpha fourth, no slash, no mix of numbers
   * and percents in rgb, percents for saturation and lightness in hsl.
   * @param {string} name @param {string} inner
   * @returns {{ parts: string[], alpha: string | null } | null}
   */
  const splitFunctionArgs = (name, inner) => {
    if (inner.includes('(')) return null;
    const need = name === 'color' ? 4 : 3;
    if (inner.includes(',')) {
      if (!LEGACY.has(name) || inner.includes('/')) return null;
      const list = inner.split(',').map((t) => t.trim());
      if (list.length !== 3 && list.length !== 4) return null;
      if (list.some((t) => t === '' || t === 'none' || /\s/.test(t))) return null;
      const pct = list.slice(0, 3).map((t) => t.endsWith('%'));
      if (name.startsWith('rgb') ? pct.some((x) => x !== pct[0]) : !pct[1] || !pct[2]) return null;
      return { parts: list.slice(0, 3), alpha: list[3] ?? null };
    }
    const flat = inner.replace(/\//g, ' / ').split(/\s+/).filter(Boolean);
    const slash = flat.indexOf('/');
    if (slash >= 0) return slash === need && flat.length === need + 2 ? { parts: flat.slice(0, slash), alpha: flat[slash + 1] } : null;
    return flat.length === need ? { parts: flat, alpha: null } : null;
  };
  const LEGACY = new Set(['rgb', 'rgba', 'hsl', 'hsla']);
  /** The farthest a color component is taken: beyond it nothing changes on a display. */
  const BIG = 1e6;
  /** The channel of a color written in the legacy gamut (rgb, hsl, hwb), as 8 bits, which is how a browser keeps it (it computes in single precision, so a tie at .5 rounds down as it does there). @param {number} v */
  const eight = (v) => Math.round(Math.fround(Math.fround(clamp(v, 0, 1)) * 255)) / 255;

  /** @param {Vec3} lin @param {number} a @returns {Rgba} */
  const fromLinear = (lin, a) => ({ r: linearToSrgb(lin[0]), g: linearToSrgb(lin[1]), b: linearToSrgb(lin[2]), a });

  /** @param {number[]} srgb @param {number} a @returns {Rgba} */
  const fromSrgb = (srgb, a) => ({ r: srgb[0], g: srgb[1], b: srgb[2], a });

  /**
   * @param {string} name
   * @param {string[]} p
   * @param {number} a
   * @returns {Rgba | null}
   */
  function fromFunction(name, p, a) {
    if (name === 'color') return null;
    if (p.length !== 3) return null;
    switch (name) {
      case 'rgb':
      case 'rgba': {
        const v = p.map((t) => component(t, 255));
        return v.includes(null) ? null : fromSrgb(/** @type {number[]} */ (v).map((x) => eight(x / 255)), a);
      }
      case 'hsl':
      case 'hsla': {
        const h = hueOf(p[0]);
        const s = component(p[1], 100);
        const l = component(p[2], 100);
        if (h === null || s === null || l === null) return null;
        return fromSrgb(hslToSrgb(h, clamp(s, 0, 100) / 100, clamp(l, 0, 100) / 100).map(eight), a);
      }
      case 'hwb': {
        const h = hueOf(p[0]);
        const w = component(p[1], 100);
        const b = component(p[2], 100);
        if (h === null || w === null || b === null) return null;
        return fromSrgb(hwbToSrgb(h, clamp(w, 0, 100) / 100, clamp(b, 0, 100) / 100).map(eight), a);
      }
      case 'lab': {
        const L = component(p[0], 100);
        const A = component(p[1], 125);
        const B = component(p[2], 125);
        if (L === null || A === null || B === null) return null;
        return fromLinear(labToLinear(clamp(L, 0, 100), A, B), a);
      }
      case 'lch': {
        const L = component(p[0], 100);
        const C = component(p[1], 150);
        const h = hueOf(p[2]);
        if (L === null || C === null || h === null) return null;
        const [A, B] = fromPolar(Math.max(C, 0), h);
        return fromLinear(labToLinear(clamp(L, 0, 100), A, B), a);
      }
      case 'oklab': {
        const L = component(p[0], 1);
        const A = component(p[1], 0.4);
        const B = component(p[2], 0.4);
        if (L === null || A === null || B === null) return null;
        return fromLinear(oklabToLinear(clamp(L, 0, 1), A, B), a);
      }
      case 'oklch': {
        const L = component(p[0], 1);
        const C = component(p[1], 0.4);
        const h = hueOf(p[2]);
        if (L === null || C === null || h === null) return null;
        const [A, B] = fromPolar(Math.max(C, 0), h);
        return fromLinear(oklabToLinear(clamp(L, 0, 1), A, B), a);
      }
      default:
        return null;
    }
  }

  /** @param {string} space @param {string[]} p @param {number} a @returns {Rgba | null} */
  function fromColorFunction(space, p, a) {
    if (p.length !== 3) return null;
    const v = p.map((t) => component(t, 1));
    if (v.includes(null)) return null;
    const n = /** @type {number[]} */ (v);
    if (space === 'srgb') return fromSrgb(n, a);
    if (space === 'srgb-linear') return fromLinear([n[0], n[1], n[2]], a);
    if (space === 'xyz' || space === 'xyz-d65') return fromLinear(xyzToLinear([n[0], n[1], n[2]]), a);
    if (space === 'xyz-d50') return fromLinear(xyzToLinear(mul(D50_TO_D65, n)), a);
    const def = RGB_SPACES[space];
    if (!def) return null;
    let xyz = mul(def.m, n.map(def.decode));
    if (def.d50) xyz = mul(D50_TO_D65, xyz);
    return fromLinear(xyzToLinear(xyz), a);
  }

  /**
   * Parse a CSS color string. Returns null for anything that is not a plain color (`currentcolor`, system colors,
   * `var()`, `calc()`, relative colors).
   * @param {unknown} input
   * @param {number} [depth]
   * @returns {Rgba | null}
   */
  function parseColor(input, depth = 0) {
    if (typeof input !== 'string' || input.length > MAX_INPUT || depth > MAX_DEPTH) return null;
    const s = input.trim().toLowerCase();
    if (s === '') return null;

    if (s.charCodeAt(0) === 35) {
      if (!HEX.test(s)) return null;
      let h = s.slice(1);
      if (h.length <= 4) h = [...h].map((c) => c + c).join('');
      const n = (/** @type {number} */ i) => parseInt(h.slice(i, i + 2), 16) / 255;
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
    }
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (s in NAMED) {
      const v = NAMED[s];
      return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a: 1 };
    }

    const m = /^([a-z-]+)\((.*)\)$/s.exec(s);
    if (!m) return null;
    const [, name, inner] = m;
    if (name === 'color-mix') return parseColorMix(inner, depth);
    if (/\b(from|var|calc|env|attr|min|max|clamp)\b/.test(inner) || inner.includes('(')) return null;

    const args = splitFunctionArgs(name, inner);
    if (!args) return null;
    const a = alphaOf(args.alpha);
    if (a === null) return null;
    if (name === 'color') {
      const [space, ...rest] = args.parts;
      return space ? fromColorFunction(space, rest, a) : null;
    }
    return fromFunction(name, args.parts, a);
  }

  /**
   * A color from an HTML attribute (`bgcolor`, `text`, `link`, `font color`), read as browsers read it (legacy color rules):
   * a name, `#rgb`, or any text turned into hex digits (`chucknorris` is `#c00000`). Returns `#rrggbb`, or null where the
   * browser ignores the attribute.
   * @param {unknown} input
   * @returns {string | null}
   */
  function legacyColor(input) {
    if (typeof input !== 'string') return null;
    let s = input.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
    if (s === '' || s.toLowerCase() === 'transparent') return null;
    const key = s.toLowerCase();
    if (key in NAMED) return `#${NAMED[key].toString(16).padStart(6, '0')}`;
    if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
    s = Array.from(s, (c) => ((c.codePointAt(0) ?? 0) > 0xffff ? '00' : c)).join('');
    if (s.length > 128) s = s.slice(0, 128);
    if (s[0] === '#') s = s.slice(1);
    s = s.replace(/[^0-9a-fA-F]/g, '0');
    while (s.length === 0 || s.length % 3 !== 0) s += '0';
    let n = s.length / 3;
    let parts = [s.slice(0, n), s.slice(n, 2 * n), s.slice(2 * n)];
    if (n > 8) {
      parts = parts.map((x) => x.slice(n - 8));
      n = 8;
    }
    while (n > 2 && parts.every((x) => x[0] === '0')) {
      parts = parts.map((x) => x.slice(1));
      n -= 1;
    }
    if (n > 2) parts = parts.map((x) => x.slice(0, 2));
    return `#${parts.map((x) => parseInt(x, 16).toString(16).padStart(2, '0')).join('')}`;
  }

  /* ---------------------------------------------------------------- */
  /* color-mix()                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Coordinates of each interpolation space. `hue` is the index of the hue component or -1.
   * @type {Record<string, { hue: number, to: (c: Rgba) => Vec3, from: (v: Vec3, a: number) => Rgba }>}
   */
  const MIX_SPACES = {
    srgb: { hue: -1, to: (c) => [c.r, c.g, c.b], from: (v, a) => fromSrgb(v, a) },
    'srgb-linear': {
      hue: -1,
      to: (c) => [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)],
      from: (v, a) => fromLinear(v, a),
    },
    xyz: { hue: -1, to: (c) => linearToXyz(rgbToLinear(c)), from: (v, a) => fromLinear(xyzToLinear(v), a) },
    'xyz-d65': { hue: -1, to: (c) => linearToXyz(rgbToLinear(c)), from: (v, a) => fromLinear(xyzToLinear(v), a) },
    'xyz-d50': {
      hue: -1,
      to: (c) => mul(D65_TO_D50, linearToXyz(rgbToLinear(c))),
      from: (v, a) => fromLinear(xyzToLinear(mul(D50_TO_D65, v)), a),
    },
    lab: { hue: -1, to: (c) => linearToLab(rgbToLinear(c)), from: (v, a) => fromLinear(labToLinear(v[0], v[1], v[2]), a) },
    lch: {
      hue: 2,
      to: (c) => {
        const [L, A, B] = linearToLab(rgbToLinear(c));
        const [C, h] = toPolar(A, B, 0.01);
        return [L, C, h];
      },
      from: (v, a) => {
        const [A, B] = fromPolar(v[1], v[2]);
        return fromLinear(labToLinear(v[0], A, B), a);
      },
    },
    oklab: {
      hue: -1,
      to: (c) => linearToOklab(rgbToLinear(c)),
      from: (v, a) => fromLinear(oklabToLinear(v[0], v[1], v[2]), a),
    },
    oklch: {
      hue: 2,
      to: (c) => {
        const [L, A, B] = linearToOklab(rgbToLinear(c));
        const [C, h] = toPolar(A, B);
        return [L, C, h];
      },
      from: (v, a) => {
        const [A, B] = fromPolar(v[1], v[2]);
        return fromLinear(oklabToLinear(v[0], A, B), a);
      },
    },
    hsl: {
      hue: 0,
      to: (c) => srgbToHsl([c.r, c.g, c.b]),
      from: (v, a) => fromSrgb(hslToSrgb(v[0], clamp(v[1], 0, 1), clamp(v[2], 0, 1)), a),
    },
    hwb: {
      hue: 0,
      to: (c) => srgbToHwb([c.r, c.g, c.b]),
      from: (v, a) => fromSrgb(hwbToSrgb(v[0], clamp(v[1], 0, 1), clamp(v[2], 0, 1)), a),
    },
  };

  // The wide RGB spaces mix in their own gamma-encoded coordinates.
  for (const space of ['display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020']) {
    const def = RGB_SPACES[space];
    const inverse = invert(def.m);
    MIX_SPACES[space] = {
      hue: -1,
      to: (c) => {
        const xyz = linearToXyz(rgbToLinear(c));
        const [r, g, b] = mul(inverse, def.d50 ? mul(D65_TO_D50, xyz) : xyz);
        return [def.encode(r), def.encode(g), def.encode(b)];
      },
      from: (v, a) => {
        const xyz = mul(def.m, v.map(def.decode));
        return fromLinear(xyzToLinear(def.d50 ? mul(D50_TO_D65, xyz) : xyz), a);
      },
    };
  }

  /** @param {Rgba} c @returns {Vec3} */
  function rgbToLinear(c) {
    return [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
  }

  /** Split on commas that are not inside parentheses. @param {string} text */
  function splitTopLevel(text) {
    /** @type {string[]} */
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        out.push(text.slice(start, i).trim());
        start = i + 1;
      }
      if (depth < 0) return [];
    }
    out.push(text.slice(start).trim());
    return out;
  }

  /** @param {string} arg @param {number} depth @returns {{ color: Rgba, pct: number | null } | null} */
  function mixArg(arg, depth) {
    let pct = null;
    let rest = arg;
    const tail = /^(.*?)\s+([+-]?(?:\d+\.?\d*|\.\d+)%)$/s.exec(arg);
    const head = /^([+-]?(?:\d+\.?\d*|\.\d+)%)\s+(.*)$/s.exec(arg);
    if (tail) {
      rest = tail[1];
      pct = parseFloat(tail[2]);
    } else if (head) {
      rest = head[2];
      pct = parseFloat(head[1]);
    }
    if (pct !== null && (pct < 0 || pct > 100)) return null;
    const color = parseColor(rest, depth + 1);
    return color ? { color, pct } : null;
  }

  /** @param {string} inner @param {number} depth @returns {Rgba | null} */
  function parseColorMix(inner, depth) {
    const parts = splitTopLevel(inner);
    if (parts.length !== 3) return null;
    const method = /^in\s+([a-z0-9-]+)(?:\s+(shorter|longer|increasing|decreasing)\s+hue)?$/.exec(parts[0]);
    if (!method) return null;
    const space = MIX_SPACES[method[1]];
    if (!space) return null;
    if (method[2] && space.hue < 0) return null;
    const one = mixArg(parts[1], depth);
    const two = mixArg(parts[2], depth);
    if (!one || !two) return null;

    let p1 = one.pct;
    let p2 = two.pct;
    if (p1 === null && p2 === null) {
      p1 = 50;
      p2 = 50;
    } else if (p1 === null) p1 = 100 - /** @type {number} */ (p2);
    else if (p2 === null) p2 = 100 - p1;
    const sum = p1 + /** @type {number} */ (p2);
    if (sum <= 0) return null;
    const w1 = p1 / sum;
    const w2 = /** @type {number} */ (p2) / sum;
    const alphaScale = sum < 100 ? sum / 100 : 1;

    const c1 = space.to(one.color);
    const c2 = space.to(two.color);
    const a1 = one.color.a;
    const a2 = two.color.a;
    const alpha = a1 * w1 + a2 * w2;

    /** @type {Vec3} */
    const out = [0, 0, 0];
    let h1 = space.hue >= 0 ? c1[space.hue] : 0;
    let h2 = space.hue >= 0 ? c2[space.hue] : 0;
    if (space.hue >= 0) {
      if (Number.isNaN(h1) && Number.isNaN(h2)) h1 = h2 = 0;
      else if (Number.isNaN(h1)) h1 = h2;
      else if (Number.isNaN(h2)) h2 = h1;
      [h1, h2] = fixHues(h1, h2, method[2] ?? 'shorter');
    }
    for (let i = 0; i < 3; i++) {
      if (i === space.hue) {
        out[i] = (((h1 * w1 + h2 * w2) % 360) + 360) % 360;
      } else if (alpha > 0) {
        const x1 = Number.isNaN(c1[i]) ? 0 : c1[i];
        const x2 = Number.isNaN(c2[i]) ? 0 : c2[i];
        out[i] = (x1 * a1 * w1 + x2 * a2 * w2) / alpha;
      }
    }
    return space.from(out, clamp(alpha * alphaScale, 0, 1));
  }

  /** @param {number} a @param {number} b @param {string} method @returns {[number, number]} */
  function fixHues(a, b, method) {
    const norm = (/** @type {number} */ x) => ((x % 360) + 360) % 360;
    a = norm(a);
    b = norm(b);
    const d = b - a;
    switch (method) {
      case 'longer':
        if (d > 0 && d < 180) a += 360;
        else if (d > -180 && d <= 0) b += 360;
        break;
      case 'increasing':
        if (d < 0) b += 360;
        break;
      case 'decreasing':
        if (d > 0) a += 360;
        break;
      default:
        if (d > 180) a += 360;
        else if (d < -180) b += 360;
    }
    return [a, b];
  }

  /* ---------------------------------------------------------------- */
  /* OKLCH, gamut mapping, output                                      */
  /* ---------------------------------------------------------------- */

  /** @param {Rgba} c @returns {Vec3} lightness 0..1, chroma, hue in degrees (NaN for gray) */
  function toOklch(c) {
    const [L, a, b] = linearToOklab(rgbToLinear(c));
    const [C, h] = toPolar(a, b);
    return [L, C, h];
  }

  /** @param {Vec3} lin */
  const inGamut = (lin) => lin.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

  /**
   * OKLCH to sRGB inside the gamut: chroma is reduced until the color fits, lightness and hue stay.
   * @param {number} L @param {number} C @param {number} h @param {number} [alpha]
   * @returns {Rgba}
   */
  function fromOklch(L, C, h, alpha = 1) {
    if (L >= 1) return { r: 1, g: 1, b: 1, a: alpha };
    if (L <= 0) return { r: 0, g: 0, b: 0, a: alpha };
    const hue = Number.isNaN(h) ? 0 : h;
    const lab = (/** @type {number} */ c) => {
      const [A, B] = fromPolar(c, hue);
      return oklabToLinear(L, A, B);
    };
    let lin = lab(C);
    if (!inGamut(lin)) {
      let lo = 0;
      let hi = C;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(lab(mid))) lo = mid;
        else hi = mid;
      }
      lin = lab(lo);
    }
    return {
      r: clamp(linearToSrgb(lin[0]), 0, 1),
      g: clamp(linearToSrgb(lin[1]), 0, 1),
      b: clamp(linearToSrgb(lin[2]), 0, 1),
      a: alpha,
    };
  }

  /** @param {number} v */
  const byte = (v) => Math.round(clamp(Number.isNaN(v) ? 0 : v, 0, 1) * 255);
  const hex2 = (/** @type {number} */ v) => (v < 16 ? '0' : '') + v.toString(16);

  /** @param {Rgba} c  `#rrggbb`, or `#rrggbbaa` when not opaque */
  function toHex(c) {
    const s = `#${hex2(byte(c.r))}${hex2(byte(c.g))}${hex2(byte(c.b))}`;
    return c.a >= 1 ? s : s + hex2(byte(c.a));
  }

  /** @param {Rgba} c  `#rrggbb` when opaque, `rgba()` otherwise */
  function toCss(c) {
    if (c.a >= 1) return toHex(c);
    const a = Math.round(clamp(c.a, 0, 1) * 1000) / 1000;
    return `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${a})`;
  }

  /* ---------------------------------------------------------------- */
  /* Contrast                                                          */
  /* ---------------------------------------------------------------- */

  /** @param {Rgba} c WCAG relative luminance */
  const luminance = (c) => {
    const [r, g, b] = rgbToLinear({ r: clamp(c.r, 0, 1), g: clamp(c.g, 0, 1), b: clamp(c.b, 0, 1), a: 1 });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  /** WCAG 2 contrast ratio. Alpha is ignored: both colors are read as opaque. @param {Rgba} a @param {Rgba} b */
  function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /**
   * Move the lightness of `fg` as little as possible until it reaches `target` against `bg`. Hue and chroma are kept
   * (chroma only drops when the gamut needs it). The color stays on its side of the background (lighter or darker) when
   * that side can reach the target. With `side` it never leaves that side (1 lighter, 0 darker); when that side cannot
   * reach the target, the color goes most of the way (SIDE_SHARE of the best ratio there), so a hue is not lost to pure
   * black or white. Otherwise, out of reach, the best reachable color is returned.
   * @param {Rgba} fg @param {Rgba} bg @param {number} target @param {1 | 0} [side]
   * @returns {Rgba}
   */
  function ensureContrast(fg, bg, target, side) {
    if (contrastRatio(fg, bg) >= target) return fg;
    const [L, C, h] = toOklch(fg);
    const white = fromOklch(1, C, h, fg.a);
    const black = fromOklch(0, C, h, fg.a);
    const upRatio = contrastRatio(white, bg);
    const downRatio = contrastRatio(black, bg);
    const preferUp = side === undefined ? luminance(fg) > luminance(bg) : side === 1;
    /** @type {1 | 0 | null} */
    let end = null;
    if (preferUp && upRatio >= target) end = 1;
    else if (!preferUp && downRatio >= target) end = 0;
    else if (side !== undefined) {
      target = 1 + ((preferUp ? upRatio : downRatio) - 1) * SIDE_SHARE;
      if (contrastRatio(fg, bg) >= target) return fg;
      end = side;
    } else if (upRatio >= target) end = 1;
    else if (downRatio >= target) end = 0;
    if (end === null) return upRatio >= downRatio ? white : black;
    let lo = L;
    let hi = /** @type {number} */ (end);
    // 12 halvings leave a lightness step of 1/4096, finer than one 8-bit step; `hi` always meets the target.
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (contrastRatio(fromOklch(mid, C, h, fg.a), bg) >= target) hi = mid;
      else lo = mid;
    }
    return fromOklch(hi, C, h, fg.a);
  }

  const SIDE_SHARE = 0.9;

  /** The contrast a rewritten text and background pair must keep: the original ratio, at most 7 and at least 4.5 (WCAG 1.4.3; Apple asks for 4.5 at the least and 7 for small text). @param {number} original */
  const contrastFloor = (original) => Math.min(Math.max(original, 4.5), 7);

  /* ---------------------------------------------------------------- */
  /* Theme                                                             */
  /* ---------------------------------------------------------------- */

  /** Contrast floors (WCAG 1.4.3 and 1.4.11) and how far a black box may sink below the page (OKLab lightness). */
  const TEXT_MIN = 4.5;
  // A shadow color with less chroma than this and no lighter than this is a plain shadow; its alpha grows by the boost, up to the cap.
  const SHADOW_NEUTRAL = 0.04;
  const SHADOW_MAX_L = 0.75;
  const SHADOW_BOOST = 1.6;
  const SHADOW_MAX_ALPHA = 0.8;
  // Repair mode: a background darker than this, or an accent no lighter than ACCENT_L, is already right for a dark page.
  const REPAIR_BG_L = 0.35;
  const REPAIR_ACCENT_C = 0.08;
  const REPAIR_ACCENT_L = 0.62;
  const REPAIR_BORDER_L = 0.75;
  const EDGE_MIN = 3;
  const RECESS = 0.03;
  // A neutral color this light in the dark domain, with no more alpha than this, is an overlay.
  const OVERLAY_ALPHA = 0.3;
  const OVERLAY_NEUTRAL = 0.04;
  const OVERLAY_M = 0.8;
  /** A card sits this much lighter than the page in the dark domain. Text and control edges keep their floor against it too. */
  const CARD_STEP = 0.06;

  const FALLBACK_THEME = {
    mode: 'dark',
    brightness: 100,
    contrast: 100,
    sepia: 0,
    grayscale: 0,
    warmth: 0,
    darkBackground: '#16181d',
    darkText: '#e6e8eb',
    lightBackground: '#eeece8',
    lightText: '#1a1c20',
  };

  /** @param {number} a @param {number} b @param {number} t shortest-path hue blend */
  const hueLerp = (a, b, t) => {
    let d = ((b - a + 540) % 360) - 180;
    if (Number.isNaN(d)) d = 0;
    return (((a + d * t) % 360) + 360) % 360;
  };

  /** The tint of the theme and a color mixed in the a/b plane, `w` of the color (an angle mix turned #ced4da green). @param {number} tintC @param {number} tintH @param {number} c @param {number} h @param {number} w @returns {[number, number]} chroma and hue (NaN when none) */
  function mixTint(tintC, tintH, c, h, w) {
    const ta = Number.isNaN(tintH) ? 0 : tintC * Math.cos(tintH * rad);
    const tb = Number.isNaN(tintH) ? 0 : tintC * Math.sin(tintH * rad);
    const ca = Number.isNaN(h) ? 0 : c * Math.cos(h * rad);
    const cb = Number.isNaN(h) ? 0 : c * Math.sin(h * rad);
    const a = ta + (ca - ta) * w;
    const b = tb + (cb - tb) * w;
    const chroma = Math.hypot(a, b);
    return [chroma, chroma < 1e-7 ? NaN : (((Math.atan2(b, a) / rad) % 360) + 360) % 360];
  }

  /* ---------------------------------------------------------------- */
  /* E-ink and Paper                                                   */
  /* ---------------------------------------------------------------- */

  // The two presets. A null or missing theme field takes the preset's value. The same table is in shared/settings.js; a
  // unit test keeps the two equal.
  const EINK_PRESETS = Object.freeze({
    eink: Object.freeze({
      paperColor: '#ffffff', inkColor: '#000000', einkColor: 'mono', einkColorAmount: 0, einkGrayAll: true, einkLevels: 8, einkContrast: 100, whiteCap: 100, einkBlue: 0,
      einkImages: 'gray', einkImageContrast: 120, einkLinks: true, einkBorders: true,
      noAnimation: true, noTransition: true, noSmoothScroll: true, noShadow: true, reducedMotionHint: true,
      einkFont: 'keep', einkWeight: 0,
    }),
    paper: Object.freeze({
      paperColor: '#f4f1ea', inkColor: '#2b2620', einkColor: 'muted', einkColorAmount: 35, einkGrayAll: false, einkLevels: 0, einkContrast: 100, whiteCap: 84, einkBlue: 12,
      einkImages: 'follow', einkImageContrast: 100, einkLinks: true, einkBorders: false,
      noAnimation: false, noTransition: false, noSmoothScroll: false, noShadow: false, reducedMotionHint: false,
      einkFont: 'keep', einkWeight: 0,
    }),
  });
  const EINK_HEX = /^#[0-9a-f]{6}$/i;
  const EINK_LEVELS = [0, 2, 4, 8, 16];

  /** The settings of the mode with the preset's value wherever the person set none. @param {Record<string, any>} [s] */
  function einkSettings(s = {}) {
    const preset = s.einkPreset === 'eink' ? 'eink' : 'paper';
    const d = /** @type {Record<string, any>} */ (EINK_PRESETS[preset]);
    /** @param {string} key @param {(v: any) => boolean} ok */
    const pick = (key, ok) => (ok(s[key]) ? s[key] : d[key]);
    const int = (/** @type {number} */ lo, /** @type {number} */ hi) => (/** @type {any} */ v) => Number.isInteger(v) && v >= lo && v <= hi;
    const bool = (/** @type {any} */ v) => typeof v === 'boolean';
    return {
      preset,
      paperColor: pick('paperColor', (v) => typeof v === 'string' && EINK_HEX.test(v)),
      inkColor: pick('inkColor', (v) => typeof v === 'string' && EINK_HEX.test(v)),
      // Percent of color. The old words count when no amount is set: mono 0, muted 40.
      einkColorAmount: int(0, 100)(s.einkColorAmount) ? s.einkColorAmount : s.einkColor === 'mono' ? 0 : s.einkColor === 'muted' ? 40 : d.einkColorAmount,
      einkGrayAll: pick('einkGrayAll', bool),
      einkLevels: pick('einkLevels', (v) => EINK_LEVELS.includes(v)),
      einkContrast: pick('einkContrast', int(50, 200)),
      whiteCap: pick('whiteCap', int(50, 100)),
      einkBlue: pick('einkBlue', int(0, 100)),
      einkImages: pick('einkImages', (v) => v === 'gray' || v === 'dim' || v === 'off' || v === 'follow'),
      einkImageContrast: pick('einkImageContrast', int(50, 200)),
      einkLinks: pick('einkLinks', bool),
      einkBorders: pick('einkBorders', bool),
      noAnimation: pick('noAnimation', bool),
      noTransition: pick('noTransition', bool),
      noSmoothScroll: pick('noSmoothScroll', bool),
      noShadow: pick('noShadow', bool),
      reducedMotionHint: pick('reducedMotionHint', bool),
      einkFont: pick('einkFont', (v) => typeof v === 'string' && v.length > 0 && v.length <= 100),
      einkWeight: pick('einkWeight', int(0, 3)),
      textStroke: int(0, 10)(s.textStroke) ? s.textStroke : 0,
    };
  }

  /** @typedef {ReturnType<typeof einkSettings> & { Lp: number, Li: number, Cp: number, hp: number, Ci: number, hi: number, k: number, scale: number, blue: number, textMin: number, borderMin: number, Lfloor: number, keep: number, mono: boolean, finish: (c: Rgba) => Rgba, page: Rgba }} EinkPalette */

  /** The palette functions of the E-ink and Paper mode, added by `einkpalette.js` when the mode is used. @type {{ palette: (e: ReturnType<typeof einkSettings>) => EinkPalette, transform: (e: EinkPalette, L: number, C: number, h: number, role: Role, a: number) => Rgba, surfaces: (e: EinkPalette) => { page: Rgba, card: Rgba } } | null} */
  let eink = null;

  /* ---------------------------------------------------------------- */
  /* Color vision                                                      */
  /* ---------------------------------------------------------------- */

  /** @typedef {{ kind: string, severity: number, space: 'linear' | 'srgb', simulate: number[][] | null, correct: number[][], offset: number[], undo: number[][] | null }} CvdMatrices */
  /** The model and the correction of a color vision deficiency, added by `cvd.js` when the correction is on. @type {{ matrices: (kind: unknown, severity: unknown, boost?: unknown) => CvdMatrices | null, run: (m: CvdMatrices, rgb: number[]) => number[] } | null} */
  let cvdParts = null;
  const CVD_KINDS = ['protan', 'deutan', 'tritan'];
  // The plain filters change the look as a whole, which a theme already does: they work in the original mode only.
  const PLAIN_KINDS = ['grayscale', 'grayscaleInverted', 'inverted'];

  /**
   * Does this theme ask for a color filter? A deficiency with an intensity above 0, in every look but E-ink at 0 percent color, which
   * shows grays only and leaves no color to correct; a plain filter in the original mode only. The answer does not need `cvd.js`; the
   * gate loads it when the answer is yes.
   * @param {Record<string, any> | undefined} t  the `theme` object of the settings
   */
  function cvdWanted(t) {
    if (!t || !(CVD_KINDS.includes(t.cvdType) || PLAIN_KINDS.includes(t.cvdType))) return false;
    if (Number.isFinite(t.cvdSeverity) && t.cvdSeverity <= 0) return false;
    if (PLAIN_KINDS.includes(t.cvdType)) return t.mode === 'original';
    return !(t.mode === 'eink' && einkSettings(t).einkColorAmount === 0);
  }

  /** @param {Record<string, any>} t @returns {CvdMatrices | null} */
  const cvdOf = (t) => (cvdParts && cvdWanted(t) ? cvdParts.matrices(t.cvdType, Number.isFinite(t.cvdSeverity) ? t.cvdSeverity : 100, t.cvdBoost) : null);

  /**
   * Precompute everything the transform needs from the theme settings.
   * Light mode runs the dark curves on mirrored lightness.
   * @param {Record<string, any>} [settings]  the `theme` object of the settings
   */
  function createTheme(settings = {}) {
    const t = { ...FALLBACK_THEME, ...settings };
    const cvd = cvdOf(t);
    if (t.mode === 'original') {
      // The page's own colors, with the correction for color vision as the only change.
      return Object.freeze({
        dark: false,
        original: true,
        cvd,
        eink: /** @type {EinkPalette | null} */ (null),
        Lb: 0,
        Lt: 1,
        Lmin: 0,
        Lhi: 0,
        Lmid: 0,
        borderLow: 0,
        borderHigh: 0,
        bgTint: Object.freeze({ C: 0, h: NaN }),
        fgTint: Object.freeze({ C: 0, h: NaN }),
        brightness: 1,
        contrast: 1,
        sepia: 0,
        grayscale: 0,
        warmth: 0,
      });
    }
    if (t.mode === 'eink' && eink) {
      const palette = eink.palette(einkSettings(settings));
      return Object.freeze({
        dark: false,
        original: false,
        cvd,
        eink: /** @type {EinkPalette | null} */ (palette),
        Lb: 0.02,
        Lt: 1,
        Lmin: 0,
        Lhi: 0,
        Lmid: 0,
        borderLow: 0,
        borderHigh: 0,
        bgTint: Object.freeze({ C: palette.Cp, h: palette.hp }),
        fgTint: Object.freeze({ C: palette.Ci, h: palette.hi }),
        brightness: 1,
        contrast: 1,
        sepia: 0,
        grayscale: 0,
        warmth: 0,
      });
    }
    // Without the E-ink palette (it could not be loaded) the mode shows as the light mode.
    const dark = t.mode !== 'light' && t.mode !== 'eink';
    const bg = parseColor(dark ? t.darkBackground : t.lightBackground) ?? parseColor(FALLBACK_THEME.darkBackground);
    const fg = parseColor(dark ? t.darkText : t.lightText) ?? parseColor(FALLBACK_THEME.darkText);
    const [bgL, bgC, bgH] = toOklch(/** @type {Rgba} */ (bg));
    const [fgL, fgC, fgH] = toOklch(/** @type {Rgba} */ (fg));

    const Lb = clamp(dark ? bgL : 1 - bgL, 0.02, 0.6);
    // The text color is the person's choice (the default is 0.93), so it is not capped; only the contrast floor can lift text.
    const Lt = clamp(dark ? fgL : 1 - fgL, Lb + 0.3, 1);
    // A black box is a little deeper than the page, not a hole in it: elevation goes by lightness.
    const Lmin = Math.max(0, Lb - RECESS);
    const Lhi = Math.min(Lb + 0.22, (Lb + 1) / 2);
    const Lmid = Lb + (Lt - Lb) * 0.6;
    const borderLow = Lb + 0.08;
    const borderHigh = Lb + (Lt - Lb) * 0.75;

    const num = (/** @type {any} */ v, /** @type {number} */ fallback) => (Number.isFinite(v) ? Number(v) : fallback);
    return Object.freeze({
      dark,
      original: false,
      cvd,
      eink: /** @type {EinkPalette | null} */ (null),
      Lb,
      Lt,
      Lmin,
      Lhi,
      Lmid,
      borderLow,
      borderHigh,
      bgTint: Object.freeze({ C: bgC, h: bgH }),
      fgTint: Object.freeze({ C: fgC, h: fgH }),
      brightness: num(t.brightness, 100) / 100,
      contrast: num(t.contrast, 100) / 100,
      sepia: clamp(num(t.sepia, 0), 0, 100) / 100,
      grayscale: clamp(num(t.grayscale, 0), 0, 100) / 100,
      warmth: clamp(num(t.warmth, 0), 0, 100) / 100,
    });
  }

  /** @typedef {ReturnType<typeof createTheme>} Theme */

  /** Lightness curves in the dark domain. `m` is lightness, mirrored in light mode. */
  /** @param {Theme} th @param {Role} role @param {number} m */
  function curve(th, role, m) {
    switch (role) {
      case 'background':
        return m >= 0.5
          ? th.Lb + (th.Lhi - th.Lb) * (1 - (m - 0.5) / 0.5) ** 1.15
          : th.Lmin + (th.Lhi - th.Lmin) * (m / 0.5) ** 1.2;
      case 'foreground':
        // Dark text (what a light page uses) goes close to the theme's text color, so headings and body copy are bright
        // and sharp, not gray. Light text on a dark part of the page keeps the steeper curve.
        return th.Lmid + (th.Lt - th.Lmid) * (m <= 0.5 ? (1 - 2 * m) ** 0.5 : (2 * m - 1) ** 1.3);
      default:
        return th.borderLow + (th.borderHigh - th.borderLow) * (1 - m) ** 1.2;
    }
  }

  /** How much green and blue the night shift takes away at its full setting. */
  const WARM_GREEN = 0.12;
  const WARM_BLUE = 0.45;

  /** Lightness (OKLab) between which a chromatic color counts as pale: none below the first, all above the second. */
  const PALE_FROM = 0.9;
  const PALE_TO = 0.94;

  const CHROMA_SCALE = { background: 0.92, foreground: 0.95, border: 0.9 };

  /** @param {Theme} th @param {Rgba} c @returns {Rgba} sepia, grayscale, contrast, brightness as CSS filters do */
  function adjust(th, c) {
    if (th.sepia === 0 && th.grayscale === 0 && th.contrast === 1 && th.brightness === 1 && th.warmth === 0) return c;
    let { r, g, b } = c;
    if (th.sepia > 0) {
      const s = 1 - th.sepia;
      [r, g, b] = [
        (0.393 + 0.607 * s) * r + (0.769 - 0.769 * s) * g + (0.189 - 0.189 * s) * b,
        (0.349 - 0.349 * s) * r + (0.686 + 0.314 * s) * g + (0.168 - 0.168 * s) * b,
        (0.272 - 0.272 * s) * r + (0.534 - 0.534 * s) * g + (0.131 + 0.869 * s) * b,
      ];
    }
    if (th.grayscale > 0) {
      const s = 1 - th.grayscale;
      [r, g, b] = [
        (0.2126 + 0.7874 * s) * r + (0.7152 - 0.7152 * s) * g + (0.0722 - 0.0722 * s) * b,
        (0.2126 - 0.2126 * s) * r + (0.7152 + 0.2848 * s) * g + (0.0722 - 0.0722 * s) * b,
        (0.2126 - 0.2126 * s) * r + (0.7152 - 0.7152 * s) * g + (0.0722 + 0.9278 * s) * b,
      ];
    }
    /** @param {number} v */
    const finish = (v) => clamp((clamp(v, 0, 1) - 0.5) * th.contrast + 0.5, 0, 1) * th.brightness;
    // Night shift: less green and much less blue, as a warm lamp does. It comes last, so it also warms the sepia result.
    const w = th.warmth;
    return { r: clamp(finish(r), 0, 1), g: clamp(finish(g), 0, 1) * (1 - WARM_GREEN * w), b: clamp(finish(b), 0, 1) * (1 - WARM_BLUE * w), a: c.a };
  }

  /** The most chroma that fits the sRGB gamut at this lightness and hue. @param {number} L @param {number} h */
  function maxChroma(L, h) {
    if (Number.isNaN(h) || L <= 0.001 || L >= 0.999) return 0;
    return toOklch(fromOklch(L, 0.4, h, 1))[1];
  }

  /** 0 below `a`, 1 above `b`, smooth in between. */
  const smoothstep = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  /**
   * Backgrounds and borders. Neutral and pastel colors follow the surface curves. Colors with real chroma (brand colors,
   * banners, badges) are accents: they keep hue and vividness, and their lightness stays in a band that reads as that color
   * on a dark page. `m` is the lightness in the dark domain, `base` the surface curve at `m`.
   * @param {Theme} th @param {Role} role @param {number} L @param {number} C @param {number} h @param {number} m @param {number} base @param {number} alpha
   */
  function accentAware(th, role, L, C, h, m, base, alpha) {
    // A very light color with chroma (a pale highlight, a marker) carries dark text: it is a surface, not an accent, so it
    // follows the surface curve.
    const pale = role === 'border' ? 0 : smoothstep(PALE_FROM, PALE_TO, L);
    // In the light mode a deep chromatic box (a band, a footer) is a section that carries light text: it turns pale like a gray one.
    const deep = th.dark || role === 'border' ? 0 : 1 - smoothstep(0.3, 0.55, L);
    const acc = smoothstep(0.05, 0.12, C) * (1 - pale) * (1 - deep);
    const band = role === 'border' ? clamp(m, 0.4, 0.7) : m <= 0.62 ? Math.max(m, 0.3) : 0.62 + 0.25 * (m - 0.62);
    const dark = base + (band - base) * acc;
    const outL = th.dark ? dark : 1 - dark;
    const inMax = maxChroma(L, h);
    const rel = inMax > 0 ? Math.min(1, C / inMax) : 0;
    const accentC = rel * maxChroma(outL, h);
    const tint = th.bgTint;
    const tintC = role === 'border' ? tint.C * 1.1 : tint.C;
    const neutralC = Math.max(C * (th.dark ? 1.8 : 1.8 - 0.8 * pale), 0);
    const wanted = neutralC + (accentC - neutralC) * acc;
    const [chroma, hue] = mixTint(tintC, tint.h, wanted, h, smoothstep(0.004, 0.016, C));
    return fromOklch(outL, chroma, hue, alpha);
  }

  /**
   * Transform one color for the theme. The correction for color vision is the last step: it acts on the color the person would see.
   * @param {Theme} th @param {Rgba} c @param {Role} role
   * @returns {Rgba}
   */
  function transformColor(th, c, role) {
    const out = th.original ? c : themed(th, c, role);
    if (!th.cvd || !cvdParts || out.a <= 0) return out;
    const [r, g, b] = cvdParts.run(th.cvd, [out.r, out.g, out.b]);
    return { r, g, b, a: out.a };
  }

  /** @param {Theme} th @param {Rgba} c @param {Role} role @returns {Rgba} */
  function themed(th, c, role) {
    if (c.a <= 0) return c;
    const [L, C, h] = toOklch(c);
    const shadowed = role === 'shadow';
    if (role === 'shadow') {
      // A neutral shadow stays black in the dark mode, a little stronger, so a raised card keeps its edge. The E-ink and
      // Paper mode leave it as written. A colored shadow (a glow) and the light mode follow the surface rule.
      if (C < SHADOW_NEUTRAL && L <= SHADOW_MAX_L) {
        if (th.eink) return c;
        if (th.dark) return { r: 0, g: 0, b: 0, a: Math.max(c.a, Math.min(SHADOW_MAX_ALPHA, c.a * SHADOW_BOOST)) };
      }
      role = 'background';
    }
    if (th.eink && eink) return eink.transform(th.eink, L, C, h, role, c.a);
    const m = clamp(th.dark ? L : 1 - L, 0, 1);
    // A faint white veil (a black one in the light mode) lightens what lies under it: a glass card, a hover tint, a hairline on a dark
    // section. It keeps its direction and its alpha. A fuller one is a surface and follows the curves.
    if (c.a <= OVERLAY_ALPHA && C < OVERLAY_NEUTRAL && m >= OVERLAY_M && !shadowed && (role === 'background' || role === 'border')) return adjust(th, c);
    const out = curve(th, role, m);
    if (role === 'edge') return keepContrast(th, adjust(th, accentAware(th, 'border', L, C, h, m, out, c.a)), EDGE_MIN);
    if (role !== 'foreground') return adjust(th, accentAware(th, role, L, C, h, m, out, c.a));
    const tint = th.fgTint;
    const [chroma, hue] = mixTint(tint.C, tint.h, C * CHROMA_SCALE.foreground, h, smoothstep(0.01, 0.03, C));
    return keepContrast(th, adjust(th, fromOklch(th.dark ? out : 1 - out, chroma, hue, c.a)), TEXT_MIN);
  }

  /**
   * Is this color already right for a dark page (repair mode)? A background darker than 35 percent lightness, an accent that
   * carries white text, text that reads on the page and on a card, a border that is not light, every shadow. A translucent
   * color is judged over the page. @param {Theme} th @param {Rgba} c @param {Role} role
   */
  function fineForDark(th, c, role) {
    if (!th.dark || th.eink) return false;
    if (role === 'shadow' || c.a <= 0) return true;
    const { page, card } = surfaceColors(th);
    const eff = c.a >= 1 ? c : { r: c.r * c.a + page.r * (1 - c.a), g: c.g * c.a + page.g * (1 - c.a), b: c.b * c.a + page.b * (1 - c.a), a: 1 };
    if (role === 'foreground') return contrastRatio(eff, page) >= TEXT_MIN && contrastRatio(eff, card) >= TEXT_MIN;
    if (role === 'edge') return contrastRatio(eff, page) >= EDGE_MIN && contrastRatio(eff, card) >= EDGE_MIN;
    const [L, C] = toOklch(eff);
    if (role === 'border') return L < REPAIR_BORDER_L;
    return L < REPAIR_BG_L || (C >= REPAIR_ACCENT_C && L <= REPAIR_ACCENT_L);
  }

  /** The page color and a card color of a theme, as the engine paints them. @type {WeakMap<object, { page: Rgba, card: Rgba }>} */
  const surfaces = new WeakMap();

  /** @param {Theme} th */
  function surfaceColors(th) {
    let s = surfaces.get(th);
    if (!s && th.eink && eink) {
      s = eink.surfaces(th.eink);
      surfaces.set(th, s);
    }
    if (!s) {
      const page = transformColor(th, th.dark ? { r: 1, g: 1, b: 1, a: 1 } : { r: 0, g: 0, b: 0, a: 1 }, 'background');
      const L = th.dark ? th.Lb + CARD_STEP : 1 - (th.Lb + CARD_STEP);
      s = { page, card: adjust(th, fromOklch(L, th.bgTint.C, th.bgTint.h, 1)) };
      surfaces.set(th, s);
    }
    return s;
  }

  /**
   * Move a color until it keeps `target` against the page and a card of the theme. Hue and chroma stay; a color that
   * already passes is returned as it is, and one out of reach gets as close as the display allows. Text stays lighter
   * than the surfaces in the dark mode and darker in the light mode: a dimmed light page keeps dark text.
   * @param {Theme} th @param {Rgba} c @param {number} target @returns {Rgba}
   */
  function keepContrast(th, c, target) {
    const { page, card } = surfaceColors(th);
    const side = th.dark ? 1 : 0;
    return ensureContrast(ensureContrast(c, card, target, side), page, target, side);
  }

  /**
   * A transformer with a bounded cache. One per theme; make a new one when the theme changes. The cache has two
   * generations: a hit in the old one moves the entry to the new one, and a full new one becomes the old one. That drops
   * the least recently used half without deleting single entries.
   * @param {Theme} theme
   * @param {{ maxEntries?: number }} [options]
   */
  function createTransformer(theme, options = {}) {
    const half = Math.max(1, Math.floor((options.maxEntries ?? 20000) / 2));
    /** One map per role, so a lookup needs no joined key. @typedef {Map<string, string | null>} Memo */
    const makeMaps = () => ({ background: /** @type {Memo} */ (new Map()), foreground: /** @type {Memo} */ (new Map()), border: /** @type {Memo} */ (new Map()), edge: /** @type {Memo} */ (new Map()), shadow: /** @type {Memo} */ (new Map()) });
    let fresh = makeMaps();
    let old = makeMaps();
    let freshCount = 0;
    // Repair mode: a color that is right for a dark page comes back as the same text (it did not move).
    let repair = false;
    /** The same theme without the correction, for the fitted looks of `rewrite.js` that add the correction themselves. @type {Theme | null} */
    let bare = null;

    /** @param {Role} role @param {string} key @param {() => string | null} compute */
    const remember = (role, key, compute) => {
      let value = fresh[role].get(key);
      if (value !== undefined) return value;
      value = old[role].get(key);
      if (value === undefined) value = compute();
      fresh[role].set(key, value);
      if (++freshCount >= half) {
        old = fresh;
        fresh = makeMaps();
        freshCount = 0;
      }
      return value;
    };

    return {
      /**
       * @param {string} input a CSS color
       * @param {Role} role
       * @returns {string | null} the new color, or null when the input is not a plain color
       */
      transform(input, role) {
        if (typeof input !== 'string') return null;
        return remember(role, input, () => {
          const c = parseColor(input);
          if (!c) return null;
          if (repair && (fineForDark(theme, c, role) || /** @type {any} */ (dk).sitetheme?.own(c, role))) return input;
          return toCss(transformColor(theme, c, role));
        });
      },
      /**
       * The color without the correction for color vision (not remembered). @param {string} input @param {Role} role
       * @returns {string | null}
       */
      plain(input, role) {
        const c = typeof input === 'string' ? parseColor(input) : null;
        if (!c) return null;
        bare ??= theme.cvd ? Object.freeze({ ...theme, cvd: null }) : theme;
        return toCss(transformColor(bare, c, role));
      },
      /** The color vision filter (its space, matrix and offset), or null. */
      get cvd() {
        return cvdParts && theme.cvd ? theme.cvd : null;
      },
      /** The page keeps its own colors; only the correction changes them. */
      get original() {
        return theme.original === true;
      },
      /** Switch repair mode on or off. The remembered answers are dropped. @param {boolean} on */
      setRepair(on) {
        if (repair === on) return;
        repair = on;
        fresh = makeMaps();
        old = makeMaps();
        freshCount = 0;
      },
      get repair() {
        return repair;
      },
      /**
       * Transform a text color and its background together and keep their contrast. A background that is not opaque
       * shows what lies under it, so it makes no pair.
       * @param {string} fgInput @param {string} bgInput
       * @returns {{ fg: string, bg: string } | null}
       */
      pair(fgInput, bgInput) {
        // The page's own colors are kept as the page made them: no contrast floor moves them.
        if (theme.original) return null;
        const fg = parseColor(fgInput);
        const bg = parseColor(bgInput);
        if (!fg || !bg || bg.a < 1 || fg.a <= 0) return null;
        // The remembered single transforms: most pairs already keep the floor, and then nothing more is computed.
        const bgCss = /** @type {string} */ (this.transform(bgInput, 'background'));
        const fgCss = /** @type {string} */ (this.transform(fgInput, 'foreground'));
        const bgOut = /** @type {Rgba} */ (parseColor(bgCss));
        const fgOut = /** @type {Rgba} */ (parseColor(fgCss));
        // In the E-ink and Paper mode a small margin covers the rounding to 8-bit values.
        const floor = theme.eink ? theme.eink.textMin + 0.1 : contrastFloor(contrastRatio(fg, bg));
        if (contrastRatio(fgOut, bgOut) >= floor) return { fg: fgCss, bg: bgCss };
        return { fg: toCss(ensureContrast(fgOut, bgOut, floor)), bg: bgCss };
      },
      clear: () => {
        fresh = makeMaps();
        old = makeMaps();
        freshCount = 0;
      },
      get size() {
        let n = 0;
        for (const role of /** @type {Role[]} */ (['background', 'foreground', 'border', 'edge', 'shadow'])) n += fresh[role].size + old[role].size;
        return n;
      },
    };
  }

  /**
   * The page, text and edge colors of a theme as hex, for the base style, the first-paint style and the static engine.
   * @param {Theme} th
   */
  function pageColors(th) {
    const px = (/** @type {number} */ v) => ({ r: v, g: v, b: v, a: 1 });
    if (th.eink) {
      return { page: toHex(transformColor(th, px(1), 'background')), text: toHex(transformColor(th, px(0), 'foreground')), edge: toHex(transformColor(th, px(0.8), 'border')) };
    }
    const dark = th.dark;
    return {
      page: toHex(transformColor(th, px(dark ? 1 : 0), 'background')),
      text: toHex(transformColor(th, px(dark ? 0 : 1), 'foreground')),
      edge: toHex(transformColor(th, px(dark ? 0.7 : 0.3), 'border')),
    };
  }

  // An empty box with its picture in its inline style (a photo or a video cover in a feed). The picture filters of the modes reach it
  // from its first frame, before any script looks at it; a box that imagebg.js marked follows its mark.
  const INLINE_PICTURE = `:is(${['background-image: url(', 'background-image:url(', 'background: url(', 'background:url('].map((s) => `[style*="${s}"]`).join(',')}):empty:not([data-dk-bg],[style*="gradient("])`;

  dk.color = Object.freeze({
    INLINE_PICTURE,
    parseColor,
    legacyColor,
    toHex,
    toCss,
    toOklch,
    fromOklch,
    contrastRatio,
    ensureContrast,
    contrastFloor,
    surfaceColors,
    FLOORS: Object.freeze({ text: TEXT_MIN, edge: EDGE_MIN, recess: RECESS, card: CARD_STEP }),
    createTheme,
    createTransformer,
    transformColor,
    pageColors,
    einkSettings,
    hasEink: () => eink !== null,
    useEink: (/** @type {NonNullable<typeof eink>} */ parts) => {
      eink ??= parts;
    },
    cvdWanted,
    hasCvd: () => cvdParts !== null,
    useCvd: (/** @type {NonNullable<typeof cvdParts>} */ parts) => {
      cvdParts ??= parts;
    },
    einkKit: () => ({ parseColor, toOklch, fromOklch, luminance, linearToSrgb, srgbToLinear, contrastRatio, smoothstep, maxChroma, lerp, hueLerp, TEXT_MIN, EDGE_MIN }),
    EINK_PRESETS,
  });
})();
