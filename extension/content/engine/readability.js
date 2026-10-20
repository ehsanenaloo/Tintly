// @ts-check
// A safety net for text that stays unreadable after theming. Some styles cannot be read (a style another extension puts
// into the page is not in the CSSOM), some components are themed in part (a dark box with the old dark text), and some
// colors are drawn from a source we do not follow. The net looks at the text near the viewport, finds the color it really
// has and the box really behind it, and where the contrast is below the floor it sets a keyed color that reaches it.
// It never touches text on a picture or a gradient (unknown background), text kept by the backdrop module, editable
// areas or typed content. The work is spread in slices of a few milliseconds and backs off when nothing is found.
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;
  const api = /** @type {any} */ (dk);
  const color = /** @type {any} */ (dk.color);
  const keepApi = /** @type {any} */ (dk.keep);
  if (!color) return;

  const ATTR = 'data-dk-r';
  // Below this the text is not readable by anyone (WCAG 1.4.11 for large text); the fix aims higher.
  const TRIGGER = 3;
  const TARGET = 7;
  const SLICE_MS = 3;
  const PASS_MAX = 300;
  const MAX_RULES = 400;
  const RATE_PER_SECOND = 60;
  const BASE_DELAY_MS = 1500;
  const MAX_DELAY_MS = 30000;
  const SEED_NODES = 1500;
  const QUEUE_MAX = 100;
  const ROOTS_PER_PASS = 24;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'OPTGROUP', 'TITLE', 'HEAD', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'IMG', 'SVG']);
  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'PICTURE', 'OBJECT', 'EMBED', 'CANVAS', 'IFRAME', 'SVG']);

  /** @typedef {{ r: number, g: number, b: number, a: number }} Rgba */
  /** @typedef {{ bg: Rgba | null, unknown: boolean, pos: boolean, op: number }} Layer */

  /** @param {Rgba} top @param {Rgba} below the layer under it, opaque @returns {Rgba} */
  const over = (top, below) => ({ r: top.r * top.a + below.r * (1 - top.a), g: top.g * top.a + below.g * (1 - top.a), b: top.b * top.a + below.b * (1 - top.a), a: 1 });

  /** @param {Node} n @returns {Element | null} the parent in the flat tree, through a shadow root to its host */
  const parentOf = (n) => (n.parentElement ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null));

  /** @param {Record<string, any>} themeSettings @param {{ roots?: () => ShadowRoot[], follow?: (listener: { add: (root: ShadowRoot) => void, drop: (roots: ShadowRoot[]) => void }) => () => void, active?: () => boolean }} [options] */
  function create(themeSettings, options = {}) {
    const doc = document;
    const editable = String(api.dynamic?.editable ?? '[contenteditable]');
    const theme = color.createTheme(themeSettings ?? {});
    // The mode with its own floor (E-ink 7 to 1, Paper 4.5 to 1) uses it; the other modes use the net's own.
    const trigger = theme.eink ? theme.eink.textMin : TRIGGER;
    const target = theme.eink ? theme.eink.textMin + 0.2 : TARGET;
    const stats = { passes: 0, examined: 0, fixed: 0, unknown: 0, capped: 0, stuck: 0, slices: 0, maxSliceMs: 0, rules: 0, faint: 0, animated: 0 };
    /** The element that gave the opaque color behind the text in the last call of `backgroundOf`. @type {Element | null} */
    let baseEl = null;
    let dead = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    let idle = 0;
    let delay = BASE_DELAY_MS;
    let rate = { start: 0, count: 0 };
    let rootCursor = 0;
    /** The elements the page added since the last pass. @type {Set<Element>} */
    const queue = new Set();
    /** The rule each fixed element has, and how many times it was set again. @type {Map<Element, { id: string, tries: number }>} */
    const fixed = new Map();
    /** Elements found as good as they can get in this pass. @type {WeakMap<Element, number>} */
    const seen = new WeakMap();
    /** One style element for the document and one for each shadow root. @type {Map<Document | ShadowRoot, { style: HTMLStyleElement, texts: string[] }>} */
    const sheets = new Map();
    /** @type {Map<Element, Layer>} */
    let layers = new Map();
    let counter = 0;
    let pass = 0;
    let passCount = 0;
    const keeper = keepApi ? keepApi.create() : null;

    /** What an element paints behind its content. @param {Element} e @returns {Layer} */
    function layerOf(e) {
      let l = layers.get(e);
      if (l) return l;
      if (MEDIA_TAGS.has(e.tagName.toUpperCase())) {
        l = { bg: null, unknown: true, pos: false, op: 1 };
      } else {
        const cs = getComputedStyle(e);
        const image = cs.backgroundImage;
        const effect = cs.filter !== 'none' || cs.mixBlendMode !== 'normal' || (cs.backdropFilter !== undefined && cs.backdropFilter !== 'none');
        const c = color.parseColor(cs.backgroundColor);
        const pos = cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky';
        const o = parseFloat(cs.opacity);
        l = { bg: c && c.a > 0 ? c : null, unknown: effect || (image !== 'none' && image !== ''), pos, op: Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : 1 };
      }
      layers.set(e, l);
      return l;
    }

    /**
     * The color really behind the text of `el`: the first opaque box up the tree, with the translucent layers in between
     * laid over it. Text in a positioned box may sit over something else, so it is asked what is painted there.
     * @param {Element} el @returns {Rgba | null} null when it cannot be known
     */
    function backgroundOf(el) {
      /** @type {Rgba[]} */
      const veils = [];
      /** @type {Rgba | null} */
      let base = null;
      let positioned = false;
      baseEl = null;
      /** @type {Element | null} */
      let n = el;
      for (let hops = 0; n && hops < 80; hops++, n = parentOf(n)) {
        const l = layerOf(n);
        if (l.unknown) return null;
        if (l.bg && l.bg.a >= 0.98) {
          base = l.bg;
          baseEl = n;
          break;
        }
        if (l.bg) veils.push(l.bg);
        if (l.pos) positioned = true;
      }
      if (positioned) {
        const r = el.getBoundingClientRect();
        const scope = el.getRootNode();
        const stack = (scope instanceof ShadowRoot ? scope : doc).elementsFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.top + Math.min(r.height / 2, 8), 0), innerHeight - 1));
        const at = stack.indexOf(el);
        if (at < 0) return null;
        veils.length = 0;
        base = null;
        for (let i = at + 1; i < stack.length; i++) {
          const l = layerOf(stack[i]);
          if (l.unknown) return null;
          if (l.bg && l.bg.a >= 0.98) {
            base = l.bg;
            baseEl = stack[i];
            break;
          }
          if (l.bg) veils.push(l.bg);
        }
      }
      if (!base) return null;
      let out = base;
      for (let i = veils.length - 1; i >= 0; i--) out = over(veils[i], out);
      return out;
    }

    /** @param {Element} el the element with a rule: write it down in the style element of its root @param {string} text */
    function writeRule(el, text) {
      const rn = el.getRootNode();
      const root = rn instanceof ShadowRoot ? rn : doc;
      let sheet = sheets.get(root);
      if (!sheet) {
        const style = doc.createElement('style');
        style.setAttribute('data-dk', 'read');
        sheet = { style, texts: [] };
        sheets.set(root, sheet);
        const place = () => (root === doc ? doc.head ?? doc.documentElement : root).append(style);
        place();
        if (root === doc) keeper?.track(style, place);
      }
      if (!sheet.style.isConnected) {
        // The page rebuilt its tree: put the element back and write every rule again.
        (root === doc ? doc.head ?? doc.documentElement : root).append(sheet.style);
        sheet.style.textContent = sheet.texts.join('');
      }
      sheet.texts.push(text);
      try {
        const css = sheet.style.sheet;
        if (css) css.insertRule(text, css.cssRules.length);
        else sheet.style.textContent = sheet.texts.join('');
      } catch {
        sheet.style.textContent = sheet.texts.join('');
      }
      stats.rules += 1;
    }

    /**
     * The color for text `fg` on `bg`: the least change that reaches the target, kept on the same side of the background (light
     * text stays lighter than its box) when some step of the ladder can reach it there, else the best color overall.
     * @param {Rgba} fg @param {Rgba} bg @returns {Rgba}
     */
    function pick(fg, bg) {
      const lb = color.contrastRatio(bg, { r: 0, g: 0, b: 0, a: 1 });
      const lighter = color.contrastRatio(fg, { r: 0, g: 0, b: 0, a: 1 }) > lb;
      for (const t of [target, 4.5, 3.2]) {
        if (t > target) continue;
        const w = color.ensureContrast(fg, bg, t);
        const same = color.contrastRatio(w, { r: 0, g: 0, b: 0, a: 1 }) > lb === lighter;
        if (same && color.contrastRatio(w, bg) >= t) return w;
      }
      return color.ensureContrast(fg, bg, 4.5);
    }

    /** The page color behind everything, shown through a fade. @type {Rgba | null} */
    let canvasColor = null;
    /** @returns {Rgba} */
    function pageCanvas() {
      if (canvasColor === null) canvasColor = color.parseColor(color.pageColors(theme).page) ?? { r: 1, g: 1, b: 1, a: 1 };
      return /** @type {Rgba} */ (canvasColor);
    }

    /** Is something running on this element: an animation or a transition? @param {Element} e */
    const moving = (e) => typeof e.getAnimations === 'function' && e.getAnimations().some((a) => a.playState === 'running');

    /**
     * The opacities that fade the text of `el`: `inner` below the box that gave the color behind the text (text over the box),
     * `outer` from that box up (box and text over the page); `own` is the element's, part of one of them.
     * @param {Element} el @param {Element | null} stop the box
     * @returns {{ inner: number, outer: number, own: number, ownInner: boolean, animated: boolean }}
     */
    function opacityChain(el, stop) {
      let inner = 1;
      let outer = 1;
      let own = 1;
      let animated = false;
      let below = true;
      /** @type {Element | null} */
      let n = el;
      for (let hops = 0; n && hops < 80; hops++, n = parentOf(n)) {
        if (n === stop) below = false;
        const o = layerOf(n).op;
        if (n === el) own = o;
        if (below) inner *= o;
        else outer *= o;
        if (o < 1 && moving(n)) animated = true;
      }
      return { inner, outer, own, ownInner: stop !== el, animated };
    }

    /** The color `o` of the way from `bg` to `fg`: text at that opacity over its box. @param {Rgba} bg @param {Rgba} fg @param {number} o @returns {Rgba} */
    const mixed = (bg, fg, o) => ({ r: bg.r + (fg.r - bg.r) * o, g: bg.g + (fg.g - bg.g) * o, b: bg.b + (fg.b - bg.b) * o, a: 1 });

    /** Examine one element that has text. @param {Element} el */
    function examine(el) {
      if (seen.get(el) === pass) return;
      seen.set(el, pass);
      if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el instanceof SVGElement || el.hasAttribute('data-dk-k') || el.hasAttribute('data-dk')) return;
      // Editors: the engine's own list of editable areas (some editors mark them with a class, not the attribute).
      if (/** @type {HTMLElement} */ (el).isContentEditable || el.closest(editable)) return;
      // Hidden from assistive tools or from view, or a disabled control (which WCAG leaves out of the contrast rules): left alone.
      if (el.closest('[aria-hidden="true"], [hidden], [aria-disabled="true"], [disabled]')) return;
      const mine = fixed.get(el);
      if (mine && mine.tries >= 2) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < -innerHeight || r.top > 2 * innerHeight || r.right < -innerWidth || r.left > 2 * innerWidth) return;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible' || cs.opacity === '0' || parseFloat(cs.fontSize) < 1) return;
      // `-webkit-text-fill-color` paints over `color`; it is the color of the glyphs when the page sets it.
      const fillText = color.parseColor(cs.webkitTextFillColor) ?? color.parseColor(cs.color);
      if (!fillText || fillText.a < 0.1) return;
      stats.examined += 1;
      passCount += 1;
      const bg = backgroundOf(el);
      if (!bg) {
        stats.unknown += 1;
        return;
      }
      // The color of the glyphs with its own alpha, then faded by the opacity of the element and of what holds it.
      const fg = over(fillText, bg);
      const chain = opacityChain(el, baseEl);
      // Something is fading in or out: the contrast changes by itself, so it is left alone.
      if (chain.animated || moving(el)) {
        stats.animated += 1;
        return;
      }
      /** The text and the box as they show, for a text color and an opacity of the element. @param {Rgba} text @param {number} o */
      const view = (text, o) => {
        const inner = chain.ownInner ? (chain.inner / chain.own) * o : chain.inner;
        const outer = chain.ownInner ? chain.outer : (chain.outer / chain.own) * o;
        const onBox = inner < 1 ? mixed(bg, text, inner) : text;
        if (outer >= 1) return { text: onBox, box: bg };
        const canvas = pageCanvas();
        return { text: mixed(canvas, onBox, outer), box: mixed(canvas, bg, outer) };
      };
      const ratioAt = (/** @type {Rgba} */ text, /** @type {number} */ o) => {
        const v = view(text, o);
        return color.contrastRatio(v.text, v.box);
      };
      const now = ratioAt(fg, chain.own);
      if (now >= trigger) return;
      /** @type {number | null} */
      let opacity = null;
      /** @type {Rgba | null} */
      let wanted = null;
      if (chain.own < 1) {
        // The element's own opacity is the cause, or part of it: raise it as little as the floor needs.
        for (const goal of [target, 4.5, 3.2]) {
          if (goal > target || ratioAt(fg, 1) < goal) continue;
          let lo = chain.own;
          let hi = 1;
          for (let i = 0; i < 14; i++) {
            const mid = (lo + hi) / 2;
            if (ratioAt(fg, mid) >= goal) hi = mid;
            else lo = mid;
          }
          opacity = Math.min(1, Math.ceil(hi * 100) / 100);
          break;
        }
      }
      if (opacity === null) {
        // The color is the cause (or the opacity of a parent): ask for the color that, with those fades, reaches the target.
        const seenNow = view(fg, chain.own);
        const best = pick({ ...seenNow.text, a: 1 }, seenNow.box);
        const inner = chain.ownInner ? chain.inner : chain.inner;
        const outer = chain.outer;
        const clamp = (/** @type {number} */ v) => Math.min(1, Math.max(0, v));
        let onBox = best;
        if (outer < 1) {
          const canvas = pageCanvas();
          onBox = { r: canvas.r + (best.r - canvas.r) / outer, g: canvas.g + (best.g - canvas.g) / outer, b: canvas.b + (best.b - canvas.b) / outer, a: 1 };
        }
        wanted = inner < 1
          ? { r: clamp(bg.r + (onBox.r - bg.r) / inner), g: clamp(bg.g + (onBox.g - bg.g) / inner), b: clamp(bg.b + (onBox.b - bg.b) / inner), a: 1 }
          : { r: clamp(onBox.r), g: clamp(onBox.g), b: clamp(onBox.b), a: 1 };
        // Nothing better can be reached on this ground: leave it, and do not look again.
        if (ratioAt(wanted, chain.own) < now + 0.3) {
          stats.stuck += 1;
          return;
        }
      }
      const t = performance.now();
      if (t - rate.start > 1000) rate = { start: t, count: 0 };
      if (stats.rules >= MAX_RULES || rate.count >= RATE_PER_SECOND) {
        stats.capped += 1;
        return;
      }
      rate.count += 1;
      const hex = wanted ? color.toHex(wanted) : '';
      const id = mine ? mine.id : String(++counter);
      if (mine) mine.tries += 1;
      else {
        fixed.set(el, { id, tries: 0 });
        el.setAttribute(ATTR, id);
      }
      // The glyph fill is set only where the page set it apart from the color; it is inherited and would cover a child's own color.
      const fill = color.parseColor(cs.color);
      const apart = fill && (Math.abs(fill.r - fillText.r) > 0.004 || Math.abs(fill.g - fillText.g) > 0.004 || Math.abs(fill.b - fillText.b) > 0.004);
      if (opacity !== null) {
        writeRule(el, `[${ATTR}="${id}"]{opacity:${opacity}!important}`);
        stats.faint += 1;
      } else writeRule(el, `[${ATTR}="${id}"]{color:${hex}!important${apart ? `;-webkit-text-fill-color:${hex}!important` : ''}}`);
      stats.fixed += 1;
    }

    /**
     * Walk the text below `from` (or after it, in document order), examining the parent of each text node. Stops after
     * `limit` text nodes, or when the text is far below the viewport.
     * @param {Node} root @param {Node | null} from @param {number} limit
     */
    function* walk(root, from, limit) {
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      if (from && root.contains(from)) walker.currentNode = from;
      let below = 0;
      for (let i = 0; i < limit; i++) {
        const node = walker.nextNode();
        if (!node) return;
        const el = node.parentElement;
        if (!el || seen.get(el) === pass || !/\S/.test(node.nodeValue ?? '')) continue;
        const top = el.getBoundingClientRect().top;
        if (top > 2 * innerHeight) {
          if (++below > 40) return;
          continue;
        }
        below = 0;
        examine(el);
        yield;
      }
    }

    function* work() {
      pass += 1;
      passCount = 0;
      stats.passes += 1;
      // What the page added since the last pass comes first.
      for (const el of [...queue]) {
        queue.delete(el);
        if (el.isConnected) yield* walk(el, null, 200);
      }
      const body = doc.body;
      if (!body) return;
      // The top of the page, then the text on the screen reached from a few points; each walk goes on in document order.
      yield* walk(body, null, SEED_NODES);
      const w = innerWidth;
      const h = innerHeight;
      for (const [x, y] of [[0.5, 0.02], [0.5, 0.5], [0.5, 0.98], [0.1, 0.5], [0.9, 0.5]]) {
        const seed = doc.elementFromPoint(w * x, h * y);
        if (seed && seed !== doc.documentElement && body.contains(seed)) {
          yield* walk(body, seed.firstChild ?? seed, SEED_NODES);
          yield* walk(seed, null, 60);
        }
      }
      const roots = options.roots ? options.roots() : [];
      for (let i = 0; i < Math.min(roots.length, ROOTS_PER_PASS); i++) {
        const root = roots[(rootCursor + i) % roots.length];
        if (!root.host.isConnected) continue;
        const r = root.host.getBoundingClientRect();
        const shown = (r.width === 0 && r.height === 0) || (r.bottom > -h && r.top < 2 * h);
        if (shown) yield* walk(root, null, SEED_NODES);
      }
      rootCursor += ROOTS_PER_PASS;
    }

    function ready() {
      const top = doc.documentElement;
      if (!doc.body || top.getAttribute('data-dk-state') !== 'ready' || !top.hasAttribute('data-dk-go')) return false;
      return doc.visibilityState === 'visible' && (!options.active || options.active());
    }

    /** @param {number} ms */
    function later(ms) {
      if (dead || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, ms);
    }

    /** @type {Generator<void, void, void> | null} */
    let current = null;
    let foundBefore = 0;
    let framed = false;

    function run() {
      if (dead) return;
      if (!current) {
        if (!ready()) {
          later(500);
          return;
        }
        // The style and the layout of a big page are stale after the engine's work. Reading them now would make this task pay
        // for it, so the pass starts in the task after a frame was drawn. A page that is not drawn (a hidden tab) waits.
        if (!framed) {
          framed = true;
          requestAnimationFrame(() => setTimeout(() => {
            if (!dead) run();
          }, 0));
          return;
        }
        framed = false;
        if (!attached) attach();
        layers = new Map();
        foundBefore = stats.fixed;
        current = work();
      }
      const began = performance.now();
      let n = 0;
      let done = false;
      try {
        for (;;) {
          const step = current.next();
          if (step.done) {
            done = true;
            break;
          }
          if (passCount >= PASS_MAX) {
            done = true;
            break;
          }
          if (++n % 4 === 0 && performance.now() - began > SLICE_MS) break;
        }
      } catch {
        // A node went away while the pass ran; the next pass starts again.
        done = true;
      }
      const spent = performance.now() - began;
      stats.slices += 1;
      stats.maxSliceMs = Math.max(stats.maxSliceMs, Math.round(spent * 10) / 10);
      layers = new Map();
      if (!done) {
        later(8);
        return;
      }
      current = null;
      idle = stats.fixed > foundBefore ? 0 : idle + 1;
      delay = idle === 0 ? 1000 : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(idle, 5));
      later(delay);
    }

    /** Something may have changed: look again soon and start the back off over. @param {number} ms */
    function nudge(ms) {
      if (dead) return;
      idle = 0;
      if (timer !== null && current === null) {
        clearTimeout(timer);
        timer = null;
      }
      later(ms);
    }

    const onScroll = () => nudge(500);
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll, { passive: true });
    const onLoad = () => nudge(300);
    addEventListener('load', onLoad, { once: true });
    const onVisible = () => nudge(300);
    doc.addEventListener('visibilitychange', onVisible);

    /** @type {MutationObserver[]} */
    const observers = [];
    let burst = { start: 0, count: 0 };
    /** @param {MutationRecord[]} records */
    const onAdded = (records) => {
      const t = performance.now();
      if (t - burst.start > 1000) burst = { start: t, count: 0 };
      burst.count += records.length;
      // A page that rebuilds itself all the time is covered by the passes alone.
      if (burst.count > 2000) return;
      for (const r of records) {
        for (const node of r.addedNodes) if (node instanceof Element && queue.size < QUEUE_MAX && !node.hasAttribute('data-dk')) queue.add(node);
      }
      if (queue.size) nudge(250);
    };
    /** @param {Node} target */
    const observe = (target) => {
      const mo = new MutationObserver(onAdded);
      mo.observe(target, { childList: true, subtree: true });
      observers.push(mo);
      return mo;
    };
    /** The observer of each shadow root. @type {Map<ShadowRoot, MutationObserver>} */
    const watched = new Map();
    let attached = false;
    /** @type {(() => void) | null} */
    let unfollow = null;
    // Nothing is watched while the page loads and the engine themes it: a record for every node the parser adds would slow
    // the load down. The first pass reads what is there; the observers start with it. Shadow roots come and go while the
    // page runs: the engine tells which ones, so nothing here wakes up by itself.
    function attach() {
      attached = true;
      observe(doc);
      unfollow = options.follow
        ? options.follow({
            add(root) {
              if (dead || watched.has(root)) return;
              watched.set(root, observe(root));
            },
            drop(gone) {
              for (const root of gone) {
                const mo = watched.get(root);
                if (!mo) continue;
                mo.disconnect();
                observers.splice(observers.indexOf(mo), 1);
                watched.delete(root);
              }
            },
          })
        : null;
    }

    later(600);

    return {
      stats: () => ({ ...stats, queued: queue.size, delay }),
      end() {
        dead = true;
        if (timer !== null) clearTimeout(timer);
        unfollow?.();
        removeEventListener('scroll', onScroll);
        removeEventListener('resize', onScroll);
        removeEventListener('load', onLoad);
        doc.removeEventListener('visibilitychange', onVisible);
        for (const mo of observers) mo.disconnect();
        keeper?.stop();
        for (const sheet of sheets.values()) sheet.style.remove();
        for (const el of fixed.keys()) el.removeAttribute(ATTR);
        for (const el of doc.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
        for (const root of watched.keys()) {
          try {
            for (const el of root.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
          } catch {
            // The root is gone.
          }
        }
        sheets.clear();
        fixed.clear();
        queue.clear();
        watched.clear();
      },
    };
  }

  /** @type {{ end: () => void, stats: () => Record<string, number>, key: string } | null} */
  let active = null;

  /** @param {Record<string, any>} themeSettings @param {{ roots?: () => ShadowRoot[], follow?: (listener: { add: (root: ShadowRoot) => void, drop: (roots: ShadowRoot[]) => void }) => () => void, active?: () => boolean }} [options] */
  function start(themeSettings, options) {
    const key = JSON.stringify(themeSettings ?? {});
    if (active && active.key === key) return;
    stop();
    active = { ...create(themeSettings, options), key };
  }

  function stop() {
    active?.end();
    active = null;
  }

  /**
   * Start or stop for the decision of the gate. Not under the Filter engines: the page is filtered, so the colors it reads are
   * not the colors shown. Not while the page's own dark theme is shown: that one was checked.
   * @param {boolean} on @param {Record<string, any>} themeSettings @param {string} kind
   */
  function sync(on, themeSettings, kind) {
    const dynamic = api.dynamic;
    if (on && dynamic && kind !== 'filter' && kind !== 'filterPlus') {
      start(themeSettings, { roots: () => dynamic.roots(), follow: (/** @type {any} */ listener) => dynamic.followRoots(listener), active: () => dynamic.stats()?.siteDark?.state !== 'on' });
    } else stop();
  }

  dk.readability = Object.freeze({ start, stop, sync, isActive: () => active !== null, stats: () => (active ? active.stats() : null) });
})();
