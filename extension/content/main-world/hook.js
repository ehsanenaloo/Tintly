// @ts-check
// Runs in the page's own world before any page script. Tells the engine (isolated world) about changes it cannot see:
// shadow roots attached, constructed stylesheets adopted, rules added or removed through the CSSOM.
//
// It exposes nothing and changes no behavior: each wrapped function calls the original first and returns or throws
// exactly what it did. The only output is a DOM event on the node. The page can fake these events, so the engine
// treats them as hints and checks everything itself.
(() => {
  'use strict';

  // A second run in the same document (an injection into an open tab that the registered script reached first) must not wrap again.
  // The hook leaves no mark on the window that a page could list: a wrapped method answers this value of `this` with true, where the
  // browser's own method throws. An older build marked the window with a registered symbol; its hook is still running then.
  const PROBE = 'dk:hook?';
  try {
    if (Reflect.apply(Element.prototype.attachShadow, PROBE, []) === true) return;
  } catch {
    // The browser's own method: no hook yet.
  }
  if (Reflect.getOwnPropertyDescriptor(globalThis, Symbol.for('tintly.hook'))) return;

  // Own references to everything used, so later changes to the built-ins cannot affect us.
  const apply = Reflect.apply;
  const defineProperty = Reflect.defineProperty;
  const getDescriptor = Reflect.getOwnPropertyDescriptor;
  const NativeProxy = Proxy;
  const NativeEvent = CustomEvent;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const then = Promise.prototype.then;
  const microtask = globalThis.queueMicrotask;
  const NativeWeakMap = WeakMap;
  const mapGet = WeakMap.prototype.get;
  const mapSet = WeakMap.prototype.set;
  const doc = document;

  const MAX_QUEUE = 4000;
  /** @type {{ type: string, node: EventTarget }[]} */
  let queue = [];
  let scheduled = false;

  // What is already waiting for each node, as bits, so a thousand calls on one sheet send one event.
  const BIT = { shadow: 1, adopt: 2, sheet: 4, constructed: 8 };
  const waiting = new NativeWeakMap();

  const EVENT_NAMES = {
    shadow: 'dk:shadow',
    adopt: 'dk:adopt',
    sheet: 'dk:sheet',
    constructed: 'dk:constructed',
  };

  function flush() {
    scheduled = false;
    const items = queue;
    queue = [];
    for (let i = 0; i < items.length; i++) apply(mapSet, waiting, [items[i].node, 0]);
    for (let i = 0; i < items.length; i++) {
      try {
        const event = new NativeEvent(EVENT_NAMES[/** @type {keyof typeof EVENT_NAMES} */ (items[i].type)], {
          bubbles: true,
          composed: true,
        });
        apply(dispatch, items[i].node, [event]);
      } catch {
        // A listener of the page threw, or the node is gone. Nothing to do.
      }
    }
  }

  /** @param {keyof typeof EVENT_NAMES} type @param {EventTarget} node */
  function notify(type, node) {
    if (queue.length >= MAX_QUEUE) return;
    const bit = BIT[type];
    const mask = apply(mapGet, waiting, [node]) | 0;
    if (mask & bit) return;
    apply(mapSet, waiting, [node, mask | bit]);
    queue[queue.length] = { type, node };
    if (!scheduled) {
      scheduled = true;
      microtask(flush);
    }
  }

  /** The node a change to this sheet belongs to: its owner element, or the document for a constructed sheet. @param {any} sheet */
  function notifySheet(sheet) {
    if (!sheet) return;
    const owner = sheet.ownerNode;
    if (owner) notify('sheet', owner);
    else notify('constructed', doc);
  }

  /**
   * Replace a method with a proxy that runs the original and then reports.
   * A proxy keeps `name`, `length` and the prototype chain of the original.
   * @param {object | undefined} proto @param {string} name @param {(thisArg: any, result: any) => void} after
   */
  function wrap(proto, name, after) {
    if (!proto) return;
    const descriptor = getDescriptor(proto, name);
    if (!descriptor || typeof descriptor.value !== 'function') return;
    const proxy = new NativeProxy(descriptor.value, {
      apply(target, thisArg, args) {
        if (thisArg === PROBE) return true;
        const result = apply(target, thisArg, args);
        try {
          after(thisArg, result);
        } catch {
          // Never let reporting change what the page sees.
        }
        return result;
      },
    });
    defineProperty(proto, name, { ...descriptor, value: proxy });
  }

  /** @param {object | undefined} proto */
  function wrapAdopted(proto) {
    if (!proto) return;
    const descriptor = getDescriptor(proto, 'adoptedStyleSheets');
    if (!descriptor || typeof descriptor.set !== 'function') return;
    const setter = new NativeProxy(descriptor.set, {
      apply(target, thisArg, args) {
        const result = apply(target, thisArg, args);
        try {
          notify('adopt', thisArg);
        } catch {
          // See above.
        }
        return result;
      },
    });
    defineProperty(proto, 'adoptedStyleSheets', {
      get: descriptor.get,
      set: setter,
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
    });
  }

  // The scheme hint. While the gate says the engine runs in dark mode and the page's own dark theme is allowed,
  // `matchMedia('(prefers-color-scheme: dark)')` answers true and the light query false, so a page that picks its theme
  // with script picks the dark one. Only these two queries are touched. The gate sends the word in the name of a DOM event.
  const listen = EventTarget.prototype.addEventListener;
  const SCHEME_QUERY = /^(?:screen\s+and\s+)?\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i;
  // The E-ink mode adds one more: `(prefers-reduced-motion: reduce)` answers yes and `no-preference` no while
  // `dk:motion-reduce` is the last word. No other query is touched.
  const MOTION_QUERY = /^(?:screen\s+and\s+)?\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)$/i;
  // Dead references are dropped when the list reaches this size; it then grows to twice what is alive.
  let pruneAt = 200;
  let hint = false;
  let calm = false;
  /** @type {{ ref: WeakRef<MediaQueryList>, kind: string }[]} */
  let tracked = [];

  /** @param {string} kind */
  const isMotion = (kind) => kind === 'reduce' || kind === 'no-preference';
  /** The answer for a query: the hint when it is on, the browser's answer otherwise. @param {string} kind @param {boolean} real */
  const schemeAnswer = (kind, real) => {
    if (isMotion(kind)) return calm ? kind === 'reduce' : real;
    return hint ? kind === 'dark' : real;
  };
  /** Is the hint of this query's kind on? @param {string} kind */
  const hinted = (kind) => (isMotion(kind) ? calm : hint);

  function wrapMatchMedia() {
    const list = typeof MediaQueryList === 'undefined' ? undefined : MediaQueryList.prototype;
    const matchesGet = list && getDescriptor(list, 'matches')?.get;
    const mediaGet = list && getDescriptor(list, 'media')?.get;
    if (!list || typeof matchesGet !== 'function' || typeof mediaGet !== 'function') return;
    const NativeRef = WeakRef;
    const deref = WeakRef.prototype.deref;
    const NativeListEvent = MediaQueryListEvent;
    // The kind of each scheme or motion query the page made. The getter of `matches` on the prototype answers for those and gives the
    // browser's own answer for every other list, so a list has no property of its own that the page could find.
    const kinds = new NativeWeakMap();
    const matchesDescriptor = /** @type {PropertyDescriptor} */ (getDescriptor(list, 'matches'));
    defineProperty(list, 'matches', {
      ...matchesDescriptor,
      get: new NativeProxy(matchesGet, {
        apply(target, thisArg, args) {
          const real = apply(target, thisArg, args);
          const kind = apply(mapGet, kinds, [thisArg]);
          return kind === undefined ? real : schemeAnswer(kind, real);
        },
      }),
    });
    // One change guard for each kind of query, shared by every list the page makes: a call of the page costs a lookup, not a new function.
    /** @type {Record<string, (event: Event) => void>} */
    const guards = {};
    const guardFor = (/** @type {string} */ kind) =>
      (guards[kind] ??= (event) => {
        if (hinted(kind) && event.isTrusted) event.stopImmediatePropagation();
      });
    wrap(globalThis, 'matchMedia', (_window, mql) => {
      if (!mql) return;
      const text = String(apply(mediaGet, mql, []));
      const m = SCHEME_QUERY.exec(text) ?? MOTION_QUERY.exec(text);
      if (!m) return;
      const kind = m[1].toLowerCase();
      apply(mapSet, kinds, [mql, kind]);
      // The browser's own change events say the real answer; while the hint is on they would contradict the hint.
      apply(listen, mql, ['change', guardFor(kind), true]);
      if (tracked.length >= pruneAt) {
        tracked = tracked.filter((t) => apply(deref, t.ref, []) !== undefined);
        pruneAt = Math.max(200, tracked.length * 2);
      }
      tracked[tracked.length] = { ref: new NativeRef(mql), kind };
    });
    /** @param {boolean} on @param {boolean} motion */
    const setHint = (on, motion) => {
      if (motion ? calm === on : hint === on) return;
      if (motion) calm = on;
      else hint = on;
      for (const t of tracked) {
        if (isMotion(t.kind) !== motion) continue;
        const mql = apply(deref, t.ref, []);
        if (!mql) continue;
        // The page saw the hint's answer while the hint was on and the browser's own answer otherwise.
        const real = apply(matchesGet, mql, []);
        const forced = t.kind === 'dark' || t.kind === 'reduce';
        const before = on ? real : forced;
        const now = on ? forced : real;
        if (now === before) continue;
        try {
          apply(dispatch, mql, [new NativeListEvent('change', { media: apply(mediaGet, mql, []), matches: now })]);
        } catch {
          // A listener of the page threw.
        }
      }
    };
    apply(listen, doc, ['dk:scheme-dark', () => setHint(true, false), true]);
    apply(listen, doc, ['dk:scheme-off', () => setHint(false, false), true]);
    apply(listen, doc, ['dk:motion-reduce', () => setHint(true, true), true]);
    apply(listen, doc, ['dk:motion-off', () => setHint(false, true), true]);
  }

  try {
    wrapMatchMedia();
  } catch {
    // The page keeps the browser's own answers.
  }

  try {
    wrap(Element.prototype, 'attachShadow', (host) => notify('shadow', host));

    const sheetProto = typeof CSSStyleSheet === 'undefined' ? undefined : CSSStyleSheet.prototype;
    for (const name of ['insertRule', 'deleteRule', 'addRule', 'removeRule', 'replaceSync']) {
      wrap(sheetProto, name, (sheet) => notifySheet(sheet));
    }
    // `replace` finishes later, so report when its promise settles.
    wrap(sheetProto, 'replace', (sheet, promise) => {
      if (promise && typeof promise.then === 'function') {
        apply(then, promise, [() => notifySheet(sheet), () => {}]);
      }
    });

    const groupProto = typeof CSSGroupingRule === 'undefined' ? undefined : CSSGroupingRule.prototype;
    for (const name of ['insertRule', 'deleteRule']) {
      wrap(groupProto, name, (rule) => notifySheet(rule && rule.parentStyleSheet));
    }

    wrapAdopted(typeof Document === 'undefined' ? undefined : Document.prototype);
    wrapAdopted(typeof ShadowRoot === 'undefined' ? undefined : ShadowRoot.prototype);
  } catch {
    // A page or browser that does not allow this just gets no reports.
  }
})();
