// The worker with a chrome that has the alarms API: the listener is added at the top level and an alarm brings the registration to the clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { SCHEMA_VERSION } from '../../extension/shared/settings.js';
import { stubChrome, stored, tick, hhmm } from '../helpers/alarms-chrome.mjs';

test('with the permission: the worker sets the alarms, registers nothing outside the hours, and an alarm brings the registration back', async () => {
  const now = new Date();
  // A window that starts in an hour and ends in two: outside it now.
  const hours = { mode: 'time', behavior: 'onOff', time: { from: hhmm(new Date(now.getTime() + 3600_000)), to: hhmm(new Date(now.getTime() + 7200_000)) } };
  const { listeners, scripts, set, local } = stubChrome({ alarms: { api: true, granted: true } });
  await local.set({ settings: stored(hours), schemaVersion: SCHEMA_VERSION });
  await import(pathToFileURL(join(REPO, 'extension', 'background', 'service-worker.js')).href + '?a');
  await tick(150);
  assert.equal(typeof listeners.alarm, 'function', 'the listener is added when the worker starts');
  assert.ok(set.has('dk-schedule-next') && set.has('dk-schedule-check'));
  assert.equal(scripts.size, 0, 'outside the hours a page gets no script');
  // The clock reaches the lead before the start: the alarm fires and the registration comes back.
  const real = Date.now;
  const start = new Date(now.getTime() + 3600_000);
  start.setSeconds(0, 0);
  try {
    Date.now = () => start.getTime() - 30_000;
    listeners.alarm({ name: 'dk-schedule-next' });
    await tick(150);
    assert.equal(scripts.size, 2);
    assert.equal(set.get('dk-schedule-next').when, start.getTime() + 2000, 'the next alarm is for the start');
    // The clock passes the end: the next alarm removes it again.
    Date.now = () => start.getTime() + 3600_000 + 10_000;
    listeners.alarm({ name: 'dk-schedule-check' });
    await tick(150);
    assert.equal(scripts.size, 0);
  } finally {
    Date.now = real;
  }
  // An alarm of another name is not ours.
  listeners.alarm({ name: 'other' });
  delete globalThis.chrome;
});
