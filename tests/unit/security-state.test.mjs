import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { createState } = await load('background/modules/state.js');
const S = await load('shared/settings.js');

function make() {
  const state = createState({ local: fakeArea(), session: fakeArea() });
  return state;
}

test('SEC: an imported file cannot switch browser sync on or widen it', async () => {
  const state = make();
  await state.init();
  const file = S.defaultState();
  file.settings.syncEnabled = true;
  file.settings.syncIncludeSites = true;
  const text = S.serializeExport(file);
  const applied = await state.importText(text, true);
  assert.equal(applied.ok, true);
  const read = await state.read();
  assert.equal(read.state.settings.syncEnabled, false);
  assert.equal(read.state.settings.syncIncludeSites, false);
});

test('SEC: an import keeps the sync choice the person made', async () => {
  const state = make();
  await state.init();
  const current = (await state.read()).state.settings;
  assert.equal((await state.patchSettings({ syncEnabled: true, syncIncludeSites: false })).ok, true);
  void current;
  const file = S.defaultState();
  file.settings.syncEnabled = false;
  file.settings.syncIncludeSites = true;
  await state.importText(S.serializeExport(file), true);
  const after = (await state.read()).state.settings;
  assert.equal(after.syncEnabled, true);
  assert.equal(after.syncIncludeSites, false);
});

test('SEC: keys that name the prototype never become rules', async () => {
  const state = make();
  await state.init();
  const base = JSON.parse(S.serializeExport(S.defaultState()));
  const text = JSON.stringify(base).replace('"siteRules":{}', '"siteRules":{"__proto__":{"enabled":false},"constructor":{"enabled":false},"prototype":{"enabled":false}}');
  const preview = await state.importText(text, false);
  assert.ok(preview.ok === false || preview.summary.siteRules <= 1, JSON.stringify(preview));
  assert.equal({}.enabled, undefined);
  assert.equal(Object.prototype.enabled, undefined);
});

test('SEC: the import summary says when custom CSS can load something from another address', () => {
  const base = () => S.defaultState();
  const plain = base();
  plain.settings.theme.css = 'a{color:#fff}';
  assert.deepEqual([S.summarize(plain).customCss, S.summarize(plain).remoteCss], [true, false]);
  for (const css of ['a{background:url(https://x.test/a.png)}', '@import "https://x.test/a.css";', 'a{background:IMAGE-SET("x" 1x)}', String.raw`a{background:\75rl(x)}`, '@font-face{src:url(x)}']) {
    const state = base();
    state.siteRules = { 'a.example': { css } };
    assert.equal(S.summarize(state).remoteCss, true, css);
    const fix = base();
    fix.userFixes = { 'a.example': { dynamic: { css } } };
    assert.equal(S.summarize(fix).remoteCss, true, css);
  }
  assert.equal(S.summarize(base()).remoteCss, false);
});
