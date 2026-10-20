// @ts-check
// The page's own dark theme: the verdict on it, the decision to keep it, and the repair of what it leaves light. Loaded on
// demand (loader.js) when the sheets of a page show a dark theme of their own; most pages never load it. `create` gives the Dynamic
// engine the parts that need its state; the rest are pure functions the readers and the rewriter use while the repair runs.
(() => {
  'use strict';
  const dk = /** @type {Record<string, any>} */ (globalThis.__dk);
  if (!dk || dk.sitetheme) return;
  const site = /** @type {any} */ (dk.sitedark);

  // A large section of the page (taller than this, wider than this share of the window) that is light is a part the page's own dark
  // theme does not cover. The repair mode darkens it; when sections like it make up this share of the sections' height, the theme is not
  // used at all.
  const SECTION_MIN_HEIGHT = 300;
  const SECTION_MIN_WIDTH = 0.6;
  const SECTION_MAX = 60;
  const LIGHT_SHARE_MAX = 0.6;
  // The most selectors the repair keeps in its list of what the page's dark rules cover.
  const MAX_COVER = 20000;
  let assessments = 0;

  /**
   * Is a large section light? Its background color decides, or the colors of its gradient when it has no color.
   * @param {CSSStyleDeclaration} cs @param {Record<string, any>} kit
   */
  function sectionIsLight(cs, kit) {
    const { parse, LIGHT_BOX_Y } = kit;
    const c = parse(cs.backgroundColor);
    if (c && c.a >= 0.5) return c.y >= LIGHT_BOX_Y;
    const image = cs.backgroundImage;
    if (image && image.indexOf('gradient(') >= 0) {
      let sum = 0;
      let n = 0;
      for (const m of image.matchAll(/rgba?\([^)]*\)/g)) {
        const g = parse(m[0]);
        if (g && g.a >= 0.5) {
          sum += g.y;
          n++;
        }
      }
      return n > 0 && sum / n >= LIGHT_BOX_Y;
    }
    return false;
  }

  /**
   * The large top-level sections of the whole page (children of the body or of its one wrapper): how much of the page the
   * dark theme leaves light.
   * @param {Element} body @param {Record<string, any>} kit @returns {{ count: number, share: number }}
   */
  function lightSections(body, kit, styleOf = getComputedStyle) {
    let host = body;
    for (let step = 0; step < 2; step++) {
      const kids = [...host.children].filter((el) => !/^(?:script|style|link|noscript)$/i.test(el.localName));
      if (kids.length !== 1) break;
      host = kids[0];
    }
    let total = 0;
    let light = 0;
    let count = 0;
    let seen = 0;
    const w = innerWidth;
    for (const el of host.children) {
      if (++seen > SECTION_MAX) break;
      const r = el.getBoundingClientRect();
      if (r.height < SECTION_MIN_HEIGHT || r.width < SECTION_MIN_WIDTH * w) continue;
      total += r.height;
      if (sectionIsLight(styleOf(el), kit)) {
        light += r.height;
        count++;
      }
    }
    return { count, share: total > 0 ? light / total : 0 };
  }

  /**
   * Is the page dark with readable text as it is now (the site's own dark theme)? The engine elements are off for the call,
   * except the ones `keep` names. `scheme` forces the dark scheme on the root, as the engine does anyway. Sampled as `probe`
   * does. When `plainWhen` says yes, the look with no engine element is added as `plain`, in the same switch.
   * @param {{ keep: (el: Element) => boolean, scheme: boolean, minContrast: number, plainWhen?: (verdict: any) => boolean }} options
   * @returns {{ ok: boolean, contrast: number | null, background: number | null, text: number | null, repair?: boolean, canvasFromBody?: boolean, lightSections?: number, lightShare?: number, plain?: any }} `repair`: a part below the top is light and is darkened; `canvasFromBody`: the body paints the canvas
   */
  function assess(options) {
    assessments += 1;
    const kit = /** @type {Record<string, any>} */ (dk.detect.kit);
    const { parse, lightBoxAtCenter, DARK_BACKGROUND } = kit;
    const root = document.documentElement;
    return /** @type {any} */ (dk.scheme).cascade(
      (/** @type {any} */ r) => {
        const styleOf = r?.style ?? getComputedStyle;
        const verdict = look(styleOf);
        if (!options.plainWhen?.(verdict)) return verdict;
        // Still on: the ones `keep` named.
        const kept = /** @type {HTMLStyleElement[]} */ ([...document.querySelectorAll('style[data-dk]')].filter((el) => el instanceof HTMLStyleElement && !el.disabled));
        for (const el of kept) el.disabled = true;
        try {
          r?.settle();
          return { ...verdict, plain: look(styleOf) };
        } finally {
          for (const el of kept) el.disabled = false;
        }
      },
      (/** @type {HTMLStyleElement} */ el) => options.keep(el),
      options.scheme ? '@media screen{html{color-scheme:dark!important}}' : '',
    );

    /** @param {any} styleOf @returns {any} */
    function look(styleOf) {
      const rootStyle = styleOf(root);
      const meta = document.querySelector('meta[name="color-scheme" i]');
      const scheme = `${rootStyle.colorScheme} ${meta ? meta.getAttribute('content') ?? '' : ''}`.toLowerCase().split(/[\s,]+/).filter(Boolean);
      const schemeDark = scheme.includes('dark') && !scheme.includes('light');
      const body = document.body;
      if (!body) return { ok: false, contrast: null, background: null, text: null };
      const bodyStyle = styleOf(body);
      const solid = [parse(bodyStyle.backgroundColor), parse(rootStyle.backgroundColor)].find((c) => c && c.a >= 0.5);
      const background = solid ? solid.y : schemeDark ? 0.01 : 1;
      const text = parse(bodyStyle.color);
      if (!text) return { ok: false, contrast: null, background, text: null };
      // The body paints the canvas when the root has no color of its own: a color of ours on the root would take that away.
      const bodySolid = parse(bodyStyle.backgroundColor);
      const rootSolid = parse(rootStyle.backgroundColor);
      const canvasFromBody = !!bodySolid && bodySolid.a >= 0.5 && !(rootSolid && rootSolid.a >= 0.5);
      const contrast = (Math.max(background, text.y) + 0.05) / (Math.min(background, text.y) + 0.05);
      const sections = lightSections(body, kit, styleOf);
      const ok = background < DARK_BACKGROUND && contrast >= options.minContrast && !lightBoxAtCenter(root, body, 0.5, styleOf) && sections.share < LIGHT_SHARE_MAX;
      // A light box low in the window, or a light section anywhere on the page, is for the repair to darken.
      const repair = ok && (sections.count > 0 || lightBoxAtCenter(root, body, 0.85, styleOf));
      return { ok, contrast, background, text: text.y, repair, canvasFromBody, lightSections: sections.count, lightShare: Math.round(sections.share * 1000) / 1000 };
    }
  }

  /**
   * Which group of properties a declaration belongs to, for the repair of a page that shows its own dark theme: a light rule of
   * the page is not repaired for a group in which a dark rule of the page sets the same selector. '' for a name outside the groups.
   * @param {string} name lower case property name
   */
  function family(name) {
    switch (name) {
      case 'background':
      case 'background-color':
      case 'background-image':
        return 'b';
      case 'color':
      case '-webkit-text-fill-color':
      case 'caret-color':
      case 'text-decoration':
      case 'text-decoration-color':
        return 'c';
      case 'fill':
      case 'stroke':
      case 'stop-color':
      case 'flood-color':
        return 'f';
      case 'box-shadow':
      case 'text-shadow':
      case 'filter':
      case '-webkit-filter':
        return 'h';
      default:
        if (name.startsWith('border')) return 'd';
        if (name.startsWith('outline')) return 'o';
        return '';
    }
  }

  /**
   * The selectors a rule of the copy of the dark rules stands for, as a light rule of the page writes them: the always-true
   * condition that replaced the dark state is taken out. A bare state stands for the root and the body.
   * @param {string} selectorText @returns {string[]}
   */
  function coverKeys(selectorText) {
    /** @type {string[]} */
    const out = [];
    for (const one of site.splitList(selectorText)) {
      let s = one.split(site.ALWAYS).join('').replace(/^:where\(html,body\)/, '').trim();
      if (s === '') {
        out.push('html', 'body');
        continue;
      }
      s = s.replace(/^[\s>+~]+/, '').replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1');
      if (s === '') continue;
      out.push(s);
      // `:root.dark a` styles the same elements as `a`: the root and the body in front of the selector are not part of the key.
      for (let m = /^(?:html|:root|body)[\s>](.+)$/.exec(s); m; m = /^(?:html|:root|body)[\s>](.+)$/.exec(s)) {
        s = m[1];
        out.push(s);
      }
    }
    return out;
  }

  /**
   * The function that gives the look of a `var()` in repair mode (see `look`), with its own memory of what the root holds.
   * @param {{ rootValue?: (name: string) => string, relativeColor?: boolean, colorOf: (text: string, role: string) => string | null, themeText?: (text: string, role: string) => string }} env
   * @returns {(whole: string, first: string, role: string) => string}
   */
  function varLook(env) {
    /** The themed look of custom properties by name and role: the relative color, or '' when the variable is left alone. @type {Map<string, string>} */
    const repairCache = new Map();
    /** The first read of a variable on the root can make the browser restyle the page, so reads are limited in time: 20 ms in each window of 250 ms. */
    let rootReadMs = 0;
    let rootWindowAt = 0;
    const ROOT_READ_BUDGET_MS = 20;
    const ROOT_READ_WINDOW_MS = 250;
    /** @type {boolean | null} */
    let relativeOk = null;
    /** Whether the browser reads relative colors (Chrome 119 and later); the manifest allows older ones. */
    function canRelative() {
      if (relativeOk === null) {
        relativeOk =
          typeof env.relativeColor === 'boolean'
            ? env.relativeColor
            : typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('color', 'oklch(from red calc(l + 0) c h)');
      }
      return relativeOk;
    }

    /**
     * Repair mode: `var(--x)` read for a background or a text color where `--x` is a plain color on the root that the page's dark theme left
     * light. The page's dark theme sets its own variables itself, so a variable that is dark on the root is not touched. For the others the
     * lightness is moved at the place of use, with the value the element really inherits: a light value goes to the theme's lightness, a
     * dark one stays as it is, so a dark value that the page gives to a deeper scope is kept. Chroma is limited when the lightness moves.
     * @param {string} whole the `var()` call @param {string} first its variable name @param {string} role @returns {string}
     */
    function look(whole, first, role) {
      if (!env.rootValue || (role !== 'background' && role !== 'foreground' && role !== 'border')) return whole;
      const key = `${role}${first}`;
      let found = repairCache.get(key);
      if (found === undefined) {
        found = '';
        const color = dk.color;
        // Past the budget the variable is left alone for now and asked again later; nothing is remembered for it.
        const began = performance.now();
        if (began - rootWindowAt >= ROOT_READ_WINDOW_MS) {
          rootWindowAt = began;
          rootReadMs = 0;
        }
        if (rootReadMs >= ROOT_READ_BUDGET_MS) return whole;
        const value = env.rootValue(first);
        rootReadMs += performance.now() - began;
        if (typeof value !== 'string') return whole;
        // A color that the page's own dark theme puts in its palette is the page's decision (its accent, its ink on the accent, its lines).
        const mine = color ? color.parseColor(value) : null;
        if (mine && current?.(mine, role)) {
          repairCache.set(key, '');
          return whole;
        }
        if (role === 'background' && env.themeText && value.length < 400 && value.includes('gradient(')) {
          // A gradient cannot be moved in place; the themed gradient stands for the call.
          const themed = env.themeText(value, role);
          if (themed !== value) found = themed;
        } else if (color && canRelative() && value !== '' && value.length < 80 && !value.includes('var(')) {
          const plain = color.parseColor(value);
          const themed = plain ? env.colorOf(value, role) : null;
          const target = themed ? color.parseColor(themed) : null;
          if (plain && target && themed !== value) {
            const L = color.toOklch(target)[0].toFixed(3);
            // `step` is 1 for a value on the light side of the limit (35 percent for a background, 60 for a text) and 0 on the other side.
            found = role !== 'foreground'
              ? `oklch(from ## calc(l - clamp(0, (l - 0.35) * 1000, 1) * (l - ${L})) calc(c - clamp(0, (l - 0.35) * 1000, 1) * max(0, c - 0.05)) h)`
              : `oklch(from ## calc(l + clamp(0, (0.6 - l) * 1000, 1) * (${L} - l)) c h)`;
          }
        }
        repairCache.set(key, found);
      }
      return found === '' ? whole : found.replace('##', whole);
    }
    return look;
  }
  /**
   * @typedef {{ options: Record<string, any>, check: Record<string, any>, info: { state: string, startedAt: number, ms: number, pieces: number, chars: number }, cover: Map<string, Set<string>>,
   *   copies: Map<Node, HTMLStyleElement[]>, isSitePiece: (el: Element) => boolean, scheme: boolean, minContrast: number, holdMs: number,
   *   show: () => void, adoptedCopies: () => CSSStyleSheet[], giveUp: (reason: string) => void, keep: () => void, stopInline: () => void, setReason: (reason: string) => void,
   *   rewriteAdopted: () => void, setRepairing: (on: boolean) => void, repairing: () => boolean, rw: { setRepair: (on: boolean) => void },
   *   rereadAll: (nodes: Node[]) => boolean, holding: () => boolean, dead: () => boolean, release: (reason: string) => void, isStyleRule: (r: CSSRule) => boolean, isGroup: (r: CSSRule) => boolean, normalize: (selector: string) => string }} Context
   */

  // The palette of the page's own dark theme: the colors its dark rules write, by the group of the place that uses them (b background,
  // c text, fill and stroke, d border and outline). A custom property of a dark rule counts for every group, with the value it has
  // on the root, so a variable that points at it (`--accent: var(--brand)`) is covered too.
  const GROUP = /** @type {Record<string, string>} */ ({ background: 'b', foreground: 'c', border: 'd', edge: 'd' });
  const FAMILY_GROUP = /** @type {Record<string, string>} */ ({ b: 'b', c: 'c', f: 'c', d: 'd', o: 'd' });
  const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^()]*\)/gi;
  /** The test of the repair that runs now: is a color part of the page's own dark theme? @type {((c: any, role: string) => boolean) | null} */
  let current = null;
  const MAX_VARS = 600;
  const MAX_PALETTE = 5000;
  /** @param {{ r: number, g: number, b: number, a: number }} c */
  const paletteKey = (c) => `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${Math.round(c.a * 100)}`;

  /** @param {Context} ctx */
  function create(ctx) {
    const { check, info, cover, copies } = ctx;
    /** @type {Set<string>} */
    const palette = new Set();
    /** Custom properties the dark rules set, and the ones whose root value is already in the palette. @type {Set<string>} */
    const darkVars = new Set();
    /** @type {Set<string>} */
    const settled = new Set();

    /** @param {string} groups @param {string} text */
    function addColors(groups, text) {
      if (palette.size >= MAX_PALETTE || text === '' || text.length > 600) return;
      const color = /** @type {any} */ (dk.color);
      const whole = color.parseColor(text);
      if (whole) {
        for (const g of groups) palette.add(`${g}|${paletteKey(whole)}`);
        return;
      }
      for (const m of text.matchAll(COLOR_TOKEN)) {
        const c = color.parseColor(m[0]);
        if (c) for (const g of groups) palette.add(`${g}|${paletteKey(c)}`);
      }
    }

    /** The values the root gives the custom properties of the dark rules: they are the page's palette, and so are the variables that read them. */
    function settleVars() {
      if (darkVars.size === settled.size) return;
      const rootStyle = getComputedStyle(document.documentElement);
      for (const name of darkVars) {
        if (settled.has(name) || settled.size >= MAX_VARS) continue;
        settled.add(name);
        addColors('bcd', rootStyle.getPropertyValue(name).trim());
      }
    }

    /** The page's body paints the canvas: the root keeps no color of ours, so the canvas follows the body. */
    function leaveCanvas() {
      const base = document.querySelector('style[data-dk="base"]');
      if (base?.textContent) base.textContent = base.textContent.replace(/background-color:[^;]*;/, '');
    }

    /**
     * Is this color part of the page's own dark theme for this role? Repair mode leaves such a color as it is: the page chose it
     * (its accent, the ink on its accent, its lines), and a color moved by our curves would break the pair.
     * @param {{ r: number, g: number, b: number, a: number }} c @param {string} role
     */
    function ownColor(c, role) {
      const g = GROUP[role];
      return g !== undefined && palette.has(`${g}|${paletteKey(c)}`);
    }

    /** @param {CSSRuleList} rules @param {number} depth */
    function collectCover(rules, depth) {
      if (depth > 8) return;
      for (let i = 0, n = rules.length; i < n; i++) {
        const rule = rules[i];
        if (ctx.isStyleRule(rule)) {
          const style = /** @type {CSSStyleRule} */ (rule).style;
          /** @type {Set<string>} */
          const families = new Set();
          for (let k = 0; k < style.length; k++) {
            const name = style[k];
            if (name.startsWith('--')) {
              if (darkVars.size < MAX_VARS) darkVars.add(name);
              addColors('bcd', style.getPropertyValue(name));
              continue;
            }
            const f = family(name);
            if (f) {
              families.add(f);
              if (f !== 'h') addColors(FAMILY_GROUP[f] ?? '', style.getPropertyValue(name));
            }
          }
          if (!families.size) continue;
          for (const key of coverKeys(/** @type {CSSStyleRule} */ (rule).selectorText)) {
            const have = cover.get(key);
            if (have) for (const f of families) have.add(f);
            else if (cover.size < MAX_COVER) cover.set(key, new Set(families));
          }
        } else if (ctx.isGroup(rule)) collectCover(/** @type {any} */ (rule).cssRules, depth + 1);
      }
    }

    /** @param {HTMLStyleElement | undefined} piece a copy of the page's dark rules */
    function addCover(piece) {
      try {
        const rules = piece?.sheet?.cssRules;
        if (rules) collectCover(rules, 0);
        settleVars();
      } catch {
        // A sheet that cannot be read covers nothing.
      }
    }

    /**
     * The groups of properties that the page's dark rules already set for every selector of this rule, or null. A light rule of
     * the page for these is not repaired: the dark rule beats it in the page's own dark theme.
     * @param {string} selector @returns {Set<string> | null}
     */
    function coverFor(selector) {
      if (!ctx.repairing() || cover.size === 0) return null;
      /** @type {Set<string> | null} */
      let common = null;
      for (const one of site.splitList(selector)) {
        const have = cover.get(ctx.normalize(one));
        if (!have) return null;
        if (common === null) common = new Set(have);
        else for (const f of common) if (!have.has(f)) common.delete(f);
      }
      return common !== null && common.size ? common : null;
    }

    /** @param {Node[]} nodes the sheets that were read for the page's dark theme */
    function startRepair(nodes) {
      ctx.setRepairing(true);
      info.state = 'pending';
      info.startedAt = performance.now();
      ctx.rw.setRepair(true);
      current = ownColor;
      palette.clear();
      darkVars.clear();
      settled.clear();
      cover.clear();
      for (const pieces of copies.values()) for (const piece of pieces) if (ctx.isSitePiece(piece)) addCover(piece);
      // The inline colors, the markup colors, the shadow roots and the constructed sheets are read again, and so are the sheets.
      if (!ctx.rereadAll(nodes)) finishRepair();
      // A long repair does not hold the page back for more than this: the parts still to repair are mostly below the window.
      if (ctx.holding()) setTimeout(() => ctx.holding() && !ctx.dead() && info.state === 'pending' && ctx.release('repair'), ctx.holdMs);
    }

    /** What the popup is told: the page's theme is used, with or without repairs (a repair that moved no color is none). @type {boolean | null} */
    let told = null;
    /** @param {boolean} repaired */
    function tell(repaired) {
      if (told === repaired) return;
      told = repaired;
      try {
        ctx.options.onSiteTheme?.(repaired);
      } catch {
        // The status is only a notice.
      }
    }

    // A rule for a state that the page is not in now (hover, focus, ...) shows nothing yet; pseudo-elements and link states are cut off before the match.
    const LATER_STATE = /:(?:hover|focus|focus-visible|focus-within|active|target|target-within|fullscreen|modal|popover-open)(?![-\w])/i;
    const BARE_PSEUDO = /:(?:visited|link|any-link|before|after|first-line|first-letter)(?![-\w])|::[a-z-]+(?:\([^)]*\))?/gi;
    const MAX_PROBE_RULES = 600;

    const VAR_FALLBACK = /^var\((--[a-z0-9_-]+),/i;

    /**
     * Does a declaration of the repair change what an element shows? A `var()` whose variable is set there only has its fallback moved, which is not used.
     * @param {CSSStyleDeclaration} style @param {Element} el
     */
    function changesPage(style, el) {
      for (let k = 0; k < style.length; k++) {
        const m = VAR_FALLBACK.exec(style.getPropertyValue(style[k]));
        if (!m || getComputedStyle(el).getPropertyValue(m[1]).trim() === '') return true;
      }
      return false;
    }

    /**
     * Does a rule that the repair wrote reach an element of the page now? A class that nothing uses, or a rule for a focus state,
     * changes nothing the person sees.
     * @param {CSSRuleList} rules @param {{ n: number }} budget @returns {boolean}
     */
    function reachesPage(rules, budget) {
      for (let i = 0, n = rules.length; i < n; i++) {
        const rule = rules[i];
        if (budget.n >= MAX_PROBE_RULES) return true;
        if (ctx.isStyleRule(rule)) {
          budget.n += 1;
          for (const one of site.splitList(/** @type {CSSStyleRule} */ (rule).selectorText)) {
            if (LATER_STATE.test(one)) continue;
            const bare = one.replace(BARE_PSEUDO, '').trim();
            if (bare === '' || /[>+~(,]$/.test(bare)) return true;
            try {
              const el = document.querySelector(bare);
              if (el && changesPage(/** @type {CSSStyleRule} */ (rule).style, el)) return true;
            } catch {
              return true;
            }
          }
        } else if (ctx.isGroup(rule) && reachesPage(/** @type {any} */ (rule).cssRules, budget)) return true;
      }
      return false;
    }

    /** Is the page changed by the repair, as the person sees it? Inline colors count; sheet rules count when they reach an element. */
    function repairedOnScreen() {
      if (document.querySelector('style[data-dk="inline"]:not(:empty), style[data-dk="attrs"]:not(:empty)')) return true;
      const budget = { n: 0 };
      for (const pieces of copies.values()) {
        for (const piece of pieces) {
          // A piece inside a shadow root is not counted.
          if (ctx.isSitePiece(piece) || piece.getRootNode() !== document) continue;
          try {
            const rules = piece.sheet?.cssRules;
            if (rules && reachesPage(rules, budget)) return true;
          } catch {
            return true;
          }
        }
      }
      return false;
    }

    /** The notice is about what is on the screen: a repair counts when it moved a color that shows. */
    function tellRepairs() {
      if (!ctx.dead()) tell(repairedOnScreen());
    }

    function finishRepair() {
      if (info.state !== 'pending') return;
      info.state = 'done';
      tellRepairs();
      // The inline colors and the shadow roots finish a little later.
      setTimeout(tellRepairs, 1500);
      info.ms = performance.now() - info.startedAt;
      info.pieces = 0;
      info.chars = 0;
      for (const pieces of copies.values()) {
        for (const piece of pieces) {
          if (ctx.isSitePiece(piece)) continue;
          info.pieces += 1;
          info.chars += piece.textContent ? piece.textContent.length : 0;
        }
      }
    }

    /**
     * The page's dark theme is good: keep it and drop the full themed copies. What the theme does not cover is repaired: every
     * sheet, inline style and constructed sheet is read again with the rewriter in repair mode, which leaves a color that is already
     * right for a dark page as the page wrote it and writes only the wrong ones (section 2.22 of theme-engines.md).
     */
    function commit() {
      ctx.setReason('ok');
      const nodes = [...copies.keys()];
      ctx.keep();
      ctx.stopInline();
      ctx.rewriteAdopted();
      const repair = ctx.options.repair !== false;
      if (check.canvasFromBody === true) leaveCanvas();
      tell(repair && check.repairNeeded === true);
      if (repair) startRepair(nodes);
    }

    /**
     * Show the page with its own dark rules and nothing of ours but the scheme hint, and ask the probe whether it is dark with
     * readable text. All of it runs in one task, so no frame shows an in-between look.
     * @param {{ scheme: number, lightDark: number }} found
     */
    function trySite(found) {
      ctx.show();
      /** The themed copies of constructed sheets are off for the length of the check. */
      const adoptedCopies = ctx.adoptedCopies();
      for (const copy of adoptedCopies) copy.disabled = true;
      /** @type {any} */
      let verdict = null;
      let why = '';
      try {
        const plainWhen = found.scheme + found.lightDark === 0 ? (/** @type {any} */ v) => v.ok === true : undefined;
        verdict = assess({ keep: (/** @type {Element} */ el) => ctx.isSitePiece(el), scheme: ctx.scheme, minContrast: ctx.minContrast, plainWhen });
        check.contrast = verdict.contrast;
        check.background = verdict.background;
        check.text = verdict.text;
        check.repairNeeded = verdict.repair === true;
        check.canvasFromBody = verdict.canvasFromBody === true;
        check.lightSections = verdict.lightSections ?? 0;
        if (!verdict.ok) why = 'gate';
        else if (found.scheme + found.lightDark === 0) {
          // Without the page's rules the same check must give other colors, or fail.
          const plain = verdict.plain;
          check.contributed = !plain.ok || Math.abs(plain.background - verdict.background) > 0.02 || Math.abs(plain.text - verdict.text) > 0.05;
          if (!check.contributed) why = 'no-change';
        }
      } catch {
        why = 'error';
      }
      for (const copy of adoptedCopies) copy.disabled = false;
      if (why === '') commit();
      else ctx.giveUp(why);
    }

    return { trySite, coverFor, addCover, finishRepair };
  }

  dk.sitetheme = Object.freeze({ assess, family, coverKeys, varLook, create, own: (/** @type {any} */ c, /** @type {string} */ role) => current !== null && current(c, role), useOwn: (/** @type {typeof current} */ fn) => void (current = fn), stats: () => ({ assessments }) });
})();
