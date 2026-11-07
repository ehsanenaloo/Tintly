// @ts-check
// Text on a picture keeps the color the page gave it. Points of a grid over the page are hit tested from the top down: the first thing
// with text is the candidate, and the first thing under it that paints decides (a picture: the text is on a picture; a box: not).
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk) return;
  const keepApi = /** @type {any} */ (dk.keep);

  const ATTR = 'data-dk-k';
  const NONE_ATTR = 'data-dk-ph';
  const MAX_NONE = 300;
  const DIMMED_TEXT = 55;
  const DIMMED_TEXT_LUM = 0.5;
  const SCAN_TTL_MS = 15000;
  const COLS = 24;
  const ROWS = 16;
  const CELL = 24;
  const MIN_AREA = 2000;
  const EMPTY_PASSES = 3;
  const REFRESH_MS = 250;
  const PICTURES = 'img,video,picture,object,embed,svg,canvas,iframe,[style*="url("],[style*="image-set("]';
  const MAX_KEPT = 600;
  // Kept text that left the page: how long new text that looks the same can still take its rule.
  const GONE_MS = 1000;
  const MAX_ADDED = 3000;
  const BUDGET_MS = 14;
  const OVERRIDE_MAX_ELEMENTS = 5000;
  const MAX_ELEMENTS = 15000;
  const LOADING_GIVE_UP_MS = 10000;
  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'PICTURE', 'OBJECT', 'EMBED']);
  // Text found on a picture: the other text in the box that holds both is tested at its own place (lines between two grid rows).
  const NEIGHBOR_SCOPE = 400;
  const NEIGHBOR_TESTS = 30;

  /** @param {Element} e */
  function hasOwnText(e) {
    for (let n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.textContent ?? '')) return true;
    return false;
  }

  /** @param {string} css @returns {number} alpha of an rgb() or rgba() value */
  function alphaOf(css) {
    const m = /rgba?\(([^)]+)\)/.exec(css);
    if (!m) return 0;
    const p = m[1].split(/[,\s/]+/).filter(Boolean);
    return p.length > 3 ? Number(p[3]) : 1;
  }

  /** A background clipped to the text paints the glyphs, not a box. @param {CSSStyleDeclaration} cs */
  const clipsText = (cs) => /\btext\b/.test(cs.backgroundClip || cs.getPropertyValue('-webkit-background-clip'));

  /** @param {Element} e @returns {'media' | 'paint' | 'none'} */
  function painting(e) {
    if (e.tagName === 'IMG' || e.tagName === 'PICTURE') {
      const img = e.tagName === 'IMG' ? e : e.querySelector('img');
      if (img?.getAttribute('data-dk-img') === 'night') return 'none';
      // A page can keep a second copy of a picture invisible on top of the first. It paints nothing.
      if (img && getComputedStyle(img).opacity === '0') return 'none';
    }
    if (MEDIA_TAGS.has(e.tagName)) return 'media';
    const bg = e.getAttribute('data-dk-bg');
    if (e.tagName === 'CANVAS' || bg === 'dusk' || bg === 'veil') return 'none';
    if (e.tagName === 'IFRAME') return 'paint';
    const cs = getComputedStyle(e);
    if (clipsText(cs)) return 'none';
    const image = cs.backgroundImage;
    if (image && image !== 'none') {
      if (/url\(/.test(image) && /** @type {any} */ (dk).imagebg?.isThin?.(image)) return alphaOf(cs.backgroundColor) > 0.5 ? 'paint' : 'none';
      return /url\(/.test(image) && !/gradient\(/.test(image) ? 'media' : 'paint';
    }
    return alphaOf(cs.backgroundColor) > 0.5 ? 'paint' : 'none';
  }

  /** @param {Element} e */
  const isShape = (e) => e instanceof SVGElement && !(e instanceof SVGSVGElement) && 'getBBox' in e;

  function start() {
    const doc = document;
    /** @type {Map<Element, string>} the id of each kept element */
    const kept = new Map();
    /** @type {Map<string, string>} */
    const rules = new Map();
    let counter = 0;
    let dead = false;
    let failures = 0;
    /** @type {HTMLStyleElement | null} */
    let style = null;
    const keeper = keepApi ? keepApi.create() : null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    let lastSweep = 0;
    const startedAt = performance.now();
    let lastSpent = 0;
    let passes = 0;
    let spent = 0;
    let hitTests = 0;
    let cursor = 0;
    let gridSize = 0;
    let emptyPasses = 0;
    // A timed look at a page with nothing new: one full pass is enough to go back to sleep.
    let oneLook = false;
    let stride = 1;
    let phase = 0;
    // Passes done in the present round of a strided sweep: a round has to test every cell once, which takes stride squared passes.
    let round = 0;
    let hitMs = 0;
    let hitSamples = 0;
    /** @type {number | null} */
    let sleepingOn = null;
    let sleptAtY = 0;
    /** Kept text that was out of view when a picture turned out mostly clear: it is tested once it shows. @type {Set<Element>} */
    const unsure = new Set();
    /** @type {Set<Element>} */
    const toKeep = new Set();
    let keepTimer = 0;
    /** The elements that compute to `pointer-events: none` ({ list }), complete once `count` is set. @type {{ list: Element[], at: number, count: number, time: number, wide: boolean } | null} */
    let scan = null;
    /** The last whole list: a pass uses it while a new one is read, so text that scrolls in does not wait for the read. @type {{ list: Element[], at: number, count: number, time: number, wide: boolean } | null} */
    let spare = null;

    /** @param {number} until @returns {NonNullable<typeof scan> | null} the list when it is complete */
    function scanNone(until) {
      const all = doc.getElementsByTagName('*');
      const sc = (scan ??= { list: [], at: 0, count: 0, time: 0, wide: false });
      while (sc.at < all.length) {
        for (const stop = Math.min(all.length, sc.at + 64); sc.at < stop; sc.at++) {
          const e = all[sc.at];
          if (e === doc.documentElement || e === doc.body || getComputedStyle(e).pointerEvents !== 'none') continue;
          if (sc.list.length < MAX_NONE) sc.list.push(e);
          else sc.wide = true;
        }
        if (sc.at < all.length && performance.now() > until) return null;
      }
      return sc;
    }

    const range = doc.createRange();

    /** The boxes of the lines of the element's own text. @param {Element} e @returns {DOMRect[]} */
    function textBoxes(e) {
      /** @type {DOMRect[]} */
      const out = [];
      for (let n = e.firstChild; n; n = n.nextSibling) {
        if (n.nodeType !== 3 || !/\S/.test(n.textContent ?? '')) continue;
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) out.push(r);
      }
      return out;
    }

    /**
     * Does the text of `e` lie on a picture where it is drawn? Hit tested at the middle of its first line: what is above it
     * must paint nothing, and the first thing below it that paints must be a picture.
     * @param {Element} e @param {boolean} [unknown] the answer when the test cannot see the text
     */
    function onPicture(e, unknown = false) {
      const own = painting(e);
      if (own !== 'none') return own === 'media';
      const line = textBoxes(e)[0];
      if (!line) return unknown;
      const x = line.left + line.width / 2;
      const y = line.top + line.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return unknown;
      const stack = doc.elementsFromPoint(x, y);
      const at = stack.indexOf(e);
      // Outside a pass `pointer-events: none` is in force, and such text is not in the stack.
      if (at < 0) return unknown;
      for (let i = 0; i < at; i++) if (painting(stack[i]) !== 'none') return unknown;
      for (let i = at + 1; i < stack.length; i++) {
        const s = stack[i];
        if (s === doc.documentElement || s === doc.body) return false;
        const p = painting(s);
        if (p !== 'none') return p === 'media';
      }
      return false;
    }

    /**
     * A grid point found `candidate` above `media`. The point may be in the box of the element but not on its text (a link whose
     * box is stretched over a card by a pseudo-element): then the text is tested where it is drawn. When it is on the picture,
     * the other text of the box that holds both is tested too.
     * @param {Element} candidate @param {Element} media @param {number} x @param {number} y @param {Set<Element>} found @param {Set<Element>} scopes
     */
    function confirm(candidate, media, x, y, found, scopes) {
      if (!isShape(candidate)) {
        const on = textBoxes(candidate).some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1);
        if (!on && !onPicture(candidate)) return;
      }
      found.add(candidate);
      /** @type {Element | null} */
      let scope = candidate.parentElement;
      for (let hops = 0; scope && hops < 8 && !scope.contains(media); hops++) scope = scope.parentElement;
      if (scope?.contains(media)) testScope(scope, candidate, found, scopes);
    }

    /**
     * A grid point fell on a picture with no text over it. Text between two grid points, in a box of about the size of the picture, is tested here.
     * @param {Element} media @param {Set<Element>} found @param {Set<Element>} scopes
     */
    function around(media, found, scopes) {
      const box = media.getBoundingClientRect();
      const most = box.width * box.height * 1.5;
      let scope = null;
      let next = media.parentElement;
      for (let hops = 0; next && next !== doc.body && hops < 4; hops++, next = next.parentElement) {
        const r = next.getBoundingClientRect();
        if (r.width * r.height > most) break;
        scope = next;
      }
      if (scope) testScope(scope, null, found, scopes);
    }

    /** @param {Element} scope @param {Element | null} skip @param {Set<Element>} found @param {Set<Element>} scopes */
    function testScope(scope, skip, found, scopes) {
      if (scope === doc.body || scope === doc.documentElement || scopes.has(scope)) return;
      scopes.add(scope);
      const all = scope.getElementsByTagName('*');
      if (all.length > NEIGHBOR_SCOPE) return;
      let tests = 0;
      for (const n of all) {
        if (n === skip || kept.has(n) || found.has(n) || !hasOwnText(n)) continue;
        if (++tests > NEIGHBOR_TESTS) break;
        if (onPicture(n)) found.add(n);
      }
    }

    function pictureCount() {
      const notes = /** @type {any} */ (dk).dynamic?.pictureNotes?.();
      if (typeof notes !== 'number') return doc.querySelector(PICTURES) ? 1 : -1;
      return doc.querySelectorAll(PICTURES).length + notes;
    }

    function sweep() {
      if (dead || !doc.body) return;
      const top = doc.documentElement;
      const settled = top.hasAttribute('data-dk-go') && top.getAttribute('data-dk-state') === 'ready' && doc.readyState === 'complete';
      if (!settled && performance.now() - startedAt < LOADING_GIVE_UP_MS) {
        later(250);
        return;
      }
      lastSweep = performance.now();
      const pass = lastSweep;
      const w = innerWidth;
      const h = innerHeight;
      if (w * h < MIN_AREA) return;
      if (unsure.size > 0) testUnsure();
      const pictures = pictureCount();
      if (pictures === 0) return;
      if (sleepingOn !== null) {
        // Half a screen of scrolling shows text that no pass has seen, with no new picture to say so.
        if (pictures === sleepingOn && Math.abs(scrollY - sleptAtY) < h / 2) return;
        sleepingOn = null;
        emptyPasses = 0;
      }
      const elements = doc.getElementsByTagName('*').length;
      if (elements > MAX_ELEMENTS) return;
      /** @type {Set<Element>} */
      const found = new Set();
      /** The boxes whose text was tested in this pass. @type {Set<Element>} */
      const scopes = new Set();
      const cols = Math.max(2, Math.min(COLS, Math.floor(w / CELL)));
      const rows = Math.max(2, Math.min(ROWS, Math.floor(h / CELL)));
      if (gridSize !== cols * rows) {
        gridSize = cols * rows;
        cursor = 0;
      }
      // Where a hit test is dear (a filter on every picture makes each a layer that the test visits) only every `stride`-th column and row
      // is tested in a pass, shifted from pass to pass, so that a pass costs about 40 ms.
      if (hitSamples >= 8) {
        stride = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(((hitMs / hitSamples) * gridSize) / 40))));
        phase %= stride * stride;
      }
      // Hit testing skips `pointer-events: none`. Those elements are listed once (15 s, while the element count holds) and marked inside a
      // slice for a rule; a rule on every element would restyle the page twice in each slice (above 300 of them it is used anyway).
      if (scan && scan.count > 0 && (scan.count !== elements || pass - scan.time > SCAN_TTL_MS)) {
        spare = scan;
        scan = null;
      }
      const sc = scan?.count ? scan : scanNone(performance.now() + BUDGET_MS);
      // The first list can take many seconds on a busy page. Text on a picture must not stay unreadable that long, so a pass runs without it.
      const list = sc ?? spare ?? { list: [], wide: false };
      if (sc && !sc.count) [sc.count, sc.time] = [elements, pass];
      const wide = list.wide;
      const marked = wide ? [] : list.list;
      for (const e of marked) e.setAttribute(NONE_ATTR, '');
      const hit = doc.createElement('style');
      hit.setAttribute('data-dk', 'probe');
      hit.textContent = wide ? '*{pointer-events:auto!important}' : `[${NONE_ATTR}]{pointer-events:auto!important}`;
      if (wide ? elements <= OVERRIDE_MAX_ELEMENTS : marked.length > 0) (doc.head ?? doc.documentElement).append(hit);
      let done = true;
      let began2 = 0;
      try {
        outer: for (let r = Math.floor(cursor / cols); r < rows; r++) {
          for (let c = r === Math.floor(cursor / cols) ? cursor % cols : 0; c < cols; c++) {
            if (stride > 1 && (c % stride !== phase % stride || r % stride !== Math.floor(phase / stride))) continue;
            if (began2 !== 0 && performance.now() - began2 > BUDGET_MS) {
              cursor = r * cols + c;
              done = false;
              break outer;
            }
            const at = performance.now();
            const x = ((c + 0.5) * w) / cols;
            const y = ((r + 0.5) * h) / rows;
            const stack = doc.elementsFromPoint(x, y);
            if (began2 !== 0) {
              hitMs += performance.now() - at;
              hitSamples += 1;
            }
            hitTests += 1;
            if (began2 === 0) began2 = performance.now();
            let candidate = null;
            for (const e of stack) {
              if (e === doc.documentElement || e === doc.body) break;
              if (candidate === null) {
                if (kept.has(e)) break;
                if (MEDIA_TAGS.has(e.tagName)) around(e, found, scopes);
                if (hasOwnText(e) || isShape(e)) {
                  const own = painting(e);
                  if (own === 'media') found.add(e);
                  if (own !== 'none') break;
                  candidate = e;
                }
                continue;
              }
              const p = painting(e);
              if (p === 'media') confirm(candidate, e, x, y, found, scopes);
              if (p !== 'none') break;
            }
          }
        }
      } finally {
        hit.remove();
        for (const e of marked) e.removeAttribute(NONE_ATTR);
      }
      lastSpent = performance.now() - pass;
      if (done) {
        cursor = 0;
        phase += 1;
        // A strided pass tests one cell in stride squared. The rest of the round follows at once, not at the next scroll or timer.
        round = stride > 1 ? round + 1 : 0;
        if (round >= stride * stride) round = 0;
        else later(Math.min(2000, Math.max(250, lastSpent * 10)));
      } else later(Math.min(2000, Math.max(60, lastSpent * 5)));
      // Reading the page's colors restyles it twice: it gets a task of its own.
      for (const e of found) toKeep.add(e);
      if (found.size > 0 && !keepTimer) {
        keepTimer = window.setTimeout(() => {
          keepTimer = 0;
          const batch = new Set(toKeep);
          toKeep.clear();
          const began = performance.now();
          guarded(() => keep(batch));
          spent += performance.now() - began;
        }, 0);
      }
      passes += 1;
      spent += performance.now() - pass;
      if (!sc) later(Math.min(2000, Math.max(60, lastSpent * 5)));
      // A find that cannot be kept (the budget is full, or the element is kept already) is no progress: the scan may sleep.
      const progress = kept.size < MAX_KEPT && [...found].some((e) => !kept.has(e));
      if (done && !progress && sc) {
        if (++emptyPasses >= EMPTY_PASSES * stride * stride || (oneLook && stride === 1)) {
          oneLook = false;
          sleepingOn = pictures;
          sleptAtY = scrollY;
        }
      } else {
        emptyPasses = 0;
        if (progress) oneLook = false;
      }
    }

    /** @param {Element} el */
    function drop(el) {
      const id = kept.get(el);
      if (id === undefined) return;
      kept.delete(el);
      rules.delete(id);
      el.removeAttribute(ATTR);
    }

    /** @param {Element} el */
    function inView(el) {
      const line = textBoxes(el)[0];
      return !line || (line.right > 0 && line.bottom > 0 && line.left < innerWidth && line.top < innerHeight);
    }

    function testUnsure() {
      let dropped = false;
      for (const el of unsure) {
        if (el.isConnected && !inView(el)) continue;
        unsure.delete(el);
        if (el.isConnected && onPicture(el, true)) continue;
        drop(el);
        dropped = true;
      }
      if (dropped) writeRules();
    }

    /** @param {Set<Element>} found */
    function keep(found) {
      if (dead || found.size === 0) return;
      const fresh = [...found].filter((e) => !kept.has(e)).slice(0, Math.max(0, MAX_KEPT - kept.size));
      if (fresh.length === 0) return;
      for (const { el, text } of readColors(fresh, true)) {
        const id = String(++counter);
        kept.set(el, id);
        el.setAttribute(ATTR, id);
        rules.set(id, `[${ATTR}="${id}"]${text}`);
        watched.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
      }
      rebuilt.observe(doc.documentElement, { childList: true, subtree: true });
      writeRules();
    }

    /**
     * A picture dimmed for the dark mode has less contrast with the dark or colored text the page wrote for it.
     * @param {Element} el @param {string} color
     */
    function onDimmed(el, color) {
      if (!doc.querySelector('img[data-dk-img="glare"]')) return false;
      const c = /** @type {any} */ (dk).color?.parseColor(color);
      if (!c || 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b >= DIMMED_TEXT_LUM) return false;
      const line = textBoxes(el)[0];
      return !!line && doc.elementsFromPoint(line.left + line.width / 2, line.top + line.height / 2).some((e) => e.getAttribute('data-dk-img') === 'glare');
    }

    /**
     * @param {Element[]} list @param {boolean} keepRules  leave the kept rules in force (the elements are not kept yet)
     * @returns {{ el: Element, text: string }[]} the rule after the attribute selector of each element
     */
    function readColors(list, keepRules) {
      /** @type {{ el: Element, text: string }[]} */
      const reads = [];
      /** @type {any} */ (dk).scheme.cascade((/** @type {any} */ r) => {
        const styleOf = r?.style ?? getComputedStyle;
        for (const el of list) {
          const cs = styleOf(el);
          if (isShape(el)) reads.push({ el, text: `{fill:${cs.fill}!important;stroke:${cs.stroke}!important;}` });
          // Text painted by a background clipped to it keeps that background and its fill. The E-ink mode replaces both with
          // weighted rules, so this rule weighs as an id.
          else if (clipsText(cs)) reads.push({ el, text: `:not(#dk-none){color:${cs.color}!important;background-image:${cs.backgroundImage}!important;-webkit-text-fill-color:${cs.webkitTextFillColor}!important;}` });
          else reads.push({ el, text: `{color:${onDimmed(el, cs.color) ? `color-mix(in srgb,${cs.color} ${DIMMED_TEXT}%,#000)` : cs.color}!important;}` });
        }
      }, keepRules ? (/** @type {HTMLStyleElement} */ el) => el.getAttribute('data-dk') === 'keep' : null);
      return reads;
    }

    function writeRules() {
      if (!style) {
        style = doc.createElement('style');
        style.setAttribute('data-dk', 'keep');
        (doc.head ?? doc.documentElement).append(style);
        const own = style;
        keeper?.track(own, () => (doc.head ?? doc.documentElement).append(own));
      }
      style.textContent = `@media screen{${[...rules.values()].join('')}}`;
    }

    /** @type {Set<Element>} */
    const changed = new Set();
    /** @type {ReturnType<typeof setTimeout> | null} */
    let refreshTimer = null;
    let lastRefresh = 0;
    let refreshed = 0;
    const watched = new MutationObserver((records) => {
      if (dead) return;
      for (const r of records) if (r.target instanceof Element && kept.has(r.target)) changed.add(r.target);
      refreshSoon();
    });

    function refreshSoon() {
      if (changed.size && refreshTimer === null) refreshTimer = setTimeout(refresh, Math.max(0, lastRefresh + REFRESH_MS - performance.now()));
    }

    /** Kept text that left the DOM, by its look. A page that renders a part again takes it out and puts new nodes in. @type {Map<string, { el: Element, id: string }[]>} */
    const gone = new Map();
    /** @type {ReturnType<typeof setTimeout> | null} */
    let goneTimer = null;

    /** @param {Element} el */
    function lookOf(el) {
      let text = '';
      for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) text += n.nodeValue;
      text = text.trim();
      return text && `${el.tagName}|${el.getAttribute('class') ?? ''}|${text}`;
    }

    /** @param {NodeList} nodes */
    const hasElement = (nodes) => [...nodes].some((n) => n.nodeType === Node.ELEMENT_NODE);

    /** Text in a filled box that holds no picture is not on a picture, however much it looks like kept text. @param {Element} el */
    function onPlainBox(el) {
      for (let e = /** @type {Element | null} */ (el), hops = 0; e && e !== doc.body && hops < 8; e = e.parentElement, hops++) {
        const p = painting(e);
        if (p === 'media') return false;
        if (p === 'paint') return !e.querySelector(PICTURES);
      }
      return false;
    }

    /** @param {Element} el @returns {boolean} true when nothing is left to match */
    function takeRule(el) {
      if (kept.has(el)) return false;
      const look = lookOf(el);
      const list = gone.get(look);
      if (!list || onPlainBox(el)) return false;
      const was = list.shift();
      if (!was) return false;
      if (list.length === 0) gone.delete(look);
      kept.set(el, was.id);
      el.setAttribute(ATTR, was.id);
      watched.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
      if (unsure.delete(was.el)) unsure.add(el);
      // Two texts can look the same and differ in color: the read that follows puts the page color of this node in the rule.
      changed.add(el);
      return gone.size === 0;
    }

    // Runs before the next paint, so new text has its color in its first frame.
    const rebuilt = new MutationObserver((records) => {
      if (dead) return;
      guarded(() => {
        if (records.some((r) => hasElement(r.removedNodes))) {
          for (const [el, id] of kept) {
            if (el.isConnected) continue;
            kept.delete(el);
            const look = lookOf(el);
            const list = gone.get(look);
            if (list) list.push({ el, id });
            else gone.set(look, [{ el, id }]);
          }
        }
        if (gone.size === 0) return;
        goneTimer ??= setTimeout(forget, GONE_MS);
        let budget = MAX_ADDED;
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeType !== Node.ELEMENT_NODE || !n.isConnected) continue;
            const walk = doc.createTreeWalker(n, NodeFilter.SHOW_ELEMENT);
            for (let e = walk.currentNode; e; e = /** @type {Node} */ (walk.nextNode())) {
              if (budget-- <= 0 || takeRule(/** @type {Element} */ (e))) {
                refreshSoon();
                return;
              }
            }
          }
        }
        refreshSoon();
      });
    });

    function forget() {
      goneTimer = null;
      if (dead) return;
      let dropped = false;
      for (const list of gone.values()) {
        for (const { el, id } of list) {
          if (el.isConnected && !kept.has(el)) {
            kept.set(el, id);
            continue;
          }
          rules.delete(id);
          if (!kept.has(el)) el.removeAttribute(ATTR);
          dropped = true;
        }
      }
      gone.clear();
      if (dropped) guarded(writeRules);
    }

    function refresh() {
      refreshTimer = null;
      if (dead) return;
      lastRefresh = performance.now();
      const list = [...changed].filter((el) => el.isConnected && kept.has(el));
      changed.clear();
      if (list.length === 0) return;
      guarded(() => {
        for (const { el, text } of readColors(list, false)) {
          const id = kept.get(el);
          if (id !== undefined) rules.set(id, `[${ATTR}="${id}"]${text}`);
        }
        writeRules();
        refreshed += list.length;
      });
    }

    /** @param {() => void} pass */
    function guarded(pass) {
      try {
        pass();
      } catch {
        if (++failures >= 3) dead = true;
      }
    }

    function later(delay = 300) {
      if (dead || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        guarded(sweep);
      }, Math.max(delay, lastSweep + Math.max(300, lastSpent * 10) - performance.now()));
    }

    const onScroll = () => later(250);
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll, { passive: true });
    const onLoad = () => later(400);
    addEventListener('load', onLoad, { once: true });
    // A page can take a placeholder off its pictures long after the load, and that changes nothing the scan counts.
    const nudges = [600, 1500, 3500, 7000, 12000].map((t) => setTimeout(() => {
      sleepingOn = null;
      emptyPasses = 0;
      oneLook = true;
      later(0);
    }, t));

    return {
      /** A picture turned out to be mostly clear: text that is no longer on a picture takes the theme. */
      release() {
        toKeep.clear();
        for (const el of kept.keys()) unsure.add(el);
        testUnsure();
        sleepingOn = null;
        emptyPasses = 0;
      },
      stats: () => ({ kept: kept.size, since: startedAt, passes, spent: Math.round(spent), hitTests, sleeping: sleepingOn !== null, refreshed }),
      /** @param {Element[]} list */
      adopt(list) {
        if (doc.documentElement.getAttribute('data-dk-state') !== 'ready') return;
        guarded(() => keep(new Set(list.filter((e) => e.isConnected))));
      },
      end() {
        dead = true;
        if (timer !== null) clearTimeout(timer);
        clearTimeout(keepTimer);
        toKeep.clear();
        removeEventListener('scroll', onScroll);
        removeEventListener('resize', onScroll);
        removeEventListener('load', onLoad);
        for (const t of nudges) clearTimeout(t);
        watched.disconnect();
        rebuilt.disconnect();
        if (goneTimer !== null) clearTimeout(goneTimer);
        for (const list of gone.values()) for (const { el } of list) el.removeAttribute(ATTR);
        gone.clear();
        if (refreshTimer !== null) clearTimeout(refreshTimer);
        keeper?.stop();
        style?.remove();
        unsure.clear();
        for (const el of kept.keys()) el.removeAttribute(ATTR);
        for (const el of doc.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
        scan = null;
        spare = null;
        for (const el of doc.querySelectorAll(`[${NONE_ATTR}]`)) el.removeAttribute(NONE_ATTR);
        kept.clear();
        rules.clear();
      },
    };
  }

  /** @type {ReturnType<typeof start> | null} */
  let active = null;
  dk.backdrop = Object.freeze({
    start() {
      active?.end();
      active = start();
    },
    stop() {
      active?.end();
      active = null;
    },
    isActive: () => active !== null,
    stats: () => (active ? active.stats() : null),
    adopt(/** @type {Element[]} */ list) {
      active?.adopt(list);
    },
    release() {
      active?.release();
    },
  });
})();
