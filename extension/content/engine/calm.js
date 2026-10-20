// @ts-check
// The extra rules of the E-ink and Paper mode: calm motion, underlined links, thicker lines, a reading font, heavier text, calm
// pictures. One style element, `data-dk=calm`. The only thing read from the page is whether a control has a border.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;
  const color = /** @type {any} */ (dk.color);
  const keepApi = /** @type {any} */ (dk.keep);
  if (!color) return;

  // Pictures: the filter that makes them calm. A dimmed picture is a little darker as well.
  const DIM = 0.88;
  // Picture boxes set in an inline style: the mark of imagebg.js comes 300 to 600 ms after the box.
  const INLINE_PICTURE = color.INLINE_PICTURE;
  // Fonts: a name is quoted unless it is a generic family.
  const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong']);
  const SERIF = 'Georgia,"Iowan Old Style","Palatino Linotype",Palatino,"Noto Serif","Times New Roman",serif';
  const SANS = 'system-ui,"Segoe UI",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif';
  // Elements that show text. Icon fonts keep their own family: an element named like an icon is left out.
  const NOT_ICON = ':not([class*="icon" i]):not([class*="glyph" i]):not([class*="material" i]):not([class*="fa-"]):not(.fa):not(.fas):not(.far):not(.fab):not([aria-hidden="true"])';
  const TEXT_TAGS = 'body,p,li,dd,dt,td,th,caption,figcaption,blockquote,q,cite,h1,h2,h3,h4,h5,h6,label,legend,summary,a,em,strong,b,small,article,section,main,aside,header,footer,nav,div,span';
  const TEXT_SELECTOR = `:where(${TEXT_TAGS.split(',').map((t) => `${t}${NOT_ICON}`).join(',')})`;
  const PX_PER_STEP = 0.12;
  // Controls whose border is thickened, and the mark on the ones that have a border.
  const CONTROLS = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=image]),select,textarea,button';
  const BORDER_MARK = 'data-dk-bw';
  const SLICE_MS = 6;
  // The longest slice: a page whose layout takes long between two slices gets fewer, larger ones (under the 50 ms of a long task).
  const MAX_SLICE_MS = 30;
  const PER_SLICE = 200;
  // More roots than this wait: the whole document is read once instead.
  const MAX_ROOTS = 400;
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];

  /** @param {string} value a font setting @returns {string | null} a font-family value, or null to keep the page's fonts */
  function fontStack(value) {
    if (value === 'keep') return null;
    if (value === 'serif') return SERIF;
    if (value === 'sans') return SANS;
    const names = value
      .split(',')
      .map((n) => n.replace(/["']/g, '').trim())
      .filter((n) => n !== '' && n.length <= 60)
      .slice(0, 6);
    if (!names.length) return null;
    return names.map((n) => (GENERIC.has(n.toLowerCase()) ? n.toLowerCase() : `"${n}"`)).join(',');
  }

  /**
   * The filter for pictures, or '' when they stay as they are. `gray` and `dim` take all color out; `follow` takes the amount
   * of color of the mode (the root filter does that when it is on, so it is left out then) and dims a little.
   * @param {ReturnType<typeof color.einkSettings>} e @param {boolean} [root]  the root filter carries the color amount
   */
  function pictureFilter(e, root = e.einkGrayAll) {
    if (e.einkImages === 'off') return '';
    /** @type {string[]} */
    const parts = [];
    if (e.einkImages === 'follow') {
      if (!root && e.einkColorAmount < 100) parts.push(e.einkColorAmount === 0 ? 'grayscale(1)' : `saturate(${e.einkColorAmount / 100})`);
    } else parts.push('grayscale(1)');
    if (e.einkImageContrast !== 100) parts.push(`contrast(${e.einkImageContrast / 100})`);
    if (e.einkImages !== 'gray') parts.push(`brightness(${DIM})`);
    return parts.join(' ');
  }

  /** The filter on the root that takes the color of everything the palette cannot reach down to the amount, or ''. @param {ReturnType<typeof color.einkSettings>} e */
  function rootFilter(e) {
    if (!e.einkGrayAll || e.einkColorAmount >= 100) return '';
    return e.einkColorAmount === 0 ? 'grayscale(1)' : `saturate(${e.einkColorAmount / 100})`;
  }

  /** The rules for these theme settings. Transitions have no rule (see `endTransitions`). @param {Record<string, any>} themeSettings @param {{ rootFilter?: boolean }} [options]  `rootFilter: false` leaves the root filter out */
  function build(themeSettings, options = {}) {
    const e = color.einkSettings(themeSettings);
    const out = [];
    const root = options.rootFilter === false ? '' : rootFilter(e);
    if (root) out.push(`html{filter:${root}!important}`);
    if (e.noAnimation) out.push('*,*::before,*::after{animation-duration:.01ms!important;animation-delay:0s!important;animation-iteration-count:1!important}');
    if (e.noSmoothScroll) out.push('*{scroll-behavior:auto!important}');
    // The focused element keeps its shadow: many pages draw the focus ring with one (WCAG 2.4.7).
    if (e.noShadow) out.push(':where(:not(:focus-visible)),*::before,*::after{box-shadow:none!important;text-shadow:none!important}');
    if (e.einkLinks) out.push('a:any-link{text-decoration:underline!important;text-decoration-thickness:max(1px,.07em)!important;text-underline-offset:.16em!important}');
    if (e.einkBorders) {
      out.push(
        `[${BORDER_MARK}]{border-width:2px!important}`,
        'hr{border-top-width:2px!important}',
        ':focus-visible{outline-width:3px!important;outline-style:solid!important;outline-offset:2px!important}',
      );
    }
    const stack = fontStack(e.einkFont);
    if (stack) out.push(`${TEXT_SELECTOR}{font-family:${stack}!important}`);
    const stroke = Math.round((e.textStroke * 0.1 + e.einkWeight * PX_PER_STEP) * 100) / 100;
    if (stroke > 0) out.push(`body{-webkit-text-stroke-width:${stroke}px!important}`);
    const filter = pictureFilter(e, root !== '');
    if (filter) {
      out.push(`img,video,canvas,input[type=image],object,embed,svg image,[data-dk-bg="gray"],${INLINE_PICTURE}{filter:${filter}!important}`);
      // A photo box that holds text cannot take a filter: its picture is blended with a gray, which keeps only the lightness.
      out.push('[data-dk-bg="blend"]{background-color:#808080!important;background-blend-mode:luminosity!important}');
    }
    return out.length ? `@media screen{${out.join('')}}` : '';
  }

  /** Whether this computed style shows a border: a side with a style and a width. Read with the mark off (see `markBorders`). @param {CSSStyleDeclaration} c */
  function hasBorder(c) {
    for (const side of SIDES) {
      const style = /** @type {any} */ (c)[`border${side}Style`];
      if (style !== 'none' && style !== 'hidden' && parseFloat(/** @type {any} */ (c)[`border${side}Width`]) > 0) return true;
    }
    return false;
  }

  /** A border width that runs as a transition. @param {Animation} a */
  const widthRun = (a) => typeof CSSTransition !== 'undefined' && a instanceof CSSTransition && /^border-(top|right|bottom|left)-width$/.test(a.transitionProperty);

  /**
   * Mark the controls with a visible border, and keep the mark right while the page changes (a page that resets borders to
   * `0 solid` has none to thicken). A marked control shows the width of our rule, so its mark is taken off for the read and put
   * back in the same task: no frame is drawn in between, and only these controls are styled again.
   * Work comes in slices of about SLICE_MS: finding controls (a walk that goes on where it stopped), reading and writing all
   * count. The style pass of the browser that the first read starts cannot be cut, so a slice that took too long reads fewer
   * controls next time. A root is a subtree to read again: an added node, or an element whose class or style changed. When too
   * many roots wait, or a stylesheet comes or changes, the whole document is read once instead.
   * @returns {() => void} stops it and takes the marks away
   */
  function markBorders() {
    const WHOLE_GAP_MS = 2000;
    // Elements walked between two looks at the clock.
    const STEP = 128;
    /** @type {Element[]} */
    let queue = [];
    /** @type {Set<Element>} */
    const queued = new Set();
    // The whole document waits to be read: every other root is inside it.
    let whole = true;
    /** The walk through the subtree being read, and its root. @type {TreeWalker | null} */
    let walk = null;
    // The root of a new walk is a control to read as well.
    let atRoot = false;
    let timer = 0;
    let stopped = false;
    // A page that changes a class of the body or adds style sheets often is read whole at most once per WHOLE_GAP_MS.
    let lastWhole = -Infinity;
    // Controls read in one slice: fewer when the browser's style pass is slow.
    let per = PER_SLICE;
    let lastEnd = performance.now();

    const later = (/** @type {number} */ ms) => {
      if (timer === 0 && !stopped) timer = window.setTimeout(run, ms);
    };
    const rescan = () => {
      queue = [];
      queued.clear();
      whole = true;
    };
    const add = (/** @type {Element} */ el) => {
      if (whole || queued.has(el)) return;
      if (queue.length >= MAX_ROOTS) return rescan();
      queue.push(el);
      queued.add(el);
    };
    const isControl = (/** @type {Element} */ el) => {
      const t = el.localName;
      return (t === 'input' || t === 'select' || t === 'textarea' || t === 'button') && el.matches(CONTROLS);
    };
    /** Start the walk of the next subtree, or false when none waits. A root inside another waiting root is left out. */
    const next = () => {
      if (whole) {
        if (performance.now() - lastWhole < WHOLE_GAP_MS) return false;
        whole = false;
        lastWhole = performance.now();
        walk = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
        atRoot = true;
        return true;
      }
      while (queue.length > 0) {
        const r = /** @type {Element} */ (queue.shift());
        queued.delete(r);
        if (!r.isConnected) continue;
        let covered = false;
        for (let p = r.parentElement; p && !covered; p = p.parentElement) covered = queued.has(p);
        if (covered) continue;
        walk = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
        atRoot = true;
        return true;
      }
      return false;
    };
    /** The next control of the walk, or null when the walk is done. Gives up after `steps` elements: then `false`. @param {number} steps */
    const step = (steps) => {
      if (!walk) return null;
      // The walk stood on an element the page has taken out: the rest of the subtree is read again whole, later.
      if (!walk.currentNode.isConnected) {
        walk = null;
        rescan();
        return null;
      }
      for (let i = 0; i < steps; i++) {
        const n = /** @type {Element | null} */ (atRoot ? walk.root : walk.nextNode());
        atRoot = false;
        if (!n) {
          walk = null;
          return null;
        }
        if (isControl(n)) return n;
      }
      return false;
    };
    const run = () => {
      timer = 0;
      if (stopped) return;
      const began = performance.now();
      // The browser lays out the page between two slices: when that takes long, a slice may take an eighth of it.
      const budget = Math.min(MAX_SLICE_MS, Math.max(SLICE_MS, (began - lastEnd) / 8));
      // Finding stops at half the slice: reading and writing take the other half.
      const findBy = began + budget / 2;
      /** @type {Element[]} */
      const read = [];
      while (read.length < per && performance.now() < findBy) {
        const el = step(STEP);
        if (el === null && !next()) break;
        if (el) read.push(el);
      }
      // Marks off, all reads, then the writes: one style pass for the slice, and only the controls read are styled again.
      const was = read.map((el) => el.hasAttribute(BORDER_MARK));
      read.forEach((el, i) => was[i] && el.removeAttribute(BORDER_MARK));
      const styles = read.map((el) => getComputedStyle(el));
      // A border width that runs as a transition starts one on the switch off, which would show the old width to the read, and
      // one on the switch back: both are ended.
      const moving = read.filter((el, i) => was[i] && /[1-9]/.test(styles[i].transitionDuration));
      const end = () => {
        for (const el of moving) for (const a of el.getAnimations()) if (widthRun(a)) a.cancel();
      };
      end();
      const marks = styles.map(hasBorder);
      read.forEach((el, i) => marks[i] && el.setAttribute(BORDER_MARK, ''));
      if (moving.length > 0) {
        for (const el of moving) void getComputedStyle(el).borderTopWidth;
        end();
      }
      lastEnd = performance.now();
      const took = lastEnd - began;
      per = took > budget ? Math.max(20, per >> 1) : Math.min(Math.round((PER_SLICE * budget) / SLICE_MS), per + Math.max(20, per >> 2));
      if (walk || queue.length > 0) later(30);
      else if (whole) later(Math.max(30, lastWhole + WHOLE_GAP_MS - performance.now()));
    };
    const isSheet = (/** @type {Node} */ n) => (n instanceof HTMLStyleElement || (n instanceof HTMLLinkElement && /stylesheet/i.test(n.rel))) && !n.hasAttribute('data-dk');
    // A removed node counts when it is a sheet or holds one. Nothing is looked at while the whole document waits to be read.
    const holdsSheet = (/** @type {Element} */ n) => isSheet(n) || (n.firstElementChild !== null && n.querySelector('style:not([data-dk]),link[rel~=stylesheet]') !== null);
    const watcher = new MutationObserver((records) => {
      if (stopped) return;
      for (const r of records) {
        if (r.type === 'attributes') {
          const name = r.attributeName;
          if (name === 'class' || name === 'style') {
            // An inline style changes the border of that element only; pages animate inline styles all the time.
            if (r.target instanceof Element && (name === 'class' || r.target.matches(CONTROLS))) add(r.target);
          } else if ((r.target instanceof HTMLStyleElement || r.target instanceof HTMLLinkElement) && !r.target.hasAttribute('data-dk')) rescan();
          continue;
        }
        if (r.type === 'characterData') {
          if (r.target.parentNode && isSheet(r.target.parentNode)) rescan();
          continue;
        }
        if (isSheet(r.target)) rescan();
        for (const n of r.addedNodes) if (n instanceof Element) (isSheet(n) ? rescan() : add(n));
        if (!whole) for (const n of r.removedNodes) if (n instanceof Element && holdsSheet(n)) rescan();
      }
      if (whole || queue.length > 0) later(200);
    });
    // A stylesheet link applies when it loads, after it was added.
    const onLoad = (/** @type {Event} */ e) => {
      if (stopped || !isSheet(/** @type {Node} */ (e.target))) return;
      rescan();
      later(200);
    };
    // The hook reports rules inserted or deleted through the CSSOM, and constructed sheets of the document.
    const HINTS = ['dk:sheet', 'dk:adopt', 'dk:constructed'];
    const onHint = (/** @type {Event} */ e) => {
      if (stopped || (e.type === 'dk:sheet' ? !isSheet(/** @type {Node} */ (e.target)) : e.target !== document)) return;
      rescan();
      later(200);
    };
    watcher.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'media', 'disabled', 'rel'] });
    // Sheets sit in the head: text edited inside a style element is seen there, without watching every text node of the page.
    if (document.head) watcher.observe(document.head, { characterData: true, subtree: true });
    document.addEventListener('load', onLoad, true);
    for (const name of HINTS) document.addEventListener(name, onHint, true);
    later(0);
    return () => {
      stopped = true;
      watcher.disconnect();
      document.removeEventListener('load', onLoad, true);
      for (const name of HINTS) document.removeEventListener(name, onHint, true);
      clearTimeout(timer);
      timer = 0;
      queue = [];
      queued.clear();
      walk = null;
      for (const el of document.querySelectorAll(`[${BORDER_MARK}]`)) el.removeAttribute(BORDER_MARK);
    };
  }

  /** The filter the page itself gives each of these pictures, read on its own cascade (the rule for calm pictures replaces it). Call in a batch: it restyles the page twice. @param {Element[]} list @returns {string[]} */
  function pageFilters(list) {
    return /** @type {any} */ (dk).scheme.cascade((/** @type {any} */ r) => list.map((el) => (r?.style ?? getComputedStyle)(el).filter));
  }

  /** @type {{ end: () => void, text: string, transitions: boolean } | null} */
  let active = null;

  /** @param {Record<string, any>} themeSettings @param {{ rootFilter?: boolean }} [options] */
  function start(themeSettings, options = {}) {
    const text = build(themeSettings ?? {}, options);
    const settings = color.einkSettings(themeSettings ?? {});
    const transitions = settings.noTransition;
    if (active && active.text === text && active.transitions === transitions) return;
    stop();
    if (text === '' && !transitions) return;
    const style = document.createElement('style');
    style.setAttribute('data-dk', 'calm');
    style.textContent = text;
    const place = () => (document.head ?? document.documentElement).append(style);
    if (text !== '') place();
    const keeper = text !== '' && keepApi ? keepApi.create() : null;
    if (text !== '') keeper?.track(style, place);
    // The code that ends the transitions comes with the E-ink palette, which the gate loads before it starts this module.
    const unmark = text !== '' && settings.einkBorders ? markBorders() : null;
    const endRuns = transitions ? /** @type {any} */ (dk).einkpalette?.endTransitions() ?? null : null;
    active = {
      text,
      transitions,
      end() {
        endRuns?.();
        unmark?.();
        keeper?.stop();
        style.remove();
      },
    };
  }

  function stop() {
    active?.end();
    active = null;
  }

  dk.calm = Object.freeze({ start, stop, build, fontStack, pictureFilter, rootFilter, pageFilters, isActive: () => active !== null, holdsTransitions: () => active !== null && active.transitions });
})();
