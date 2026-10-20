import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The listeners the worker registers, with a chrome whose local storage can be made to fail. */
function stubChrome() {
  const listeners = {};
  const hook = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const local = fakeArea();
  const calls = { query: 0 };
  const failing = { on: false };
  const get = local.get.bind(local);
  local.get = async (keys) => {
    if (failing.on) throw new Error('storage is gone');
    return get(keys);
  };
  globalThis.chrome = {
    runtime: { id: 'x', getURL: (p) => `chrome-extension://x/${p}`, getManifest: () => ({ permissions: [], content_scripts: [] }), onMessage: hook('message'), onInstalled: hook('installed'), onStartup: hook('startup') },
    storage: { local, session: fakeArea(), sync: Object.assign(fakeArea(), { onChanged: hook('syncChanged') }), onChanged: hook('changed') },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, updateContentScripts: async () => {}, unregisterContentScripts: async () => {}, executeScript: async () => [] },
    action: {},
    tabs: { query: async () => (calls.query += 1, []), onRemoved: hook('removed'), onUpdated: hook('updated') },
    commands: { onCommand: hook('command') },
    contextMenus: { onClicked: hook('menu') },
    permissions: { onAdded: hook('added'), onRemoved: hook('removedPermission'), contains: async () => false },
    i18n: { getMessage: () => '' },
  };
  return { listeners, calls, failing };
}

test('a failing start is logged, and the open tabs still get their scripts', async () => {
  const { listeners, calls, failing } = stubChrome();
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const rejected = [];
  const onRejected = (e) => rejected.push(e);
  process.on('unhandledRejection', onRejected);
  try {
    await import(pathToFileURL(join(REPO, 'extension', 'background', 'service-worker.js')).href);
    // The first pass of the worker (settings, registration) is done; then the storage goes away.
    await tick();
    failing.on = true;
    listeners.installed();
    await tick();
    assert.ok(calls.query >= 1, 'tabs are looked at after a failed start');
    assert.ok(warnings.length >= 1);
    const before = warnings.length;
    listeners.startup();
    listeners.changed({ settings: { oldValue: {}, newValue: {} } }, 'local');
    listeners.syncChanged();
    listeners.removed(5);
    await tick();
    assert.ok(warnings.length > before);
    assert.deepEqual(rejected, []);
  } finally {
    console.warn = warn;
    process.off('unhandledRejection', onRejected);
    delete globalThis.chrome;
  }
});
