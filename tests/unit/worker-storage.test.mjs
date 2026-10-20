// The worker follows a change of the stored data with the work that change needs, and nothing more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { SCHEMA_VERSION } from '../../extension/shared/settings.js';
import { stubChrome, stored, tick } from '../helpers/alarms-chrome.mjs';
import { META } from '../../extension/background/modules/gate.js';

test('a change of a key the site index does not use does not make the index look at storage again', async () => {
  const { listeners, local } = stubChrome({ alarms: { api: false, granted: false } });
  await local.set({ settings: stored({}), schemaVersion: SCHEMA_VERSION });
  const get = local.get.bind(local);
  let indexReads = 0;
  local.get = async (keys) => {
    if (Array.isArray(keys) && keys.includes(META)) indexReads += 1;
    return get(keys);
  };
  await import(pathToFileURL(join(REPO, 'extension', 'background', 'service-worker.js')).href + '?storage');
  await tick(150);
  const before = indexReads;
  for (let i = 0; i < 5; i++) listeners.changed({ ui: { newValue: { tab: String(i) } } }, 'local');
  await tick(100);
  assert.equal(indexReads, before, 'the index of the site data is not touched');
  // A change of the site rules is followed.
  listeners.changed({ siteRules: { newValue: {} } }, 'local');
  await tick(100);
  assert.ok(indexReads > before);
  delete globalThis.chrome;
});
