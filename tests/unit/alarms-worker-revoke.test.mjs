// The permission is taken away from a running worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { SCHEMA_VERSION } from '../../extension/shared/settings.js';
import { stubChrome, stored, tick, hhmm } from '../helpers/alarms-chrome.mjs';

test('a permission that is taken away removes the alarms and brings the registration back', async () => {
  const now = new Date();
  const hours = { mode: 'time', behavior: 'onOff', time: { from: hhmm(new Date(now.getTime() + 3600_000)), to: hhmm(new Date(now.getTime() + 7200_000)) } };
  const permission = { api: true, granted: true };
  const { listeners, scripts, set, local } = stubChrome({ alarms: permission });
  await local.set({ settings: stored(hours), schemaVersion: SCHEMA_VERSION });
  await import(pathToFileURL(join(REPO, 'extension', 'background', 'service-worker.js')).href + '?c');
  await tick(150);
  assert.equal(scripts.size, 0);
  permission.granted = false;
  listeners.removedPermission({ permissions: ['alarms'] });
  await tick(150);
  assert.equal(set.size, 0);
  assert.equal(scripts.size, 2);
  delete globalThis.chrome;
});
