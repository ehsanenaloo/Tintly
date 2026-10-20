// @ts-check
// CSS pictures, canvases and the legacy `background` attribute: the second half of the picture sorting (images.js is the first).
(() => {
  'use strict';
  const dk = globalThis.__dk;
  if (!dk || dk.imagebg) return;
  const images = /** @type {any} */ (dk.images);
  if (!images || !images.kit) return;
  const { ATTR, BG_ATTR, MIN_SIDE, MAX_SIDE, MAX_CACHE, HIDE, WALL, TILE_CSS, classify, toneOf, kindOf } = images.kit;

  const CANVAS_LOOKS = 30;
  const CANVAS_GAP = 1000;
  const CANVAS_LATE = [20000, 45000, 90000, 200000];
  const CANVAS_PER_PASS = 20;
  const BG_MAX_SELECTORS = 3000;
  const BG_MAX_FOUND = 1500;
  const BG_MAX_URLS = 150;
  const BG_MAX_JOBS = 400;
  const BG_BUDGET_MS = 10;
  const BG_MAX_ELEMENTS = 40000;
  const BG_REQUERY_MS = 4000;
  const BG_MAX_SIDE = 640;
  const BG_PHOTO_MIN = [160, 80];
  const BG_TEXT_MAX = 40;

  /** @type {Set<Element>} */
  const legacyQueue = new Set();
  /** @type {(() => void) | null} */
  let legacyNudge = null;

  /** @param {Element} el */
  function noteLegacy(el) {
    if (legacyQueue.size >= 400) return;
    legacyQueue.add(el);
    legacyNudge?.();
  }

  // Selectors that set a background picture, told by the Dynamic engine (`?selector`: through a custom property).
  /** @type {Set<string>} */
  const bgSeen = new Set();
  /** @type {string[]} */
  let bgList = [];
  let bgVersion = 0;
  /** @type {(() => void) | null} */
  let bgNudge = null;
  const PSEUDO = /::|:(?:before|after|first-line|first-letter)\b|:(?:hover|focus|focus-visible|focus-within|active|target)\b/i;

  /** @type {{ selector: string, host: string, which: '::before' | '::after', done: boolean, tries: number, looks: number, retryAt: number }[]} */
  const pseudoList = [];
  const pseudoSeen = new Set();
  let pseudoVersion = 0;
  const PSEUDO_MAX = 300;
  const PSEUDO_RETRY_MS = 8000;
  const PSEUDO_TRIES_MAX = 20;
  const PSEUDO_LOOKS = 3;
  const PSEUDO_HOSTS_MAX = 100;

  /** @param {string} text */
  const splitList = (text) => /** @type {string[]} */ (/** @type {any} */ (dk.sitedark).splitList(text)).map((part) => part.trim());

  /** @param {string} list a selector list that holds a pseudo-element or a state */
  function notePseudo(list) {
    for (const part of splitList(list)) {
      const m = /^(.+?)::?(before|after)$/i.exec(part);
      if (!m || pseudoList.length >= PSEUDO_MAX || pseudoSeen.has(part)) continue;
      if (/:(?:hover|focus|focus-visible|focus-within|active|target|checked|disabled)(?![\w-])|::/i.test(m[1])) continue;
      pseudoSeen.add(part);
      pseudoList.push({ selector: part, host: m[1].trim(), which: m[2].toLowerCase() === 'before' ? '::before' : '::after', done: false, tries: 0, looks: 0, retryAt: 0 });
      pseudoVersion += 1;
    }
    bgNudge?.();
  }

  /** @type {Set<string>} */
  const varWait = new Set();
  let varPicture = false;

  /** @param {string} selector a rule's selector list */
  function noteBackground(selector) {
    if (selector === '') return;
    if (selector[0] === '?') {
      if (selector.length === 1) {
        varPicture = true;
        const waiting = [...varWait];
        varWait.clear();
        for (const w of waiting) noteBackground(w);
      } else if (varPicture) noteBackground(selector.slice(1));
      else if (varWait.size < BG_MAX_SELECTORS) varWait.add(selector.slice(1));
      return;
    }
    if (typeof selector !== 'string' || selector.length > 400 || bgSeen.has(selector) || bgSeen.size >= BG_MAX_SELECTORS) return;
    bgSeen.add(selector);
    if (PSEUDO.test(selector)) {
      notePseudo(selector);
      return;
    }
    try {
      document.createDocumentFragment().querySelector(selector);
    } catch {
      return;
    }
    bgList.push(selector);
    bgVersion += 1;
    bgNudge?.();
  }

  /** @param {string} css @returns {number} alpha of an rgb() or rgba() value */
  function alphaOf(css) {
    const m = /rgba?\(([^)]+)\)/.exec(css);
    if (!m) return css === 'transparent' ? 0 : 1;
    const p = m[1].split(/[,\s/]+/).filter(Boolean);
    return p.length > 3 ? Number(p[3]) : 1;
  }

  const URL_CALL = /url\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\s*\)/g;

  const SET_CALL = /(?:-webkit-)?image-set\(((?:[^()]|\([^()]*\))*)\)/g;
  const SET_ITEM = /url\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\s*\)\s*(?:([\d.]+)(?:x|dppx))?\s*(?:type\(\s*["']?([^"')]*))?/g;
  const SET_TYPES = /^image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon)$/i;

  /** @param {string} image */
  function flat(image) {
    return image.includes('image-set(')
      ? image.replace(SET_CALL, (_, items) => {
          let pick = '';
          let best = 0;
          for (const [, address, n, type] of items.matchAll(SET_ITEM)) {
            const res = n ? Number(n) : 1;
            if (type && !SET_TYPES.test(type)) continue;
            if (!pick || (res >= devicePixelRatio ? best < devicePixelRatio || res < best : best < devicePixelRatio && res > best)) [pick, best] = [`url(${address})`, res];
          }
          return pick || 'none';
        })
      : image;
  }

  /** @param {string} image @param {string} color */
  function fadesOnly(image, color) {
    const rest = flat(image).replace(URL_CALL, '');
    if (!rest.includes('gradient(')) return true;
    const ground = /rgb\((\d+), (\d+), (\d+)\)/.exec(color);
    if (!ground || /(?:radial|conic)-gradient|(?:image-set|cross-fade|element|color|lab|lch|hwb)\(/.test(rest)) return false;
    return [...rest.matchAll(/rgba?\(([^)]+)\)/g)].every(([, v]) => {
      const p = v.split(/[,\s/]+/).map(Number);
      return (p[3] ?? 1) < 0.05 || Math.abs(p[0] - +ground[1]) + Math.abs(p[1] - +ground[2]) + Math.abs(p[2] - +ground[3]) <= 60;
    });
  }

  /** @param {string} image @returns {string[]} */
  function urlsOf(image) {
    /** @type {string[]} */
    const out = [];
    for (const m of flat(image).matchAll(URL_CALL)) {
      let u = m[1].trim();
      if (u.length >= 2 && (u[0] === '"' || u[0] === "'")) u = u.slice(1, -1).replace(/\\(.)/g, '$1');
      out.push(u);
    }
    return out;
  }

  const kept = { found: new Set(), version: -1, at: 0, cost: 0, run: false, cursor: 0, pass: 0, group: 30 };

  /** @param {any} session */
  function attach(session) {
    const doc = /** @type {Document} */ (session.doc);
    const { dark, eink, options, skip, cache, stats, keeper, read, pixelsOf } = session;
    const pump = () => session.pump();
    let dead = false;
    for (const item of pseudoList) {
      item.done = false;
      item.tries = 0;
      item.looks = 0;
      item.retryAt = 0;
    }
    /** @type {ReturnType<typeof setTimeout> | null} */
    let bgTimer = null;
    let bgDue = 0;
    const bgJobs = session.jobs;
    /** @type {Set<Element>} */
    const bgFound = kept.found;
    for (const el of bgFound) if (!el.isConnected) bgFound.delete(el);
    /** @type {WeakMap<Element, string>} */
    const bgHandled = new WeakMap();
    /** @type {Set<Element>} */
    const bgMarked = new Set();
    const bgState = { more: false, at: 0, lastSweep: 0, jobs: 0, urls: 0, startedAt: performance.now() };
    const legacyEls = new WeakSet();
    const surfaces = session.surfaces;
    let ground = '';
    /** @type {Map<ShadowRoot, HTMLStyleElement>} */
    const rootStyles = new Map();

    /** @param {Element} el */
    function bgUnmark(el) {
      if (el.hasAttribute(BG_ATTR)) el.removeAttribute(BG_ATTR);
      bgMarked.delete(el);
    }

    /** @type {WeakMap<Element, { n: number, at: number }>} */
    const canvasLooks = new WeakMap();
    function canvasPass() {
      const margin = innerHeight;
      const now = performance.now();
      let left = CANVAS_PER_PASS;
      for (const c of doc.querySelectorAll('canvas')) {
        const look = canvasLooks.get(c) ?? { n: 0, at: -CANVAS_GAP };
        const w = c.width;
        const h = c.height;
        if (look.n >= CANVAS_LOOKS || now - look.at < CANVAS_GAP || Math.min(w, h) < MIN_SIDE || Math.max(w, h) > MAX_SIDE || (skip !== '' && c.matches(skip))) continue;
        const r = c.getBoundingClientRect();
        if (r.bottom < -margin || r.top > innerHeight + margin) continue;
        if (left-- === 0) break;
        canvasLooks.set(c, { n: look.n + 1, at: now });
        try {
          const pixels = pixelsOf(c);
          const action = dark ? classify(pixels) : kindOf(toneOf(pixels)) === 'wall' ? 'wall' : '';
          if (action === 'invert' || action === 'wall') c.setAttribute(ATTR, action);
          else c.removeAttribute(ATTR);
        } catch {
          c.removeAttribute(ATTR);
        }
      }
    }

    const canvasOnly = () => {
      if (!dead && !doc.hidden) canvasPass();
    };

    /** @param {number} [delay] */
    function bgLater(delay = 300) {
      const at = performance.now() + Math.max(delay, bgState.lastSweep + 300 - performance.now());
      // A look that waits for a far retry (a pseudo-element verdict) does not hold back an earlier one.
      if (dead || (bgTimer !== null && bgDue <= at)) return;
      if (bgTimer !== null) clearTimeout(bgTimer);
      bgDue = at;
      bgTimer = setTimeout(bgSweep, at - performance.now());
    }
    bgNudge = () => bgLater(400);
    legacyNudge = () => bgLater(150);

    /** @param {Element} el */
    function legacyAddress(el) {
      try {
        return new URL(el.getAttribute('background') ?? '', doc.baseURI).href;
      } catch {
        return null;
      }
    }

    /** @param {Element} el */
    function ruleFor(el) {
      const rn = el.getRootNode();
      if (!(rn instanceof ShadowRoot)) return;
      const known = rootStyles.get(rn);
      if (known && known.isConnected) return;
      const st = doc.createElement('style');
      st.setAttribute('data-dk', 'images');
      st.textContent = `@media screen{${TILE_CSS}}`;
      rn.append(st);
      rootStyles.set(rn, st);
    }

    /** @param {Element} el @param {CSSStyleDeclaration} cs @param {DOMRect} rect @returns {boolean} true when marked */
    function maskedMark(el, cs, rect) {
      const mask = cs.maskImage || cs.webkitMaskImage;
      if (!mask || mask === 'none' || !mask.includes('url(')) return false;
      const color = /** @type {any} */ (dk).color;
      const parsed = color?.parseColor(cs.backgroundColor);
      const alone = el.childElementCount === 0 && !hasText(el) && (cs.filter === 'none' || el.hasAttribute(BG_ATTR)) && Math.max(rect.width, rect.height) <= BG_MAX_SIDE;
      if (!alone || !parsed || parsed.a < 0.5 || color.toOklch(parsed)[0] >= 0.4 || color.toOklch(parsed)[1] > 0.06) return false;
      if (el.getAttribute(BG_ATTR) !== 'invert') {
        el.setAttribute(BG_ATTR, 'invert');
        bgMarked.add(el);
        stats.bgInvert += 1;
      }
      return true;
    }

    function bgSweep() {
      bgTimer = null;
      if (dead || !doc.body) return;
      const root = doc.documentElement;
      const themed = root.getAttribute('data-dk-state') === 'ready';
      const settled = themed && doc.readyState === 'complete';
      const early = !settled && themed && legacyQueue.size > 0;
      if (!settled && !early && performance.now() - bgState.startedAt < 10000) {
        bgLater(300);
        return;
      }
      if (doc.getElementsByTagName('*').length > BG_MAX_ELEMENTS) return;
      const began = performance.now();
      bgState.lastSweep = began;
      canvasPass();
      for (const el of legacyQueue) {
        legacyEls.add(el);
        if (el.isConnected && bgFound.size < BG_MAX_FOUND) bgFound.add(el);
      }
      legacyQueue.clear();
      if (!early && !kept.run && (kept.version !== bgVersion || began - kept.at > Math.max(BG_REQUERY_MS, kept.cost * 33))) {
        Object.assign(kept, { run: true, cursor: 0, at: began, pass: 0 });
      }
      if (!early && !bgState.more) {
        try {
          for (const el of doc.querySelectorAll('[style*="url("],[style*="image-set("]')) if (bgFound.size < BG_MAX_FOUND) bgFound.add(el);
        } catch {
        }
      }
      bgState.more = false;
      let more = false;
      while (!early && kept.run) {
        if (kept.cursor >= bgList.length) {
          Object.assign(kept, { run: false, cost: kept.pass, version: bgVersion });
          break;
        }
        if (performance.now() - began > BG_BUDGET_MS) {
          more = true;
          break;
        }
        const group = bgList.slice(kept.cursor, kept.cursor + kept.group).join(',');
        kept.cursor += kept.group;
        const t = performance.now();
        try {
          for (const el of doc.querySelectorAll(group)) if (bgFound.size < BG_MAX_FOUND) bgFound.add(el);
        } catch {
        }
        const took = performance.now() - t;
        kept.pass += took;
        kept.group = took > 25 ? Math.max(8, kept.group >> 1) : took < 8 ? Math.min(30, kept.group + 4) : kept.group;
      }
      if (!early) {
        for (const item of pseudoList) {
          if (item.done || item.retryAt > began) continue;
          if (performance.now() - began > BG_BUDGET_MS) {
            more = true;
            break;
          }
          pseudoLook(item);
        }
        let retryIn = Infinity;
        for (const item of pseudoList) if (!item.done && item.retryAt > 0) retryIn = Math.min(retryIn, item.retryAt - performance.now());
        if (retryIn < Infinity) bgLater(Math.max(retryIn, 0));
      }
      const vw = innerWidth;
      const vh = innerHeight;
      let examined = 0;
      const items = [...bgFound];
      let at = items.length ? bgState.at % items.length : 0;
      for (let step = 0; step < items.length; step += 1, at = (at + 1) % items.length) {
        const el = items[at];
        if (!el.isConnected) {
          bgFound.delete(el);
          bgMarked.delete(el);
          continue;
        }
        if (examined >= 150 || performance.now() - began > BG_BUDGET_MS * 2) {
          more = true;
          break;
        }
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.bottom < -vh || r.top > 2 * vh || r.right < -vw || r.left > 2 * vw) continue;
        examined += 1;
        const cs = getComputedStyle(el);
        const image = cs.backgroundImage;
        if (image === 'none' || !image.includes('url(')) {
            if (el.getAttribute(BG_ATTR) === 'tile') continue;
          bgHandled.set(el, '');
          if (!dark || !maskedMark(el, cs, r)) bgUnmark(el);
          continue;
        }
        const key = `${image}|${cs.backgroundColor}`;
        if (bgHandled.get(el) === key) continue;
        bgHandled.set(el, key);
        const urls = urlsOf(image);
        // Several layers (a photo under a gradient) are the page's own composition.
        if (urls.length !== 1 || !fadesOnly(image, cs.backgroundColor) || (skip !== '' && el.matches(skip))) {
          bgUnmark(el);
          continue;
        }
        if (bgState.jobs >= BG_MAX_JOBS) {
          stats.bgCapped += 1;
          continue;
        }
        bgState.jobs += 1;
        bgJobs.push({ el, url: urls[0], key, legacy: legacyEls.has(el) && legacyAddress(el) === urls[0] });
      }
      bgState.at = at;
      if (bgJobs.length) pump();
      if (more) {
        bgState.more = true;
        bgState.lastSweep = 0;
        bgLater(Math.max(60, (performance.now() - began) * 3));
      }
    }

    /** @param {string} url */
    function isRemote(url) {
      if (/^(?:data|blob):/i.test(url)) return false;
      try {
        return new URL(url, doc.baseURI).origin !== location.origin;
      } catch {
        return false;
      }
    }

    /** @param {string} url @returns {Promise<'keep' | 'dim' | 'invert' | 'plate' | 'flip' | null>} */
    async function actionFor(url) {
      let action = cache.get(url);
      if (action !== undefined && surfaces.has(url)) return action;
      if (bgState.urls >= BG_MAX_URLS) {
        stats.bgCapped += 1;
        return null;
      }
      bgState.urls += 1;
      try {
        const probe = new Image();
        probe.decoding = 'async';
        if (isRemote(url)) probe.crossOrigin = 'anonymous';
        probe.src = url;
        await probe.decode().catch(() => {});
        if (dead) return null;
        const pixels = await read(probe, url);
        if (dead) return null;
        if (!pixels) {
          stats.failed += 1;
          return null;
        }
        action = classify(pixels);
        surfaces.set(url, toneOf(pixels));
      } catch {
        stats.failed += 1;
        return null;
      }
      stats.analyzed += 1;
      if (cache.size >= MAX_CACHE) {
        cache.delete(/** @type {string} */ (cache.keys().next().value));
        surfaces.clear();
      }
      cache.set(url, action);
      return action;
    }

    /** @type {HTMLStyleElement | null} */
    let pseudoStyle = null;
    /** @type {Map<string, string>} */
    const pseudoRules = new Map();

    /** @param {string} selector @param {'invert' | 'dim' | 'hide' | 'wall' | 'blend' | ''} action  '' takes the rule away @returns {boolean} true when the rule changed */
    function pseudoRule(selector, action) {
      const css = !action ? '' : action === 'hide' ? HIDE : action === 'wall' ? WALL : action === 'blend' ? 'mix-blend-mode:difference!important' : `filter:${action === 'invert' ? 'invert(1) hue-rotate(180deg)' : 'brightness(.9)'}!important`;
      if ((pseudoRules.get(selector) ?? '') === css) return false;
      if (css) pseudoRules.set(selector, css);
      else pseudoRules.delete(selector);
      if (!pseudoStyle) {
        pseudoStyle = doc.createElement('style');
        pseudoStyle.setAttribute('data-dk', 'images');
        (doc.head ?? doc.documentElement).append(pseudoStyle);
        const place = /** @type {HTMLStyleElement} */ (pseudoStyle);
        keeper?.track(place, () => (doc.head ?? doc.documentElement).append(place));
      }
      pseudoStyle.textContent = `@media screen{${[...pseudoRules].map(([s, c]) => `${s}{${c}}`).join('')}}`;
      return true;
    }

    /** @param {(typeof pseudoList)[number]} item */
    function pseudoLook(item) {
      /** @type {Element[]} */
      let hosts;
      try {
        hosts = [...doc.querySelectorAll(item.host)];
      } catch {
        item.done = true;
        return;
      }
      if (hosts.length > PSEUDO_HOSTS_MAX) {
        item.done = true;
        return;
      }
      /** @type {Set<string>} */
      const urls = new Set();
      /** @type {Element[]} */
      const covered = [];
      let filterOk = true;
      let layerOk = true;
      let how = 0;
      let seen = 0;
      for (const host of hosts) {
        const cs = getComputedStyle(host, item.which);
        const w = parseFloat(cs.width);
        const h = parseFloat(cs.height);
        if (cs.content === 'none' || cs.content === 'normal' || !(w > 0) || !(h > 0)) continue;
        seen += 1;
        const image = cs.backgroundImage;
        const found = image === 'none' ? [] : urlsOf(image);
        if (cs.content !== '""' || found.length !== 1 || image.includes('gradient(')) {
          item.done = true;
          pseudoRule(item.selector, '');
          return;
        }
        urls.add(found[0]);
        how = /^(?!no-repeat( no-repeat)?$)/.test(cs.backgroundRepeat) && !/cover|contain|100%/.test(cs.backgroundSize) ? 1 : 0;
        if (alphaOf(cs.backgroundColor) >= 0.02 || cs.filter !== 'none') layerOk = false;
        if (!layerOk || Math.max(w, h) > BG_MAX_SIDE) filterOk = false;
        if (cs.position === 'absolute' && w >= BG_PHOTO_MIN[0] && h >= BG_PHOTO_MIN[1]) {
          const box = host.getBoundingClientRect();
          if (w >= box.width * 0.9 && h >= box.height * 0.9) covered.push(host);
        }
      }
      if (seen === 0) {
        item.tries += 1;
        if (item.tries >= PSEUDO_TRIES_MAX) item.done = true;
        else if (item.tries >= 3) item.retryAt = performance.now() + PSEUDO_RETRY_MS;
        return;
      }
      item.done = true;
      if (++item.looks <= PSEUDO_LOOKS) {
        item.done = false;
        item.retryAt = performance.now() + 3000 * 3 ** item.looks;
      }
      if (urls.size !== 1) {
        pseudoRule(item.selector, '');
        return;
      }
      const [url] = urls;
      void actionFor(url).then((action) => {
        if (dead || !action) return;
        /** @type {'invert' | 'dim' | 'hide' | 'wall' | 'blend' | ''} */
        let todo = '';
        if (!dark) {
          const tone = surfaces.get(url);
          todo = tone ? surfaceAction(kindOf(tone, how), how > 0 || tone.sd < 0.02) : '';
          if (todo === 'wall' && !setGround()) todo = 'hide';
          if (todo === 'blend' && !(layerOk && lightGround(hosts[0]))) todo = '';
        } else if (filterOk && (action === 'invert' || action === 'dim')) todo = action;
        if (pseudoRule(item.selector, todo) && (todo === 'invert' || todo === 'dim')) {
          if (todo === 'invert') stats.bgInvert += 1;
          else stats.bgDim += 1;
        }
        if ((dark || !todo) && (action === 'keep' || action === 'dim')) {
          for (const host of covered) if (host.isConnected) keepTextOn(host);
        }
      });
    }

    function groundColor() {
      for (const e of [doc.body, doc.documentElement]) {
        const c = getComputedStyle(e).backgroundColor;
        if (alphaOf(c) >= 0.99) return c;
      }
      return '';
    }

    function setGround() {
      const paper = groundColor();
      if (paper !== '' && paper !== ground) {
        ground = paper;
        session.setStyle(`${session.sheet}:root{--dk-ground:${paper}}`);
      }
      return paper;
    }

    /** @param {ReturnType<typeof kindOf>} kind @param {boolean} tile @returns {'hide' | 'wall' | 'blend' | ''} */
    function surfaceAction(kind, tile) {
      if (kind === 'none') return '';
      if (kind === 'lines') return dark ? '' : 'blend';
      if ((kind === 'pale' ? !options.light : kind === 'deep' && !dark) && (eink || tile)) return 'hide';
      return kind === 'wall' && !dark ? 'wall' : '';
    }

    /** @type {WeakMap<Element, boolean>} */
    const grounds = new WeakMap();
    let grounded = 0;

    /** @param {Element} el */
    function lightGround(el) {
      const color = /** @type {any} */ (dk).color;
      for (let e = /** @type {Element | null} */ (el); e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (e !== el && cs.backgroundImage !== 'none' && !/^(?:tile|wall)$/.test(e.getAttribute(BG_ATTR) ?? '')) return false;
        const c = color.parseColor(cs.backgroundColor);
        if (c && c.a >= 0.5) {
          const [l, chroma] = color.toOklch(c);
          if (l < 0.75 || chroma > 0.06) return false;
          // The lines were drawn for a dark color: read the page's own color, engine off (6 reads at most).
          let was = grounds.get(e);
          if (was === undefined && grounded++ < 6) {
            const ground = e;
            was = /** @type {any} */ (dk).scheme.cascade((/** @type {any} */ r) => {
              const own = color.parseColor((r?.style ?? getComputedStyle)(ground).backgroundColor);
              return !!own && own.a >= 0.5 && color.toOklch(own)[0] < 0.5;
            });
            grounds.set(e, was === true);
          }
          return was === true;
        }
      }
      return false;
    }

    /** @param {Element} el @param {ReturnType<typeof kindOf>} kind @param {boolean} tile @returns {boolean} true when marked */
    function surfaceMark(el, kind, tile) {
      const todo = surfaceAction(kind, tile);
      if (!todo) return false;
      let mark = 'tile';
      if (todo === 'blend') {
        const own = alphaOf(getComputedStyle(el).backgroundColor) >= 0.5;
        if (!lightGround(el) || (!own && (el.childElementCount > 0 || hasText(el)))) return false;
        mark = own ? 'lines' : 'overlay';
      } else if (todo === 'wall' && setGround() !== '') mark = 'wall';
      ruleFor(el);
      el.setAttribute(BG_ATTR, mark);
      bgMarked.add(el);
      stats.bgTile += 1;
      return true;
    }

    /** @param {{ el: Element, url: string, key: string, legacy?: boolean }} job */
    async function analyzeBackground({ el, url, key, legacy }) {
      if (dead || !el.isConnected) return;
      const action = await actionFor(url);
      if (dead || !action || !el.isConnected) return;
      const cs = getComputedStyle(el);
      if (`${cs.backgroundImage}|${cs.backgroundColor}` !== key) {
        bgHandled.delete(el);
        return;
      }
      const tone = surfaces.get(url);
      const how = legacy ? 2 : /^(?!no-repeat( no-repeat)?$)/.test(cs.backgroundRepeat) && !/cover|contain|100%/.test(cs.backgroundSize) ? 1 : 0;
      if (tone && surfaceMark(el, kindOf(tone, how), how > 0 || tone.sd < 0.02)) return;
      if (options.light || cs.backgroundImage.includes('gradient(')) {
        bgUnmark(el);
        return;
      }
      if (eink && options.einkMark === true) {
        // The calm filter replaces the page's own, as it does on `<img>`: a filter such as `brightness(1)` must not send the box to the blend.
        const alone = el.childElementCount === 0 && !hasText(el) && alphaOf(cs.backgroundColor) < 0.02;
        if (alone) {
          el.setAttribute(BG_ATTR, 'gray');
          bgMarked.add(el);
          stats.bgGray += 1;
          return;
        }
        const rect0 = el.getBoundingClientRect();
        if (alphaOf(cs.backgroundColor) < 0.02 && rect0.width >= BG_PHOTO_MIN[0] && rect0.height >= BG_PHOTO_MIN[1]) {
          el.setAttribute(BG_ATTR, 'blend');
          bgMarked.add(el);
          stats.bgGray += 1;
          keepTextOn(el);
          return;
        }
      }
      const rect = el.getBoundingClientRect();
      if (!dark) bgUnmark(el);
      if (dark && (action === 'invert' || action === 'dim')) {
        const alone = el.childElementCount === 0 && !hasText(el) && alphaOf(cs.backgroundColor) < 0.02 && (cs.filter === 'none' || el.hasAttribute(BG_ATTR)) && Math.max(rect.width, rect.height) <= BG_MAX_SIDE;
        if (alone) {
          el.setAttribute(BG_ATTR, action);
          bgMarked.add(el);
          if (action === 'invert') stats.bgInvert += 1;
          else stats.bgDim += 1;
        } else {
          bgUnmark(el);
          stats.bgSkipped += 1;
          if (action === 'dim' && rect.width >= BG_PHOTO_MIN[0] && rect.height >= BG_PHOTO_MIN[1]) keepTextOn(el);
        }
        return;
      }
      bgUnmark(el);
      if (action === 'keep' && rect.width >= BG_PHOTO_MIN[0] && rect.height >= BG_PHOTO_MIN[1]) {
        stats.bgPhotos += 1;
        keepTextOn(el);
      }
    }

    /** @param {Element} e */
    function hasText(e) {
      for (let n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.textContent ?? '')) return true;
      return false;
    }

    /** @param {Element} box */
    function keepTextOn(box) {
      const backdrop = /** @type {any} */ (globalThis).__dk?.backdrop;
      if (!backdrop || typeof backdrop.adopt !== 'function') return;
      /** @type {Element[]} */
      const found = [];
      const walker = doc.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let visited = 0;
      while (walker.nextNode() && visited < 400 && found.length < BG_TEXT_MAX) {
        visited += 1;
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!parent || !/\S/.test(node.textContent ?? '') || found.includes(parent)) continue;
        let bare = true;
        /** @type {HTMLElement | null} */
        let a = parent;
        for (; a && a !== box; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (alphaOf(cs.backgroundColor) > 0.5 || (cs.backgroundImage !== 'none' && cs.backgroundImage !== '')) {
            bare = false;
            break;
          }
        }
        if (bare) found.push(parent);
      }
      if (found.length) backdrop.adopt(found);
    }

    const onBgScroll = () => bgLater(300);
    addEventListener('scroll', onBgScroll, { passive: true });
    addEventListener('resize', onBgScroll, { passive: true });
    addEventListener('load', onBgScroll, { once: true });
    /** @type {ReturnType<typeof setTimeout>[]} */
    const bgTimers = [500, 1500, 4000, 9000].map((t) => setTimeout(() => bgLater(0), t)).concat(CANVAS_LATE.map((t) => setTimeout(canvasOnly, t)));
    doc.addEventListener('visibilitychange', canvasOnly);
    if (kept.found.size) queueMicrotask(bgSweep);

    session.runJob = analyzeBackground;
    return {
      extra: () => ({ bgSelectors: bgList.length, bgFound: bgFound.size, bgMarked: bgMarked.size }),
      end() {
        dead = true;
        session.runJob = null;
        bgNudge = null;
        if (bgTimer !== null) clearTimeout(bgTimer);
        for (const t of bgTimers) clearTimeout(t);
        removeEventListener('scroll', onBgScroll);
        removeEventListener('resize', onBgScroll);
        removeEventListener('load', onBgScroll);
        doc.removeEventListener('visibilitychange', canvasOnly);
        bgJobs.length = 0;
        for (const el of doc.querySelectorAll(`[${BG_ATTR}]`)) el.removeAttribute(BG_ATTR);
        for (const el of bgMarked) el.removeAttribute(BG_ATTR);
        pseudoStyle?.remove();
        for (const st of rootStyles.values()) st.remove();
        rootStyles.clear();
        legacyNudge = null;
        bgMarked.clear();
      },
    };
  }

  /** @type {ReturnType<typeof attach> | null} */
  let active = null;
  dk.imagebg = Object.freeze({
    noteBackground,
    noteLegacy,
    /** @param {any} session */
    attach(session) {
      if (session.bg) return;
      active?.end();
      session.bg = active = attach(session);
    },
    stop() {
      active?.end();
      active = null;
    },
    isActive: () => active !== null,
    selectors: () => bgList.length,
  });
})();
