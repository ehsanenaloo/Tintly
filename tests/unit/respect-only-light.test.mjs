import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const S = await import(pathToFileURL(join(REPO, 'extension', 'shared', 'settings.js')).href);

test('the respect for only light and only dark is on by default', () => {
  assert.equal(S.defaultSettings().respectOnlyLight, true);
  assert.equal(S.defaultState().settings.respectOnlyLight, true);
});

test('stored settings from before the setting get the default, and a bad value is an error when it is written', () => {
  const old = S.defaultSettings();
  delete old.respectOnlyLight;
  const lenient = S.sanitizeSection('settings', old);
  assert.equal(lenient.value.respectOnlyLight, true);
  const patched = S.applyPatch(S.defaultSettings(), { respectOnlyLight: false });
  assert.equal(patched.value.respectOnlyLight, false);
  for (const bad of ['no', 0, null, {}]) assert.equal(S.applyPatch(S.defaultSettings(), { respectOnlyLight: bad }).value, undefined, String(bad));
});

test('the setting goes through export and import', () => {
  const state = S.defaultState();
  state.settings.respectOnlyLight = false;
  const parsed = S.parseImport(S.serializeExport(state, 1));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.settings.respectOnlyLight, false);
  // An export from before the setting still imports, with the default.
  const legacy = JSON.parse(S.serializeExport(S.defaultState(), 1));
  delete legacy.settings.respectOnlyLight;
  const old = S.parseImport(JSON.stringify(legacy));
  assert.equal(old.ok, true);
  assert.equal(old.state.settings.respectOnlyLight, true);
});

const early = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'early.js')).href);

test('the first-paint plan carries the respect marker unless the respect is off, and leaves out the sites turned on by hand', () => {
  const base = { enabled: true, listMode: 'allExcept', holdPaint: true, automation: { mode: 'none' }, theme: { mode: 'dark' } };
  const rules = { 'a.test': { enabled: true }, 'b.test': { enabled: false } };
  const on = early.planFor(base, rules);
  assert.ok(on.respect);
  assert.ok(on.respect.excludeMatches.some((m) => m.includes('a.test')), 'a site turned on by hand is out');
  assert.ok(on.respect.excludeMatches.some((m) => m.includes('b.test')), 'a site turned off is out');
  assert.equal(early.planFor({ ...base, respectOnlyLight: false }, rules).respect, null);
  assert.equal(early.planFor({ ...base, listMode: 'onlyListed' }, rules).respect, null, 'every listed site is one turned on by hand');
});
