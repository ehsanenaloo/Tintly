import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { saveErrorKind, isTransient, sendWithRetry } = await load('shared/save-error.js');
const { createState } = await load('background/modules/state.js');

test('an unknown field means the extension needs a reload, every other refusal keeps the generic text', () => {
  assert.equal(saveErrorKind({ ok: false, code: 'unknown-field' }), 'reload');
  for (const reply of [{ ok: false, code: 'invalid' }, { ok: false, code: 'error' }, { ok: false, code: 'newer' }, { ok: false, code: 'denied' }, { ok: false }, null, undefined]) {
    assert.equal(saveErrorKind(reply), 'generic', JSON.stringify(reply));
  }
  assert.equal(saveErrorKind({ ok: true }), 'generic');
});

test('only a missing answer or the code error may pass by itself', () => {
  assert.equal(isTransient(null), true);
  assert.equal(isTransient(undefined), true);
  assert.equal(isTransient({ ok: false, code: 'error' }), true);
  assert.equal(isTransient({ ok: false, code: 'invalid' }), false);
  assert.equal(isTransient({ ok: false, code: 'unknown-field' }), false);
  assert.equal(isTransient({ ok: true }), false);
});

test('a failed send is tried once more after a pause, a refusal for the content is not', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('no worker');
    return { ok: true };
  };
  assert.deepEqual(await sendWithRetry(flaky, 1), { ok: true });
  assert.equal(calls, 2);

  calls = 0;
  const refused = async () => {
    calls += 1;
    return { ok: false, code: 'unknown-field' };
  };
  assert.deepEqual(await sendWithRetry(refused, 1), { ok: false, code: 'unknown-field' });
  assert.equal(calls, 1);

  calls = 0;
  const down = async () => {
    calls += 1;
    throw new Error('gone');
  };
  assert.equal(await sendWithRetry(down, 1), null);
  assert.equal(calls, 2, 'one retry, not more');

  calls = 0;
  const hiccup = async () => {
    calls += 1;
    return calls === 1 ? { ok: false, code: 'error' } : { ok: true };
  };
  assert.deepEqual(await sendWithRetry(hiccup, 1), { ok: true });
  assert.equal(calls, 2);
});

test('the worker answers a patch of fields it does not know with the code unknown-field, and any other refusal with invalid', async () => {
  const local = fakeArea();
  const state = createState({ local, session: fakeArea() });
  await state.init();
  const before = local.peek();
  const unknown = await state.patchSettings({ theme: { aFutureField: true } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown-field');
  assert.ok(unknown.errors.length > 0);
  const topLevel = await state.patchSettings({ aFutureSetting: 1 });
  assert.equal(topLevel.code, 'unknown-field');
  const value = await state.patchSettings({ theme: { brightness: 9999 } });
  assert.equal(value.code, 'invalid');
  // A wrong value next to an unknown field is not blamed on the version.
  const both = await state.patchSettings({ theme: { brightness: 9999, aFutureField: 1 } });
  assert.equal(both.code, 'invalid');
  assert.deepEqual(local.peek(), before);
});

test('the reload message exists in every language', async () => {
  for (const code of ['en', 'fa', 'ar', 'he']) {
    const m = await load(`shared/locales/${code}.js`);
    const catalog = m.default ?? m.messages ?? Object.values(m)[0];
    assert.ok(typeof catalog['popup.saveErrorReload'] === 'string' && catalog['popup.saveErrorReload'].length > 10, code);
    assert.notEqual(catalog['popup.saveErrorReload'], catalog['popup.saveError'], code);
  }
});
