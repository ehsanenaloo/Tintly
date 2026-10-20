import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

// A minimal DOM, enough for the watcher: nodes that hold listeners, and a way to fire an event at a node.
class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) {
    this.listeners.get(name)?.delete(fn);
  }
  count() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}
globalThis.Element = class Element extends FakeTarget {};
globalThis.ShadowRoot = class ShadowRoot extends FakeTarget {};
globalThis.HTMLStyleElement = class HTMLStyleElement extends globalThis.Element {};
globalThis.chrome = { dom: { openOrClosedShadowRoot: (el) => el.__root ?? null } };
// The document of the page, which the file listens to for the hints that come before the engine does.
globalThis.document = new FakeTarget();

const dk = await loadContent('engine/shadow.js');

/** Deliver an event to the document and to the roots, the way the browser delivers a composed event. */
function fire(doc, type, target) {
  for (const holder of [doc, ...doc.__roots]) for (const fn of holder.listeners.get(type) ?? []) fn({ type, target });
}

function setup(overrides = {}) {
  const doc = new FakeTarget();
  doc.__roots = [];
  const calls = { root: [], adopt: [], sheet: [], constructed: 0, overflow: 0 };
  const watcher = dk.shadow.createWatcher({
    document: doc,
    onRoot: (r) => {
      calls.root.push(r);
      doc.__roots.push(r);
    },
    onAdopt: (r) => calls.adopt.push(r),
    onSheet: (n) => calls.sheet.push(n),
    onConstructed: () => calls.constructed++,
    onOverflow: () => calls.overflow++,
    ...overrides,
  });
  return { doc, calls, watcher };
}

test('a shadow hint finds the root once, however often it arrives', () => {
  const { doc, calls } = setup();
  const host = new Element();
  host.__root = new ShadowRoot();
  fire(doc, 'dk:shadow', host);
  fire(doc, 'dk:shadow', host);
  assert.deepEqual(calls.root, [host.__root]);
});

test('a hint about an element with no shadow root changes nothing', () => {
  const { doc, calls } = setup();
  fire(doc, 'dk:shadow', new Element());
  assert.deepEqual(calls.root, []);
});

test('an adopt hint on the document, on a root and on a host', () => {
  const { doc, calls } = setup();
  fire(doc, 'dk:adopt', doc);
  const root = new ShadowRoot();
  fire(doc, 'dk:adopt', root);
  const host = new Element();
  host.__root = new ShadowRoot();
  fire(doc, 'dk:adopt', host);
  // A root hears an event twice, once on itself and once on the document, so the handler must not care about repeats.
  assert.deepEqual(new Set(calls.adopt), new Set([doc, root, host.__root]));
  assert.equal(calls.root.length, 2);
});

test('a sheet hint is passed on for style elements only', () => {
  const { doc, calls } = setup();
  const style = new HTMLStyleElement();
  fire(doc, 'dk:sheet', style);
  fire(doc, 'dk:sheet', new Element());
  fire(doc, 'dk:sheet', doc);
  assert.deepEqual(calls.sheet, [style]);
});

test('a constructed-sheet hint is passed on', () => {
  const { doc, calls } = setup();
  fire(doc, 'dk:constructed', doc);
  assert.equal(calls.constructed, 1);
});

test('a throwing handler does not stop the watcher', () => {
  const { doc } = setup({
    onSheet: () => {
      throw new Error('handler');
    },
  });
  assert.doesNotThrow(() => fire(doc, 'dk:sheet', new HTMLStyleElement()));
  assert.doesNotThrow(() => fire(doc, 'dk:shadow', { bad: true }));
  assert.doesNotThrow(() => fire(doc, 'dk:shadow', null));
});

