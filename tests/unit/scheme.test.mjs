import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('core/scheme.js');
const { only } = dk.scheme;

test('only light and only dark are read in either word order and any case', () => {
  for (const v of ['only light', 'light only', 'ONLY LIGHT', '  only   light ', 'only light;', 'light  only']) assert.equal(only(v), 'light', v);
  for (const v of ['only dark', 'dark only', 'Only Dark']) assert.equal(only(v), 'dark', v);
});

test('a value without only, with both schemes, or with neither says nothing', () => {
  for (const v of ['light dark', 'dark light', 'light', 'dark', 'normal', '', 'only', 'only light dark', 'dark light only', 'onlylight', 'lighter only', null, undefined]) {
    assert.equal(only(v), null, String(v));
  }
});

test('a custom scheme name next to only light does not hide it', () => {
  assert.equal(only('only light tinted'), 'light');
});

test('read looks at the cascade with the hold sheet off, and puts the page back as it was, with no change to the root', () => {
  const attrs = new Set();
  const style = { disabled: false };
  const hold = { disabled: false };
  let writes = 0;
  class FakeStyle {}
  Object.setPrototypeOf(style, FakeStyle.prototype);
  const root = { hasAttribute: (n) => attrs.has(n), setAttribute: (n) => (writes++, attrs.add(n)), removeAttribute: (n) => (writes++, attrs.delete(n)) };
  let seen = null;
  const saved = { __dkHold: globalThis.__dkHold, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, HTMLStyleElement: globalThis.HTMLStyleElement };
  try {
    globalThis.HTMLStyleElement = FakeStyle;
    globalThis.__dkHold = hold;
    globalThis.document = { documentElement: root, body: null, querySelectorAll: () => [style], querySelector: () => null };
    globalThis.getComputedStyle = () => {
      seen = { held: hold.disabled, disabled: style.disabled };
      return { colorScheme: 'only light' };
    };
    assert.equal(dk.scheme.read(), 'light');
    assert.deepEqual(seen, { held: true, disabled: true }, 'the engine styles and the held first paint are off while the value is read');
    assert.equal(writes, 0, 'the root attribute is never written or removed by a read');
    assert.equal(hold.disabled, false);
    assert.equal(style.disabled, false);
    globalThis.getComputedStyle = () => ({ colorScheme: 'light dark' });
    assert.equal(dk.scheme.read(), null);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
});
