// Runs the real gate (content/core/boot.js) in Node against stubs of the page, the storage, the worker and the engine. The test holds
// the clock, the storage reads and the visibility of the page, so a race between two decisions can be built step by step.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { REPO } from './tree.mjs';

const source = readFileSync(join(REPO, 'extension', 'content', 'core', 'boot.js'), 'utf8');

/**
 * @param {{ settings?: Record<string, any>, readyState?: string, visibility?: string, prerendering?: boolean, need?: (name: string) => Promise<boolean>, schedule?: any, random?: number, startedAt?: number }} [options] `startedAt`: the document clock when the files started
 */
export function bootRig({ settings = {}, readyState = 'loading', visibility = 'visible', prerendering = false, need, schedule, random = 0.5, startedAt = 60_000 } = {}) {
  let now = 1_000_000;
  let seq = 0;
  /** @type {{ id: number, at: number, fn: () => void, live: boolean }[]} */
  const timers = [];
  const setTimeoutFake = (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
    const t = { id: ++seq, at: now + Math.max(0, ms ?? 0), fn, live: true };
    timers.push(t);
    return t;
  };
  const clearTimeoutFake = (/** @type {any} */ t) => {
    if (t) t.live = false;
  };

  const data = { settings: structuredClone(settings) };
  /** Storage reads wait while the test holds them, each until it is let go. */
  let holding = false;
  /** @type {(() => void)[]} */
  const waiting = [];
  const reads = [];
  const storageListeners = [];
  const sent = [];
  const starts = [];
  let engineOn = false;
  const log = [];
  const docListeners = new Map();
  const winListeners = new Map();
  const observers = [];
  const waits = { loaded: new Map(), gaveUp: new Map() };
  let headQueries = 0;
  let rootScheme = '';

  class HTMLElement {}
  class SVGElement {}
  class HTMLStyleElement {}
  const root = Object.assign(new HTMLElement(), {
    getAttribute: () => null,
    hasAttribute: () => false,
    removeAttribute: () => {},
    style: { getPropertyValue: (/** @type {string} */ name) => (name === 'color-scheme' ? rootScheme : '') },
  });
  const head = {
    querySelector: () => {
      headQueries += 1;
      return null;
    },
  };
  const off = (/** @type {Map<string, Function[]>} */ map) => (/** @type {string} */ type, /** @type {Function} */ fn) => map.set(type, (map.get(type) ?? []).filter((f) => f !== fn));
  const on = (/** @type {Map<string, Function[]>} */ map) => (/** @type {string} */ type, /** @type {Function} */ fn, /** @type {any} */ options) => {
    map.set(type, [...(map.get(type) ?? []), fn]);
    options?.signal?.addEventListener('abort', () => off(map)(type, fn));
  };
  const doc = {
    contentType: 'text/html',
    documentElement: root,
    head,
    body: null,
    readyState,
    visibilityState: visibility,
    prerendering,
    addEventListener: on(docListeners),
    removeEventListener: off(docListeners),
    dispatchEvent: (/** @type {Event} */ e) => log.push(`event:${e.type}`),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const win = { navigation: undefined };
  /** @type {any} */ (win).top = win;

  const dk = {
    initialReadyState: readyState,
    startedAt,
    bucketOf: () => 'site.test',
    dynamic: {
      start: (/** @type {any} */ theme, /** @type {any} */ opts) => {
        engineOn = true;
        starts.push({ theme, opts });
      },
      stop: () => {
        engineOn = false;
        log.push('dynamic.stop');
      },
      isActive: () => engineOn,
      suspend: () => () => {},
    },
    match: { find: () => null, findEnabled: () => null },
    detect: { createDriver: () => ({ arm() {}, watchRoot() {}, recheck() {}, stop() {} }) },
    need: need ?? (async () => true),
    optional: {
      sync: async () => {},
      engineReady: () => {},
      whenLoaded: (/** @type {string} */ name, /** @type {() => void} */ fn) => waits.loaded.set(name, [...(waits.loaded.get(name) ?? []), fn]),
      whenGivenUp: (/** @type {string} */ name, /** @type {() => void} */ fn) => waits.gaveUp.set(name, [...(waits.gaveUp.get(name) ?? []), fn]),
      stop: () => log.push('optional.stop'),
    },
    scheme: {
      release: () => log.push('release'),
      clear: () => log.push('clear'),
      respecting: () => false,
      declared: () => null,
    },
    ...(schedule ? { schedule } : {}),
  };

  class FakeDate extends Date {
    constructor(/** @type {any[]} */ ...args) {
      super(...(args.length ? /** @type {[any]} */ (args) : [now]));
    }
    static now() {
      return now;
    }
  }

  const sandbox = {
    __dk: dk,
    chrome: {
      runtime: {
        id: 'x',
        sendMessage: (/** @type {any} */ m) => {
          sent.push(m);
          return Promise.resolve({ ok: false });
        },
      },
      storage: {
        local: {
          get: async (/** @type {string[]} */ keys) => {
            const snapshot = structuredClone(data);
            reads.push(keys);
            if (holding) await new Promise((r) => waiting.push(() => r(undefined)));
            if (snapshot.__fail) throw new Error('read failed');
            return Object.fromEntries(keys.filter((k) => k in snapshot).map((k) => [k, snapshot[k]]));
          },
        },
        onChanged: {
          addListener: (/** @type {Function} */ fn) => storageListeners.push(fn),
          removeListener: () => {},
        },
      },
    },
    document: doc,
    window: win,
    location: { host: 'site.test', pathname: '/', protocol: 'https:' },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    MutationObserver: class {
      constructor(/** @type {Function} */ fn) {
        this.fn = fn;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
    },
    HTMLElement,
    SVGElement,
    HTMLStyleElement,
    Event,
    AbortController,
    Date: FakeDate,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    setInterval: () => 0,
    clearInterval: () => {},
    queueMicrotask,
    addEventListener: on(winListeners),
    removeEventListener: off(winListeners),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`Math.random = () => ${random};`, context);

  const flush = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  };
  /** Move the clock; due timers run in order. */
  const advance = async (/** @type {number} */ ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      due.live = false;
      now = Math.max(now, due.at);
      due.fn();
      await flush();
    }
    now = end;
    await flush();
  };

  return {
    dk,
    data,
    starts,
    sent,
    log,
    reads,
    observers,
    statuses: () => sent.filter((m) => m.type === 'dk.page.status').map((m) => m.status),
    headQueries: () => headQueries,
    setRootScheme: (/** @type {string} */ v) => (rootScheme = v),
    run: () => vm.runInContext(source, context),
    flush,
    advance,
    /** Storage reads wait until `step` lets the oldest go or `open` lets all go. */
    hold() {
      holding = true;
    },
    step() {
      waiting.shift()?.();
    },
    open() {
      holding = false;
      for (const go of waiting.splice(0)) go();
    },
    /** A write of the stored data: the change event the browser sends. @param {Record<string, any>} values */
    write(values) {
      const changes = {};
      for (const [k, v] of Object.entries(values)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      for (const fn of storageListeners) fn(changes, 'local');
    },
    /** @param {'visible' | 'hidden'} state */
    show(state) {
      doc.visibilityState = state;
      for (const fn of docListeners.get('visibilitychange') ?? []) fn();
    },
    /** @param {string} type @param {any} event */
    fireWindow(type, event) {
      for (const fn of winListeners.get(type) ?? []) fn(event);
    },
    /** @param {string} type */
    fireDocument(type) {
      for (const fn of docListeners.get(type) ?? []) fn();
    },
    giveUp(/** @type {string} */ name) {
      for (const fn of waits.gaveUp.get(name) ?? []) fn();
    },
    doc,
  };
}
