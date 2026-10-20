// @ts-check
// The Dynamic engine's work for shadow roots and constructed sheets: the inline colors of each watched root, and the override
// copies of the sheets that a root or the document adopts. Loaded on demand, at the first root or adopted sheet.
(() => {
  'use strict';
  const dk = /** @type {Record<string, any>} */ (globalThis.__dk);
  if (!dk || dk.shadowroots) return;

  /** @param {Record<string, any>} ctx */
  function create(ctx) {
    const doc = /** @type {Document} */ (ctx.doc);
    const { stats, sl, rootInline, adopted, ours, mine, attrRules, inlineAttr, processInline, flushInline, scanAttrs, readAttrs, flushAttrs, later, fault, maybeRelease, markReady, newBudget, emitList } = ctx;
    const { dead, inlineOff, staged } = ctx;
    const INLINE_SELECTOR = ctx.selector;
    const held = () => /** @type {any} */ (globalThis).__dkHold;
    const { rate: INLINE_RATE, now: INLINE_NOW, pause: INLINE_PAUSE_MS, pauseMax: INLINE_PAUSE_MAX_MS, add: ADD_BUDGET, settle: SETTLE_MS } = ctx.limits;

    /** @typedef {{ root: ShadowRoot, style: HTMLStyleElement | null, attrs: HTMLStyleElement | null, attrVersion: number, ids: Map<string, string>, added: string[], dirty: boolean, queue: Set<Element>, timer: ReturnType<typeof setTimeout> | null, attrMo: MutationObserver | null, addMo: MutationObserver | null, windowStart: number, count: number, pause: number, addWindow: number, addBudget: number, gone: boolean }} RootInline */
    const WATCHED_ATTRS = ['style', 'background', 'bgcolor', 'text', 'link', 'vlink', 'alink', 'color', 'fill', 'stroke', 'stop-color', 'flood-color', 'contenteditable'];
    const MAX_ROOT_STATES = 64;

    /** @param {ShadowRoot} root */
    function startRootInline(root) {
      if (dead() || inlineOff() || rootInline.has(root)) return;
      if (rootInline.size >= MAX_ROOT_STATES) {
        for (const old of [...rootInline.values()]) if (!old.root.host.isConnected) teardownRoot(old);
        if (rootInline.size >= MAX_ROOT_STATES * 4) return;
      }
      /** @type {RootInline} */
      const rs = {
        root, style: null, attrs: null, attrVersion: -1, ids: new Map(), added: [], dirty: false, queue: new Set(), timer: null,
        attrMo: null, addMo: null, windowStart: performance.now(), count: 0, pause: INLINE_PAUSE_MS, addWindow: 0, addBudget: ADD_BUDGET, gone: false,
      };
      rootInline.set(root, rs);
      void rootPass(rs);
      observeRootAttributes(rs);
      observeRootAdded(rs);
    }

    /** @param {RootInline} rs */
    function teardownRoot(rs) {
      rs.gone = true;
      rs.attrMo?.disconnect();
      rs.addMo?.disconnect();
      rs.attrMo = null;
      rs.addMo = null;
      if (rs.timer !== null) clearTimeout(rs.timer);
      rs.timer = null;
      rs.queue.clear();
      rs.style?.remove();
      rs.attrs?.remove();
      rootInline.delete(rs.root);
      try {
        for (const el of rs.root.querySelectorAll(`[${inlineAttr}]`)) el.removeAttribute(inlineAttr);
      } catch {
      }
    }

    /** @param {RootInline} rs */
    async function rootPass(rs) {
      ctx.passes(1);
      try {
        scanAttrs(rs.root);
        await sl.forEach(rs.root.querySelectorAll(INLINE_SELECTOR), (/** @type {Element} */ el) => processInline(el, rs), () => dead() || inlineOff() || rs.gone);
        flushRoot(rs);
        flushInline();
      } catch (error) {
        fault(error);
      } finally {
        ctx.passes(-1);
      }
      maybeRelease();
      markReady();
    }

    /** Write the new rules of a root. @param {RootInline} rs */
    function flushRoot(rs) {
      if (dead() || inlineOff() || rs.gone) return;
      if (rs.dirty) {
        rs.dirty = false;
        if (!rs.style) {
          rs.style = doc.createElement('style');
          rs.style.setAttribute('data-dk', 'inline');
          if (staged()) rs.style.media = 'not all';
          if (rs.attrs?.isConnected) rs.attrs.after(rs.style);
          else rs.root.prepend(rs.style);
        }
        let done = false;
        if (rs.added.length && rs.style.sheet && rs.style.sheet.cssRules.length === 1) {
          try {
            const block = /** @type {CSSGroupingRule} */ (rs.style.sheet.cssRules[0]);
            for (const id of rs.added) for (const rule of ctx.inlineRule(id, rs.ids.get(id))) block.insertRule(rule, block.cssRules.length);
            done = true;
          } catch {
          }
        }
        if (!done) {
          let css = '';
          for (const [id, text] of rs.ids) css += ctx.inlineRule(id, text).join('');
          rs.style.textContent = `@media screen{${css}}`;
        }
        rs.added = [];
      }
      flushRootAttrs(rs);
    }

    /** @param {RootInline} rs */
    function flushRootAttrs(rs) {
      if (dead() || inlineOff() || rs.gone || rs.attrVersion === ctx.attrVersion() || attrRules.size === 0) return;
      rs.attrVersion = ctx.attrVersion();
      if (!rs.attrs) {
        rs.attrs = doc.createElement('style');
        rs.attrs.setAttribute('data-dk', 'attrs');
        if (staged()) rs.attrs.media = 'not all';
        rs.root.prepend(rs.attrs);
      }
      rs.attrs.textContent = ctx.attrSheetText();
    }

    /** @param {RootInline} rs */
    function drainRoot(rs) {
      if (rs.timer !== null) clearTimeout(rs.timer);
      rs.timer = null;
      if (dead() || inlineOff() || rs.gone) return;
      for (const el of rs.queue) if (el.isConnected) processInline(el, rs);
      rs.queue.clear();
      flushRoot(rs);
      flushInline();
    }

    /** @param {RootInline} rs */
    function observeRootAttributes(rs) {
      rs.attrMo = new MutationObserver((records) => {
        if (dead() || inlineOff() || rs.gone) return;
        const now = performance.now();
        if (now - rs.windowStart > 1000) {
          rs.windowStart = now;
          rs.count = 0;
        }
        rs.count += records.length;
        if (rs.count > INLINE_RATE) {
          rs.attrMo?.disconnect();
          rs.attrMo = null;
          rs.queue.clear();
          stats.inlinePauses += 1;
          const wait = rs.pause;
          rs.pause = Math.min(rs.pause * 2, INLINE_PAUSE_MAX_MS);
          later(rs, () => {
            if (dead() || inlineOff() || rs.gone || rs.attrMo) return;
            rs.windowStart = performance.now();
            rs.count = 0;
            observeRootAttributes(rs);
            void rootPass(rs);
          }, wait);
          return;
        }
        for (const r of records) {
          if (!(r.target instanceof Element)) continue;
          if (r.attributeName === 'style' || r.attributeName === 'fill' || r.attributeName === 'stroke' || r.attributeName === 'stop-color' || r.attributeName === 'flood-color') rs.queue.add(r.target);
          else if (r.attributeName === 'contenteditable') ctx.bumpEditable();
          else readAttrs(r.target);
        }
        flushAttrs();
        flushRootAttrs(rs);
        if (rs.queue.size && rs.queue.size <= INLINE_NOW) drainRoot(rs);
        else if (rs.queue.size && rs.timer === null) rs.timer = setTimeout(() => drainRoot(rs), 40);
      });
      rs.attrMo.observe(rs.root, { attributes: true, attributeFilter: WATCHED_ATTRS, subtree: true });
    }

    /** @param {RootInline} rs */
    function observeRootAdded(rs) {
      rs.addMo = new MutationObserver((records) => {
        if (dead() || inlineOff() || rs.gone) return;
        const now = performance.now();
        if (now - rs.addWindow > 1000) {
          rs.addWindow = now;
          rs.addBudget = ADD_BUDGET;
        }
        const take = (/** @type {Element} */ el) => {
          if (rs.addBudget-- > 0) rs.queue.add(el);
        };
        for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) ctx.visitAdded(n, take, false);
        flushAttrs();
        flushRootAttrs(rs);
        if (rs.queue.size && rs.queue.size <= INLINE_NOW) drainRoot(rs);
        else if (rs.queue.size && rs.timer === null) rs.timer = setTimeout(() => drainRoot(rs), 40);
      });
      rs.addMo.observe(rs.root, { childList: true, subtree: true });
    }

    /** @type {number[]} */
    const constructedTimes = [];
    const CONSTRUCTED = {};

    // A sheet that many roots adopt is rewritten once per generation (a hint of change, or a new look, starts one); all roots adopt that copy.
    /** @type {WeakMap<CSSStyleSheet, { gen: number, copy: Promise<CSSStyleSheet | null> }>} */
    const built = new WeakMap();
    let generation = 0;

    /** The override of a sheet; null: none; undefined: the sheet is off. @param {CSSStyleSheet} sheet @returns {Promise<CSSStyleSheet | null> | undefined} */
    function buildOverride(sheet) {
      if (sheet.disabled) return undefined;
      if (ctx.skipSite()) return Promise.resolve(null);
      const hit = built.get(sheet);
      if (hit && hit.gen === generation) return hit.copy;
      const copy = makeOverride(sheet);
      const entry = { gen: generation, copy };
      built.set(sheet, entry);
      copy.catch(() => {
        if (built.get(sheet) === entry) built.delete(sheet);
      });
      return copy;
    }

    /** @param {CSSStyleSheet} sheet @returns {Promise<CSSStyleSheet | null>} */
    async function makeOverride(sheet) {
      /** @type {CSSRuleList} */
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        stats.unreadable += 1;
        return null;
      }
      stats.adoptedBuilds += 1;
      stats.adoptedRules += rules.length;
      /** @type {string[]} */
      const out = [];
      const budget = newBudget();
      await emitList(rules, out, doc.baseURI, budget, 0);
      if (budget.capped && !dead()) stats.capped += 1;
      if (dead() || budget.capped || !out.length) return null;
      const media = sheet.media.mediaText;
      const copy = new CSSStyleSheet(media && media !== 'all' ? { media } : undefined);
      copy.replaceSync(`@media screen{${out.join('')}}`);
      ours.add(copy);
      mine.add(copy);
      return copy;
    }

    /** Keep an override sheet after each adopted sheet of a root; runs again after every report. @param {Document | ShadowRoot} root */
    async function syncAdopted(root) {
      if (dead()) return;
      /** @type {CSSStyleSheet[]} */
      let list;
      try {
        list = Array.from(root.adoptedStyleSheets).filter((s) => s !== held());
      } catch {
        return;
      }
      let state = adopted.get(root);
      if (!state) {
        if (!list.length) return;
        state = { map: new Map(), token: {} };
        adopted.set(root, state);
      }
      const token = {};
      state.token = token;
      const originals = list.filter((s) => !ours.has(s));
      for (const sheet of originals) {
        if (dead() || state.token !== token) return;
        if (!state.map.has(sheet)) {
          try {
            const made = buildOverride(sheet);
            if (made !== undefined) state.map.set(sheet, await made);
          } catch (error) {
            state.map.set(sheet, null);
            fault(error);
          }
        }
      }
      if (dead() || state.token !== token) return;
      for (const sheet of [...state.map.keys()]) if (!originals.includes(sheet)) state.map.delete(sheet);
      if (!staged()) writeAdopted(root, state, originals);
    }

    /**
     * @param {Document | ShadowRoot} root
     * @param {{ map: Map<CSSStyleSheet, CSSStyleSheet | null> }} state
     * @param {CSSStyleSheet[]} originals
     */
    function writeAdopted(root, state, originals) {
      /** @type {CSSStyleSheet[]} */
      const wanted = [];
      for (const sheet of originals) {
        wanted.push(sheet);
        const copy = state.map.get(sheet);
        if (copy) wanted.push(copy);
      }
      let current;
      try {
        current = Array.from(root.adoptedStyleSheets);
      } catch {
        return;
      }
      if (current.includes(held())) wanted.unshift(held());
      if (current.length !== wanted.length || current.some((s, i) => s !== wanted[i])) {
        try {
          root.adoptedStyleSheets = wanted;
        } catch {
          stats.adoptFailed += 1;
        }
      }
      later(COUNT, countCopies, SETTLE_MS);
    }

    const COUNT = {};
    function countCopies() {
      let count = 0;
      for (const s of adopted.values()) for (const copy of s.map.values()) if (copy) count += 1;
      stats.adoptedSheets = count;
    }

    /** @param {Document | ShadowRoot} root */
    const touchAdopt = (root) => later(root, () => void syncAdopted(root));

    /** A constructed sheet changed. Its overrides are stale, so all of them are made again. */
    function touchConstructed() {
      const now = Date.now();
      constructedTimes.push(now);
      while (constructedTimes.length && now - constructedTimes[0] > 10000) constructedTimes.shift();
      const delay = constructedTimes.length > 20 ? 2000 : SETTLE_MS;
      later(
        CONSTRUCTED,
        () => {
          generation += 1;
          for (const state of adopted.values()) state.map.clear();
          for (const root of [...adopted.keys()]) void syncAdopted(root);
        },
        delay,
      );
    }

    /** @param {ShadowRoot} root */
    function watchRoot(root) {
      ctx.observe(root);
      ctx.enqueueSheets(root);
      void syncAdopted(root);
      startRootInline(root);
    }

    /** Write the overrides again, after the staged engine took over. */
    function writeAll() {
      for (const [adoptedRoot, state] of adopted) {
        try {
          writeAdopted(adoptedRoot, state, Array.from(adoptedRoot.adoptedStyleSheets).filter((s) => !ours.has(s) && s !== held()));
        } catch {
        }
      }
    }

    /** Make the overrides again, from the sheets as they are. */
    function rewriteAll() {
      generation += 1;
      for (const state of adopted.values()) state.map.clear();
      writeAll();
    }

    /** Script switched a constructed sheet off or on: its override follows. */
    function recheckDisabled() {
      for (const [root, state] of adopted) {
        let list;
        try {
          list = root.adoptedStyleSheets;
        } catch {
          continue;
        }
        let redo = false;
        for (const sheet of list) {
          if (ours.has(sheet) || sheet === held()) continue;
          const copy = state.map.get(sheet);
          if (copy) {
            if (copy.disabled !== sheet.disabled) copy.disabled = sheet.disabled;
          } else if (copy === undefined && !sheet.disabled) redo = true;
        }
        if (redo) void syncAdopted(root);
      }
    }

    /** The page dropped these roots: the engine forgets them. @param {ShadowRoot[]} gone */
    function release(gone) {
      for (const root of gone) {
        const rs = rootInline.get(root);
        if (rs) teardownRoot(rs);
        adopted.delete(root);
      }
    }

    function teardownAll() {
      for (const rs of [...rootInline.values()]) teardownRoot(rs);
    }

    function flushAttrsAll() {
      for (const rs of rootInline.values()) flushRootAttrs(rs);
    }

    return { watchRoot, startRootInline, syncAdopted, touchAdopt, touchConstructed, recheckDisabled, release, writeAll, rewriteAll, teardownAll, flushAttrs: flushAttrsAll };
  }

  dk.shadowroots = Object.freeze({ create });
})();
