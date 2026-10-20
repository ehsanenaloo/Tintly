// @ts-check
// Reads the source text of a style sheet and writes the themed override copy in one pass, without the CSSOM. The copy
// matches the CSSOM path: color-bearing declarations only, in source order, a shorthand reduced to its color part.
// Anything it does not understand stops it with a reason; the engine then reads that sheet through the CSSOM.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  /** At-rules whose block holds rules (or, inside a style rule, declarations and rules). */
  const GROUPS = new Set(['media', 'supports', 'layer', 'container', 'scope', 'starting-style', 'document', '-moz-document']);
  /** At-rules that are rules of their own in the CSSOM but carry nothing to theme. */
  const LEAVES = new Set(['font-face', 'page', 'property', 'counter-style', 'font-feature-values', 'view-transition', 'font-palette-values', 'color-profile', 'position-try']);
  const KEYFRAMES = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes', '-o-keyframes']);

  /** The property names of a background picture and of a mask picture, with their colon. */
  const BACKGROUND_NAME = /background(?:-image)?:/;
  const MASK_NAME = /(?:-webkit-)?mask(?:-image)?\s*:/;

  /**
   * Does a declaration of this text name a property (`name`) and have a `url(` (or `call`) after it before the next semicolon?
   * One pass, so repeated names or openings cannot take quadratic time.
   * @param {string} text @param {RegExp} name matches the property name and its colon @param {string} [call] @returns {boolean}
   */
  function setsPicture(text, name, call = 'url(') {
    let from = 0;
    let declaration = 0;
    for (;;) {
      const at = text.indexOf(call, from);
      if (at < 0) return false;
      for (let k = at - 1; k >= from; k--) {
        if (text.charCodeAt(k) === 59) {
          declaration = k + 1;
          break;
        }
      }
      if (name.test(text.slice(Math.max(declaration, from), at))) return true;
      from = at + call.length;
    }
  }
  const VAR_NAME = /background(?:-image)?:[^;}]*var\(--/;
  /** The picture notes of the Images module (`?` first: through a custom property). @param {string} d @param {string} s @param {(s: string) => void} tell */
  const pictureNote = (d, s, tell) => (d.indexOf('url(') >= 0 && setsPicture(d, BACKGROUND_NAME) ? tell(s) : VAR_NAME.test(d) && tell(`?${s}`));
  const PICTURE = /url\(|-gradient\(|image-set\(|element\(/i;
  const LONGHAND = /^(?:border-|outline-|column-rule-|text-decoration-|text-emphasis-|-webkit-text-stroke-|background-)/;
  /** Declarations that are read for the mark and mask decisions even though they carry no color. */
  const FLAGS = new Set(['content', 'width', 'height', 'mask-image', '-webkit-mask-image', 'mask', '-webkit-mask', 'color-scheme', 'background-clip', '-webkit-background-clip']);
  const siteApi = /** @type {any} */ (dk.sitedark);
  const MOTION_MAX_CHARS = 30000;

  /** @param {string} v */
  const pixels = (v) => {
    const m = /^(\d*\.?\d+)px$/i.exec(v.trim());
    return m ? Number(m[1]) : NaN;
  };
  /** A line or a dot: it works as a mark, not as a surface. @param {number} w @param {number} h */
  function isMarkBox(w, h) {
    const thin = (/** @type {number} */ a, /** @type {number} */ b) => a > 0 && a <= 4 && !(b <= 4) && !(b < 8);
    return thin(h, w) || thin(w, h) || (w > 0 && h > 0 && w <= 8 && h <= 8);
  }

  const isIdent = (/** @type {number} */ c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 45 || c === 95 || (c >= 48 && c <= 57);

  /**
   * The index of the `)` that closes an unquoted `url(` whose `(` is at `open`, or -1. In an unquoted address `/*` and
   * quotes are part of the address. `miss` belongs to one string: once a scan found no `)` to the end, a later start finds none
   * either, so a text full of `url(` openings is not scanned again for each one.
   * @param {string} s @param {number} open @param {{ from: number }} miss
   */
  function rawUrlEnd(s, open, miss) {
    if (open < 3 || (s.charCodeAt(open - 1) | 32) !== 108 || (s.charCodeAt(open - 2) | 32) !== 114 || (s.charCodeAt(open - 3) | 32) !== 117) return -1;
    let i = open + 1;
    while (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9 || s.charCodeAt(i) === 10) i++;
    const first = s.charCodeAt(i);
    if (first === 34 || first === 39 || i >= miss.from) return -1;
    const begin = i;
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 92) i++;
      else if (c === 41) return i;
    }
    miss.from = begin;
    return -1;
  }

  /** Remove comments, leave strings alone. @param {string} s */
  function stripComments(s) {
    let out = '';
    let from = 0;
    const miss = { from: Infinity };
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 92) i++;
      else if (c === 34 || c === 39) {
        const q = c;
        for (i++; i < s.length; i++) {
          const d = s.charCodeAt(i);
          if (d === 92) i++;
          else if (d === q) break;
        }
      } else if (c === 40) {
        const end = rawUrlEnd(s, i, miss);
        if (end > 0) i = end;
      } else if (c === 47 && s.charCodeAt(i + 1) === 42) {
        const end = s.indexOf('*/', i + 2);
        out += s.slice(from, i) + ' ';
        i = end < 0 ? s.length : end + 1;
        from = i + 1;
      }
    }
    return from === 0 ? s : out + s.slice(from);
  }

  /**
   * @param {{ rw: any, isControl: (selector: string) => boolean, maxRules: number, maxDepth: number, chunkChars: number,
   *   onBackground?: (selector: string, kind?: 'mask') => void, motion?: boolean, cover?: (selector: string) => Set<string> | null }} options  `onBackground` hears the selector of a rule that sets a picture; `motion` writes the reduced-motion rules unwrapped; `cover` (repair mode) answers which groups of properties the page's dark rules set, and those are left out
   */
  function createReader(options) {
    const { rw, isControl, maxRules, maxDepth, chunkChars, onBackground } = options;
    const motion = options.motion === true;
    const cover = options.cover ?? null;
    const { FAMILY, resets, plainBackgroundColor } = /** @type {any} */ (dk).rewrite;

    /** What a declaration name is for: 1 a color property, 2 only read for the mark and mask decisions, 3 a longhand of a shorthand (written again after a whole copy of it), 0 nothing. @type {Map<string, number>} */
    const kinds = new Map();
    /** @param {string} name */
    function kindOf(name) {
      let kind = kinds.get(name);
      if (kind === undefined) {
        kind = rw.isRelevant(name) ? 1 : FLAGS.has(name) ? 2 : LONGHAND.test(name) ? 3 : 0;
        if (kinds.size >= 2000) kinds.clear();
        kinds.set(name, kind);
      }
      return kind;
    }

    /** Declarations already written: for each property name, eight maps (important or not, four modes) from value to text. @type {Map<string, Map<string, string>[]>} */
    const memo = new Map();
    let remembered = 0;

    /**
     * The text one color declaration becomes (empty when it becomes nothing).
     * @param {string} name @param {string} value @param {boolean} important
     * @param {boolean} controls @param {boolean} masked @param {boolean} mark @param {string} base
     * @param {boolean} [clip]  the background is clipped to the text: a gradient colors the letters
     */
    function one(name, value, important, controls, masked, mark, base, clip = false) {
      const tail = important ? '!important;' : ';';
      if (name.charCodeAt(0) === 45 && name.charCodeAt(1) === 45) return rw.customProperty(name, value, base, important ? 'important' : '');
      if (name !== 'border-color' && rw.isShorthand(name)) {
        const r = rw.shorthand(name, value, base, controls, clip, name === 'background' ? (masked ? 'color' : mark ? 'border-color' : '') : '');
        let text = '';
        for (const [property, v] of r.list) text += `${property}:${v}${tail}`;
        return text;
      }
      const v = name === 'background-color' && (masked || mark) ? rw.declaration(masked ? 'color' : 'border-color', value, base) : rw.declaration(name, value, base, controls, clip);
      return v !== null ? `${name}:${v}${tail}` : '';
    }

    /**
     * The color declarations of one block of declarations.
     * @param {{ name: string, value: string, important: boolean, kind: number }[]} items
     * @param {boolean} controls @param {string} base @param {{ scheme: number, lightDark: number, onlyLight: number } | null} found  counts of the site's own dark theme, or null
     * @param {Set<string> | null} [covered]  groups of properties the page's dark rules set for this rule's selector (repair mode)
     */
    function declsText(items, controls, base, found, covered = null) {
      let masked = false;
      let clip = false;
      let w = NaN;
      let h = NaN;
      let empty = false;
      for (const it of items) {
        if (it.kind !== 2) continue;
        if (it.name === 'background-clip' || it.name === '-webkit-background-clip') clip = it.value.trim().toLowerCase() === 'text';
        else if (it.name === 'width') w = pixels(it.value);
        else if (it.name === 'height') h = pixels(it.value);
        else if (it.name === 'content') empty = /^(?:""|'')$/.test(it.value.trim());
        else if (it.name === 'mask-image' || it.name === '-webkit-mask-image') masked = it.value !== 'none' && !/^(?:revert|revert-layer|initial|unset|inherit)$/i.test(it.value);
        else if (it.name === 'color-scheme') {
          if (found !== null) {
            if (siteApi.schemeOnlyLight(it.value)) found.onlyLight++;
            else if (siteApi.schemeHasDark(it.value)) found.scheme++;
          }
        } else masked = PICTURE.test(it.value);
      }
      // An empty box of at most 32 px (a dot, a bullet, a bar end) is a shape, drawn like a glyph, not a surface.
      if (empty && w > 0 && h > 0 && w <= 32 && h <= 32) masked = true;
      const mark = !masked && isMarkBox(w, h);
      const slot = masked ? 1 : mark ? 2 : controls ? 3 : 0;
      let out = '';
      let clipped = false;
      /** The shorthands copied whole in this block (they hold a bare `var()`): what they reset is written again when a later declaration sets it. @type {string[] | null} */
      let wholes = null;
      /** @param {{ name: string, value: string, important: boolean }} it @param {string} text */
      const note = (it, text) => {
        if (it.value.indexOf('var(') >= 0 && FAMILY[it.name] !== undefined && text.startsWith(`${it.name}:`)) (wholes ??= []).push(it.name);
        return text;
      };
      /** @param {{ name: string, value: string, important: boolean }} it */
      const again = (it) => {
        if (wholes !== null && it.value.indexOf('url(') < 0 && wholes.some((w) => resets(w, it.name))) out += `${it.name}:${it.value}${it.important ? '!important;' : ';'}`;
      };
      /** The last text color of the block, where its text sits in `out`, and the background color: together they get the pair floor. */
      let fg = null;
      let fgAt = -1;
      let fgEnd = -1;
      let bg = '';
      let picture = false;
      for (const it of items) {
        if (fg !== null && fgEnd < fgAt) fgEnd = out.length;
        if (it.kind !== 1) {
          if (it.kind > 1) again(it);
          continue;
        }
        if (!masked && !mark) {
          if (it.name === 'background-color') bg = it.value;
          else if (it.name === 'background-image') picture = !/^(?:none|initial)$/i.test(it.value.trim());
          else if (it.name === 'background') {
            bg = plainBackgroundColor(it.value) ?? '';
            picture = bg === '';
          }
        }
        if (it.name === 'color') {
          fg = it;
          fgAt = out.length;
          fgEnd = -1;
        }
        if (wholes !== null && rw.isShorthand(it.name) && it.name !== 'border-color') again(it);
        if (covered !== null && covered.has(/** @type {any} */ (dk).sitetheme.family(it.name))) continue;
        if (found !== null && it.value.indexOf('light-dark(') >= 0) found.lightDark++;
        // Gradient text: themed like text (or the ink); not remembered.
        if (clip && (it.name === 'background' || it.name === 'background-image') && it.value.indexOf('gradient(') >= 0) {
          out += note(it, one(it.name, it.value, it.important, controls, masked, mark, base, true));
          clipped = true;
          continue;
        }
        // A relative address depends on the sheet, so those declarations are not remembered.
        if (it.value.indexOf('url(') >= 0) {
          out += note(it, one(it.name, it.value, it.important, controls, masked, mark, base));
          continue;
        }
        let maps = memo.get(it.name);
        if (maps === undefined) {
          maps = [new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map()];
          memo.set(it.name, maps);
        }
        const table = maps[slot + (it.important ? 4 : 0)];
        const known = table.get(it.value);
        if (known !== undefined) {
          out += note(it, known);
          continue;
        }
        const text = one(it.name, it.value, it.important, controls, masked, mark, base);
        if (++remembered >= 20000) {
          memo.clear();
          remembered = 0;
        } else table.set(it.value, text);
        out += note(it, text);
      }
      if (fg !== null && fgEnd < fgAt) fgEnd = out.length;
      if (fg !== null && fgEnd > fgAt && bg !== '' && !picture) {
        const paired = rw.pairColor(fg.value, bg);
        if (paired !== null) out = `${out.slice(0, fgAt)}color:${paired}${fg.important ? '!important;' : ';'}${out.slice(fgEnd)}`;
      }
      return clipped ? out + rw.textClipRules() : out;
    }

    /**
     * Read a text sheet. `steps` is a generator: it yields 0 where the caller may flush `state.out` or give the page a turn, and
     * `{ importIndex }` where an `@import` needs the CSSOM; the caller answers with the imported text, or null to give up.
     * Returns the verdict. With `site`, a second stream is written: the rules of the page's own dark theme, ready to apply while
     * the page is not in that state; `found` counts what was seen.
     * @param {string} text @param {string} base
     * @param {{ rules: number, capped: boolean, layers?: any }} budget @param {boolean} [site]
     */
    function start(text, base, budget, site = false) {
      const s = text;
      // A rule that sets only a mask picture has no declaration of its own in the copy; the Images module still wants its selector.
      const hasMask = onBackground !== undefined && s.indexOf('mask') >= 0;
      // The copy has no declaration for an image-set() either.
      const hasSet = onBackground !== undefined && s.indexOf('image-set(') >= 0;
      const n = s.length;
      const miss = { from: Infinity };
      const S = {
        i: 0,
        /** @type {string[]} */ out: [],
        size: 0,
        top: 0,
        counted: 0,
        imports: 0,
        importsOpen: true,
        tick: 0,
        bad: '',
        /** @type {{ value: string, important: boolean } | null} */ fill: null,
        siteOn: site,
        /** @type {string[]} */ site: [],
        found: site ? siteApi.emptyFound() : null,
      };

      /** Index after the whitespace and comments from i. @param {number} i @param {boolean} top */
      function ws(i, top) {
        for (;;) {
          const c = s.charCodeAt(i);
          if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0xfeff) i++;
          else if (c === 47 && s.charCodeAt(i + 1) === 42) {
            const end = s.indexOf('*/', i + 2);
            if (end < 0) return n;
            i = end + 2;
          } else if (top && c === 60 && s.startsWith('<!--', i)) i += 4;
          else if (top && c === 45 && s.startsWith('-->', i)) i += 3;
          else return i;
        }
      }

      /**
       * From i, the index of the first `{`, `;` or `}` outside parentheses, brackets, strings and comments, or n.
       * @param {number} i
       */
      function scan(i) {
        let depth = 0;
        for (; i < n; i++) {
          const c = s.charCodeAt(i);
          if (c === 92) i++;
          else if (c === 34 || c === 39) {
            let k = i + 1;
            for (; k < n; k++) {
              const d = s.charCodeAt(k);
              if (d === 92) k++;
              else if (d === c) break;
              else if (d === 10) {
                S.bad = 'string';
                return n;
              }
            }
            if (k >= n) {
              S.bad = 'string';
              return n;
            }
            i = k;
          } else if (c === 47 && s.charCodeAt(i + 1) === 42) {
            const end = s.indexOf('*/', i + 2);
            if (end < 0) return n;
            i = end + 1;
          } else if (c === 40 || c === 91) {
            const end = c === 40 ? rawUrlEnd(s, i, miss) : -1;
            if (end > 0) i = end;
            else depth++;
          } else if (c === 41 || c === 93) {
            if (depth > 0) depth--;
          } else if (depth === 0 && (c === 123 || c === 59 || c === 125)) return i;
        }
        return n;
      }

      /** Index after the `}` that closes the block whose content starts at i, or n. @param {number} i */
      function skipBlock(i) {
        let level = 1;
        for (; i < n; i++) {
          const c = s.charCodeAt(i);
          if (c === 92) i++;
          else if (c === 34 || c === 39) {
            let k = i + 1;
            for (; k < n; k++) {
              const d = s.charCodeAt(k);
              if (d === 92) k++;
              else if (d === c) break;
              else if (d === 10) {
                S.bad = 'string';
                return n;
              }
            }
            i = k;
          } else if (c === 47 && s.charCodeAt(i + 1) === 42) {
            const end = s.indexOf('*/', i + 2);
            if (end < 0) return n;
            i = end + 1;
          } else if (c === 40) {
            const end = rawUrlEnd(s, i, miss);
            if (end > 0) i = end;
          } else if (c === 123) level++;
          else if (c === 125 && --level === 0) return i + 1;
        }
        return n;
      }

      /** The text of a prelude without comments. @param {number} a @param {number} b */
      function clean(a, b) {
        const raw = s.slice(a, b);
        return (raw.indexOf('/*') >= 0 ? stripComments(raw) : raw).trim();
      }

      /** One declaration from s[a, b). @param {number} a @param {number} b @returns {{ name: string, value: string, important: boolean, kind: number } | null} */
      function declaration(a, b) {
        const raw = clean(a, b);
        const colon = raw.indexOf(':');
        if (colon <= 0) return null;
        let name = raw.slice(0, colon).trim();
        if (name.charCodeAt(0) !== 45 || name.charCodeAt(1) !== 45) name = name.toLowerCase();
        let value = raw.slice(colon + 1).trim();
        let important = false;
        const bang = value.lastIndexOf('!');
        if (bang >= 0 && /^!\s*important$/i.test(value.slice(bang).trim())) {
          important = true;
          value = value.slice(0, bang).trim();
        }
        return { name, value, important, kind: kindOf(name) };
      }

      /**
       * The body of a style rule, or of a group inside one: declarations and nested rules, up to the closing brace.
       * @param {number} depth @param {string} selector
       * @returns {string}
       */
      function body(depth, selector) {
        let text = '';
        /** @type {{ name: string, value: string, important: boolean, kind: number }[]} */
        let items = [];
        let first = true;
        const controls = selector !== '' && isControl(selector);
        if (depth === 0) S.fill = null;
        const covered = cover !== null && depth === 0 && selector !== '' ? cover(selector) : null;
        const flush = () => {
          if (items.length) text += declsText(items, first && controls, base, S.siteOn ? S.found : null, first ? covered : null);
          items = [];
          first = false;
        };
        for (;;) {
          const i = ws(S.i, false);
          if (i >= n) {
            S.i = n;
            break;
          }
          const c = s.charCodeAt(i);
          if (c === 125) {
            S.i = i + 1;
            break;
          }
          if (c === 59) {
            S.i = i + 1;
            continue;
          }
          if (c === 64) {
            let k = i + 1;
            while (k < n && isIdent(s.charCodeAt(k))) k++;
            const name = s.slice(i + 1, k).toLowerCase();
            const j = scan(k);
            if (S.bad) break;
            if (j < n && s.charCodeAt(j) === 123) {
              if (GROUPS.has(name) && depth + 1 < maxDepth) {
                flush();
                const head = `@${name}${clean(k, j) ? ` ${clean(k, j)}` : ''}`;
                S.i = j + 1;
                const inner = body(depth + 1, '');
                if (S.bad) break;
                if (inner) text += `${head}{${inner}}`;
              } else S.i = skipBlock(j + 1);
            } else S.i = j < n && s.charCodeAt(j) === 59 ? j + 1 : j;
            continue;
          }
          let j = scan(i);
          if (S.bad) break;
          // A custom property may hold a block: `--x: { a: b }`.
          while (j < n && s.charCodeAt(j) === 123 && c === 45 && s.charCodeAt(i + 1) === 45) {
            j = scan(skipBlock(j + 1));
            if (S.bad) break;
          }
          if (j < n && s.charCodeAt(j) === 123) {
            flush();
            const sel = clean(i, j);
            S.i = j + 1;
            if (depth + 1 >= maxDepth) {
              S.i = skipBlock(S.i);
              continue;
            }
            const inner = body(depth + 1, sel);
            if (S.bad) break;
            if (inner) text += `${sel}{${inner}}`;
            continue;
          }
          const d = declaration(i, j);
          if (d !== null && d.kind !== 0) {
            items.push(d);
            if (depth === 0 && d.name === 'fill') S.fill = d;
          }
          S.i = j < n && s.charCodeAt(j) === 59 ? j + 1 : j;
        }
        flush();
        return text;
      }

      /** The declarations of one keyframe block, copied whole. Returns the text and whether a color was themed. */
      function frameBody() {
        let text = '';
        let color = false;
        for (;;) {
          const i = ws(S.i, false);
          if (i >= n) {
            S.i = n;
            break;
          }
          const c = s.charCodeAt(i);
          if (c === 125) {
            S.i = i + 1;
            break;
          }
          if (c === 59) {
            S.i = i + 1;
            continue;
          }
          const j = scan(i);
          if (S.bad) break;
          const d = declaration(i, j);
          // A keyframe ignores an important declaration; the copy must not make it count.
          if (d !== null && !d.important) {
            const v = d.kind === 1 && !d.name.startsWith('--') ? rw.declaration(d.name, d.value, base) : null;
            if (v !== null) color = true;
            text += `${d.name}:${v ?? d.value};`;
          }
          S.i = j < n && s.charCodeAt(j) === 59 ? j + 1 : j;
          if (j < n && s.charCodeAt(j) === 123) {
            // A block where a declaration should be: not a keyframe block.
            S.bad = 'keyframes';
            break;
          }
        }
        return { text, color };
      }

      /**
       * A list of rules: the top level of the sheet or the inside of a group.
       * @param {number} depth @param {string[]} sink @param {boolean} top @param {string[] | null} siteSink  where the rules of the site's dark theme go, or null
       * @returns {Generator<number | { importIndex: number }, boolean, string | null | undefined>}
       */
      function* rules(depth, sink, top, siteSink) {
        /** Count a rule the CSSOM would hold. Returns false when a limit is passed. */
        const count = () => {
          if (++budget.rules > maxRules || depth > maxDepth) {
            budget.capped = true;
            return false;
          }
          S.counted += 1;
          if (depth === 0) S.top += 1;
          return true;
        };
        /** @param {string} piece */
        const emit = (piece) => {
          sink.push(piece);
          if (top) S.size += piece.length;
        };
        for (;;) {
          const i = ws(S.i, top);
          if (i >= n) {
            S.i = n;
            return true;
          }
          const c = s.charCodeAt(i);
          if (c === 125) {
            if (top) {
              S.bad = 'stray';
              return false;
            }
            S.i = i + 1;
            return true;
          }
          if (c === 59) {
            S.i = i + 1;
            continue;
          }
          if (c === 64) {
            let k = i + 1;
            while (k < n && isIdent(s.charCodeAt(k))) k++;
            const name = s.slice(i + 1, k).toLowerCase();
            const j = scan(k);
            if (S.bad) return false;
            const block = j < n && s.charCodeAt(j) === 123;
            if (block) {
              if (KEYFRAMES.has(name)) {
                if (!count()) return false;
                S.importsOpen = false;
                S.i = j + 1;
                const label = clean(k, j);
                let frames = '';
                let color = false;
                for (;;) {
                  const f = ws(S.i, false);
                  if (f >= n) {
                    S.i = n;
                    break;
                  }
                  if (s.charCodeAt(f) === 125) {
                    S.i = f + 1;
                    break;
                  }
                  const g = scan(f);
                  if (S.bad) return false;
                  if (g >= n || s.charCodeAt(g) !== 123) {
                    S.bad = 'keyframes';
                    return false;
                  }
                  const key = clean(f, g);
                  S.i = g + 1;
                  const part = frameBody();
                  if (S.bad) return false;
                  if (part.color) color = true;
                  frames += `${key}{${part.text}}`;
                }
                // The copy keeps the prefix: a prefix the browser does not read stays unread, as in the page.
                if (color) emit(`@${name} ${label}{${frames}}`);
              } else if (GROUPS.has(name)) {
                if (!count()) return false;
                S.importsOpen = false;
                S.i = j + 1;
                /** @type {string[]} */
                const inner = [];
                const innerSite = siteSink ? [] : null;
                const from = S.i;
                const counted = S.counted;
                const layers = name === 'layer' ? budget.layers ?? null : null;
                const prelude = layers ? layers.open(clean(k, j)) : clean(k, j);
                let ok = false;
                try {
                  ok = yield* rules(depth + 1, inner, false, innerSite);
                } finally {
                  layers?.close();
                }
                if (!ok) return false;
                if (motion && name === 'media') {
                  // The page asks for reduced motion: its rules apply as they are, then the themed colors of the same rules.
                  const lead = siteApi.reducedMedia(prelude);
                  if (lead !== null) {
                    const stop = s.charCodeAt(S.i - 1) === 125 ? S.i - 1 : S.i;
                    const raw = siteApi.absolutize(s.slice(from, stop), base);
                    if (raw.trim() !== '' && raw.length <= MOTION_MAX_CHARS) {
                      emit(`${siteApi.unwrappedHead(lead)}{${raw}}`);
                      if (inner.length) emit(`${siteApi.unwrappedHead(lead)}{${inner.join('')}}`);
                    }
                  }
                }
                if (inner.length) emit(`@${name}${prelude ? ` ${prelude}` : ''}{${inner.join('')}}`);
                if (siteSink && innerSite) {
                  const rest = name === 'media' ? siteApi.darkMedia(prelude) : null;
                  if (rest !== null) {
                    const stop = s.charCodeAt(S.i - 1) === 125 ? S.i - 1 : S.i;
                    const raw = siteApi.absolutize(s.slice(from, stop), base);
                    if (raw.trim() !== '') {
                      siteSink.push(`${siteApi.unwrappedHead(rest)}{${raw}}`);
                      S.found.media++;
                      S.found.rules += S.counted - counted;
                      S.found.chars += raw.length;
                    }
                  } else if (innerSite.length) siteSink.push(`@${name}${prelude ? ` ${prelude}` : ''}{${innerSite.join('')}}`);
                }
              } else if (LEAVES.has(name)) {
                if (!count()) return false;
                S.importsOpen = false;
                S.i = skipBlock(j + 1);
                // A registered color has its initial value in the rule: the derived variables get theirs.
                if (name === 'property') {
                  const text = rw.registeredText(clean(k, j), clean(j + 1, S.i - 1));
                  if (text) emit(text);
                }
              } else S.i = skipBlock(j + 1);
            } else {
              S.i = j < n && s.charCodeAt(j) === 59 ? j + 1 : j;
              if (name === 'import') {
                if (S.importsOpen && top) {
                  if (!count()) return false;
                  const answer = yield { importIndex: S.imports++ };
                  if (typeof answer !== 'string') {
                    S.bad = 'import';
                    return false;
                  }
                  if (answer !== '') emit(answer);
                }
              } else if (name === 'layer') {
                if (!count()) return false;
                const text = budget.layers ? budget.layers.statement(clean(k, j).split(',')) : '';
                if (text) emit(text);
              } else if (name === 'namespace') {
                if (!count()) return false;
                S.importsOpen = false;
              }
            }
          } else {
            const j = scan(i);
            if (S.bad) return false;
            if (j >= n || s.charCodeAt(j) !== 123) {
              S.i = j < n && s.charCodeAt(j) === 59 ? j + 1 : j;
              continue;
            }
            if (!count()) return false;
            S.importsOpen = false;
            const selector = clean(i, j);
            S.i = j + 1;
            const bodyAt = S.i;
            const inner = body(0, selector);
            if (S.bad) return false;
            if (siteSink) {
              const moved = siteApi.rewriteSelectors(selector);
              if (moved !== '') {
                const stop = s.charCodeAt(S.i - 1) === 125 ? S.i - 1 : S.i;
                const raw = siteApi.absolutize(s.slice(bodyAt, stop), base);
                if (raw.trim() !== '') {
                  siteSink.push(`${moved}{${raw}}`);
                  S.found.state++;
                  S.found.rules++;
                  S.found.chars += raw.length;
                }
              }
            }
            if (hasMask && !(inner && inner.indexOf('url(') >= 0 && setsPicture(inner, BACKGROUND_NAME)) && setsPicture(s.slice(bodyAt, S.i), MASK_NAME)) onBackground?.(selector, 'mask');
            else if (hasSet && setsPicture(s.slice(bodyAt, S.i), BACKGROUND_NAME, 'image-set(')) onBackground?.(selector);
            if (inner) {
              emit(`${selector}{${inner}}`);
              if (S.fill && inner.indexOf('fill:') >= 0) {
                const shape = rw.shapeFill(selector, S.fill.value, S.fill.important);
                if (shape) emit(shape);
              }
              if (onBackground) pictureNote(inner, selector, onBackground);
            }
          }
          if ((++S.tick & 15) === 0 || S.size >= chunkChars) yield 0;
        }
      }

      function* steps() {
        const finished = yield* rules(0, S.out, true, site ? S.site : null);
        if (S.bad || budget.capped || !finished) return { ok: false, reason: S.bad || (budget.capped ? 'capped' : 'unfinished'), top: S.top, counted: S.counted, found: S.found };
        return { ok: true, reason: '', top: S.top, counted: S.counted, found: S.found };
      }
      return { state: S, steps: steps() };
    }

    return Object.freeze({
      start,
      /** Forget the declarations written so far: the rewriter changed its mode. */
      reset: () => {
        memo.clear();
        remembered = 0;
      },
    });
  }

  dk.sheettext = Object.freeze({ createReader, pictureNote, stripComments });
})();
