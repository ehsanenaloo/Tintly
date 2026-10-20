import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { REPO } from '../helpers/tree.mjs';

const source = readFileSync(process.env.DK_HOOK_FILE ?? join(REPO, 'extension', 'content', 'main-world', 'hook.js'), 'utf8');

/** The real hook.js in a context with fake media queries, a system whose scheme the test sets, and weak references the test can kill. */
function rig({ runs = 1 } = {}) {
  const sys = { dark: false, reduce: false };
  const refs = [];
  class Ref {
    constructor(target) {
      this.target = target;
      this.dead = false;
      refs.push(this);
    }
    deref() {
      return this.dead ? undefined : this.target;
    }
  }
  // The text of each list is kept outside it, as a browser keeps it inside: a list has no property of its own.
  const texts = new WeakMap();
  /** The system's answer for a list, as the browser computes it. */
  const real = (mql) => {
    const text = texts.get(mql);
    if (/dark/.test(text)) return sys.dark;
    if (/light/.test(text)) return !sys.dark;
    return /no-preference/.test(text) ? !sys.reduce : sys.reduce;
  };
  class MQL extends EventTarget {
    constructor(text) {
      super();
      texts.set(this, text);
    }
    get media() {
      return texts.get(this);
    }
    get matches() {
      return real(this);
    }
  }
  /** An element whose `attachShadow` throws for a `this` that is not an element, as the browser's does. */
  class Element {
    attachShadow() {
      if (!(this instanceof Element)) throw new TypeError('Illegal invocation');
      return {};
    }
  }
  class ChangeEvent extends Event {
    constructor(type, init) {
      super(type);
      this.matches = init.matches;
    }
  }
  class Trusted extends ChangeEvent {
    constructor(matches) {
      super('change', { matches });
      Object.defineProperty(this, 'isTrusted', { get: () => true });
    }
  }
  const doc = new EventTarget();
  const all = [];
  const sandbox = { document: doc, EventTarget, CustomEvent, Event, Element, MediaQueryList: MQL, MediaQueryListEvent: ChangeEvent, WeakRef: Ref, queueMicrotask, matchMedia: (text) => (all.push(new MQL(text)), all.at(-1)) };
  const context = vm.createContext(sandbox);
  for (let i = 0; i < runs; i++) vm.runInContext(source, context);
  const query = (text, seen = []) => {
    const mql = sandbox.matchMedia(text);
    mql.addEventListener('change', (e) => seen.push(e.matches));
    return { mql, seen };
  };
  const native = (patch) => {
    const was = all.map(real);
    Object.assign(sys, patch);
    all.forEach((m, i) => {
      if (real(m) !== was[i]) m.dispatchEvent(new Trusted(real(m)));
    });
  };
  const word = (name) => doc.dispatchEvent(new Event(name));
  return { sys, refs, query, native, word, all, sandbox, MQL };
}

const DARK = '(prefers-color-scheme: dark)';

test('native changes before, during and after the hint give one consistent run of values', () => {
  const r = rig();
  r.sys.dark = true;
  const { mql, seen } = r.query(DARK);
  r.native({ dark: false });
  assert.deepEqual(seen, [false]);
  r.word('dk:scheme-dark');
  assert.deepEqual(seen, [false, true]);
  assert.equal(mql.matches, true);
  r.native({ dark: true });
  r.native({ dark: false });
  assert.deepEqual(seen, [false, true], 'the page does not see the native changes while the hint is on');
  assert.equal(mql.matches, true);
  r.word('dk:scheme-off');
  assert.deepEqual(seen, [false, true, false]);
  assert.equal(mql.matches, false);
  r.native({ dark: true });
  assert.deepEqual(seen, [false, true, false, true]);
});

test('a hint that ends while the system answers as the hint did sends no event', () => {
  const r = rig();
  const { seen } = r.query(DARK);
  r.word('dk:scheme-dark');
  r.native({ dark: true });
  r.word('dk:scheme-off');
  assert.deepEqual(seen, [true]);
});

test('every live query gets the transition, past the old limit of 200', () => {
  const r = rig();
  const queries = Array.from({ length: 450 }, () => r.query(DARK));
  r.word('dk:scheme-dark');
  assert.ok(queries.every((q) => q.seen.length === 1 && q.seen[0] === true && q.mql.matches === true));
  r.word('dk:scheme-off');
  assert.ok(queries.every((q) => q.seen.length === 2 && q.seen[1] === false));
});

test('dead queries are dropped and live ones keep their events through churn of mixed kinds', () => {
  const r = rig();
  const keep = [];
  for (let round = 0; round < 6; round++) {
    const batch = Array.from({ length: 300 }, (_, i) => r.query(i % 3 === 0 ? '(prefers-reduced-motion: reduce)' : i % 3 === 1 ? DARK : '(prefers-color-scheme: light)'));
    keep.push(...batch.slice(0, 40));
    for (const ref of r.refs) if (!keep.some((q) => q.mql === ref.target)) ref.dead = true;
  }
  r.word('dk:scheme-dark');
  r.word('dk:motion-reduce');
  // The system is light with no motion request: the hint turns the light query off and the other two on.
  for (const q of keep) assert.deepEqual(q.seen, [!/light/.test(q.mql.media)], q.mql.media);
});

test('a page finds no mark of the hook: no symbol on the window, no property on a list, the getter keeps its name', () => {
  const r = rig();
  const { mql } = r.query(DARK);
  r.word('dk:scheme-dark');
  assert.equal(mql.matches, true, 'the hint works');
  assert.deepEqual(Object.getOwnPropertyNames(mql), [], 'a scheme list has no own property');
  assert.equal(Object.keys(mql).includes('matches'), false);
  const symbols = Object.getOwnPropertySymbols(r.sandbox);
  assert.deepEqual(symbols.filter((sym) => Symbol.keyFor(sym) !== undefined), [], 'no registered symbol on the window');
  const getter = Object.getOwnPropertyDescriptor(r.MQL.prototype, 'matches').get;
  assert.equal(getter.name, 'get matches');
  assert.equal(Object.getOwnPropertyDescriptor(r.MQL.prototype, 'matches').enumerable, false, 'the descriptor of the prototype is kept');
  // Another query keeps the browser's own answer, also while the hint is on.
  const other = r.query('(min-width: 600px)').mql;
  assert.equal(other.matches, false);
  assert.deepEqual(Object.getOwnPropertyNames(other), []);
});

test('a second run in the same document wraps nothing again: one change event per change of the hint', () => {
  const r = rig({ runs: 2 });
  const { mql, seen } = r.query(DARK);
  r.word('dk:scheme-dark');
  r.word('dk:scheme-off');
  assert.deepEqual(seen, [true, false]);
  assert.equal(mql.matches, false);
});
