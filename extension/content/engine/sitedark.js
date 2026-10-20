// @ts-check
// Pure string helpers for the site's own dark theme. Dark rules come as `@media (prefers-color-scheme: dark)` rules,
// rules behind a theme state of the root or body (`.dark`, `[data-theme=dark]`), and `color-scheme` or `light-dark()`.
// The Dynamic engine uses these to write a second copy where the dark rules apply without that state. No DOM.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;

  /** Cheap pre-check: only a selector that holds this word can hold a dark state. */
  const MAYBE_DARK = /dark/i;
  /** The attribute names a page uses for its theme. */
  const STATE_ATTR_NAME = /(?:theme|mode|scheme)/i;
  /** The class names a page uses for its dark theme. */
  const STATE_CLASS = /^(?:dark|darkmode|darktheme|dark[-_](?:mode|theme|scheme)|(?:theme|mode|color|is)[-_]dark)$/i;
  /** A condition that is always true (no element has this class) and weighs the same as a class or an attribute selector. */
  const ALWAYS = ':not(.dk-x)';
  const DARK_QUERY = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i;
  const REDUCE_QUERY = /\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i;

  const isIdentChar = (/** @type {number} */ c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c > 127;

  /** The index after the quoted string that starts at i. @param {string} s @param {number} i */
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

  /** The index after the group that opens at i (`(` or `[`), or -1. @param {string} s @param {number} i */
  function skipGroup(s, i) {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 92) j++;
      else if (c === 34 || c === 39) j = skipString(s, j) - 1;
      else if (c === 40 || c === 91) depth++;
      else if ((c === 41 || c === 93) && --depth === 0) return j + 1;
    }
    return -1;
  }

  /** Split on a separator outside groups and strings. @param {string} s @param {number} sep */
  function splitTop(s, sep) {
    /** @type {string[]} */
    const out = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 92) i++;
      else if (c === 34 || c === 39) i = skipString(s, i) - 1;
      else if (c === 40 || c === 91) {
        const end = skipGroup(s, i);
        if (end < 0) break;
        i = end - 1;
      } else if (c === sep) {
        out.push(s.slice(start, i));
        start = i + 1;
      }
    }
    out.push(s.slice(start));
    return out;
  }

  /**
   * @typedef {{ kind: 'tag' | 'class' | 'id' | 'attr' | 'pseudo', text: string, name: string, args: string }} Token
   */

  /**
   * The parts of one compound selector (no combinators), or null for anything this does not read.
   * @param {string} s @returns {Token[] | null}
   */
  function tokens(s) {
    /** @type {Token[]} */
    const out = [];
    let i = 0;
    const n = s.length;
    const ident = (/** @type {number} */ from) => {
      let j = from;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c === 92) j += 2;
        else if (isIdentChar(c)) j++;
        else break;
      }
      return j;
    };
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 46 || c === 35) {
        const j = ident(i + 1);
        if (j === i + 1) return null;
        out.push({ kind: c === 46 ? 'class' : 'id', text: s.slice(i, j), name: s.slice(i + 1, j), args: '' });
        i = j;
      } else if (c === 91) {
        const j = skipGroup(s, i);
        if (j < 0) return null;
        out.push({ kind: 'attr', text: s.slice(i, j), name: '', args: s.slice(i + 1, j - 1) });
        i = j;
      } else if (c === 58) {
        let j = i + 1;
        if (s.charCodeAt(j) === 58) return null;
        const k = ident(j);
        if (k === j) return null;
        const name = s.slice(j, k).toLowerCase();
        let args = '';
        j = k;
        if (s.charCodeAt(j) === 40) {
          const end = skipGroup(s, j);
          if (end < 0) return null;
          args = s.slice(j + 1, end - 1);
          j = end;
        }
        out.push({ kind: 'pseudo', text: s.slice(i, j), name, args });
        i = j;
      } else if (i === 0 && (c === 42 || isIdentChar(c))) {
        if (c === 42) {
          out.push({ kind: 'tag', text: '*', name: '*', args: '' });
          i = 1;
        } else {
          const j = ident(0);
          out.push({ kind: 'tag', text: s.slice(0, j), name: s.slice(0, j).toLowerCase(), args: '' });
          i = j;
        }
      } else return null;
    }
    return out;
  }

  /** Is this token a dark state of the page: a class or an attribute selector? @param {Token} t */
  function isState(t) {
    if (t.kind === 'class') return STATE_CLASS.test(t.name);
    if (t.kind !== 'attr') return false;
    const m = /^\s*([\w-]+)\s*([~|]?=)\s*("[^"]*"|'[^']*'|[^\s"'\]]+)\s*(?:[is]\s*)?$/i.exec(t.args);
    if (!m || !STATE_ATTR_NAME.test(m[1])) return false;
    const value = m[3].replace(/^["']|["']$/g, '').trim().toLowerCase();
    return value === 'dark';
  }

  /** The tokens of a `:where()` or `:is()` item such as `.dark`, `:root.dark` or `[data-theme=dark] *`, when it is a state. @param {string} item */
  function stateItem(item) {
    const text = item.trim().replace(/\s+\*$/, '');
    const parts = tokens(text);
    if (!parts || !parts.length) return false;
    let state = false;
    for (const t of parts) {
      if (isState(t)) state = true;
      else if (!((t.kind === 'tag' && (t.name === 'html' || t.name === 'body')) || (t.kind === 'pseudo' && t.name === 'root'))) return false;
    }
    return state;
  }

  /** Is this `:where()` or `:is()` a list of dark states, as `:where(.dark, .dark *)`? @param {Token} t */
  function isStateList(t) {
    if (t.kind !== 'pseudo' || (t.name !== 'where' && t.name !== 'is') || t.args === '') return false;
    const items = splitTop(t.args, 44);
    return items.length > 0 && items.every(stateItem);
  }

  /**
   * Rewrite one compound selector. The dark state is replaced by a condition that is always true and weighs the same.
   * @param {string} text @param {boolean} leftmost @param {boolean} subject  the compound styles the element the rule is for
   * @returns {string | null} the new text, or null when the compound holds no dark state
   */
  function rewriteCompound(text, leftmost, subject) {
    const parts = tokens(text);
    if (!parts) return null;
    let changed = false;
    let rootish = false;
    let allowed = true;
    let stateCount = 0;
    for (const t of parts) {
      if (leftmost && isState(t)) stateCount++;
      else if (isStateList(t)) stateCount++;
      else if (t.kind === 'tag' && (t.name === 'html' || t.name === 'body')) rootish = true;
      else if (t.kind === 'pseudo' && t.name === 'root') rootish = true;
      else if (t.kind === 'tag' && t.name === '*') continue;
      else if (t.kind === 'attr' || t.kind === 'pseudo') continue;
      else allowed = false;
    }
    if (stateCount === 0) return null;
    if (leftmost && !allowed) {
      // `.card.dark` is a variant of a component, not a state of the page. A list like `:where(.dark *)` is still read.
      if (!parts.some(isStateList)) return null;
    }
    let out = '';
    let replacedState = false;
    for (const t of parts) {
      if (leftmost && isState(t)) {
        out += ALWAYS;
        changed = true;
        replacedState = true;
      } else if (isStateList(t)) {
        out += t.name === 'where' ? ':where(*)' : ALWAYS;
        changed = true;
      } else if (t.kind === 'tag' && t.name === '*' && !rootish && leftmost && subject) continue;
      else out += t.text;
    }
    if (!changed) return null;
    // A bare `.dark { ... }` styles the element that carries the class, which is the root or the body. Without the tag the
    // always-true condition would match every element.
    if (replacedState && subject && !rootish) out = `:where(html,body)${out}`;
    return out;
  }

  /** Split one complex selector into compounds and the combinators between them. @param {string} sel @returns {string[] | null} alternating compound and combinator texts */
  function pieces(sel) {
    /** @type {string[]} */
    const out = [];
    let start = 0;
    let i = 0;
    const n = sel.length;
    while (i < n) {
      const c = sel.charCodeAt(i);
      if (c === 92) i += 2;
      else if (c === 34 || c === 39) i = skipString(sel, i);
      else if (c === 40 || c === 91) {
        const end = skipGroup(sel, i);
        if (end < 0) return null;
        i = end;
      } else if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 62 || c === 43 || c === 126) {
        let j = i;
        while (j < n) {
          const d = sel.charCodeAt(j);
          if (d === 32 || d === 9 || d === 10 || d === 13 || d === 12 || d === 62 || d === 43 || d === 126) j++;
          else break;
        }
        if (i > start) out.push(sel.slice(start, i));
        else if (out.length === 0) return null;
        out.push(sel.slice(i, j));
        start = j;
        i = j;
      } else i++;
    }
    if (start < n) out.push(sel.slice(start));
    return out;
  }

  /**
   * One complex selector with its dark state made always true, or null when it has none.
   * @param {string} selector
   */
  function rewriteOne(selector) {
    const sel = selector.trim();
    if (sel === '' || sel.charCodeAt(0) === 38) return null;
    const list = pieces(sel);
    if (!list) return null;
    let any = false;
    let out = '';
    for (let k = 0; k < list.length; k += 2) {
      const subject = k + 2 >= list.length;
      const next = rewriteCompound(list[k], k === 0, subject);
      if (next !== null) any = true;
      out += (next ?? list[k]) + (list[k + 1] ?? '');
    }
    return any ? out : null;
  }

  /**
   * The selectors of a rule that depend on a dark state, rewritten to match without it. Others are left out: the page's
   * own sheet still applies them. Returns '' when none was found.
   * @param {string} selectorText
   */
  function rewriteSelectors(selectorText) {
    if (!MAYBE_DARK.test(selectorText)) return '';
    /** @type {string[]} */
    const out = [];
    for (const one of splitTop(selectorText, 44)) {
      const next = rewriteOne(one);
      if (next !== null) out.push(next);
    }
    return out.join(',');
  }

  /**
   * A media prelude (the text after `@media`) that asks for the dark scheme: the condition left when that clause is taken
   * out, or null. `(prefers-color-scheme: dark)` alone gives ''. Lists, negations and mixed clauses are not read.
   * @param {string} prelude @returns {string | null}
   */
  function darkMedia(prelude) {
    if (!MAYBE_DARK.test(prelude) || !DARK_QUERY.test(prelude)) return null;
    const q = prelude.trim().replace(/\s+/g, ' ');
    if (splitTop(q, 44).length > 1) return null;
    const marked = q.replace(DARK_QUERY, '\u0001');
    if (/prefers-color-scheme/i.test(marked) || /\bnot\b/i.test(marked)) return null;
    const rest = marked
      .replace(/\s*\band\s+\u0001/i, '')
      .replace(/\u0001\s+and\b\s*/i, '')
      .replace(/\u0001/, '')
      .trim();
    if (rest.indexOf('\u0001') >= 0) return null;
    return rest;
  }

  /**
   * A media prelude that asks for reduced motion: the condition left when that clause is taken out, or null. The rules
   * inside are written unwrapped when the person asks the page for reduced motion.
   * @param {string} prelude @returns {string | null}
   */
  function reducedMedia(prelude) {
    if (!/reduced-motion/i.test(prelude) || !REDUCE_QUERY.test(prelude)) return null;
    const q = prelude.trim().replace(/\s+/g, ' ');
    if (splitTop(q, 44).length > 1) return null;
    const marked = q.replace(REDUCE_QUERY, '\u0001');
    if (/prefers-reduced-motion/i.test(marked) || /\bnot\b/i.test(marked)) return null;
    const rest = marked
      .replace(/\s*\band\s+\u0001/i, '')
      .replace(/\u0001\s+and\b\s*/i, '')
      .replace(/\u0001/, '')
      .trim();
    if (rest.indexOf('\u0001') >= 0) return null;
    return rest;
  }

  /** The text of a media rule for the unwrapped rules: the rest of the condition, or the plain `screen` type. @param {string} rest */
  function unwrappedHead(rest) {
    return rest === '' ? '@media screen' : /^(?:screen|all)$/i.test(rest) ? '@media screen' : `@media ${rest}`;
  }

  /**
   * Make the addresses in `url()` absolute. The copy sits in the page, not next to the sheet it came from.
   * @param {string} text @param {string} base
   */
  function absolutize(text, base) {
    if (!base || !/url\(|image-set\(/i.test(text)) return text;
    const n = text.length;
    let out = '';
    let from = 0;
    let depth = 0;
    /** The depths at which an `image-set()` is open: a string right inside one is an address. @type {number[]} */
    const sets = [];
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 92) i++;
      else if (c === 47 && text.charCodeAt(i + 1) === 42) {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 1;
      } else if (c === 34 || c === 39) {
        const end = stringEnd(text, i);
        // A string elsewhere (`content: "url(x)"`) is text, not an address.
        if (sets.length && sets[sets.length - 1] === depth) {
          const href = resolved(unescapeCss(text.slice(i + 1, end - 1)), base);
          if (href !== null) {
            out += `${text.slice(from, i)}"${href}"`;
            from = end;
          }
        }
        i = end - 1;
      } else if (c === 40) {
        const name = nameBefore(text, i);
        if (name === 'url') {
          const end = urlEnd(text, i + 1);
          if (end < 0) break;
          let inner = text.slice(i + 1, end - 1).trim();
          const quote = inner.charCodeAt(0);
          if ((quote === 34 || quote === 39) && inner.length >= 2) inner = inner.slice(1, -1);
          const href = resolved(unescapeCss(inner), base);
          if (href !== null) {
            out += `${text.slice(from, i - 3)}url("${href}")`;
            from = end;
          }
          i = end - 1;
          continue;
        }
        depth++;
        if (name === 'image-set' || name === '-webkit-image-set') sets.push(depth);
      } else if (c === 41 && depth > 0) {
        if (sets.length && sets[sets.length - 1] === depth) sets.pop();
        depth--;
      }
    }
    return from === 0 ? text : out + text.slice(from);
  }

  /** Index after the string that opens at i (the quote), or the end of the text. @param {string} s @param {number} i */
  function stringEnd(s, i) {
    const q = s.charCodeAt(i);
    for (let k = i + 1; k < s.length; k++) {
      const d = s.charCodeAt(k);
      if (d === 92) k++;
      else if (d === q || d === 10) return k + 1;
    }
    return s.length;
  }

  /** Index after the `)` that closes a `url(` whose content starts at i, or -1. Strings and escapes are skipped. @param {string} s @param {number} i */
  function urlEnd(s, i) {
    for (let k = i; k < s.length; k++) {
      const d = s.charCodeAt(k);
      if (d === 92) k++;
      else if (d === 34 || d === 39) k = stringEnd(s, k) - 1;
      else if (d === 41) return k + 1;
    }
    return -1;
  }

  /** The lower-case name of the function whose `(` is at i, or ''. @param {string} s @param {number} i */
  function nameBefore(s, i) {
    let k = i;
    while (k > 0) {
      const d = s.charCodeAt(k - 1);
      if ((d >= 97 && d <= 122) || (d >= 65 && d <= 90) || (d >= 48 && d <= 57) || d === 45 || d === 95) k--;
      else break;
    }
    return s.slice(k, i).toLowerCase();
  }

  /** The text of a CSS string or url without its escapes. @param {string} s */
  function unescapeCss(s) {
    if (s.indexOf('\\') < 0) return s;
    return s.replace(/\\(?:([0-9a-f]{1,6})\s?|(\n)|([\s\S]))/gi, (_, hex, nl, ch) => {
      if (nl) return '';
      if (ch !== undefined) return ch;
      const code = parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code);
    });
  }

  /** An address made absolute, written so it is safe inside a double-quoted string, or null to leave it as it is. @param {string} target @param {string} base */
  function resolved(target, base) {
    const t = target.trim();
    if (t === '' || t.startsWith('#') || /^(?:data|blob|about):/i.test(t)) return null;
    try {
      return new URL(t, base).href.replace(/["\\\n\r\f]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `);
    } catch {
      return null;
    }
  }

  /** Does a `color-scheme` value name the dark scheme? @param {string} value */
  const schemeHasDark = (value) => /\bdark\b/i.test(value);
  /** Does a `color-scheme` value forbid the other scheme (`only light`)? @param {string} value */
  const schemeOnlyLight = (value) => /\bonly\b/i.test(value) && /\blight\b/i.test(value) && !/\bdark\b/i.test(value);

  /** @returns {{ media: number, state: number, scheme: number, lightDark: number, onlyLight: number, rules: number, chars: number }} */
  const emptyFound = () => ({ media: 0, state: 0, scheme: 0, lightDark: 0, onlyLight: 0, rules: 0, chars: 0 });

  dk.sitedark = Object.freeze({ splitList: (/** @type {string} */ s) => splitTop(s, 44), rewriteSelectors, darkMedia, reducedMedia, unwrappedHead, absolutize, schemeHasDark, schemeOnlyLight, emptyFound, ALWAYS });
})();