test('too many hints are dropped, and one catch-up follows, later and later for a page that keeps flooding', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { doc, calls, watcher } = setup();
    const flood = () => {
      for (let i = 0; i < 5100; i++) fire(doc, 'dk:constructed', doc);
    };
    flood();
    assert.equal(calls.constructed, 5000);
    assert.equal(watcher.stats.dropped, 100);
    assert.equal(calls.overflow, 0);
    mock.timers.tick(999);
    assert.equal(calls.overflow, 0);
    mock.timers.tick(1);
    assert.equal(calls.overflow, 1);
    // Still the same window, so the next flood drops again and the catch-up now waits twice as long.
    flood();
    mock.timers.tick(1999);
    assert.equal(calls.overflow, 1);
    mock.timers.tick(1);
    assert.equal(calls.overflow, 2);
    watcher.stop();
  } finally {
    mock.timers.reset();
  }
});

test('stop removes every listener and cancels the catch-up', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { doc, calls, watcher } = setup();
    const host = new Element();
    host.__root = new ShadowRoot();
    fire(doc, 'dk:shadow', host);
    assert.ok(doc.count() > 0 && host.__root.count() > 0);
    for (let i = 0; i < 5100; i++) fire(doc, 'dk:constructed', doc);
    const handled = calls.constructed;
    watcher.stop();
    assert.equal(doc.count(), 0);
    assert.equal(host.__root.count(), 0);
    mock.timers.tick(60000);
    assert.equal(calls.overflow, 0);
    fire(doc, 'dk:constructed', doc);
    assert.equal(calls.constructed, handled);
    watcher.stop();
  } finally {
    mock.timers.reset();
  }
});

test('the shadow root is read through the browser, and a failing lookup gives null', () => {
  const el = new Element();
  el.__root = new ShadowRoot();
  assert.equal(dk.shadow.shadowRootOf(el), el.__root);
  assert.equal(dk.shadow.shadowRootOf(new Element()), null);
  const saved = globalThis.chrome.dom.openOrClosedShadowRoot;
  globalThis.chrome.dom.openOrClosedShadowRoot = () => {
    throw new Error('gone');
  };
  assert.equal(dk.shadow.shadowRootOf(new Element()), null);
  globalThis.chrome.dom.openOrClosedShadowRoot = saved;
});

test('Firefox style lookup: a property on the element is used first', () => {
  const el = new Element();
  const root = new ShadowRoot();
  el.openOrClosedShadowRoot = root;
  assert.equal(dk.shadow.shadowRootOf(el), root);
});

test('the first hint of a root, an adopted sheet or a constructed sheet is noted before any engine listens, a hint about a style element is not', () => {
  assert.equal(dk.shadowSeen, undefined);
  for (const type of ['dk:sheet']) for (const fn of globalThis.document.listeners.get(type) ?? []) fn({ type });
  assert.equal(dk.shadowSeen, undefined, 'a sheet hint is for ordinary style elements');
  for (const fn of globalThis.document.listeners.get('dk:adopt') ?? []) fn({ type: 'dk:adopt' });
  assert.equal(dk.shadowSeen, true);
});

test('roots whose host left the document are let go once there are many, not before and not while young', async () => {
  const released = [];
  const { doc, watcher } = setup({ onRelease: (list) => released.push(...list) });
  const make = (connected) => {
    const host = new Element();
    host.isConnected = connected;
    host.__root = new ShadowRoot();
    host.__root.host = host;
    return host;
  };
  const gone = [];
  for (let i = 0; i < 70; i++) {
    const host = make(true);
    gone.push(host);
    fire(doc, 'dk:shadow', host);
  }
  // All are connected: nothing is let go, however many there are.
  assert.equal(released.length, 0);
  assert.equal(watcher.roots.size, 70);
  for (const host of gone) host.isConnected = false;
  // They are young: the next root does not let them go.
  fire(doc, 'dk:shadow', make(true));
  assert.equal(released.length, 0);
  // Old enough: a prune lets go of all of them and leaves the one in the document.
  const real = performance.now;
  performance.now = () => real.call(performance) + 5000;
  try {
    watcher.prune();
  } finally {
    performance.now = real;
  }
  assert.equal(released.length, 70);
  assert.equal(watcher.roots.size, 1);
  assert.equal(watcher.stats.released, 70);
  // The listeners of a released root are gone.
  assert.equal(released[0].count(), 0);
  watcher.stop();
});
