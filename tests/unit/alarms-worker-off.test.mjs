// The worker without the alarms permission starts as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { SCHEMA_VERSION } from '../../extension/shared/settings.js';
import { stubChrome, stored, tick, hhmm } from '../helpers/alarms-chrome.mjs';

test('without the permission the worker behaves as before: the registration stays outside the hours', async () => {
  const now = new Date();
  const hours = { mode: 'time', behavior: 'onOff', time: { from: hhmm(new Date(now.getTime() + 3600_000)), to: hhmm(new Date(now.getTime() + 7200_000)) } };
  const { listeners, scripts, local } = stubChrome({ alarms: { api: false, granted: false } });
  await local.set({ settings: stored(hours), schemaVersion: SCHEMA_VERSION });
  await import(pathToFileURL(join(REPO, 'extension', 'background', 'service-worker.js')).href + '?b');
  await tick(150);
  assert.equal(listeners.alarm, undefined);
  assert.equal(scripts.size, 2);
  delete globalThis.chrome;
});
