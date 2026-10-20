// @ts-check
// The Dynamic engine: writes an override copy of each stylesheet with only the color-bearing
// declarations, rewritten for the theme, right after the original. The original is never changed.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;
  const color = /** @type {any} */ (dk.color);
  const rewrite = /** @type {any} */ (dk.rewrite);
  const slicer = /** @type {any} */ (dk.slicer);
  const sheetText = /** @type {any} */ (dk.sheettext);
  const shadowApi = /** @type {any} */ (dk.shadow);
  const siteApi = /** @type {any} */ (dk.sitedark);
  const matchApi = /** @type {any} */ (dk.match);
  if (!color || !rewrite || !slicer) return;

  const STATE = 'data-dk-state';
  const INLINE_ID = 'data-dk-i';
  // The layer of presentation hints (bgcolor, SVG fill). Our attribute and inline style elements are the first in their
  // tree, so this layer is declared first and every layer of the page beats it.
  const HINT_LAYER = 'dk-hint';
  // Inline styles share one rule for each distinct declaration text, so this counts distinct values, not elements.
  const MAX_INLINE = 5000;
  const MAX_INLINE_ELEMENTS = 150000;
  // Limits for one hostile or huge sheet. A sheet that goes over one is left as the page wrote it.
  const MAX_RULES = 60000;
  const MAX_DEPTH = 32;
  const MAX_IMPORT_DEPTH = 6;
  const MAX_IMPORTS = 40;
  // A sheet whose imported files have not arrived is looked at again every 250 ms, up to 20 times.
  const IMPORT_RETRIES = 20;
  const IMPORT_RETRY_MS = 250;
  const INLINE_RATE = 2000;
  const DRAIN_SLICE_MS = 8;
  const INLINE_NOW = 200;
  // After a burst of attribute changes the observer pauses this long, then looks at every element once and goes on.
  // A page that keeps bursting is paused for longer each time, up to the limit.
  const INLINE_PAUSE_MS = 1500;
  const INLINE_PAUSE_MAX_MS = 12000;
  const ADD_BUDGET = 5000;
  const FAULTS_BEFORE_STOP = 3;
  // The quick dark version ends here when nothing is left to wait for but the engine is not settled; a page that is
  // being themed or waits for the network keeps it up to the second limit.
  const HOLD_MAX_MS = 8000;
  const HOLD_LONG_MAX_MS = 60000;
  const FREEZE_MAX_MS = 2000;
  // Slice limits while the page is held back or not yet ready; a slice stays near the 50 ms mark of a long task.
  const HOLD_SOFT_MS = 45;
  const HOLD_HARD_MS = 90;
  const SHEET_SELECTOR = 'style, link[rel~="stylesheet" i]';
  // Sheets that only hold @font-face rules: they have no color to theme, so they are not read or fetched.
  const FONT_ONLY_URLS = ['//fonts.googleapis.com/', '//fonts.bunny.net/', '//use.typekit.net/', '//p.typekit.net/', '//api.fontshare.com/'];
  // Places where text is typed. Inline colors there belong to the person's document, so they get no marker.
  const EDITABLE =
    '[contenteditable]:not([contenteditable="false" i]), .ProseMirror, .ql-editor, .tiptap, .ck-editor__editable, .DraftEditor-root, .public-DraftEditor-content, .trix-content, .note-editable, .fr-element, .mce-content-body, [role="textbox"][aria-multiline="true"]';
  // Property names the engine themes contain one of these words. A style attribute without any is skipped.
  const COLOR_WORDS = /color|background|border|outline|fill|stroke|shadow|filter|--|caret|accent|column-rule|text-decoration|text-emphasis/i;
  const INLINE_PLAIN_MAX = 4000;
  const INLINE_MEMO_CHARS = 1024;
  const INLINE_MEMO_MAX = 2000;
  const CODE_COLORS = new Set(['none', 'black', 'white', '#000', '#000000', '#fff', '#ffffff', 'rgb(0,0,0)', 'rgb(255,255,255)']);
  // Rules that style form controls. Their borders mark where a control is, so they keep a contrast floor (WCAG 1.4.11).
  const CONTROL_SELECTOR = /(?:^|[\s,>+~(:])(?:input|select|textarea|button)\b|\[type=|\[role=["']?(?:textbox|button|combobox|searchbox|checkbox|radio|switch)|\.(?:btn|form-control|form-select|input)\b/i;
  const CHUNK_CHARS = 120000;
  // The text path writes smaller pieces: inserting one costs the browser about as much as writing it, and a piece is one slice.
  const TEXT_CHUNK_CHARS = 40000;
  const TEXT_LINK_MIN = 100;
  const TEXT_MAX_CHARS = 6000000;
  const MOTION_MAX_CHARS = 30000;
  // The rules of a site's own dark theme that are copied: more than this and the sheet is not trusted to switch.
  const SITE_MAX_CHARS = 600000;
  const REPAIR_HOLD_MS = 200;
  const SITE_HINT = /dark/i;
  const SCHEME_ONLY = /color-scheme\s*:[^;}]*\bonly\b/i;
  // The page's text must read on its background at this ratio (WCAG 1.4.3) for the site's own dark theme to be kept.
  const SITE_MIN_CONTRAST = 4.5;
  /** How long the quick dark version stays up for the engine that takes over from an engine that cannot read a sheet. */
  const UNREACHABLE_WAIT_MS = 3000;
  /** A page whose background is lighter than this (relative luminance) is light when a sheet cannot be read. */
  const UNREACHABLE_LIGHT_BACKGROUND = 0.4;
  /** Reasons of the worker for a refusal that may not come again; any other reason is final. */
  const TRANSIENT_REASONS = new Set(['timeout', 'network', 'unused', 'rate', 'error']);
  // A sheet that is rewritten again and again settles for this long before it is built again; the old copy stays meanwhile.
  const CHURN_WINDOW_MS = 1000;
  const CHURN_EDITS = 4;
  const CHURN_SETTLE_MS = 250;

  /** A tester for sheet addresses, see `addressTester` in core/match.js. @param {string[]} patterns @returns {(href: string) => boolean} */
  const addressTester = (patterns) => (matchApi ? matchApi.addressTester(patterns) : () => false);

  const IMAGE_NOTES_MAX = 3000;
  /** @type {Set<string>} */
  const backlogSelectors = new Set();
  /** @type {Set<Element>} */
  const backlogElements = new Set();

  /** Followers of the shadow roots: `add(root)`, `drop(roots)`. @type {Set<{ add: (root: ShadowRoot) => void, drop: (roots: ShadowRoot[]) => void }>} */
  const rootListeners = new Set();

  /** Pictures noted by sheets; 0: none paints one. */
  let pictureNotes = 0;
  // Selectors of rules that paint a background picture (not a mask, which takes its color from the theme), for the picture filter of
  // the color vision layer (cvd.js).
  /** @type {Set<string>} */
  const pictureRules = new Set();

  /** @param {string} selector */
  function notePicture(selector) {
    if (selector === '' || selector[0] === '?' || pictureRules.has(selector) || pictureRules.size >= IMAGE_NOTES_MAX) return;
    pictureRules.add(selector);
    /** @type {any} */ (globalThis).__dk?.cvd?.notePicture?.(selector);
  }

  /** @param {'background' | 'legacy'} kind @param {string | Element} value */
  function tellImages(kind, value) {
    pictureNotes += 1;
    const dk = /** @type {any} */ (globalThis).__dk;
    const images = dk?.imagebg;
    if (images) {
      const call = kind === 'legacy' ? images.noteLegacy : images.noteBackground;
      if (typeof call === 'function') call(value);
      return;
    }
    if (kind === 'legacy') {
      if (backlogElements.size < IMAGE_NOTES_MAX) backlogElements.add(/** @type {Element} */ (value));
    } else if (backlogSelectors.size < IMAGE_NOTES_MAX) backlogSelectors.add(/** @type {string} */ (value));
    // The module for CSS pictures is loaded when the first picture is noted (it replays what was kept).
    dk?.optional?.wantBackgrounds?.();
  }

  function replayImageNotes() {
    const images = /** @type {any} */ (globalThis).__dk?.imagebg;
    if (!images) return;
    for (const selector of backlogSelectors) if (typeof images.noteBackground === 'function') images.noteBackground(selector);
    for (const el of backlogElements) if (el.isConnected && typeof images.noteLegacy === 'function') images.noteLegacy(el);
    backlogSelectors.clear();
    backlogElements.clear();
  }

  /** What the page keeps for itself, read from the real cascade with the engines' elements off (`scheme.read`). @returns {'light' | 'dark' | null} */
  const pageSchemeOnly = () => /** @type {any} */ (globalThis).__dk?.scheme?.read() ?? null;

  // Text of the linked sheets that were read, kept while the page is themed, so a settings change asks neither the worker
  // nor the cache again. Size-limited, entries expire, emptied when the engine stops.
  /** The roles each custom property was read for, kept from one engine to the next. @type {Map<string, number>} */
  const demandSeed = new Map();
  const DEMAND_SEED_MAX = 30000;

  const TEXT_STORE_MAX_CHARS = 8000000;
  const TEXT_STORE_TTL_MS = 120000;
  /** @type {Map<string, { text: string, url: string, at: number }>} */
  const textStore = new Map();
  let textStoreChars = 0;

  /** @param {string} href */
  function storedText(href) {
    const entry = textStore.get(href);
    if (!entry) return null;
    if (Date.now() - entry.at > TEXT_STORE_TTL_MS) {
      textStoreChars -= entry.text.length;
      textStore.delete(href);
      return null;
    }
    return entry;
  }

  /** @param {string} href @param {string} text @param {string} url */
  function storeText(href, text, url) {
    if (text.length > TEXT_STORE_MAX_CHARS / 4) return;
    const old = textStore.get(href);
    if (old) textStoreChars -= old.text.length;
    textStore.delete(href);
    textStore.set(href, { text, url, at: Date.now() });
    textStoreChars += text.length;
    if (storeTimer !== null) clearTimeout(storeTimer);
    storeTimer = setTimeout(clearTextStore, TEXT_STORE_TTL_MS + 5000);
    for (const key of textStore.keys()) {
      if (textStoreChars <= TEXT_STORE_MAX_CHARS) break;
      textStoreChars -= textStore.get(key)?.text.length ?? 0;
      textStore.delete(key);
    }
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let storeTimer = null;
  function clearTextStore() {
    textStore.clear();
    textStoreChars = 0;
    if (storeTimer !== null) clearTimeout(storeTimer);
    storeTimer = null;
  }

  /** @typedef {{ end: () => void, stats: () => any, inlineAttr: string, look: string, suspend: () => () => void, roots: () => ShadowRoot[] }} Engine */
  /** The engine that themes the page now. @type {Engine | null} */
  let active = null;
  /** A new engine that builds its copies out of sight and takes over when it is done. @type {Engine | null} */
  let staging = null;
  /** Override sheets of every engine, so one engine never themes another's. */
  const ours = new WeakSet();
  /** The sheet an alternate link showed when first seen; it applies only after script gave the link a new sheet. @type {WeakMap<HTMLLinkElement, { sheet: CSSStyleSheet, href: string }>} */
  const alternates = new WeakMap();

  /** Does the browser not apply the sheet of this node (disabled, unselected alternate)? No sheet yet: not known to be off. @param {HTMLStyleElement | HTMLLinkElement} node */
  function switchedOff(node) {
    const sheet = node.sheet;
    if (node instanceof HTMLLinkElement) {
      if (node.disabled) return true;
      if (sheet && node.relList.contains('alternate')) {
        const seen = alternates.get(node);
        if (!seen || seen.href !== node.href) {
          alternates.set(node, { sheet, href: node.href });
          return true;
        }
        if (seen.sheet === sheet) return true;
      }
    }
    return !!sheet && sheet.disabled;
  }

  /** @param {Node | null | undefined} n */
  const isSheetNode = (n) =>
    (n instanceof HTMLStyleElement || (n instanceof HTMLLinkElement && /(^|\s)stylesheet(\s|$)/i.test(n.rel))) &&
    !n.hasAttribute('data-dk');

  /** The color caches of engines that ended, by theme settings. @type {Map<string, ReturnType<typeof color.createTransformer>>} */
  const spareTransformers = new Map();

  /**
   * @param {Record<string, any>} themeSettings  the `theme` object of the settings
   * @param {{ slicer?: object, onFault?: (error: unknown) => void, early?: boolean, hold?: boolean, startedAt?: number,
   *   stage?: boolean, inlineAttr?: string, beforeCommit?: () => void, onCommit?: () => void, ignoreInline?: string[], ignoreCssUrl?: string[], onRelease?: (reason: string) => void,
   *   textPath?: boolean, siteDark?: boolean, repair?: boolean, coalesce?: boolean, motion?: boolean, atCommit?: () => void, onPageScheme?: (kind: string) => boolean, onSiteTheme?: (repaired: boolean) => void, onSiteWait?: (waiting: boolean) => void, onSiteModule?: (state: string) => void, onUnreachable?: () => void, onReady?: () => void }} options  `onUnreachable`: an unreadable sheet applies and the page stays light; `onPageScheme`: a sheet keeps one scheme, true leaves the page alone; `onSiteTheme`: the page's own dark theme is kept (repaired or not); `onSiteWait`: the engine waits (or stopped waiting) for the module that judges that theme; `onSiteModule`: that module did not come; `motion`: write the page's reduced-motion rules; `textPath`/`siteDark`/`repair`/`coalesce`: false turns that part off
   */
  function createEngine(themeSettings, options) {
    const theme = color.createTheme(themeSettings);
    // A return to a look finds its colors made: the cache of an engine that ended waits for the same settings.
    const themeKey = JSON.stringify(themeSettings ?? {});
    const transformer = spareTransformers.get(themeKey) ?? color.createTransformer(theme);
    spareTransformers.delete(themeKey);
    transformer.setRepair(false);
    // In the E-ink and Paper mode a gradient is one solid color, or nothing when it fades.
    const rw = rewrite.createRewriter(transformer, { resolve: resolveRelative, rootValue: (/** @type {string} */ name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), flatGradients: !!theme.eink, onUse: (/** @type {string} */ name, /** @type {number} */ bits) => want(name, bits) });

    /* ---------------- derived variables, by demand ---------------- */

    // A color token gets a themed variant for each role a `var()` reads it for. Variants nobody reads cost restyle time,
    // so a copy holds a marker where they go, filled by demand and again when a later `var()` reads a new role.
    const MARK_OPEN = `/*~${Math.random().toString(36).slice(2, 10)}:`;
    /** The roles in demand, by variable name: the bits of `ROLE_BITS` in `rewrite.js`. */
    const demand = new Map(demandSeed);
    /** `have`: the roles (bits of `ROLE_BITS`) made so far; the others are made when a `var()` reads them. @type {{ name: string, value: string, base: string, priority: string, have: number, channels: string[], values: string[], uses: Array<Array<string | number> | null> }[]} */
    const variants = [];
    /** @type {Map<string, number>} */
    const variantIndex = new Map();
    /** @type {Map<string, number[]>} */
    const variantsByName = new Map();
    /**
     * The pieces that hold markers: for each marker the variant it stands for, where its text starts in the piece and how long it is
     * now, and the variable names in the piece. The text itself is read back from the piece when a marker is filled again, so no
     * second copy of it stays in memory.
     * @type {Map<HTMLStyleElement, { idx: Int32Array, pos: Int32Array, len: Int32Array, size: number, names: Set<string> }>}
     */
    const templated = new Map();
    const MEDIA_OPEN = '@media screen{';
    /** The size at which disconnected entries of `templated` are looked for. */
    let templatedPrune = 32;
    /** Names whose demand grew since the pieces were last filled. @type {Set<string>} */
    const grown = new Set();
    let fillQueued = false;
    /** True while the code of a copy runs; the other builders write all the variants. */
    let deferNow = false;
    const demandStats = { variants: 0, fills: 0, fillMs: 0 };

    /** A `var()` reads a derived variable of `name` for these roles. @param {string} name @param {number} bits */
    function want(name, bits) {
      const have = demand.get(name) ?? 0;
      const add = bits & ~have;
      if (add === 0) return;
      demand.set(name, have | add);
      if (demandSeed.size >= DEMAND_SEED_MAX) demandSeed.clear();
      demandSeed.set(name, have | add);
      grown.add(name);
      const list = variantsByName.get(name);
      if (list) for (const at of list) followUses(variants[at], add);
      // The pieces are filled before the next frame whenever the page can be seen: after the first pass, and before it when the
      // quick version does not cover the page.
      if ((stats.readyAt !== null || early === null || options.hold === false) && !fillQueued) {
        fillQueued = true;
        queueMicrotask(() => {
          fillQueued = false;
          fillMarkers();
        });
      }
    }

    /** Make the roles of a variant that are asked for and not made yet. @param {(typeof variants)[number]} v @param {number} bits */
    function ensure(v, bits) {
      const missing = bits & ~v.have;
      if (missing === 0) return;
      v.have |= missing;
      const more = rw.customVariants(v.name, v.value, v.base, v.priority, missing);
      if (more === null) return;
      for (let at = 0; at < 4; at++) {
        if ((missing & (1 << at)) === 0) continue;
        v.channels[at] = more.channels[at];
        v.values[at] = more.values[at];
        v.uses[at] = more.uses[at];
      }
    }

    /** The variables these variants read are in demand for the same roles. @param {(typeof variants)[number]} v @param {number} bits */
    function followUses(v, bits) {
      ensure(v, bits);
      for (let at = 0; at < 4; at++) {
        const list = v.uses[at];
        if (list === null || (bits & (1 << at)) === 0) continue;
        for (let k = 0; k < list.length; k += 2) want(/** @type {string} */ (list[k]), /** @type {number} */ (list[k + 1]));
      }
    }

    /**
     * A custom property of a copy: a marker, to be filled with the variants in demand. Empty when the value holds no color.
     * @param {string} name @param {string} value @param {string} base @param {string} priority
     */
    function custom(name, value, base, priority) {
      if (value.indexOf('url(') >= 0) noteBackground('?');
      if (repairing) return '';
      if (!deferNow) {
        const text = rw.customProperty(name, value, base, priority);
        if (text !== '' || !demand.get(name)) return text;
        const free = rw.customVariants(name, value, base, priority);
        return free && free.free ? variantText({ name, value, base, priority, have: 15, channels: free.channels, values: free.values, uses: [] }) : '';
      }
      const key =`${name}\u0001${priority}\u0001${value.indexOf('url(') >= 0 ? base : ''}\u0001${value}`;
      let at = variantIndex.get(key);
      if (at === undefined) {
        const bits = (demand.get(name) ?? 0) | 1;
        const v = rw.customVariants(name, value, base, priority, bits);
        if (v === null) return '';
        at = variants.push({ name, value, base, priority, have: v.free ? 15 : bits, channels: v.channels, values: v.values, uses: v.uses }) - 1;
        variantIndex.set(key, at);
        demandStats.variants += 1;
        let list = variantsByName.get(name);
        if (list === undefined) variantsByName.set(name, (list = []));
        list.push(at);
        const have = demand.get(name);
        if (have) followUses(variants[at], have);
      }
      return `${MARK_OPEN}${at}*/`;
    }

    /** @param {(typeof variants)[number]} v */
    function variantText(v) {
      const bits = demand.get(v.name) ?? 0;
      if (bits === 0) return '';
      ensure(v, bits);
      let out = '';
      for (let at = 0; at < 4; at++) if (bits & (1 << at)) out += v.channels[at];
      for (let at = 0; at < 4; at++) if (bits & (1 << at)) out += v.values[at];
      return out;
    }

    /**
     * The text of a copy with its markers filled, and the table of where each marker's variants went (offsets in the piece, which
     * starts with `MEDIA_OPEN`).
     * @param {string} tpl
     */
    function fill(tpl) {
      /** @type {number[]} */
      const idx = [];
      /** @type {number[]} */
      const pos = [];
      /** @type {number[]} */
      const len = [];
      const names = new Set();
      const parts = [];
      let size = MEDIA_OPEN.length;
      let from = 0;
      for (;;) {
        const at = tpl.indexOf(MARK_OPEN, from);
        if (at < 0) {
          parts.push(tpl.slice(from));
          size += tpl.length - from;
          break;
        }
        const close = tpl.indexOf('*/', at + MARK_OPEN.length);
        const n = close < 0 ? -1 : Number(tpl.slice(at + MARK_OPEN.length, close));
        const v = variants[n];
        if (v === undefined) {
          parts.push(tpl.slice(from, at + MARK_OPEN.length));
          size += at + MARK_OPEN.length - from;
          from = at + MARK_OPEN.length;
          continue;
        }
        names.add(v.name);
        const text = variantText(v);
        parts.push(tpl.slice(from, at), text);
        size += at - from;
        idx.push(n);
        pos.push(size);
        len.push(text.length);
        size += text.length;
        from = close + 2;
      }
      return { text: parts.join(''), rec: { idx: Int32Array.from(idx), pos: Int32Array.from(pos), len: Int32Array.from(len), size: size + 1, names } };
    }

    /** Fill again the pieces that hold a variable whose demand grew. */
    function fillMarkers() {
      if (dead || grown.size === 0) return;
      const names = new Set(grown);
      grown.clear();
      const began = performance.now();
      for (const [piece, rec] of templated) {
        if (!piece.isConnected) {
          templated.delete(piece);
          continue;
        }
        let touched = false;
        for (const n of names) {
          if (rec.names.has(n)) {
            touched = true;
            break;
          }
        }
        if (!touched) continue;
        const now = piece.textContent ?? '';
        if (now.length !== rec.size) {
          templated.delete(piece);
          continue;
        }
        const parts = [];
        let from = 0;
        let delta = 0;
        for (let k = 0; k < rec.idx.length; k++) {
          rec.pos[k] += delta;
          const v = variants[rec.idx[k]];
          if (!names.has(v.name)) continue;
          const fresh = variantText(v);
          if (fresh.length === rec.len[k]) continue;
          const start = rec.pos[k] - delta;
          parts.push(now.slice(from, start), fresh);
          from = start + rec.len[k];
          delta += fresh.length - rec.len[k];
          rec.len[k] = fresh.length;
        }
        if (parts.length === 0) continue;
        parts.push(now.slice(from));
        rec.size += delta;
        piece.textContent = parts.join('');
        demandStats.fills += 1;
      }
      demandStats.fillMs += performance.now() - began;
    }
    const sl = slicer.createSlicer(options.slicer);
    const doc = document;
    const root = doc.documentElement;
    const skipUrl = addressTester([...FONT_ONLY_URLS, ...(options.ignoreCssUrl ?? [])]);
    // The text reader writes a sheet's copy from its source text; the CSSOM walk is the fallback.
    // The person asked for reduced motion: the page's own reduced-motion rules apply.
    const motionRules = options.motion === true && !!siteApi && typeof siteApi.reducedMedia === 'function';
    const reader =
      sheetText && options.textPath !== false
        ? sheetText.createReader({ rw: Object.assign(Object.create(null), rw, { customProperty: custom }), isControl: (/** @type {string} */ selector) => CONTROL_SELECTOR.test(selector), maxRules: MAX_RULES, maxDepth: MAX_DEPTH, chunkChars: TEXT_CHUNK_CHARS, onBackground: noteBackground, motion: motionRules, cover: (/** @type {string} */ selector) => (repairing && siteMod ? siteMod.coverFor(selector) : null) })
        : null;
    /** Style elements the page changed through the CSSOM: their text is no longer the sheet. @type {WeakSet<Node>} */
    const edited = new WeakSet();
    /** Sheets the text reader gave up on, by what it saw (text length and rule count): the same text is not tried again. @type {WeakMap<Node, string>} */
    const refused = new WeakMap();
    /** The text of the rule for a style attribute, by the attribute. Pages write the same few values again and again. @type {Map<string, string>} */
    const inlineMemo = new Map();

    // The site's own dark theme. While `pending`, each sheet is read twice: the themed copy and the copy of the
    // page's dark rules; one is kept when the page is ready.
    // The page's own dark theme keeps the page's colors, which would miss the correction for color vision.
    const siteEnabled = !!siteApi && theme.dark && !theme.cvd && themeSettings.useSiteDark !== false && options.siteDark !== false;
    /** `pending` until decided; `on` shows the site's dark theme and the engine themes nothing else; `off` is the normal theme. */
    let siteState = siteEnabled ? 'pending' : 'off';
    let siteReason = siteEnabled ? '' : 'disabled';
    // The module that judges the page's own dark theme (sitetheme.js) is asked for at engine start; when a sheet shows
    // a dark theme the engine does not decide or get ready before it is there.
    /** @type {any} */
    let siteMod = null;
    let siteLoading = false;
    let siteFailed = false;
    /** The engine waits for the module (the gate shows the wait in the status after a second). */
    let siteWaiting = false;
    /** @param {boolean} on */
    function tellSiteWait(on) {
      if (siteWaiting === on) return;
      siteWaiting = on;
      options.onSiteWait?.(on);
    }
    /** The module that judges the page's own dark theme; the dark-page check it uses is part of the always-loaded files. @returns {Promise<boolean>} */
    function needSiteTheme() {
      const need = /** @type {any} */ (globalThis).__dk?.need;
      return typeof need === 'function' && /** @type {any} */ (globalThis).__dk?.detect ? need('sitetheme') : Promise.resolve(false);
    }
    function loadSiteTheme() {
      if (siteMod || siteLoading || siteFailed) return;
      siteLoading = true;
      void needSiteTheme().then((ok) => {
        siteLoading = false;
        if (dead) return;
        if (ok && siteApi && /** @type {any} */ (globalThis).__dk?.sitetheme) siteMod = /** @type {any} */ (globalThis).__dk.sitetheme.create(siteContext);
        else {
          siteFailed = true;
          // The module may still come: the gate decides again then (the loader asks in the background).
          options.onSiteModule?.('missing');
        }
        tellSiteWait(false);
        maybeRelease();
        markReady();
      });
    }
    if (siteEnabled) loadSiteTheme();
    /** What each sheet holds of the site's dark theme. @type {Map<Node, any>} */
    const siteCounts = new Map();
    /** The copies of the page's dark rules, among the other pieces of the sheets. */
    const sitePieces = new WeakSet();
    /** @type {{ contrast: number | null, background: number | null, text: number | null, contributed: boolean | null, repairNeeded: boolean | null, lightSections: number | null }} */
    const siteCheck = { contrast: null, background: null, text: null, contributed: null, repairNeeded: null, lightSections: null };
    // A sheet with `color-scheme: only ...`: the page may keep one scheme. Its computed value is read once the sheet is
    // there (engine elements off) and again when the engine is done.
    let schemeFlag = false;
    let schemeChecks = 0;
    /** @returns {boolean} true when the page is left alone because of what it declares */
    function checkScheme() {
      if (!schemeFlag || dead || schemeChecks >= 2) return false;
      schemeChecks += 1;
      const kind = pageSchemeOnly();
      if (kind === null) return false;
      schemeChecks = 2;
      return options.onPageScheme?.(kind) === true;
    }
    function flagScheme() {
      if (schemeFlag || dead || !options.onPageScheme) return;
      schemeFlag = true;
      checkScheme();
    }
    let inlineOff = false;
    /** How often each style element was rewritten in the last second, for the churn rule. @type {WeakMap<Node, number[]>} */
    const editTimes = new WeakMap();

    const stats = {
      sheets: 0,
      switchedOff: 0,
      /** Passes over the sheets that script may have switched on or off. */
      switchChecks: 0,
      pieces: 0,
      insertMs: 0,
      rules: 0,
      unreadable: 0,
      /** Links the browser applies and neither the CSSOM nor the worker could read, and what was done about them. */
      unreachable: 0,
      unreachableFallback: /** @type {string | null} */ (null),
      inline: 0,
      inlineCapped: false,
      inlineElements: 0,
      /** Style attributes that name nothing the engine themes (not parsed), and attributes answered from the memory of earlier ones. */
      inlinePlain: 0,
      /** Time spent reading the style attributes that the page wrote (the observer queue). */
      inlineMs: 0,
      inlineMemoHits: 0,
      inlineObserverOff: false,
      inlinePauses: 0,
      roots: 0,
      adoptedSheets: 0,
      longestAddMs: 0,
      rootsReleased: 0,
      adoptedBuilds: 0,
      adoptedRules: 0,
      adoptFailed: 0,
      restored: 0,
      restoreGaveUp: 0,
      skippedUrls: 0,
      skippedEditable: 0,
      rescans: 0,
      processed: 0,
      fetched: 0,
      textSheets: 0,
      cssomSheets: 0,
      textFallbacks: 0,
      churnDeferred: 0,
      cacheMisses: 0,
      storeHits: 0,
      cacheError: '',
      /** @type {Record<string, number>} */
      textReasons: {},
      capped: 0,
      attrs: 0,
      gateMs: typeof options.startedAt === 'number' ? performance.now() - options.startedAt : null,
      holdMs: /** @type {number | null} */ (null),
      released: /** @type {string | null} */ (null),
      faults: 0,
      startedAt: performance.now(),
      readyAt: /** @type {number | null} */ (null),
    };
    let dead = false;
    // Repair of the page's own dark theme (section 2.22): declared early because the sheet readers and release() look at it.
    /** The groups of properties (`sitedark.family`) that the page's dark rules set, by the selector of a light rule for the same elements. @type {Map<string, Set<string>>} */
    const coverMap = new Map();
    let repairing = false;
    const repairInfo = { state: 'off', startedAt: 0, ms: 0, pieces: 0, chars: 0 };
    // A staged engine builds everything with `media="not all"` (not applied) and switches it on in one step.
    let staged = options.stage === true;
    const inlineAttr = options.inlineAttr ?? INLINE_ID;
    /** The media each piece gets when it is switched on. @type {Map<HTMLStyleElement, string>} */
    const pieceMedia = new Map();

    /**
     * The media a piece has now. A staged piece is off, and so is a piece of the mode that is not shown: the themed copy while
     * the site's own dark theme shows, the copy of the page's dark rules otherwise.
     * @param {HTMLStyleElement} piece
     */
    function wantedMedia(piece) {
      if (staged || (options.hold !== false && early !== null && !activated)) return 'not all';
      if (!repairing && sitePieces.has(piece) !== (siteState === 'on')) return 'not all';
      return pieceMedia.get(piece) ?? '';
    }

    /**
     * While the quick dark version covers the page nobody can see the pieces, and each live insertion would make the browser restyle
     * the page (130 restyles and 5 s for a page of 30 000 rules with the main thread 6 times slower). They are inserted inert
     * and switched on together, in the task that takes the quick version away or before the engine reads the page with them on.
     * Without the hold (the quick version is not painted) the page is visible while it is themed, so the pieces are live at once.
     */
    let activated = false;
    function activatePieces() {
      if (activated) return;
      activated = true;
      for (const piece of pieceMedia.keys()) if (piece.isConnected) setMedia(piece);
    }

    /** @param {HTMLStyleElement} piece */
    function setMedia(piece) {
      const media = wantedMedia(piece);
      if (media) piece.media = media;
      else piece.removeAttribute('media');
    }
    let pumping = false;
    let inlineDone = false;
    let scanDone = false;

    /** @type {Map<Node, HTMLStyleElement[]>} */
    const copies = new Map();
    /** The style elements of this engine that are not copies of a page sheet; they come back when the page removes them. @type {Set<HTMLStyleElement>} */
    const owned = new Set();
    /** When each of them was put back, so a page that removes them again and again is given up on. @type {WeakMap<Element, number[]>} */
    const restoreTimes = new WeakMap();
    const RESTORE_MAX = 3;
    const RESTORE_WINDOW_MS = 2000;
    const RESTORE_RETRY_MAX_MS = 32000;
    /** The newest run for each sheet node. A run that finds a different token stops and removes its pieces. @type {Map<Node, object>} */
    const tokens = new Map();
    /** @type {Set<Node>} */
    const pending = new Set();
    /** Nodes with no copy because their sheet is not applied; looked at again after events. @type {Set<Node>} */
    const dormant = new Set();
    /** @type {Map<Node, (event: Event) => void>} */
    const loadListeners = new Map();
    /** Load listeners of links the page does not wait for: the release does not wait for them either. @type {Map<Node, () => void>} */
    const lateListeners = new Map();
    /** @type {number[]} */
    const faultTimes = [];

    /* ---------------- relative colors ---------------- */

    // A relative color (`rgb(from ...)`) is read by the browser: a hidden element gets the value and the computed color is
    // taken back. The element is made on first use and removed when the engine ends.
    /** @type {HTMLElement | null} */
    let relProbe = null;
    /** @type {Map<string, string | null>} */
    const relCache = new Map();
    /** @param {string} text @returns {string | null} */
    function resolveRelative(text) {
      if (relCache.has(text)) return relCache.get(text) ?? null;
      let plain = null;
      if (!dead && text.length <= 300 && !/var\(|currentcolor|env\(|attr\(/i.test(text)) {
        try {
          if (!relProbe) {
            relProbe = doc.createElement('span');
            relProbe.setAttribute('data-dk', 'probe');
            relProbe.hidden = true;
            root.append(relProbe);
          }
          // An inline value beats a rule of the page, also an important one.
          relProbe.style.setProperty('color', text, 'important');
          if (relProbe.style.getPropertyValue('color') !== '') {
            const computed = getComputedStyle(relProbe).color;
            if (/^(?:rgb|color|oklch|oklab|lab|lch|hsl|hwb)\(/i.test(computed)) plain = computed;
          }
          relProbe.style.removeProperty('color');
        } catch {
          plain = null;
        }
      }
      if (relCache.size >= 500) relCache.clear();
      relCache.set(text, plain);
      return plain;
    }

    /* ---------------- base style ---------------- */

    const base = doc.createElement('style');
    base.setAttribute('data-dk', 'base');
    // The page's own colors (`original`) keep the page's canvas and scheme: the base style stays empty.
    if (!theme.original) {
      const dark = theme.dark;
      const { page, text } = color.pageColors(theme);
      const scheme = themeSettings.systemControls === false ? '' : `color-scheme:${dark ? 'dark' : 'light'};`;
      // `:where()` gives no specificity, so any page rule beats it. The scheme is also set with `!important` on the root,
      // so a page with `light-dark()` colors shows its dark side.
      const strong = themeSettings.systemControls === false ? '' : `html{color-scheme:${dark ? 'dark' : 'light'}!important}`;
      base.textContent = `@media screen{:where(html){${scheme}background-color:${page};color:${text}}${strong}}`;
    }
    if (staged) base.media = 'not all';
    (doc.head ?? root).append(base);
    owned.add(base);
    if (!staged) root.setAttribute(STATE, 'starting');

    /* ---------------- early paint ---------------- */

    // Until the first sheets are themed the page has a dark canvas and, with `hold`, an invisible body, so no light
    // frame shows. Released when the sheets known so far are done.
    /** @type {HTMLStyleElement | null} */
    let early = options.early === false || theme.original ? null : doc.createElement('style');
    if (early) {
      early.setAttribute('data-dk', 'early');
      const dark = theme.dark;
      const { page, text, edge } = color.pageColors(theme);
      const scheme = themeSettings.systemControls === false ? '' : `color-scheme:${dark ? 'dark' : 'light'}!important;`;
      // Quick dark version: every box dark, every text light. It shows at once; the real theme replaces it.
      const quick = options.hold === false ? '' : `html body,html body :not(iframe){background-color:${page}!important;border-color:${edge}!important;color:${text}!important}`;
      early.textContent = `@media screen{html{${scheme}background-color:${page}!important}${quick}}`;
      root.append(early);
      owned.add(early);
    }
    const look = theme.original ? 'original' : theme.eink ? `eink:${themeSettings.einkPreset === 'eink' ? 'eink' : 'paper'}` : theme.dark ? 'dark' : 'light';

    // The colors change in one step at takeover. E-ink's 0.01 ms transitions would start one per changed element (seconds
    // on a big page, old colors for a frame), so none start while this style is on; it goes after the frame that shows the new colors.
    /** @type {HTMLStyleElement | null} */
    let freeze = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let freezeTimer = null;
    function dropFreeze() {
      if (freezeTimer !== null) clearTimeout(freezeTimer);
      freezeTimer = null;
      freeze?.remove();
      freeze = null;
    }
    function holdTransitions() {
      freeze = doc.createElement('style');
      freeze.setAttribute('data-dk', 'freeze');
      freeze.textContent = '@media screen{*,*::before,*::after{transition-property:none!important}}';
      root.append(freeze);
      const mine = freeze;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (freeze === mine) dropFreeze();
        }),
      );
      freezeTimer = setTimeout(dropFreeze, FREEZE_MAX_MS);
    }

    /** Links the browser applies that nobody could read. */
    const unreachable = new Set();
    /** When the host was asked to take over a page that stays light because of them, or 0. */
    let unreachableAsked = 0;
    let probeLoading = false;
    let probeFailed = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let holdTimer = null;
    // While the page is held back nobody sees it, and each short slice waits behind the page's own tasks. Longer slices
    // get the theme in sooner.
    if (early && options.hold !== false) {
      sl.tune(HOLD_SOFT_MS, HOLD_HARD_MS);
      sl.phase('quick');
    }

    /** @param {string} reason */
    function release(reason) {
      if (!early) return;
      if (reason !== 'stopped' && checkScheme()) return;
      fillMarkers();
      if (reason !== 'stopped') decideSite(reason === 'settled');
      if (reason !== 'stopped' && holdForUnreachable(reason)) return;
      // The page's own dark theme was kept and the parts it does not cover are being repaired: the quick version stays until then.
      if (reason === 'settled' && repairInfo.state === 'pending' && performance.now() - repairInfo.startedAt < REPAIR_HOLD_MS) return;
      activatePieces();
      owned.delete(early);
      early.remove();
      early = null;
      if (stats.readyAt === null) sl.tune(HOLD_SOFT_MS, HOLD_HARD_MS);
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
      stats.holdMs = performance.now() - stats.startedAt;
      stats.released = reason;
      options.onRelease?.(reason);
    }

    /**
     * A sheet that applies to the page and cannot be read leaves its rules in the page's own colors. Whether that matters is
     * judged on the page as it would show now (every piece of ours on, the quick version off): a page that is still light is
     * handed to the engine that needs no text (`onUnreachable`, the Filter+ engine), and the quick version stays up until that
     * engine takes over. A page that is dark enough keeps this engine. Returns true when the release has to wait.
     * @param {string} reason
     */
    function holdForUnreachable(reason) {
      if (unreachableAsked !== 0) return performance.now() - unreachableAsked < UNREACHABLE_WAIT_MS;
      if (!options.onUnreachable || !early) return false;
      let count = 0;
      for (const node of unreachable) if (node.isConnected) count += 1;
      stats.unreachable = count;
      if (count === 0) return false;
      const probe = /** @type {any} */ (globalThis.__dk?.sitetheme);
      if (!probe || typeof probe.assess !== 'function' || !(/** @type {any} */ (globalThis).__dk?.detect)) {
        if (!probeLoading && !probeFailed) {
          probeLoading = true;
          void needSiteTheme().then((ok) => {
            probeLoading = false;
            probeFailed = !ok;
            if (!dead && early) release(reason);
          });
        }
        return probeLoading;
      }
      activatePieces();
      let light = false;
      try {
        const verdict = probe.assess({ keep: (/** @type {Element} */ el) => el !== early, scheme: themeSettings.systemControls !== false, minContrast: SITE_MIN_CONTRAST });
        // Only the page's background decides: low contrast text or one light card is for the Dynamic engine to fix.
        if (typeof verdict.background !== 'number') return doc.readyState === 'loading' && reason !== 'timeout';
        light = verdict.background > UNREACHABLE_LIGHT_BACKGROUND;
      } catch {
        light = false;
      }
      stats.unreachableFallback = light ? 'asked' : 'kept';
      if (!light) return false;
      unreachableAsked = performance.now();
      setTimeout(() => !dead && early && release('settled'), UNREACHABLE_WAIT_MS + 50);
      try {
        options.onUnreachable();
      } catch {
        // The host could not switch; the release follows after the wait.
      }
      return true;
    }

    /** A stylesheet link in the head that the browser waits for before it paints. @param {Node} node */
    function blocksRendering(node) {
      if (!(node instanceof HTMLLinkElement) || !node.getAttribute('href') || node.disabled || !/(^|\s)stylesheet(\s|$)/i.test(node.rel) || /alternate/i.test(node.rel)) return false;
      if (node.media && node.media !== 'all') {
        try {
          if (!matchMedia(node.media).matches) return false;
        } catch {
          return false;
        }
      }
      return !!node.closest('head');
    }

    function blockingPending() {
      for (const node of loadListeners.keys()) if (blocksRendering(node)) return true;
      return false;
    }

    function maybeRelease() {
      if (dead || !early) return;
      if (!doc.body && doc.readyState === 'loading') return;
      if (!inlineDone || !scanDone) return;
      if (pending.size || pumping || loadListeners.size || fetching.size || rootPasses || probeNeeded()) return;
      release('settled');
    }

    if (early) {
      holdTimer = setTimeout(function giveUp() {
        holdTimer = null;
        if (dead || !early) return;
        // A page that waits for the network or is still being themed keeps the quick dark version: ending the hold would show
        // light colors for as long as the work takes. A link that does not block rendering is waited for only until this cap (maybeRelease).
        const busy = blockingPending() || fetching.size > 0 || pending.size > 0 || pumping || !inlineDone || !scanDone || rootPasses > 0;
        if (busy && performance.now() - stats.startedAt < HOLD_LONG_MAX_MS) {
          holdTimer = setTimeout(giveUp, 250);
          return;
        }
        release('timeout');
        markReady();
      }, HOLD_MAX_MS);
    }

    /* ---------------- declarations and rules ---------------- */

    /** The Images module sorts CSS background pictures; it is told which selectors set one. @param {string} selector @param {'mask'} [kind] */
    function noteBackground(selector, kind) {
      tellImages('background', selector);
      if (kind !== 'mask') notePicture(selector);
    }

    /** Split a declaration block on top-level semicolons. @param {string} text */
    function splitDeclarations(text) {
      /** @type {string[]} */
      const out = [];
      let depth = 0;
      let start = 0;
      let quote = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (quote) {
          if (c === 92) i++;
          else if (c === quote) quote = 0;
        } else if (c === 34 || c === 39) quote = c;
        else if (c === 40) depth++;
        else if (c === 41) depth--;
        else if (c === 59 && depth === 0) {
          out.push(text.slice(start, i));
          start = i + 1;
        }
      }
      if (start < text.length) out.push(text.slice(start));
      return out;
    }

    /** Does this declaration block set a mask picture? @param {CSSStyleDeclaration} style */
    function hasMask(style) {
      for (const name of ['mask-image', '-webkit-mask-image']) {
        const v = style.getPropertyValue(name);
        if (v !== '' && v !== 'none' && !/^(?:revert|revert-layer|initial|unset|inherit)$/i.test(v)) return true;
      }
      return false;
    }

    /** A length in pixels, or NaN for anything else. @param {string} v */
    const pixels = (v) => {
      const m = /^(\d*\.?\d+)px$/.exec(v.trim());
      return m ? Number(m[1]) : NaN;
    };

    /**
     * A box that is a line or a dot (a menu bar, a divider, a bullet) is drawn with a background color but works as a
     * mark: on a dark page a dark bar becomes the page color and vanishes. Such a box takes its color from the border
     * curve, which keeps dark marks visible and light dividers quiet.
     * @param {CSSStyleDeclaration} style
     */
    function isMarkBox(style) {
      const w = pixels(style.width);
      const h = pixels(style.height);
      const thin = (/** @type {number} */ a, /** @type {number} */ b) => a > 0 && a <= 4 && !(b <= 4) && !(b < 8);
      return thin(h, w) || thin(w, h) || (w > 0 && h > 0 && w <= 8 && h <= 8);
    }

    /** Is the background of this rule clipped to the text? @param {CSSStyleDeclaration} style */
    function isTextClip(style) {
      return style.getPropertyValue('background-clip') === 'text' || style.getPropertyValue('-webkit-background-clip') === 'text';
    }

    /** Shorthands that hold `var()` are not expanded by the CSSOM, so they are read from the text. */
    function shorthandVars(/** @type {CSSStyleDeclaration} */ style, /** @type {string} */ baseUrl, /** @type {boolean} */ force, /** @type {boolean} */ controls) {
      let out = '';
      /** @type {string[]} */
      const wholes = [];
      for (const part of splitDeclarations(style.cssText)) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        const name = part.slice(0, colon).trim().toLowerCase();
        let value = part.slice(colon + 1).trim();
        let important = force;
        if (/!\s*important\s*$/i.test(value)) {
          important = true;
          value = value.replace(/!\s*important\s*$/i, '').trim();
        }
        const tail = important ? '!important;' : ';';
        if (!rw.isShorthand(name) || !value.includes('var(')) {
          // What a whole copy of a shorthand resets is written again when a later declaration of the rule sets it.
          if (wholes.length && !value.includes('url(') && !(rw.isRelevant(name) && (!rw.isShorthand(name) || name === 'border-color')) && wholes.some((w) => rewrite.resets(w, name))) out += `${name}:${value}${tail}`;
          continue;
        }
        const r = rw.shorthand(name, value, baseUrl, controls);
        for (const [property, v] of r.list) out += `${property}:${v}${tail}`;
        if (r.whole) wholes.push(name);
      }
      return out;
    }

    /**
     * @param {CSSStyleDeclaration} style
     * @param {string} baseUrl
     * @param {boolean} force  add `!important` to every declaration (used for inline styles)
     * @param {{ unresolved: boolean } | null} [note]
     * @param {boolean} [controls]  the rule styles a form control, so its border keeps a contrast floor
     * @param {any} [found]  counts of the site dark theme to add to, or null
     * @param {Set<string> | null} [covered]  groups of properties the page's dark rules set for this rule's selector (repair mode)
     */
    function declarationsText(style, baseUrl, force, note = null, controls = false, found = null, covered = null) {
      let out = '';
      let needShorthandScan = false;
      /** Is the background clipped to the text (gradient text)? Read when a gradient background shows up. @type {boolean | null} */
      let clipped = null;
      const masked = hasMask(style) || (style.getPropertyValue('content').replace(/\s/g, '') === '""' && pixels(style.width) > 0 && pixels(style.width) <= 32 && pixels(style.height) > 0 && pixels(style.height) <= 32);
      const mark = !masked && isMarkBox(style);
      /** The text color of the rule, where its declaration sits in `out`, and the background color: together they get the pair floor. */
      let fgValue = '';
      let fgAt = -1;
      let fgEnd = -1;
      let fgTail = '';
      let bgValue = '';
      let picture = false;
      for (let i = 0, n = style.length; i < n; i++) {
        const name = style[i];
        if (name === 'color-scheme') {
          const scheme = style.getPropertyValue(name);
          if (!schemeFlag && SCHEME_ONLY.test(`color-scheme:${scheme}`)) flagScheme();
          if (found !== null) {
            if (siteApi.schemeOnlyLight(scheme)) found.onlyLight++;
            else if (siteApi.schemeHasDark(scheme)) found.scheme++;
          }
          continue;
        }
        if (!rw.isRelevant(name)) continue;
        if (covered !== null && covered.has(/** @type {any} */ (dk).sitetheme.family(name))) continue;
        const value = style.getPropertyValue(name);
        if (value === '') {
          needShorthandScan = true;
          continue;
        }
        if (found !== null && value.indexOf('light-dark(') >= 0) found.lightDark++;
        const important = force || style.getPropertyPriority(name) === 'important';
        if (name.charCodeAt(0) === 45 && name.charCodeAt(1) === 45) {
          out += custom(name, value, baseUrl, important ? 'important' : '');
          continue;
        }
        const v =
          name === 'background-color' && (masked || mark)
            ? rw.declaration(masked ? 'color' : 'border-color', value, baseUrl)
            : rw.declaration(name, value, baseUrl, controls, (name === 'background-image' || name === 'background') && value.includes('gradient(') && (clipped ??= isTextClip(style)));
        if (v !== null) {
          if (name === 'color') {
            fgValue = value;
            fgAt = out.length;
            fgTail = important ? '!important;' : ';';
          }
          out += `${name}:${v}${important ? '!important' : ''};`;
          if (name === 'color') fgEnd = out.length;
        }
        if (name === 'background-color' && !masked && !mark) bgValue = value;
        else if (name === 'background-image') picture = !/^(?:none|initial)$/i.test(value.trim());
      }
      if (fgAt >= 0 && bgValue !== '' && !picture) {
        const paired = rw.pairColor(fgValue, bgValue);
        if (paired !== null) out = `${out.slice(0, fgAt)}color:${paired}${fgTail}${out.slice(fgEnd)}`;
      }
      if (clipped === true) out += rw.textClipRules();
      if (needShorthandScan) {
        const extra = shorthandVars(style, baseUrl, force, controls);
        if (extra === '' && note) note.unresolved = true;
        // First: a longhand the page set after the shorthand is in `out` and must win over it.
        out = extra + out;
      }
      return out.includes('border-top-color:') ? mergeBorderColors(out) : out;
    }

    /** `border: 1px solid red` is four longhands in the CSSOM. When all four colors agree, one shorthand is shorter. @param {string} text */
    function mergeBorderColors(text) {
      const m = /border-top-color:([^;]*?)(!important)?;border-right-color:;border-bottom-color:;border-left-color:;/.exec(text);
      if (!m) return text;
      return `${text.slice(0, m.index)}border-color:${m[1]}${m[2] ?? ''};${text.slice(m.index + m[0].length)}`;
    }

    /** @param {CSSRule} rule */
    const isStyleRule = (rule) => rule instanceof CSSStyleRule;
    /** @param {CSSRule} rule */
    const isNestedDeclarations = (rule) => rule.constructor && rule.constructor.name === 'CSSNestedDeclarations';
    /** @param {CSSRule} rule */
    const isKeyframes = (rule) => typeof CSSKeyframesRule !== 'undefined' && rule instanceof CSSKeyframesRule;
    /** @param {CSSRule} rule */
    const isImport = (rule) => typeof CSSImportRule !== 'undefined' && rule instanceof CSSImportRule;
    /** Rules that hold other rules: media, supports, layer, container, scope, starting-style. @param {CSSRule} rule */
    const isGroup = (rule) => !isStyleRule(rule) && !isKeyframes(rule) && !isImport(rule) && /** @type {any} */ (rule).cssRules !== undefined;

    /** The part of a grouping rule before its block, such as `@media (min-width: 600px)`. @param {CSSRule} rule */
    function groupHead(rule) {
      // `cssText` of a group prints every rule inside it, so the common groups are read from their own fields.
      const kind = rule.constructor ? rule.constructor.name : '';
      const any = /** @type {any} */ (rule);
      if (kind === 'CSSMediaRule' && typeof any.conditionText === 'string') return `@media ${any.conditionText}`.trim();
      if (kind === 'CSSSupportsRule' && typeof any.conditionText === 'string') return `@supports ${any.conditionText}`.trim();
      if (kind === 'CSSContainerRule' && typeof any.conditionText === 'string') {
        const name = typeof any.containerName === 'string' ? any.containerName : '';
        return `@container ${name && !any.conditionText.startsWith(name) ? `${name} ` : ''}${any.conditionText}`.trim();
      }
      if (kind === 'CSSLayerBlockRule' && typeof any.name === 'string') return any.name ? `@layer ${any.name}` : '@layer';
      const text = rule.cssText;
      const open = text.indexOf('{');
      return open < 0 ? '' : text.slice(0, open).trim();
    }

    /** One rule inside a style rule (nesting). @param {CSSRule} rule @param {string} baseUrl @returns {string} */
    function nestedText(rule, baseUrl, depth = 0) {
      if (depth >= MAX_DEPTH) return '';
      if (isStyleRule(rule)) return styleRuleText(/** @type {CSSStyleRule} */ (rule), baseUrl, depth + 1);
      if (isNestedDeclarations(rule)) return declarationsText(/** @type {any} */ (rule).style, baseUrl, false);
      if (isGroup(rule)) {
        let inner = '';
        for (const child of /** @type {any} */ (rule).cssRules) inner += nestedText(child, baseUrl, depth + 1);
        const head = groupHead(rule);
        return inner && head ? `${head}{${inner}}` : '';
      }
      return '';
    }

    /** The color declarations of one rule, read from its source text. @param {string} raw @param {string} baseUrl */
    function declarationsFromSource(raw, baseUrl, controls = false) {
      let out = '';
      /** @type {string[]} */
      const wholes = [];
      for (const part of splitDeclarations(raw.replace(/\/\*[\s\S]*?\*\//g, ''))) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        const name = part.slice(0, colon).trim().toLowerCase();
        let value = part.slice(colon + 1).trim();
        let important = false;
        if (/!\s*important\s*$/i.test(value)) {
          important = true;
          value = value.replace(/!\s*important\s*$/i, '').trim();
        }
        const tail = important ? '!important;' : ';';
        const mixed = wholes.length > 0 && !value.includes('url(') && wholes.some((w) => rewrite.resets(w, name));
        if (!rw.isRelevant(name)) {
          if (mixed) out += `${name}:${value}${tail}`;
          continue;
        }
        if (name.startsWith('--')) {
          out += custom(name, value, baseUrl, important ? 'important' : '');
          continue;
        }
        if (rw.isShorthand(name) && name !== 'border-color') {
          if (mixed) out += `${name}:${value}${tail}`;
          const r = rw.shorthand(name, value, baseUrl, controls);
          for (const [property, v] of r.list) out += `${property}:${v}${tail}`;
          if (r.whole) wholes.push(name);
          continue;
        }
        const v = rw.declaration(name, value, baseUrl, controls);
        if (v !== null) out += `${name}:${v}${tail}`;
      }
      return out;
    }

    /** @param {CSSStyleRule} rule @param {string} baseUrl @param {number} [depth] @param {Budget | null} [budget] @returns {string} */
    function styleRuleText(rule, baseUrl, depth = 0, budget = null) {
      const note = { unresolved: false };
      const controls = CONTROL_SELECTOR.test(rule.selectorText);
      deferNow = budget !== null && budget.defer;
      /** @type {string} */
      let decls;
      try {
        decls = declarationsText(rule.style, baseUrl, false, note, controls, budget ? budget.found : null, repairing && siteMod ? siteMod.coverFor(rule.selectorText) : null);
      } finally {
        deferNow = false;
      }
      if (note.unresolved && budget) {
        budget.unresolved += 1;
        const key = rewrite.normalizeSelector(rule.selectorText);
        const list = budget.extra?.get(key);
        const at = list ? list.findIndex((_, i) => !budget.used.has(`${key}#${i}`)) : -1;
        if (list && at >= 0) {
          budget.used.add(`${key}#${at}`);
          deferNow = budget.defer;
          /** @type {string} */
          let fromSource;
          try {
            fromSource = declarationsFromSource(list[at], baseUrl, controls);
          } finally {
            deferNow = false;
          }
          if (fromSource) decls = fromSource;
        }
      }
      let nested = '';
      const kids = /** @type {any} */ (rule).cssRules;
      if (kids && kids.length) for (const child of kids) nested += nestedText(child, baseUrl, depth);
      if (budget && sheetText) {
        sheetText.pictureNote(decls, rule.selectorText, noteBackground);
        // A mask picture or an image-set() has no declaration in the copy: the style of the rule is asked.
        if ((rule.style.maskImage || rule.style.webkitMaskImage).includes('url(')) noteBackground(rule.selectorText, 'mask');
        else if (rule.style.backgroundImage.includes('image-set(')) noteBackground(rule.selectorText);
      }
      if (decls === '' && nested === '') return '';
      const fill = decls.includes('fill:') ? rule.style.getPropertyValue('fill') : '';
      const shape = fill ? rw.shapeFill(rule.selectorText, fill, rule.style.getPropertyPriority('fill') === 'important') : '';
      return `${rule.selectorText}{${decls}${nested}}${shape}`;
    }

    /** A keyframes rule is copied whole, because a later rule with the same name replaces the first. @param {CSSKeyframesRule} rule @param {string} baseUrl */
    function keyframesText(rule, baseUrl) {
      let hasColor = false;
      let body = '';
      for (const frame of /** @type {any} */ (rule).cssRules) {
        const style = frame.style;
        let decls = '';
        // A shorthand with `var()` leaves its longhands empty in the CSSOM; it is read from the text of the frame.
        let pendingVar = false;
        /** @type {Set<string>} */
        const written = new Set();
        for (let i = 0, n = style.length; i < n; i++) {
          const name = style[i];
          const value = style.getPropertyValue(name);
          if (value === '') {
            pendingVar = true;
            continue;
          }
          written.add(name);
          const v = rw.isRelevant(name) && !name.startsWith('--') ? rw.declaration(name, value, baseUrl) : null;
          if (v !== null) hasColor = true;
          decls += `${name}:${v ?? value};`;
        }
        if (pendingVar) {
          let lead = '';
          for (const part of splitDeclarations(style.cssText)) {
            const colon = part.indexOf(':');
            if (colon < 0) continue;
            const name = part.slice(0, colon).trim().toLowerCase();
            const value = part.slice(colon + 1).trim();
            if (name.startsWith('--') || !value.includes('var(') || written.has(name)) continue;
            const v = rw.isRelevant(name) ? rw.declaration(name, value, baseUrl) : null;
            if (v !== null) hasColor = true;
            lead += `${name}:${v ?? value};`;
          }
          // First, so a longhand the frame sets after the shorthand still wins.
          decls = lead + decls;
        }
        body += `${frame.keyText}{${decls}}`;
      }
      return hasColor ? `${/^@[-\w]*keyframes/i.exec(rule.cssText)?.[0] ?? '@keyframes'} ${rule.name}{${body}}` : '';
    }

    /** The counters of one sheet: when one limit is passed, the whole sheet is dropped. @typedef {{ rules: number, imports: number, capped: boolean, waiting: boolean, unresolved: number, extra: Map<string, string[]> | null, used: Set<string>, found: any, defer: boolean, layers: any }} Budget (`defer`: the custom properties of the copy get markers, to be filled by demand; `layers`: the layer namer of the copy, or null) */
    const newBudget = (/** @type {Map<string, string[]> | null} */ extra = null, /** @type {boolean} */ defer = false, /** @type {any} */ layers = null) => ({ rules: 0, imports: 0, capped: false, waiting: false, unresolved: 0, extra, used: new Set(), found: null, defer, layers });

    /* ---------------- layer names of the copies ---------------- */

    /** The stand-in layer names of each tree: a document or a shadow root (`rewrite.layerNamer`). @type {WeakMap<Node, { names: Map<string, string>, next: number, tag: string }>} */
    const layerScopes = new WeakMap();
    /** The layer paths each sheet declares, kept when its copy is made, so the next sheets need not read it again. @type {WeakMap<Node, Set<string>>} */
    const layerPaths = new WeakMap();
    const layerTag = Math.floor(Math.random() * 0x100000).toString(36);
    const MAX_LAYER_READ = 20000;

    /** The namer of the copy of a sheet node. @param {Node} node */
    function namerFor(node) {
      const tree = node.getRootNode();
      let scope = layerScopes.get(tree);
      if (!scope) {
        scope = { names: new Map(), next: 0, tag: layerTag };
        layerScopes.set(tree, scope);
      }
      /** @type {Set<string> | null | undefined} */
      let before;
      return rewrite.layerNamer(scope, (/** @type {string} */ path) => {
        if (before === undefined) before = layersBefore(node, tree);
        return before === null || before.has(path);
      });
    }

    /**
     * The layer paths declared by the sheets before `node` in its tree, or null when one of them cannot be read (then no
     * stand-in name is made, and the copy keeps the order it had without one).
     * @param {Node} node @param {Node} tree
     * @returns {Set<string> | null}
     */
    function layersBefore(node, tree) {
      /** @type {Set<string>} */
      const found = new Set();
      const budget = { left: MAX_LAYER_READ };
      const sheets = /** @type {any} */ (tree).styleSheets;
      if (!sheets) return null;
      for (const sheet of sheets) {
        const owner = sheet.ownerNode;
        if (owner === node) return found;
        if (!owner || (owner instanceof Element && owner.hasAttribute('data-dk'))) continue;
        const known = layerPaths.get(owner);
        if (known) {
          for (const path of known) found.add(path);
          continue;
        }
        try {
          if (!collectLayers(sheet.cssRules, '', found, budget)) return null;
        } catch {
          return null;
        }
      }
      return found;
    }

    /** @param {CSSRuleList} rules @param {string} prefix @param {Set<string>} found @param {{ left: number }} budget @returns {boolean} false when the walk had to stop */
    function collectLayers(rules, prefix, found, budget) {
      /** @param {string} name */
      const add = (name) => {
        let path = prefix;
        for (const part of name.split('.')) {
          path = path === '' ? part.trim() : `${path}.${part.trim()}`;
          found.add(path);
        }
        return path;
      };
      for (const rule of rules) {
        if (--budget.left < 0) return false;
        const kind = rule.constructor ? rule.constructor.name : '';
        const any = /** @type {any} */ (rule);
        if (kind === 'CSSLayerStatementRule') for (const name of any.nameList) add(name);
        else if (kind === 'CSSLayerBlockRule') {
          if (any.name && !collectLayers(any.cssRules, add(any.name), found, budget)) return false;
        } else if (isImport(rule)) {
          if (any.layerName === '' || !any.styleSheet) continue;
          if (!collectLayers(any.styleSheet.cssRules, any.layerName ? add(any.layerName) : prefix, found, budget)) return false;
        } else if (isGroup(rule) && !collectLayers(any.cssRules, prefix, found, budget)) return false;
      }
      return true;
    }

    /**
     * The dark rules of a style rule, for the copy that applies while the page is not in a dark state.
     * @param {CSSStyleRule} rule @param {string} baseUrl @param {Budget} budget @param {string[]} site
     */
    function siteStyleRule(rule, baseUrl, budget, site) {
      const moved = siteApi.rewriteSelectors(rule.selectorText);
      if (moved === '') return;
      const text = rule.cssText;
      const open = text.indexOf('{', rule.selectorText.length);
      const close = text.lastIndexOf('}');
      if (open < 0 || close <= open) return;
      const raw = siteApi.absolutize(text.slice(open + 1, close), baseUrl);
      if (raw.trim() === '') return;
      site.push(`${moved}{${raw}}`);
      budget.found.state++;
      budget.found.rules++;
      budget.found.chars += raw.length;
    }

    /** @param {CSSRule} rule @param {string[]} out @param {string} baseUrl @param {Budget} budget @param {number} depth @param {string[] | null} [site]  where the dark rules go */
    async function emitRule(rule, out, baseUrl, budget, depth, site = null) {
      if (budget.capped) return;
      if (++budget.rules > MAX_RULES || depth > MAX_DEPTH) {
        budget.capped = true;
        return;
      }
      stats.rules += 1;
      if (isStyleRule(rule)) {
        const text = styleRuleText(/** @type {CSSStyleRule} */ (rule), baseUrl, 0, budget);
        if (text) out.push(text);
        if (site) siteStyleRule(/** @type {CSSStyleRule} */ (rule), baseUrl, budget, site);
      } else if (isImport(rule)) {
        await emitImport(/** @type {CSSImportRule} */ (rule), out, budget, depth, site);
      } else if (isKeyframes(rule)) {
        const text = keyframesText(/** @type {CSSKeyframesRule} */ (rule), baseUrl);
        if (text) out.push(text);
      } else if (typeof CSSPropertyRule !== 'undefined' && rule instanceof CSSPropertyRule) {
        const text = rw.registered(rule.name, rule.syntax, rule.inherits, rule.initialValue);
        if (text) out.push(text);
      } else if (rule.constructor && rule.constructor.name === 'CSSLayerStatementRule') {
        const text = budget.layers ? budget.layers.statement(Array.from(/** @type {any} */ (rule).nameList)) : '';
        if (text) out.push(text);
      } else if (isGroup(rule)) {
        /** @type {string[]} */
        const inner = [];
        const innerSite = site ? [] : null;
        const layer = budget.layers && rule.constructor && rule.constructor.name === 'CSSLayerBlockRule' ? `@layer ${budget.layers.open(String(/** @type {any} */ (rule).name ?? ''))}` : null;
        try {
          await emitList(/** @type {any} */ (rule).cssRules, inner, baseUrl, budget, depth + 1, innerSite);
        } finally {
          if (layer !== null) budget.layers.close();
        }
        const head = layer ?? groupHead(rule);
        if (motionRules && rule.constructor && rule.constructor.name === 'CSSMediaRule') {
          const any = /** @type {any} */ (rule);
          const lead = siteApi.reducedMedia(String(any.media ? any.media.mediaText : any.conditionText ?? ''));
          if (lead !== null) {
            const raw = siteApi.absolutize(Array.from(any.cssRules, (/** @type {CSSRule} */ r) => r.cssText).join(''), baseUrl);
            if (raw.trim() !== '' && raw.length <= MOTION_MAX_CHARS) {
              out.push(`${siteApi.unwrappedHead(lead)}{${raw}}`);
              if (inner.length) out.push(`${siteApi.unwrappedHead(lead)}{${inner.join('')}}`);
            }
          }
        }
        if (inner.length && head) out.push(`${head}{${inner.join('')}}`);
        if (site && innerSite) {
          const any = /** @type {any} */ (rule);
          const rest = rule.constructor && rule.constructor.name === 'CSSMediaRule' ? siteApi.darkMedia(String(any.media ? any.media.mediaText : any.conditionText ?? '')) : null;
          if (rest !== null) {
            const raw = siteApi.absolutize(Array.from(any.cssRules, (/** @type {CSSRule} */ r) => r.cssText).join(''), baseUrl);
            if (raw.trim() !== '') {
              site.push(`${siteApi.unwrappedHead(rest)}{${raw}}`);
              budget.found.media++;
              budget.found.rules += any.cssRules.length;
              budget.found.chars += raw.length;
            }
          } else if (innerSite.length && head) site.push(`${head}{${innerSite.join('')}}`);
        }
      }
    }

    /** @param {CSSRuleList} list @param {string[]} out @param {string} baseUrl @param {Budget} budget @param {number} depth @param {string[] | null} [site] */
    async function emitList(list, out, baseUrl, budget, depth, site = null) {
      for (let i = 0, n = list.length; i < n; i++) {
        if (dead || budget.capped) return;
        await emitRule(list[i], out, baseUrl, budget, depth, site);
        if (sl.shouldYield()) await sl.yieldNow();
      }
    }

    /** @param {CSSImportRule} rule @param {string[]} out @param {Budget} budget @param {number} depth @param {string[] | null} [site] */
    async function emitImport(rule, out, budget, depth, site = null) {
      const sheet = rule.styleSheet;
      if (!sheet) {
        budget.waiting = true;
        return;
      }
      if (sheet.href && skipUrl(sheet.href)) {
        stats.skippedUrls += 1;
        return;
      }
      if (++budget.imports > MAX_IMPORTS || depth >= MAX_IMPORT_DEPTH) {
        budget.capped = true;
        return;
      }
      /** @type {CSSRuleList} */
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        stats.unreadable += 1;
        return;
      }
      /** @type {string[]} */
      const inner = [];
      const innerSite = site ? [] : null;
      const named = /** @type {any} */ (rule).layerName;
      const layered = named !== null && named !== undefined && budget.layers !== null;
      const layer = layered ? budget.layers.open(String(named)) : named;
      try {
        await emitList(rules, inner, sheet.href ?? doc.baseURI, budget, depth + 1, innerSite);
      } finally {
        if (layered) budget.layers.close();
      }
      const media = rule.media?.mediaText;
      const supports = /** @type {any} */ (rule).supportsText;
      const wrap = (/** @type {string} */ body) => {
        let text = body;
        if (media && media !== 'all') text = `@media ${media}{${text}}`;
        if (supports) text = `@supports ${supports}{${text}}`;
        if (layer !== null && layer !== undefined) text = layer === '' ? `@layer{${text}}` : `@layer ${layer}{${text}}`;
        return text;
      };
      if (site && innerSite && innerSite.length) site.push(wrap(innerSite.join('')));
      if (inner.length) out.push(wrap(inner.join('')));
    }

    /* ---------------- sheets ---------------- */

    /**
     * @param {Node} node
     * @param {boolean} [keepPieces]  leave the old copy in the page; the caller removes it when the new one is in
     * @returns {HTMLStyleElement[] | undefined} the old copy
     */
    function dropCopy(node, keepPieces = false) {
      tokens.delete(node);
      dormant.delete(node);
      siteCounts.delete(node);
      const pieces = copies.get(node);
      if (pieces) {
        if (!keepPieces) for (const piece of pieces) piece.remove();
        copies.delete(node);
      }
      const listener = loadListeners.get(node);
      if (listener) {
        node.removeEventListener('load', listener);
        node.removeEventListener('error', listener);
        loadListeners.delete(node);
      }
      const late = lateListeners.get(node);
      if (late) {
        node.removeEventListener('load', late);
        lateListeners.delete(node);
      }
      return pieces;
    }

    /** @param {Node} node */
    function enqueue(node) {
      if (dead) return;
      watchRootStyle(node);
      pending.add(node);
      void pump();
    }

    /** @param {string} href */
    function hasFinished(href) {
      try {
        return performance.getEntriesByName(href, 'resource').length > 0;
      } catch {
        return false;
      }
    }

    // A sheet that is looked at again keeps its old copy until the new one is complete, so no frame shows the page
    // between the two.
    /** @param {HTMLStyleElement | HTMLLinkElement} node */
    async function processNode(node) {
      stats.processed += 1;
      const old = dropCopy(node, true);
      try {
        await buildCopy(node);
      } finally {
        if (old) for (const piece of old) piece.remove();
      }
    }

    /** @param {HTMLStyleElement | HTMLLinkElement} node */
    async function buildCopy(node) {
      if (!node.isConnected) return;
      if (node instanceof HTMLLinkElement && node.href && skipUrl(node.href)) {
        stats.skippedUrls += 1;
        return;
      }
      const sheet = node.sheet;
      if (!sheet) {
        // A link with no sheet is loading or failed. A failed one has a finished resource entry and its `error` event may be
        // past, so it is not waited for; nor are alternate, print and disabled links (enabling one is an attribute change).
        if (node instanceof HTMLLinkElement && node.disabled) {
          dormant.add(node);
          return;
        }
        const forScreen = !(node instanceof HTMLLinkElement) || !(/(^|\s)alternate(\s|$)/i.test(node.rel) || /^\s*print\s*$/i.test(node.media));
        if (forScreen && node instanceof HTMLLinkElement && node.getAttribute('href') && !hasFinished(node.href)) {
          /** @param {Event} event */
          const listener = (event) => {
            loadListeners.delete(node);
            node.removeEventListener('load', listener);
            node.removeEventListener('error', listener);
            if (event.type === 'load') enqueue(node);
            maybeRelease();
            markReady();
          };
          loadListeners.set(node, listener);
          node.addEventListener('load', listener);
          node.addEventListener('error', listener);
          prefetchRemote(node);
        } else if (node instanceof HTMLLinkElement && node.getAttribute('href')) {
          // The address was fetched before (a preload, a cache hit), so this link may still be about to load. The page does
          // not wait for it, but it is themed when it arrives.
          if (!lateListeners.has(node)) {
            const late = () => {
              lateListeners.delete(node);
              if (!dead && node.isConnected && !tokens.has(node)) enqueue(node);
            };
            lateListeners.set(node, late);
            node.addEventListener('load', late, { once: true });
          }
        }
        return;
      }
      if (switchedOff(node)) {
        dormant.add(node);
        return;
      }
      const mediaText = sheet.media.mediaText;
      if (/^\s*print\s*$/i.test(mediaText)) return;
      /** @type {CSSRuleList | null} */
      let rules = null;
      /** A sheet from another origin cannot be read, so its text is fetched by the worker. @type {string | null} */
      let remoteText = null;
      let remoteHref = null;
      try {
        rules = sheet.cssRules;
      } catch {
        // The file comes from the worker. It is asked for in the background and the sheet is looked at again when it
        // arrives, so one slow file does not hold up the sheets behind it.
        const known = node instanceof HTMLLinkElement && node.href ? remoteCache.get(node) : undefined;
        if (node instanceof HTMLLinkElement && node.href && (!known || known.href !== node.href || (known.early === true && known.text === null && known.transient === true))) {
          startFetch(node);
          return;
        }
        const fetched = known && known.text !== null ? { text: known.text, url: known.url } : null;
        if (!fetched) {
          stats.unreadable += 1;
          if (node instanceof HTMLLinkElement) {
            unreachable.add(node);
            stats.unreachable = unreachable.size;
          }
          return;
        }
        if (node instanceof HTMLLinkElement) unreachable.delete(node);
        remoteText = fetched.text;
        remoteHref = fetched.url;
        stats.fetched += 1;
      }
      /** The same text as a style element that applies to nothing, for the CSSOM walk. @type {HTMLStyleElement | null} */
      let inert = null;
      const token = {};
      tokens.set(node, token);
      try {
      const baseUrl = remoteHref ?? sheet.href ?? doc.baseURI;
      const media = mediaText && mediaText !== 'all' ? mediaText : '';
      /** @type {HTMLStyleElement[]} */
      let pieces = [];
      /** @param {string} css */
      /** @param {string} css @param {boolean} site  the copy of the page's dark rules */
      const put = (css, site) => {
        const began = performance.now();
        const piece = doc.createElement('style');
        piece.setAttribute('data-dk', site ? 'site' : 'sheet');
        if (site) sitePieces.add(piece);
        pieceMedia.set(piece, media);
        setMedia(piece);
        if (css.indexOf(MARK_OPEN) >= 0) {
          const filled = fill(css);
          piece.textContent = `${MEDIA_OPEN}${filled.text}}`;
          templated.set(piece, filled.rec);
          if (templated.size > templatedPrune) {
            for (const old of templated.keys()) if (!old.isConnected) templated.delete(old);
            templatedPrune = Math.max(32, templated.size * 2);
          }
        } else piece.textContent = `${MEDIA_OPEN}${css}}`;
        (pieces.length ? pieces[pieces.length - 1] : node).after(piece);
        pieces.push(piece);
        stats.pieces += 1;
        if (stats.readyAt !== null) fillMarkers();
        stats.insertMs += performance.now() - began;
      };
      const insert = (/** @type {string} */ css) => {
        if (siteState !== 'on' || repairing) put(css, false);
      };
      const wantSite = siteState !== 'off';
      let siteText = '';
      /** @type {any} */
      let siteFound = null;
      const box = { site: '', found: null };
      const stale = () => dead || tokens.get(node) !== token || !node.isConnected;
      let budget = newBudget(null, true, namerFor(node));
      let done = false;

      /** @type {string | null} */
      let text = null;
      if (reader && !edited.has(node)) {
        if (remoteText !== null) text = remoteText;
        else if (node instanceof HTMLStyleElement) text = node.textContent;
        else if (rules && rules.length >= TEXT_LINK_MIN && node instanceof HTMLLinkElement) {
          // The wait for the cache is not our time: close the slice before it and start a new one after it.
          sl.finish();
          text = await cachedText(node.href);
          sl.reset();
        }
        // A sheet with rules and no text was built by script.
        if (text !== null && (text.length > TEXT_MAX_CHARS || (text.trim() === '' && rules !== null && rules.length > 0))) text = null;
        if (stale()) return;
        if (text !== null && !schemeFlag && text.indexOf('color-scheme') >= 0 && SCHEME_ONLY.test(text)) flagScheme();
      }
      if (text !== null && siteState === 'on' && !repairing && !SITE_HINT.test(text)) return;
      const refusedKey = text === null ? '' : `${text.length}:${rules ? rules.length : -1}`;
      if (text !== null && refused.get(node) === refusedKey) text = null;
      if (text !== null) {
        const verdict = await runText(text, baseUrl, rules, budget, insert, stale, wantSite, box);
        if (verdict === 'stale') {
          for (const piece of pieces) piece.remove();
          return;
        }
        if (verdict === 'ok') {
          done = true;
          siteText = box.site;
          siteFound = box.found;
        } else {
          for (const piece of pieces) piece.remove();
          pieces = [];
          budget = newBudget(null, true, namerFor(node));
          stats.textFallbacks += 1;
          stats.textReasons[verdict] = (stats.textReasons[verdict] ?? 0) + 1;
          refused.set(node, refusedKey);
        }
      }

      if (!done) {
        stats.cssomSheets += 1;
        if (rules === null) {
          inert = doc.createElement('style');
          inert.setAttribute('data-dk', 'inert');
          inert.media = 'not all';
          inert.textContent = remoteText;
          (doc.head ?? root).append(inert);
          try {
            rules = /** @type {CSSStyleSheet} */ (inert.sheet).cssRules;
          } catch {
            stats.unreadable += 1;
            return;
          }
        }
        const sourceText = inert ? inert.textContent : node instanceof HTMLStyleElement ? node.textContent : null;
        const cached = sourceCache.get(node);
        const extra = cached ?? (sourceText && sourceText.includes('var(') ? rewrite.parseVarShorthands(sourceText) : null);
        budget = newBudget(extra, true, namerFor(node));
        const siteOut = wantSite ? [] : null;
        if (wantSite) budget.found = siteApi.emptyFound();
        /** @type {string[]} */
        let out = [];
        let size = 0;
        for (let i = 0, n = rules.length; i < n; i++) {
          if (stale() || budget.capped) break;
          const before = out.length;
          await emitRule(rules[i], out, baseUrl, budget, 0, siteOut);
          for (let k = before; k < out.length; k++) size += out[k].length;
          if (size >= CHUNK_CHARS) {
            if (stale()) break;
            insert(out.join(''));
            out = [];
            size = 0;
          }
          if (sl.shouldYield()) await sl.yieldNow();
        }
        if (!stale() && !budget.capped && out.length) insert(out.join(''));
        if (siteOut) {
          siteText = siteOut.join('');
          siteFound = budget.found;
        }
      }
      if (stale() || budget.capped) {
        for (const piece of pieces) piece.remove();
        if (budget.capped && !dead) stats.capped += 1;
        return;
      }
      if (wantSite && siteFound && siteState !== 'off') {
        if (siteFound.chars > SITE_MAX_CHARS) siteFound.capped = true;
        else if (siteText !== '') {
          put(siteText, true);
          if (repairing) siteMod?.addCover(pieces[pieces.length - 1]);
        }
        siteCounts.set(node, siteFound);
        probeNeeded();
      }
      if (pieces.length) {
        copies.set(node, pieces);
        stats.sheets += 1;
      }
      if (budget.layers) layerPaths.set(node, budget.layers.paths);
      if (budget.waiting) retryImports(node);
      if (budget.unresolved > 0 && !sourceCache.has(node) && node instanceof HTMLLinkElement && node.href) {
        void sourceFor(node).then((map) => {
          if (map && map.size && !dead && node.isConnected) enqueue(node);
        });
      }
      } finally {
        inert?.remove();
      }
    }

    /**
     * Write the copy of a sheet from its source text. Returns 'ok', 'stale' (the sheet changed meanwhile), or the reason
     * the reader gave up: the CSSOM walk then takes the sheet. A sheet over a limit counts as done and is dropped by the caller.
     * @param {string} text @param {string} baseUrl @param {CSSRuleList | null} rules
     * @param {Budget} budget @param {(css: string) => void} insert @param {() => boolean} stale
     * @param {boolean} wantSite  also write the page's dark rules @param {{ site: string, found: any }} box  receives them
     */
    async function runText(text, baseUrl, rules, budget, insert, stale, wantSite, box) {
      const run = reader.start(text, baseUrl, budget, wantSite);
      const state = run.state;
      if (wantSite) budget.found = state.found;
      /** One step of the reader; its custom properties get markers (it runs without a pause, so nothing else sees the flag). @param {any} [answer] */
      const advance = (answer) => {
        deferNow = true;
        try {
          return run.steps.next(answer);
        } finally {
          deferNow = false;
        }
      };
      /** @type {CSSRule[] | null} */
      let imports = null;
      let step = advance();
      while (!step.done) {
        if (stale()) return 'stale';
        const request = step.value;
        if (typeof request === 'object') {
          let answer = null;
          if (rules) {
            if (!imports) imports = leadingImports(rules);
            const rule = imports[request.importIndex];
            if (rule) {
              /** @type {string[]} */
              const inner = [];
              const innerSite = wantSite ? [] : null;
              await emitImport(/** @type {CSSImportRule} */ (rule), inner, budget, 0, innerSite);
              answer = inner.join('');
              if (innerSite && innerSite.length) state.site.push(innerSite.join(''));
            }
          }
          step = advance(answer);
          continue;
        }
        if (state.size >= TEXT_CHUNK_CHARS) {
          insert(state.out.join(''));
          state.out.length = 0;
          state.size = 0;
        }
        if (sl.shouldYield()) await sl.yieldNow();
        step = advance();
      }
      if (stale()) return 'stale';
      const verdict = step.value;
      if (!verdict.ok) return verdict.reason === 'capped' ? 'ok' : verdict.reason;
      // The browser may drop rules it does not understand, so the text can hold a few more than the CSSOM. Fewer, or far
      // more, mean script changed the sheet.
      if (rules) {
        const surplus = verdict.top - rules.length;
        if (surplus < 0 || surplus > Math.max(3, Math.floor(verdict.top * 0.3))) return 'count';
      }
      if (state.out.length) insert(state.out.join(''));
      stats.rules += verdict.counted;
      stats.textSheets += 1;
      if (wantSite) {
        box.site = state.site.join('');
        box.found = verdict.found;
      }
      return 'ok';
    }

    /** The `@import` rules at the top of a sheet, in order. @param {CSSRuleList} rules */
    function leadingImports(rules) {
      /** @type {CSSRule[]} */
      const list = [];
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (isImport(rule)) list.push(rule);
        else {
          const kind = rule.constructor ? rule.constructor.name : '';
          if (kind !== 'CSSLayerStatementRule' && kind !== 'CSSNamespaceRule') break;
        }
      }
      return list;
    }

    let cacheMissesInARow = 0;
    /**
     * The text of a linked sheet of this origin from the browser's cache. `only-if-cached` never goes to the network: the
     * page has loaded the file already, and when the cache has no copy this answers null and the CSSOM is read instead. A
     * file that has just arrived may not be in the cache yet, so a miss is tried once more after a moment.
     * @param {string} href @returns {Promise<string | null>}
     */
    async function cachedText(href) {
      if (cacheMissesInARow >= 4) return null;
      let url;
      try {
        url = new URL(href, doc.baseURI);
      } catch {
        return null;
      }
      if (url.origin !== location.origin) return null;
      const kept = storedText(url.href);
      if (kept) {
        stats.storeHits += 1;
        return kept.text;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 40));
        if (dead) return null;
        try {
          const response = await fetch(url.href, { cache: 'only-if-cached', mode: 'same-origin', credentials: 'same-origin' });
          if (response.ok && !response.redirected) {
            cacheMissesInARow = 0;
            // text() reads UTF-8 only; a sheet in another charset, or one over the cap, is left to the CSSOM path.
            const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(response.headers.get('content-type') ?? '')?.[1];
            if ((charset && !/^utf-?8$/i.test(charset)) || Number(response.headers.get('content-length')) > TEXT_MAX_CHARS) return null;
            const body = await response.text();
            storeText(url.href, body, url.href);
            return body;
          }
        } catch (error) {
          stats.cacheError = String(error && /** @type {Error} */ (error).message).slice(0, 80);
        }
      }
      stats.cacheMisses += 1;
      cacheMissesInARow += 1;
      return null;
    }

    /** The source shorthands of sheets that could not give them from the CSSOM. @type {WeakMap<Node, Map<string, string[]>>} */
    const sourceCache = new WeakMap();
    /** @param {HTMLLinkElement} node @returns {Promise<Map<string, string[]> | null>} */
    async function sourceFor(node) {
      const fetched = await fetchRemoteText(node.href);
      const map = fetched ? rewrite.parseVarShorthands(fetched.text) : new Map();
      sourceCache.set(node, map);
      return map;
    }

    /** How many times each sheet was looked at again because an imported file was missing. @type {WeakMap<Node, number>} */
    const importRetries = new WeakMap();
    /** @param {Node} node */
    function retryImports(node) {
      const tries = importRetries.get(node) ?? 0;
      if (tries >= IMPORT_RETRIES || dead) return;
      importRetries.set(node, tries + 1);
      later(node, () => {
        if (node.isConnected) enqueue(node);
      }, IMPORT_RETRY_MS);
    }

    /**
     * Files of other origins that came back, by link element. `text` is null when the worker refused. `early` marks an answer asked
     * for before the browser had loaded the sheet: a refusal then (a server that was slow) is asked again once the sheet is there.
     * A refusal that may not come again (`transient`: a timeout, a network error) is asked again once; any other (a type, a size or a
     * status the worker refuses) is final.
     * @type {WeakMap<Node, { href: string, text: string | null, url: string, early?: boolean, transient?: boolean }>}
     */
    const remoteCache = new WeakMap();
    /** Links whose text was asked for before their load. @type {WeakSet<Node>} */
    const earlyFetches = new WeakSet();
    /** @type {Set<Node>} */
    const fetching = new Set();
    /** @type {HTMLLinkElement[]} */
    const fetchQueue = [];
    const MAX_FETCHES = 6;
    /** Whether the last refusal of an address may not come again. @type {Map<string, boolean>} */
    const failures = new Map();

    /**
     * A sheet of another origin that the CSSOM will not show: its text is asked for while the browser loads it, not after. A page
     * whose sheet is slow would otherwise wait twice for it. A link with a `crossorigin` attribute can be read and is left alone.
     * @param {HTMLLinkElement} node
     */
    function prefetchRemote(node) {
      try {
        const url = new URL(node.href);
        if (node.disabled || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === location.origin || node.crossOrigin !== null) return;
        if (node.media && /^\s*print\s*$/i.test(node.media)) return;
        const known = remoteCache.get(node);
        if (known && known.href === node.href) return;
        earlyFetches.add(node);
        startFetch(node);
      } catch {
        // An address that cannot be read is left to the load.
      }
    }

    /** @param {HTMLLinkElement} node */
    function startFetch(node) {
      if (fetching.has(node) || fetchQueue.includes(node)) return;
      fetchQueue.push(node);
      fetching.add(node);
      pumpFetches();
    }

    let activeFetches = 0;
    function pumpFetches() {
      while (!dead && activeFetches < MAX_FETCHES && fetchQueue.length) {
        const node = /** @type {HTMLLinkElement} */ (fetchQueue.shift());
        activeFetches += 1;
        const href = node.href;
        const early = earlyFetches.delete(node);
        void fetchRemoteText(href).then((r) => {
          remoteCache.set(node, { href, text: r ? r.text : null, url: r ? r.url : href, early, transient: !r && failures.get(href) === true });
        }).finally(() => {
          activeFetches -= 1;
          fetching.delete(node);
          if (!dead && node.isConnected) enqueue(node);
          pumpFetches();
          maybeRelease();
          markReady();
        });
      }
    }

    /** Ask the worker for the text of a stylesheet of another origin. @param {string} href @returns {Promise<{ text: string, url: string } | null>} */
    async function fetchRemoteText(href) {
      const kept = storedText(href);
      if (kept) {
        stats.storeHits += 1;
        return { text: kept.text, url: kept.url };
      }
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'dk.net.text', url: href, charset: doc.characterSet });
        if (!reply || reply.ok !== true || typeof reply.text !== 'string') {
          failures.set(href, !reply || TRANSIENT_REASONS.has(String(reply.code)));
          return null;
        }
        failures.delete(href);
        const url = String(reply.url || href);
        storeText(href, reply.text, url);
        return { text: reply.text, url };
      } catch {
        failures.set(href, true);
        return null;
      }
    }

    async function pump() {
      if (pumping || dead) return;
      pumping = true;
      try {
        sl.reset();
        while (pending.size && !dead) {
          const node = /** @type {HTMLStyleElement | HTMLLinkElement} */ (pending.values().next().value);
          pending.delete(node);
          try {
            await processNode(node);
          } catch (error) {
            fault(error);
          }
          if (sl.shouldYield()) await sl.yieldNow();
        }
      } finally {
        sl.finish();
        pumping = false;
      }
      if (dead) return;
      if (pending.size) void pump();
      else {
        fillMarkers();
        siteMod?.finishRepair();
        maybeRelease();
        markReady();
      }
    }

    function markReady() {
      if (dead) return;
      if (stats.readyAt !== null) {
        // A sheet that was loading at ready ends the wait for the page's dark theme when it arrives.
        if (siteState === 'pending' && !pending.size && !pumping && !fetching.size && !loadListeners.size && !rootPasses) decideSite(true);
        return;
      }
      if (!inlineDone || !scanDone || pending.size || pumping || fetching.size || rootPasses || probeNeeded()) return;
      // A head sheet still loading may hold the page's dark theme: wait for it, as long as the hold would.
      if (loadListeners.size && blockingPending() && performance.now() - stats.startedAt < HOLD_LONG_MAX_MS) return;
      if (doc.readyState === 'loading') return;
      if (checkScheme()) return;
      fillMarkers();
      stats.readyAt = performance.now();
      sl.tune();
      sl.phase('live');
      if (staged) commit();
      else {
        decideSite(true);
        root.setAttribute(STATE, 'ready');
      }
      try {
        options.onReady?.();
      } catch {
        // The gate's callback must not stop the engine.
      }
    }

    /** Switch a staged engine on and the engine it replaces off, in one step so no frame sees both or neither. */
    function commit() {
      if (!staged || dead) return;
      staged = false;
      options.atCommit?.();
      if (/** @type {any} */ (globalThis).__dk?.calm?.holdsTransitions?.() === true) holdTransitions();
      options.onCommit?.();
      options.beforeCommit?.();
      for (const piece of pieceMedia.keys()) if (piece.isConnected) setMedia(piece);
      base.removeAttribute('media');
      inlineStyle?.removeAttribute('media');
      attrStyle?.removeAttribute('media');
      for (const rs of rootInline.values()) {
        rs.style?.removeAttribute('media');
        rs.attrs?.removeAttribute('media');
      }
      decideSite(true);
      rootsMod?.writeAll();
      root.setAttribute(STATE, 'ready');
    }

    /** @param {unknown} error */
    function fault(error) {
      stats.faults += 1;
      const now = Date.now();
      faultTimes.push(now);
      while (faultTimes.length && now - faultTimes[0] > 60000) faultTimes.shift();
      if (faultTimes.length >= FAULTS_BEFORE_STOP) {
        options.onFault?.(error);
        end();
      }
    }

    /* ---------------- the site's own dark theme ---------------- */

    /** Is the engine waiting for the module that judges the page's own dark theme (a sheet shows one)? It asks for the module the first time. */
    function probeNeeded() {
      if (siteMod || siteFailed || !siteEnabled) return false;
      const f = siteTotals();
      const wait = f.onlyLight === 0 && !f.capped && f.media + f.selectors + f.scheme + f.lightDark > 0;
      if (wait) {
        loadSiteTheme();
        if (siteLoading && !(/** @type {any} */ (globalThis).__dk?.sitetheme)) tellSiteWait(true);
      }
      return wait;
    }

    function siteTotals() {
      const t = { media: 0, selectors: 0, scheme: 0, lightDark: 0, onlyLight: 0, rules: 0, capped: false };
      for (const f of siteCounts.values()) {
        t.media += f.media;
        t.selectors += f.state;
        t.scheme += f.scheme;
        t.lightDark += f.lightDark;
        t.onlyLight += f.onlyLight;
        t.rules += f.rules;
        if (f.capped) t.capped = true;
      }
      return t;
    }

    /** Keep only the pieces of one kind and take the others out of the page. @param {boolean} site */
    function keepOnly(site) {
      for (const [node, pieces] of copies) {
        const keep = [];
        for (const piece of pieces) {
          if (sitePieces.has(piece) === site) keep.push(piece);
          else {
            piece.remove();
            pieceMedia.delete(piece);
          }
        }
        if (keep.length) copies.set(node, keep);
        else copies.delete(node);
      }
    }

    /** The page keeps no dark theme of its own that can be used: our theme shows, and the copies of its dark rules go. @param {string} reason */
    function giveUpSite(reason) {
      siteState = 'off';
      siteReason = reason;
      keepOnly(false);
      for (const piece of pieceMedia.keys()) setMedia(piece);
    }

    /** The inline styles and the markup colors are not themed when the site's own theme shows: the observers stop and the rules go. */
    function stopInline() {
      inlineOff = true;
      attrObserver?.disconnect();
      attrObserver = null;
      addObserver?.disconnect();
      addObserver = null;
      if (inlineTimer !== null) clearTimeout(inlineTimer);
      inlineTimer = null;
      inlineQueue.clear();
      for (const el of [inlineStyle, attrStyle]) {
        if (!el) continue;
        owned.delete(el);
        el.remove();
      }
      inlineStyle = null;
      attrStyle = null;
      rootsMod?.teardownAll();
      inlineValues.clear();
      inlineByText.clear();
      inlineAdded = [];
      for (const el of doc.querySelectorAll(`[${inlineAttr}]`)) el.removeAttribute(inlineAttr);
    }

    const siteContext = {
      options,
      check: siteCheck,
      info: repairInfo,
      cover: coverMap,
      copies,
      isSitePiece: (/** @type {Element} */ el) => sitePieces.has(/** @type {HTMLStyleElement} */ (el)),
      scheme: themeSettings.systemControls !== false,
      minContrast: SITE_MIN_CONTRAST,
      holdMs: REPAIR_HOLD_MS,
      show: () => {
        siteState = 'on';
        for (const piece of pieceMedia.keys()) if (piece.isConnected) setMedia(piece);
      },
      adoptedCopies: () => {
        /** @type {CSSStyleSheet[]} */
        const list = [];
        for (const state of adopted.values()) for (const copy of state.map.values()) if (copy && !copy.disabled) list.push(copy);
        return list;
      },
      giveUp: giveUpSite,
      keep: () => keepOnly(true),
      stopInline,
      setReason: (/** @type {string} */ reason) => {
        siteReason = reason;
      },
      rewriteAdopted: () => rootsMod?.rewriteAll(),
      setRepairing: (/** @type {boolean} */ on) => {
        repairing = on;
      },
      repairing: () => repairing,
      rw,
      rereadAll,
      holding: () => early !== null,
      dead: () => dead,
      release,
      isStyleRule,
      isGroup,
      normalize: (/** @type {string} */ selector) => rewrite.normalizeSelector(selector),
    };

    /** Read everything again with the rewriter in repair mode: the inline colors, the markup colors, the shadow roots, the constructed sheets and the sheets. @param {Node[]} nodes @returns {boolean} true when sheets are waiting */
    function rereadAll(nodes) {
      inlineMemo.clear();
      reader?.reset();
      inlineOff = false;
      inlineDone = false;
      attrRules.clear();
      attrDirty = false;
      void inlinePass();
      if (watcher?.roots.size || adopted.size) {
        void viaRoots((roots) => {
          if (watcher) for (const r of watcher.roots) roots.startRootInline(r);
          for (const [adoptedRoot, state] of adopted) {
            state.map.clear();
            void roots.syncAdopted(adoptedRoot);
          }
        });
      }
      for (const node of nodes) if (node.isConnected) pending.add(node);
      if (pending.size) void pump();
      return pending.size > 0;
    }

    /**
     * Choose between the site's own dark theme and ours. `final` is the last chance: the page is ready and nothing was found.
     * @param {boolean} final
     */
    function decideSite(final) {
      if (siteState !== 'pending' || dead || staged) return;
      if (pumping || pending.size || fetching.size) return;
      const found = siteTotals();
      const meta = doc.querySelector('meta[name="color-scheme" i]');
      if (found.onlyLight > 0 || (meta && siteApi.schemeOnlyLight(meta.getAttribute('content') ?? ''))) {
        giveUpSite('only-light');
        return;
      }
      if (found.capped) {
        giveUpSite('too-big');
        return;
      }
      if (found.media + found.selectors + found.scheme + found.lightDark === 0) {
        if (final && !loadListeners.size) giveUpSite('none');
        return;
      }
      if (!siteMod) {
        if (siteFailed) giveUpSite('no-probe');
        else loadSiteTheme();
        return;
      }
      activatePieces();
      siteMod.trySite(found);
    }

    /* ---------------- inline styles inside shadow roots ---------------- */

    // shadowroots.js is loaded at the first root or adopted sheet; `rootInline` and `adopted` are shared with it,
    // `rootPasses` counts the passes and the wait for the module.
    /** @type {Map<ShadowRoot, any>} */
    const rootInline = new Map();
    let rootPasses = 0;

    /* ---------------- sheets that change again and again ---------------- */

    /** The settle timer of each sheet node that is rewritten in a burst. @type {Map<Node, ReturnType<typeof setTimeout>>} */
    const settleTimers = new Map();

    /**
     * A sheet element changed. A sheet that changes again and again (an application that rewrites its style elements all
     * the time) is built once after it has been quiet for a moment, not at every change; its old copy stays in the page
     * meanwhile. The first build of a sheet and the first few changes are never delayed.
     * @param {Node} node
     */
    function touchSheet(node) {
      if (dead) return;
      if (options.coalesce === false) {
        enqueue(node);
        return;
      }
      const now = performance.now();
      const times = (editTimes.get(node) ?? []).filter((t) => now - t < CHURN_WINDOW_MS);
      times.push(now);
      editTimes.set(node, times);
      const waiting = settleTimers.get(node);
      if (waiting === undefined && (times.length <= CHURN_EDITS || !copies.has(node))) {
        enqueue(node);
        return;
      }
      if (waiting !== undefined) clearTimeout(waiting);
      stats.churnDeferred += 1;
      settleTimers.set(
        node,
        setTimeout(() => {
          settleTimers.delete(node);
          if (!dead && node.isConnected) enqueue(node);
        }, CHURN_SETTLE_MS),
      );
    }

    /* ---------------- observing the document ---------------- */

    /** @param {Node} n @returns {boolean} a sheet node was found */
    function consider(n) {
      if (!(n instanceof Element)) return false;
      if (isSheetNode(n)) {
        enqueue(n);
        return true;
      }
      let found = false;
      if (n.childElementCount) {
        for (const el of n.querySelectorAll(SHEET_SELECTOR)) {
          if (isSheetNode(el)) {
            enqueue(el);
            found = true;
          }
        }
      }
      return found;
    }

    /** @param {Node} n @returns {boolean} a sheet node was found */
    function forget(n) {
      if (!(n instanceof Element)) return false;
      let found = copies.has(n) || pending.has(n) || dormant.has(n);
      pending.delete(n);
      const waiting = settleTimers.get(n);
      if (waiting !== undefined) clearTimeout(waiting);
      settleTimers.delete(n);
      dropCopy(n);
      if (n.childElementCount) for (const el of n.querySelectorAll(SHEET_SELECTOR)) {
        found = true;
        pending.delete(el);
        dropCopy(el);
      }
      return found;
    }

    /** Style elements inside shadow roots whose text is watched on their own: the root itself is not watched for text. @type {WeakSet<Node>} */
    const watchedRootStyles = new WeakSet();
    /** @param {Node} node */
    function watchRootStyle(node) {
      if (!(node instanceof HTMLStyleElement) || watchedRootStyles.has(node) || !(node.getRootNode() instanceof ShadowRoot)) return;
      watchedRootStyles.add(node);
      mo.observe(node, { characterData: true, subtree: true });
    }

    /** A put-back was refused in this pass, and how long the next try waits (it doubles while the page keeps fighting). */
    let restoreRefused = false;
    let restoreWait = RESTORE_WINDOW_MS;

    /** May this node be put back now? Not more than a few times in a short while. @param {Element} el */
    function allowRestore(el) {
      const now = performance.now();
      const times = (restoreTimes.get(el) ?? []).filter((t) => now - t < RESTORE_WINDOW_MS);
      if (times.length >= RESTORE_MAX) {
        restoreTimes.set(el, times);
        stats.restoreGaveUp += 1;
        restoreRefused = true;
        return false;
      }
      times.push(now);
      restoreTimes.set(el, times);
      stats.restored += 1;
      return true;
    }

    /**
     * A sheet whose only change is its `media` keeps its copy: the pieces take the new media and nothing is built again.
     * Returns false when the sheet has to be looked at again (no copy yet, or the new media is print).
     * @param {Node} node
     */
    function retime(node) {
      const pieces = copies.get(node);
      if (!pieces || !tokens.has(node)) return false;
      const sheet = /** @type {HTMLStyleElement | HTMLLinkElement} */ (node).sheet;
      if (!sheet || sheet.disabled) return false;
      const mediaText = sheet.media.mediaText;
      if (/^\s*print\s*$/i.test(mediaText)) return false;
      const media = mediaText && mediaText !== 'all' ? mediaText : '';
      for (const piece of pieces) {
        pieceMedia.set(piece, media);
        setMedia(piece);
      }
      return true;
    }

    /* ---------------- sheets that script switches on and off ---------------- */

    // `style.disabled`, `sheet.disabled` and a link toggle leave no mutation record: the sheets are looked at again after a click,
    // key, change, becoming visible, a head change or a hook hint (no timer of its own).
    const SWITCH = {};
    const SWITCH_MS = 150;
    const checkSwitched = () => {
      if (!dead && copies.size + dormant.size + adopted.size > 0) later(SWITCH, recheckSwitched, SWITCH_MS);
    };
    const SWITCH_EVENTS = ['click', 'keydown', 'change'];
    const onVisible = () => {
      if (doc.visibilityState === 'visible') checkSwitched();
    };
    for (const name of SWITCH_EVENTS) doc.addEventListener(name, checkSwitched, { capture: true, passive: true });
    doc.addEventListener('visibilitychange', onVisible);

    function recheckSwitched() {
      if (dead) return;
      stats.switchChecks += 1;
      for (const node of [...copies.keys()]) {
        if (node.isConnected && switchedOff(/** @type {HTMLStyleElement | HTMLLinkElement} */ (node))) {
          dropCopy(node);
          dormant.add(node);
          stats.switchedOff += 1;
        }
      }
      for (const node of dormant) {
        if (!node.isConnected) dormant.delete(node);
        else if (/** @type {HTMLStyleElement | HTMLLinkElement} */ (node).sheet && !switchedOff(/** @type {HTMLStyleElement | HTMLLinkElement} */ (node))) {
          dormant.delete(node);
          enqueue(node);
        }
      }
      rootsMod?.recheckDisabled();
    }

    const RESTORE = {};
    /** The page removed something (a script that rebuilds the head, a component that clears its tree). Put back what is ours. */
    function restoreOwned() {
      if (dead) return;
      restoreRefused = false;
      for (const el of owned) {
        if (el.isConnected || !allowRestore(el)) continue;
        if (el === early) root.append(el);
        else if (el === attrStyle) (doc.head ?? root).prepend(el);
        else if (el === inlineStyle) placeInline(el);
        else (doc.head ?? root).append(el);
      }
      for (const [node, pieces] of copies) {
        if (!node.isConnected) continue;
        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i];
          if (piece.isConnected) continue;
          const anchor = i > 0 ? pieces[i - 1] : node;
          if (anchor.isConnected && allowRestore(piece)) /** @type {ChildNode} */ (anchor).after(piece);
        }
      }
      for (const rs of rootInline.values()) {
        if (!rs.root.host.isConnected) continue;
        if (rs.attrs && !rs.attrs.isConnected && allowRestore(rs.attrs)) rs.root.prepend(rs.attrs);
        if (rs.style && !rs.style.isConnected && allowRestore(rs.style)) (rs.attrs?.isConnected ? rs.attrs.after(rs.style) : rs.root.prepend(rs.style));
      }
      // A page that stopped removing gets its nodes back after the window.
      if (restoreRefused) {
        later(RESTORE, restoreOwned, restoreWait);
        restoreWait = Math.min(restoreWait * 2, RESTORE_RETRY_MAX_MS);
      } else restoreWait = RESTORE_WINDOW_MS;
      watchHeadAndBody();
    }

    const watchedHead = { value: /** @type {HTMLHeadElement | null} */ (null) };
    const watchedBody = { value: /** @type {HTMLElement | null} */ (null) };

    function watchHeadAndBody() {
      if (doc.head && watchedHead.value !== doc.head) {
        watchedHead.value = doc.head;
        mo.observe(doc.head, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['media', 'disabled', 'href', 'rel'],
        });
      }
      if (doc.body && watchedBody.value !== doc.body) {
        watchedBody.value = doc.body;
        mo.observe(doc.body, { childList: true });
        attrMo.observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['rel', 'href', 'media', 'disabled'] });
      }
    }

    const attrMo = new MutationObserver((records) => {
      if (dead) return;
      for (const r of records) if (r.target instanceof Element && (r.target.localName === 'link' || r.target.localName === 'style') && isSheetNode(r.target)) enqueue(r.target);
    });

    const mo = new MutationObserver((records) => {
      if (dead) return;
      try {
        // Only a change of the document's own nodes asks for the look at switched sheets (a `disabled` set by script leaves no
        // record, a re-render of the body does): a busy component in a shadow root must not keep that pass running.
        let touched = false;
        for (const r of records) {
          if (r.type === 'childList') {
            for (const n of r.addedNodes) if (consider(n)) touched = true;
            for (const n of r.removedNodes) if (forget(n)) touched = true;
            if (r.removedNodes.length) {
              clearTimeout(timers.get(RESTORE));
              timers.delete(RESTORE);
              later(RESTORE, restoreOwned, 0);
            }
            if (isSheetNode(r.target)) {
              touchSheet(r.target);
              touched = true;
            } else if (!touched && r.target.getRootNode() === doc) touched = true;
          } else if (r.type === 'characterData') {
            const parent = r.target.parentElement;
            if (isSheetNode(parent)) {
              touchSheet(/** @type {Node} */ (parent));
              touched = true;
            }
          } else if (r.type === 'attributes') {
            if (isSheetNode(r.target)) {
              if (!(r.attributeName === 'media' && retime(r.target))) touchSheet(r.target);
              touched = true;
            }
          }
        }
        watchHeadAndBody();
        maybeRelease();
        if (touched) checkSwitched();
      } catch (error) {
        fault(error);
      }
    });
    mo.observe(root, { childList: true });
    watchHeadAndBody();

    for (const el of doc.querySelectorAll(SHEET_SELECTOR)) if (isSheetNode(el)) enqueue(el);

    /* ---------------- shadow roots and constructed sheets ---------------- */

    const SETTLE_MS = 40;
    /** Timers that merge a burst of hints into one run, keyed by what they are about. @type {Map<unknown, ReturnType<typeof setTimeout>>} */
    const timers = new Map();
    /** @param {unknown} key @param {() => void} fn @param {number} [delay] */
    function later(key, fn, delay = SETTLE_MS) {
      if (dead || timers.has(key)) return;
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          if (!dead) fn();
        }, delay),
      );
    }

    /** @type {Map<Document | ShadowRoot, { map: Map<CSSStyleSheet, CSSStyleSheet | null>, token: object }>} */
    const adopted = new Map();
    /** The override sheets of this engine only: the ones it removes when it ends. */
    const mine = new WeakSet();
    /** @param {Document | ShadowRoot} root */
    const hasAdopted = (root) => {
      try {
        // The first-paint hold (early/sheet.js) is not the page's.
        return Array.from(root.adoptedStyleSheets).some((s) => s !== /** @type {any} */ (globalThis).__dkHold);
      } catch {
        return false;
      }
    };

    /** After a flood of hints some may have been lost, so look at everything once. */
    function rescanAll() {
      if (dead) return;
      stats.rescans += 1;
      watcher?.prune();
      for (const el of doc.querySelectorAll(SHEET_SELECTOR)) if (isSheetNode(el)) enqueue(el);
      if (watcher) for (const root of watcher.roots) enqueueSheets(root);
      rootsMod?.touchConstructed();
    }

    /** @param {ParentNode} root */
    function enqueueSheets(root) {
      for (const el of root.querySelectorAll(SHEET_SELECTOR)) if (isSheetNode(el)) enqueue(el);
    }

    /** @type {any} */
    let rootsMod = null;
    let rootsLoading = false;
    let rootsFailed = false;
    /** @type {Array<() => void>} */
    const rootsQueue = [];

    /**
     * Run `fn` with the module for the roots, which is loaded on the first use. The page is held while it loads (`rootPasses`). The
     * answer is the result of `fn`; when the module cannot be loaded, `fn` does not run and the answer is undefined.
     * @param {(roots: any) => any} fn
     */
    function viaRoots(fn) {
      if (rootsMod) {
        try {
          return Promise.resolve(fn(rootsMod));
        } catch (error) {
          fault(error);
          return Promise.resolve();
        }
      }
      if (rootsFailed || dead) return Promise.resolve();
      return new Promise((resolve) => {
        rootsQueue.push(() => {
          try {
            resolve(rootsMod ? fn(rootsMod) : undefined);
          } catch (error) {
            fault(error);
            resolve(undefined);
          }
        });
        if (rootsLoading) return;
        rootsLoading = true;
        rootPasses += 1;
        const need = /** @type {any} */ (globalThis).__dk?.need;
        Promise.resolve(typeof need === 'function' ? need('shadowroots') : false).then((ok) => {
          rootsLoading = false;
          rootPasses -= 1;
          if (!dead && ok === true && /** @type {any} */ (globalThis).__dk?.shadowroots) rootsMod = /** @type {any} */ (globalThis).__dk.shadowroots.create(makeRootsContext());
          else {
            rootsFailed = true;
            // A module that comes later takes the roots over: they are scanned again.
            /** @type {any} */ (globalThis).__dk?.optional?.whenLoaded?.('shadowroots', () => {
              if (dead || !rootsFailed || !(/** @type {any} */ (globalThis).__dk?.shadowroots)) return;
              rootsFailed = false;
              rootsMod = /** @type {any} */ (globalThis).__dk.shadowroots.create(makeRootsContext());
              void scanShadowRoots();
            });
          }
          for (const run of rootsQueue.splice(0)) run();
          if (dead) return;
          maybeRelease();
          markReady();
        });
      });
    }

    const makeRootsContext = () => ({
      doc,
      stats,
      sl,
      rootInline,
      adopted,
      ours,
      mine,
      attrRules,
      dead: () => dead,
      inlineOff: () => inlineOff,
      staged: () => staged,
      skipSite: () => siteState === 'on' && !repairing,
      inlineAttr,
      selector: INLINE_SELECTOR,
      limits: { rate: INLINE_RATE, now: INLINE_NOW, pause: INLINE_PAUSE_MS, pauseMax: INLINE_PAUSE_MAX_MS, add: ADD_BUDGET, settle: SETTLE_MS },
      hasInlineHint,
      inlineRule,
      attrSheetText,
      processInline,
      flushInline,
      scanAttrs,
      visitAdded,
      readAttrs,
      flushAttrs,
      attrVersion: () => attrVersion,
      bumpEditable: () => {
        editableEpoch += 1;
      },
      passes: (/** @type {number} */ n) => {
        rootPasses += n;
      },
      later,
      fault,
      maybeRelease,
      markReady,
      newBudget,
      emitList,
      observe: (/** @type {ShadowRoot} */ root) =>
        mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['media', 'disabled', 'href', 'rel'] }),
      enqueueSheets,
    });

    const watcher = shadowApi
      ? shadowApi.createWatcher({
          document: doc,
          onRoot: (/** @type {ShadowRoot} */ root) => {
            void viaRoots((roots) => roots.watchRoot(root));
            for (const listener of rootListeners) listener.add(root);
          },
          onAdopt: (/** @type {Document | ShadowRoot} */ root) => void viaRoots((roots) => roots.touchAdopt(root)),
          onSheet: (/** @type {HTMLStyleElement} */ node) => {
            edited.add(node);
            later(node, () => touchSheet(node));
            checkSwitched();
          },
          onConstructed: () => {
            void viaRoots((roots) => roots.touchConstructed());
            checkSwitched();
          },
          onOverflow: rescanAll,
          onRelease: releaseRoots,
        })
      : null;

    /** Tag names of released hosts (for a revive query). @type {Set<string>} */
    const releasedNames = new Set();
    const RELEASED_NAMES_MAX = 40;

    /** Forget roots whose host left the document: state, sheet copies, waiting sheets. @param {ShadowRoot[]} gone */
    function releaseRoots(gone) {
      if (dead) return;
      const set = new Set(gone);
      for (const root of gone) if (releasedNames.size < RELEASED_NAMES_MAX) releasedNames.add(root.host.localName);
      const inside = (/** @type {Node} */ node) => set.has(/** @type {ShadowRoot} */ (node.getRootNode()));
      for (const node of [...copies.keys()]) if (inside(node)) dropCopy(node);
      for (const node of [...pending]) if (inside(node)) pending.delete(node);
      for (const node of [...dormant]) if (inside(node)) dormant.delete(node);
      for (const node of [...loadListeners.keys()]) if (inside(node)) dropCopy(node);
      for (const node of [...unreachable]) if (inside(node)) unreachable.delete(/** @type {HTMLLinkElement} */ (node));
      for (const node of [...settleTimers.keys()]) if (inside(node)) {
        clearTimeout(settleTimers.get(node));
        settleTimers.delete(node);
      }
      void viaRoots((roots) => roots.release(gone));
      for (const listener of rootListeners) listener.drop(gone);
      stats.rootsReleased += gone.length;
    }

    async function scanShadowRoots() {
      try {
        // Undefined custom elements will get roots: fetch the module before they do.
        if (!rootsMod && doc.querySelector(':not(:defined)')) void /** @type {any} */ (globalThis).__dk?.need?.('shadowroots');
        if (watcher) {
          await watcher.scan(doc, (/** @type {any} */ items, /** @type {any} */ fn, /** @type {any} */ stop) =>
            sl.forEach(items, fn, stop),
          );
        }
        if (hasAdopted(doc)) await viaRoots((roots) => roots.syncAdopted(doc));
      } catch (error) {
        fault(error);
      }
      if (dead) return;
      scanDone = true;
      maybeRelease();
      markReady();
    }

    if (hasAdopted(doc)) void viaRoots((roots) => roots.syncAdopted(doc));
    else if (/** @type {any} */ (globalThis).__dk?.shadowSeen === true) void viaRoots(() => undefined);

    /* ---------------- inline styles ---------------- */

    /** The rule of each shared value: the declaration text and how many elements use it. @type {Map<string, { text: string, count: number }>} */
    const inlineValues = new Map();
    /** The id of each distinct declaration text. @type {Map<string, string>} */
    const inlineByText = new Map();
    /** The value id an element was given by this engine. A copy of an element carries the attribute but is not in here. @type {WeakMap<Element, string>} */
    const inlineMember = new WeakMap();
    let inlinePauseMs = INLINE_PAUSE_MS;
    let lastCompact = 0;
    /** @type {HTMLStyleElement | null} */
    let inlineStyle = null;
    let inlineDirty = false;
    /** @type {string[]} */
    let inlineAdded = [];
    let inlineRebuild = false;
    let inlineStale = 0;
    let inlineCounter = 0;
    /** @type {MutationObserver | null} */
    let attrObserver = null;
    /** @type {Set<Element>} */
    const inlineQueue = new Set();
    /** @type {ReturnType<typeof setTimeout> | null} */
    let inlineTimer = null;
    let rateWindowStart = 0;
    let rateCount = 0;

    /** The elements a fix leaves alone. A selector the browser refuses is dropped, not a fault. */
    const skipSelector = (options.ignoreInline ?? [])
      .filter((s) => {
        try {
          doc.createDocumentFragment().querySelector(s);
          return true;
        } catch {
          return false;
        }
      })
      .join(',');
    /** @param {Element} el */
    const ignored = (el) => skipSelector !== '' && el.matches(skipSelector);

    const INLINE_SELECTOR = '[style],svg[fill],svg[stroke],svg [fill],svg [stroke],svg [stop-color],svg [flood-color]';
    /** @param {Element} n */
    const hasInlineHint = (n) => n.hasAttribute('style') || (n instanceof SVGElement && (n.hasAttribute('fill') || n.hasAttribute('stroke') || n.hasAttribute('stop-color') || n.hasAttribute('flood-color')));

    /** @type {WeakMap<Element, { n: number, value: boolean }>} */
    const codeSvgs = new WeakMap();

    /** An SVG that is square, drawn with crisp edges and only black and white: a QR code or a bar code. @param {SVGElement} svg */
    function isCodeSvg(svg) {
      const n = svg.childElementCount;
      const known = codeSvgs.get(svg);
      if (known && known.n === n) return known.value;
      let value = false;
      try {
        value = looksLikeCode(svg);
      } catch {
        value = false;
      }
      codeSvgs.set(svg, { n, value });
      return value;
    }

    /** @param {SVGElement} svg */
    function looksLikeCode(svg) {
      if (svg.getAttribute('shape-rendering') !== 'crispEdges' && svg.querySelector('[shape-rendering="crispEdges"]') === null) return false;
      const dims = [svg.getAttribute('width'), svg.getAttribute('height')].map((v) => (v ? parseFloat(v) : NaN));
      const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      const w = Number.isFinite(dims[0]) ? dims[0] : box && box.length === 4 ? box[2] : NaN;
      const h = Number.isFinite(dims[1]) ? dims[1] : box && box.length === 4 ? box[3] : NaN;
      if (!(w > 0 && h > 0) || Math.abs(w - h) > 0.02 * Math.max(w, h)) return false;
      let seen = 0;
      for (const e of [svg, ...svg.querySelectorAll('[fill], [stroke]')]) {
        if (++seen > 5000) return false;
        for (const name of ['fill', 'stroke']) {
          const v = e.getAttribute(name);
          if (v !== null && !CODE_COLORS.has(v.trim().toLowerCase().replace(/\s+/g, ''))) return false;
        }
      }
      return true;
    }

    const MARKER_STROKE = 6;
    /** @param {SVGElement} el @returns {number} the stroke width of a shape, from the attribute or the inline style, or 0 */
    function strokeWidthOf(el) {
      const raw = el.getAttribute('stroke-width') ?? (el instanceof SVGElement ? el.style.strokeWidth : '');
      const n = parseFloat(raw ?? '');
      return Number.isFinite(n) ? n : 0;
    }

    /**
     * SVG colors set with attributes (`fill="#0f1111"`). In a small icon they are text colors; in a large drawing a light
     * fill is a background. Written as keyed rules, so the attribute itself is not edited.
     * @param {Element} el
     */
    function svgAttributeText(el) {
      if (!(el instanceof SVGElement)) return '';
      let out = '';
      const owner = el.ownerSVGElement ?? (el instanceof SVGSVGElement ? el : null);
      if (owner && isCodeSvg(owner)) return '';
      let icon = true;
      if (owner) {
        const dims = [owner.getAttribute('width'), owner.getAttribute('height')].map((v) => (v ? parseFloat(v) : NaN));
        const box = owner.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
        const w = Number.isFinite(dims[0]) ? dims[0] : box && box.length === 4 ? box[2] : NaN;
        const h = Number.isFinite(dims[1]) ? dims[1] : box && box.length === 4 ? box[3] : NaN;
        icon = !(w > 64 || h > 64);
      }
      for (const name of ['fill', 'stroke', 'stop-color', 'flood-color']) {
        const raw = el.getAttribute(name);
        if (!raw) continue;
        const value = raw.trim();
        if (/^(none|currentcolor|inherit|transparent|context-fill|context-stroke|url\()/i.test(value) || value.length > 60) continue;
        const parsed = color.parseColor(/^[0-9a-f]{6}$/i.test(value) ? `#${value}` : value);
        if (!parsed || parsed.a <= 0) continue;
        const light = color.toOklch(parsed)[0] > 0.7;
        // A wide light stroke is a marker laid behind text (a highlight), so it is a background and gets no text contrast floor.
        const marker = name === 'stroke' && light && strokeWidthOf(el) >= MARKER_STROKE;
        // The rectangle of a pattern is the ground of its tile.
        const property = (name === 'fill' && ((!icon && light) || (el.localName === 'rect' && el.parentElement?.localName === 'pattern'))) || marker ? 'background-color' : name;
        const v = rw.declaration(property, /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : value, doc.baseURI);
        if (v !== null && v !== value) out += `${name}:${v};`;
      }
      return out;
    }

    /** An element stops using its shared value; the rule goes when nobody uses it. @param {string} id */
    function releaseInline(id) {
      const value = inlineValues.get(id);
      if (!value) return;
      value.count -= 1;
      if (value.count <= 0) {
        inlineValues.delete(id);
        inlineByText.delete(value.text);
        inlineStale += 1;
        inlineDirty = true;
      }
    }

    /** Drop the rules that no element in the document or in a watched shadow root uses any more (their elements were removed), and count the marked elements again. */
    function compactInline() {
      const now = performance.now();
      if (now - lastCompact < 2000) return;
      lastCompact = now;
      /** @type {Map<string, number>} */
      const live = new Map();
      let elements = 0;
      /** @param {Document | ShadowRoot} scope */
      const count = (scope) => {
        for (const el of scope.querySelectorAll(`[${inlineAttr}]`)) {
          const id = el.getAttribute(inlineAttr);
          if (id) {
            live.set(id, (live.get(id) ?? 0) + 1);
            elements += 1;
          }
        }
      };
      count(doc);
      for (const [shadow, rs] of rootInline) if (!rs.gone) count(shadow);
      stats.inlineElements = elements;
      for (const [id, value] of [...inlineValues]) {
        const n = live.get(id);
        if (n === undefined) {
          inlineValues.delete(id);
          inlineByText.delete(value.text);
          inlineDirty = true;
          inlineRebuild = true;
        } else value.count = n;
      }
    }

    /** When an element was last found outside an editable area, and the count of `contenteditable` changes then. The answer is kept for a moment, so a page that writes the same elements on every frame is not asked again; a change of `contenteditable` ends it at once, a class that makes an editor ends it with the time. @type {WeakMap<Element, { at: number, epoch: number }>} */
    const outsideEditable = new WeakMap();
    const EDITABLE_KEEP_MS = 1000;
    let editableEpoch = 0;

    /** @param {Element} el */
    function inEditable(el) {
      const now = performance.now();
      const known = outsideEditable.get(el);
      if (known !== undefined && known.epoch === editableEpoch && now - known.at < EDITABLE_KEEP_MS) return false;
      const inside = el.closest(EDITABLE) !== null;
      if (!inside) outsideEditable.set(el, { at: now, epoch: editableEpoch });
      return inside;
    }

    // Inline rules come before the sheet copies, so an important page rule of the same weight beats a plain inline value; an
    // important inline value names the attribute twice.
    const BOOST = '\u0001';
    // SVG presentation attributes come before the HINT mark. A presentation attribute loses to every rule of the page,
    // layered ones too, so its rule has no weight, no `!important`, and sits in the hint layer (HINT_LAYER).
    const HINT = '\u0002';
    /** The rules of an inline value. @param {string} id @param {string} text @returns {string[]} */
    function inlineRule(id, text) {
      const one = `[${inlineAttr}="${id}"]`;
      const cut = text.indexOf(HINT);
      const own = cut < 0 ? text : text.slice(cut + 1);
      const out = cut > 0 ? [`@layer ${HINT_LAYER}{:where(${one}){${text.slice(0, cut)}}}`] : [];
      if (own !== '') out.push(own.startsWith(BOOST) ? `${one}${one}{${own.slice(1)}}` : `${one}{${own}}`);
      return out;
    }

    /** @param {CSSStyleDeclaration} style @param {string} raw the style attribute */
    function inlineStyleText(style, raw) {
      let part = inlineMemo.get(raw);
      if (part !== undefined) {
        stats.inlineMemoHits += 1;
        return part;
      }
      part = style.length ? declarationsText(style, doc.baseURI, true) : '';
      // An `!important` `color` in the style attribute beats every rule of ours; the text fill color is rarely set, so the text keeps the theme.
      if (part !== '' && style.length && style.getPropertyPriority('color') === 'important' && style.getPropertyValue('-webkit-text-fill-color') === '') {
        const themed = /(?:^|;)color:([^;]*?)!important;/.exec(part);
        if (themed) part += `-webkit-text-fill-color:${themed[1]}!important;`;
      }
      if (part !== '') {
        for (let i = 0; i < style.length; i++) {
          if (style.getPropertyPriority(style[i]) === 'important') {
            part = `${BOOST}${part}`;
            break;
          }
        }
      }
      if (raw.length <= INLINE_MEMO_CHARS) {
        if (inlineMemo.size >= INLINE_MEMO_MAX) inlineMemo.clear();
        inlineMemo.set(raw, part);
      }
      return part;
    }

    /**
     * @param {Element} el
     * @param {{ ids: Map<string, string>, added: string[], dirty: boolean } | null} [rs]  the state of the shadow root the element is in: its rule goes into the style element of that root
     */
    function processInline(el, rs = null) {
      const style = /** @type {HTMLElement} */ (el).style;
      if (!style) return;
      const raw = el.getAttribute('style');
      // A style attribute with no themed property (transform, width, position) is common on busy pages: it is not parsed.
      // SVG elements may still carry colors in attributes. A value seen before names one, so it is not tested again.
      const plain = raw !== null && !inlineMemo.has(raw) && raw.length <= INLINE_PLAIN_MAX && !COLOR_WORDS.test(raw) && raw.indexOf('\\') < 0 && raw.indexOf('/*') < 0;
      let text = '';
      if (plain) stats.inlinePlain += 1;
      if (!plain || el instanceof SVGElement) {
        const editable = inEditable(el);
        if (editable) stats.skippedEditable += 1;
        if (!ignored(el) && !editable) {
          const own = plain || raw === null ? '' : inlineStyleText(style, raw);
          const hint = svgAttributeText(el);
          text = hint === '' ? own : hint + HINT + own;
        }
      }
      const current = inlineMember.get(el);
      if (text === '') {
        if (current !== undefined) {
          releaseInline(current);
          inlineMember.delete(el);
          stats.inlineElements -= 1;
        }
        if (el.hasAttribute(inlineAttr)) el.removeAttribute(inlineAttr);
        return;
      }
      // Elements the page removed still count until the marked elements are counted again.
      if (current === undefined && stats.inlineElements >= MAX_INLINE_ELEMENTS) compactInline();
      let id = inlineByText.get(text);
      if (id === undefined) {
        if (inlineValues.size >= MAX_INLINE) compactInline();
        if (inlineValues.size >= MAX_INLINE) {
          stats.inlineCapped = true;
          if (current !== undefined) {
            releaseInline(current);
            inlineMember.delete(el);
            stats.inlineElements -= 1;
          }
          if (el.hasAttribute(inlineAttr)) el.removeAttribute(inlineAttr);
          return;
        }
        id = String(++inlineCounter);
        inlineByText.set(text, id);
        inlineValues.set(id, { text, count: 0 });
        inlineAdded.push(id);
        inlineDirty = true;
      }
      if (current !== id) {
        if (current === undefined) {
          if (stats.inlineElements >= MAX_INLINE_ELEMENTS) {
            stats.inlineCapped = true;
            return;
          }
          stats.inlineElements += 1;
        } else releaseInline(current);
        const value = /** @type {{ text: string, count: number }} */ (inlineValues.get(id));
        value.count += 1;
        inlineMember.set(el, id);
      }
      if (el.getAttribute(inlineAttr) !== id) el.setAttribute(inlineAttr, id);
      if (rs && !rs.ids.has(id)) {
        const known = inlineValues.get(id);
        if (known) {
          rs.ids.set(id, known.text);
          rs.added.push(id);
          rs.dirty = true;
        }
      }
      stats.inline = inlineValues.size;
    }

    /* ---------------- presentational attributes (bgcolor, text, link, font color) ---------------- */

    // Old pages color with attributes. They are hints with no specificity, so these rules use `:where()`, sit before the
    // copies of the page's sheets and live in the hint layer; page rules, layered or not, still win.
    const ATTR_SELECTOR = '[bgcolor],body[background],table[background],thead[background],tbody[background],tfoot[background],tr[background],td[background],th[background],body[text],body[link],body[vlink],body[alink],font[color]';
    const LEGACY_BACKGROUND = new Set(['body', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);
    const MAX_ATTR_RULES = 400;
    /** @type {Map<string, string>} */
    const attrRules = new Map();
    /** @type {HTMLStyleElement | null} */
    let attrStyle = null;
    let attrDirty = false;
    let attrVersion = 0;

    /** @param {string} kind @param {string} selectorHead @param {string} property @param {string} raw */
    function addAttrRule(kind, selectorHead, property, raw) {
      const key = `${kind}|${raw}`;
      if (attrRules.has(key) || attrRules.size >= MAX_ATTR_RULES || raw.length > 128 || /["\\\n\r\f]/.test(raw)) return;
      const value = color.legacyColor(raw);
      if (value === null) {
        attrRules.set(key, '');
        return;
      }
      const v = rw.declaration(property, value, doc.baseURI);
      attrRules.set(key, v === null ? '' : `:where(${selectorHead.replace('%', raw)}){${property}:${v}}`);
      if (v !== null) attrDirty = true;
    }

    /** @param {Element} el */
    function readAttrs(el) {
      const tag = el.localName;
      if (LEGACY_BACKGROUND.has(tag) && el.hasAttribute('background')) {
        tellImages('legacy', el);
      }
      const bg = el.getAttribute('bgcolor');
      if (bg !== null) addAttrRule('bg', '[bgcolor="%" i]', 'background-color', bg);
      if (tag === 'body') {
        const text = el.getAttribute('text');
        if (text !== null) addAttrRule('text', 'body[text="%" i]', 'color', text);
        for (const [name, pseudo] of /** @type {const} */ ([['link', ':link'], ['vlink', ':visited'], ['alink', ':active']])) {
          const v = el.getAttribute(name);
          if (v !== null) addAttrRule(name, `body[${name}="%" i] a${pseudo}`, 'color', v);
        }
      } else if (tag === 'font') {
        const c = el.getAttribute('color');
        if (c !== null) addAttrRule('font', 'font[color="%" i]', 'color', c);
      }
    }

    /** @param {ParentNode} scope */
    function scanAttrs(scope) {
      if (scope instanceof Element && scope.matches(ATTR_SELECTOR)) readAttrs(scope);
      let n = 0;
      for (const el of scope.querySelectorAll(ATTR_SELECTOR)) {
        if (++n > 20000) break;
        readAttrs(el);
      }
      flushAttrs();
    }

    function attrSheetText() {
      return `@media screen{@layer ${HINT_LAYER}{${[...attrRules.values()].join('')}}}`;
    }

    function flushAttrs() {
      if (!attrDirty || dead || inlineOff) return;
      attrDirty = false;
      stats.attrs = attrRules.size;
      if (!attrStyle) {
        attrStyle = doc.createElement('style');
        attrStyle.setAttribute('data-dk', 'attrs');
        if (staged) attrStyle.media = 'not all';
        (doc.head ?? root).prepend(attrStyle);
        owned.add(attrStyle);
      }
      attrStyle.textContent = attrSheetText();
      attrVersion += 1;
      rootsMod?.flushAttrs();
    }

    /** Inline rules go after the attribute rules and before the rest. @param {HTMLStyleElement} el */
    function placeInline(el) {
      if (attrStyle?.isConnected) attrStyle.after(el);
      else (doc.head ?? root).prepend(el);
    }

    function flushInline() {
      if (!inlineDirty || dead || inlineOff) return;
      inlineDirty = false;
      if (!inlineStyle) {
        inlineStyle = doc.createElement('style');
        inlineStyle.setAttribute('data-dk', 'inline');
        if (staged) inlineStyle.media = 'not all';
        placeInline(inlineStyle);
        owned.add(inlineStyle);
      }
      stats.inline = inlineValues.size;
      if (!inlineRebuild && inlineStale <= 500 && inlineStyle.sheet && inlineStyle.sheet.cssRules.length === 1) {
        try {
          const block = /** @type {CSSGroupingRule} */ (inlineStyle.sheet.cssRules[0]);
          for (const id of inlineAdded) {
            const value = inlineValues.get(id);
            if (value) for (const rule of inlineRule(id, value.text)) block.insertRule(rule, block.cssRules.length);
          }
          inlineAdded = [];
          return;
        } catch {
          // Fall through to a full write.
        }
      }
      let css = '';
      for (const [id, value] of inlineValues) css += inlineRule(id, value.text).join('');
      inlineStyle.textContent = `@media screen{${css}}`;
      inlineAdded = [];
      inlineRebuild = false;
      inlineStale = 0;
    }

    function drainInlineQueue() {
      inlineTimer = null;
      if (dead || inlineOff) return;
      const began = performance.now();
      // A long queue is worked off in short tasks, so a bulk insert never holds the page for long.
      for (const el of inlineQueue) {
        inlineQueue.delete(el);
        if (el.isConnected) processInline(el);
        if (inlineQueue.size && performance.now() - began > DRAIN_SLICE_MS) {
          inlineTimer = setTimeout(drainInlineQueue, 0);
          break;
        }
      }
      flushInline();
      stats.inlineMs += performance.now() - began;
      stats.longestAddMs = Math.max(stats.longestAddMs, performance.now() - began);
    }

    const RESUME = {};
    function resumeAttributeObserver() {
      if (dead || inlineOff || attrObserver) return;
      rateWindowStart = performance.now();
      rateCount = 0;
      stats.inlineObserverOff = false;
      observeAttributes();
      void rescanInline();
    }

    /** One look at every element that may carry an inline color, after the observer was away. */
    async function rescanInline() {
      if (inlineOff) return;
      try {
        sl.reset();
        scanAttrs(doc);
        await sl.forEach(doc.querySelectorAll(INLINE_SELECTOR), processInline, () => dead);
        flushInline();
      } catch (error) {
        fault(error);
      }
    }

    function startAttributeObserver() {
      observeAttributes();
      startAddObserver();
    }

    function observeAttributes() {
      attrObserver = new MutationObserver((records) => {
        const now = performance.now();
        if (now - rateWindowStart > 1000) {
          rateWindowStart = now;
          rateCount = 0;
        }
        rateCount += records.length;
        if (rateCount > INLINE_RATE) {
          // A burst is not followed record by record: the observer pauses, then looks at everything once, so no color set in the burst is lost.
          attrObserver?.disconnect();
          attrObserver = null;
          inlineQueue.clear();
          stats.inlineObserverOff = true;
          stats.inlinePauses += 1;
          const wait = inlinePauseMs;
          inlinePauseMs = Math.min(inlinePauseMs * 2, INLINE_PAUSE_MAX_MS);
          later(RESUME, resumeAttributeObserver, wait);
          return;
        }
        for (const r of records) {
          if (!(r.target instanceof Element)) continue;
          if (r.attributeName === 'style' || r.attributeName === 'fill' || r.attributeName === 'stroke' || r.attributeName === 'stop-color' || r.attributeName === 'flood-color') inlineQueue.add(r.target);
          else if (r.attributeName === 'contenteditable') editableEpoch += 1;
          else readAttrs(r.target);
        }
        flushAttrs();
        if (inlineQueue.size && inlineQueue.size <= INLINE_NOW) {
          // A callback of the observer runs before the next frame is drawn. A color that is themed here is never seen in
          // the page's own value, not even for one frame.
          if (inlineTimer !== null) clearTimeout(inlineTimer);
          drainInlineQueue();
        } else if (inlineQueue.size && inlineTimer === null) inlineTimer = setTimeout(drainInlineQueue, 40);
      });
      attrObserver.observe(doc, { attributes: true, attributeFilter: ['style', 'background', 'bgcolor', 'text', 'link', 'vlink', 'alink', 'color', 'fill', 'stroke', 'stop-color', 'flood-color', 'contenteditable'], subtree: true });
    }


    /** Every sheet of the document that has not been looked at yet. */
    function scanMissing() {
      if (dead) return;
      for (const el of doc.querySelectorAll(SHEET_SELECTOR)) if (isSheetNode(el) && !tokens.has(el) && !pending.has(el)) enqueue(el);
    }

    /** @type {MutationObserver | null} */
    let addObserver = null;
    let addWindowStart = 0;
    let addBudget = ADD_BUDGET;

    // One query finds what a new subtree holds (inline colors, markup attributes, sheets). Wide subtrees are split and what a
    // callback cannot do in a few ms goes on in slices, so a bulk insert makes no long task.
    const ADDED_SELECTOR = `${ATTR_SELECTOR},${SHEET_SELECTOR},${INLINE_SELECTOR}`;
    const ADDED_SPLIT = 48;
    const ADDED_SYNC_MS = 4;

    /**
     * Sort what the added node `n` holds: `onInline` gets elements with inline hints, attributes are read, sheets are queued if `sheets`.
     * @param {Element} n @param {(el: Element) => void} onInline @param {boolean} sheets
     * @param {Element[] | null} [rest]  receives the children of a wide `n`
     */
    function visitAdded(n, onInline, sheets, rest = null) {
      if (hasInlineHint(n)) onInline(n);
      if (n.matches(ATTR_SELECTOR)) readAttrs(n);
      if (sheets && isSheetNode(n) && !tokens.has(n) && !pending.has(n)) enqueue(n);
      if (!n.firstElementChild) return;
      if (rest && n.childElementCount > ADDED_SPLIT) {
        for (const child of n.children) rest.push(child);
        return;
      }
      for (const el of n.querySelectorAll(ADDED_SELECTOR)) {
        const tag = el.localName;
        if ((tag === 'style' || tag === 'link') && sheets) {
          if (isSheetNode(el) && !tokens.has(el) && !pending.has(el)) enqueue(el);
          continue;
        }
        if (hasInlineHint(el)) onInline(el);
        readAttrs(el);
      }
    }

    /** The added roots waiting their turn. @type {Element[]} */
    const addedRoots = [];
    let addedAt = 0;
    let addedPumping = false;
    const takeInline = (/** @type {Element} */ el) => {
      if (addBudget-- > 0) inlineQueue.add(el);
    };

    /** @param {Element} n */
    function lookAtAdded(n) {
      visitAdded(n, takeInline, !doc.head?.contains(n), addedRoots);
    }

    /** Look at the added roots for a few ms; the rest goes on in slices. */
    function pumpAdded() {
      const began = performance.now();
      while (addedAt < addedRoots.length && performance.now() - began < ADDED_SYNC_MS) {
        const n = addedRoots[addedAt++];
        if (n.isConnected) lookAtAdded(n);
      }
      flushAttrs();
      stats.longestAddMs = Math.max(stats.longestAddMs, performance.now() - began);
      if (addedAt < addedRoots.length) void sliceAdded();
      else {
        addedRoots.length = 0;
        addedAt = 0;
      }
    }

    async function sliceAdded() {
      if (addedPumping) return;
      addedPumping = true;
      try {
        sl.reset();
        let began = performance.now();
        while (addedAt < addedRoots.length && !dead && !inlineOff) {
          const n = addedRoots[addedAt++];
          if (n.isConnected) lookAtAdded(n);
          if (sl.shouldYield()) {
            flushAttrs();
            if (inlineQueue.size && inlineTimer === null) inlineTimer = setTimeout(drainInlineQueue, 40);
            stats.longestAddMs = Math.max(stats.longestAddMs, performance.now() - began);
            await sl.yieldNow();
            began = performance.now();
          }
        }
        stats.longestAddMs = Math.max(stats.longestAddMs, performance.now() - began);
      } catch (error) {
        fault(error);
      } finally {
        sl.finish();
        addedPumping = false;
        flushAttrs();
        if (addedAt >= addedRoots.length) {
          addedRoots.length = 0;
          addedAt = 0;
        }
        if (!dead && inlineQueue.size && inlineTimer === null) inlineTimer = setTimeout(drainInlineQueue, 40);
      }
    }

    /** Elements that arrive after the first pass with a `style` attribute raise no attribute record, so look at what is added. */
    function startAddObserver() {
      addObserver = new MutationObserver((records) => {
        const now = performance.now();
        if (now - addWindowStart > 1000) {
          addWindowStart = now;
          addBudget = ADD_BUDGET;
        }
        for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) addedRoots.push(n);
        if (!addedPumping) pumpAdded();
        if (inlineQueue.size && inlineTimer === null) inlineTimer = setTimeout(drainInlineQueue, 40);
      });
      addObserver.observe(doc, { childList: true, subtree: true });
    }

    async function inlinePass() {
      if (inlineOff) return;
      try {
        scanAttrs(doc);
        await sl.forEach(doc.querySelectorAll(INLINE_SELECTOR), processInline, () => dead);
        flushInline();
      } catch (error) {
        fault(error);
      }
      if (dead) return;
      inlineDone = true;
      startAttributeObserver();
      maybeRelease();
      markReady();
    }

    const onReady = () => {
      scanMissing();
      maybeRelease();
      void inlinePass();
      void scanShadowRoots();
    };
    // Parsing is finished when the state leaves `loading`, which is before DOMContentLoaded when a deferred script is slow.
    const onInteractive = () => {
      if (doc.readyState === 'loading' || dead) return;
      doc.removeEventListener('readystatechange', onInteractive);
      onReady();
    };
    if (doc.readyState === 'loading') doc.addEventListener('readystatechange', onInteractive);
    else onReady();
    // The inline pass can finish before the document does, so check again when loading ends.
    const onLoaded = () => {
      if (doc.readyState === 'complete') scanMissing();
      markReady();
    };
    doc.addEventListener('readystatechange', onLoaded);

    /* ---------------- end ---------------- */

    function end() {
      spareTransformers.set(themeKey, transformer);
      if (spareTransformers.size > 2) spareTransformers.delete(/** @type {string} */ (spareTransformers.keys().next().value));
      if (dead) return;
      dead = true;
      tellSiteWait(false);
      mo.disconnect();
      attrMo.disconnect();
      attrObserver?.disconnect();
      addObserver?.disconnect();
      if (inlineTimer !== null) clearTimeout(inlineTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const timer of settleTimers.values()) clearTimeout(timer);
      settleTimers.clear();
      watcher?.stop();
      for (const root of adopted.keys()) {
        try {
          root.adoptedStyleSheets = Array.from(root.adoptedStyleSheets).filter((s) => !mine.has(s));
        } catch {
          // The root is gone or the browser refuses; there is nothing left to restore.
        }
      }
      adopted.clear();
      doc.removeEventListener('readystatechange', onInteractive);
      doc.removeEventListener('readystatechange', onLoaded);
      for (const name of SWITCH_EVENTS) doc.removeEventListener(name, checkSwitched, true);
      doc.removeEventListener('visibilitychange', onVisible);
      dormant.clear();
      for (const [node, listener] of loadListeners) {
        node.removeEventListener('load', listener);
        node.removeEventListener('error', listener);
      }
      loadListeners.clear();
      for (const [node, late] of lateListeners) node.removeEventListener('load', late);
      lateListeners.clear();
      for (const pieces of copies.values()) for (const piece of pieces) piece.remove();
      copies.clear();
      tokens.clear();
      pending.clear();
      base.remove();
      dropFreeze();
      relProbe?.remove();
      if (early) release('stopped');
      inlineStyle?.remove();
      attrStyle?.remove();
      rootsMod?.teardownAll();
      for (const el of doc.querySelectorAll(`[${inlineAttr}]`)) el.removeAttribute(inlineAttr);
      pieceMedia.clear();
      templated.clear();
      variants.length = 0;
      variantIndex.clear();
      variantsByName.clear();
      if (!staged) root.removeAttribute(STATE);
      if (active && active.end === end) active = null;
      if (staging && staging.end === end) staging = null;
    }

    /**
     * Switch every sheet of this engine off, for the length of one task. A copy of selected text is made from the computed
     * colors, so while the page copies, the page must show its own. Returns the function that switches them on again.
     */
    function suspend() {
      if (dead || staged) return () => {};
      /** @type {HTMLStyleElement[]} */
      const nodes = [];
      const rootStyles = [];
      for (const rs of rootInline.values()) rootStyles.push(rs.style, rs.attrs);
      for (const el of [base, early, inlineStyle, attrStyle, ...rootStyles, ...pieceMedia.keys()]) {
        if (el && el.isConnected && !el.disabled) nodes.push(el);
      }
      /** @type {CSSStyleSheet[]} */
      const sheets = [];
      for (const state of adopted.values()) for (const copy of state.map.values()) if (copy && !copy.disabled) sheets.push(copy);
      for (const el of nodes) el.disabled = true;
      for (const sheet of sheets) sheet.disabled = true;
      return () => {
        for (const el of nodes) el.disabled = false;
        for (const sheet of sheets) sheet.disabled = false;
      };
    }

    return {
      end,
      inlineAttr,
      look,
      suspend,
      roots: () => (watcher ? [...watcher.roots] : []),
      stats: () => ({
        ...stats,
        ready: stats.readyAt !== null,
        waiting: { pending: pending.size, pumping, listeners: loadListeners.size, fetching: fetching.size, inline: inlineDone, scan: scanDone },
        slices: { ...sl.stats },
        siteDark: { ...siteTotals(), ...siteCheck, state: siteState, reason: siteReason, repair: { ...repairInfo, covered: coverMap.size } },
        rootInline: rootInline.size,
        colorCache: transformer.size,
        variants: { ...demandStats, names: demand.size, markers: templated.size },
        roots: watcher ? watcher.roots.size : 0,
        hookEvents: watcher ? watcher.stats.events : 0,
        hookDropped: watcher ? watcher.stats.dropped : 0,
      }),
    };
  }

  /**
   * Start the engine. With `stage`, an engine that already runs (this one or the filter engine) stays in place while the
   * new one is built out of sight, and the new one replaces it in one step when it is ready. That is how a change of
   * settings avoids showing the page in its own colors for a moment.
   * @param {Record<string, any>} themeSettings
   * @param {{ slicer?: object, onFault?: (error: unknown) => void, early?: boolean, hold?: boolean, startedAt?: number,
   *   stage?: boolean, atCommit?: () => void, beforeCommit?: () => void, onUnreachable?: () => void, onReady?: () => void }} [options]
   */
  function start(themeSettings, options = {}) {
    if (staging) staging.end();
    staging = null;
    if (!options.stage) {
      stop();
      active = createEngine(themeSettings ?? {}, options);
      return;
    }
    const previous = active;
    const inlineAttr = previous && previous.inlineAttr === INLINE_ID ? 'data-dk-j' : INLINE_ID;
    /** @type {Engine} */
    const engine = createEngine(themeSettings ?? {}, {
      ...options,
      early: false,
      inlineAttr,
      onCommit: () => {
        active = engine;
        staging = null;
        if (previous) previous.end();
      },
    });
    staging = engine;
  }

  function suspend() {
    return active ? active.suspend() : () => {};
  }

  function stop() {
    if (staging) staging.end();
    staging = null;
    if (active) active.end();
    active = null;
    clearTextStore();
  }

  dk.dynamic = Object.freeze({
    start,
    stop,
    suspend,
    roots: () => (active ? active.roots() : []),
    editable: EDITABLE,
    replayImageNotes,
    pictureNotes: () => pictureNotes,
    pictureRules: () => [...pictureRules],
    /** Follow the shadow roots: the listener gets the roots known now, then each new one. Returns the call that stops it. @param {{ add: (root: ShadowRoot) => void, drop: (roots: ShadowRoot[]) => void }} listener */
    followRoots(listener) {
      rootListeners.add(listener);
      for (const root of active ? active.roots() : []) listener.add(root);
      return () => void rootListeners.delete(listener);
    },
    isActive: () => active !== null,
    stats: () => (active ? active.stats() : staging ? staging.stats() : null),
  });
})();
