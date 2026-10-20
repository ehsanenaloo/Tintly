// A chrome for the tests that start the whole service worker with or without the alarms API.
import { fakeArea } from './area.mjs';
import { defaultSettings } from '../../extension/shared/settings.js';

export const stored = (automation) => ({ ...defaultSettings(), enabled: true, automation: { ...defaultSettings().automation, ...automation } });
export const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

export const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function stubChrome({ alarms }) {
  const listeners = {};
  const hook = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const changed = [];
  const scripts = new Map();
  const set = new Map();
  const local = fakeArea();
  globalThis.chrome = {
    runtime: { id: 'x', getURL: (p) => `chrome-extension://x/${p}`, getManifest: () => ({ permissions: [], version: '1' }), onMessage: hook('message'), onInstalled: hook('installed'), onStartup: hook('startup') },
    storage: { local, session: fakeArea(), sync: Object.assign(fakeArea(), { onChanged: hook('syncChanged') }), onChanged: { addListener: (fn) => changed.push(fn) } },
    scripting: {
      getRegisteredContentScripts: async () => [...scripts.values()],
      registerContentScripts: async (list) => list.forEach((s) => scripts.set(s.id, s)),
      updateContentScripts: async (list) => list.forEach((s) => scripts.set(s.id, { ...scripts.get(s.id), ...s })),
      unregisterContentScripts: async (f) => (f?.ids ?? [...scripts.keys()]).forEach((id) => scripts.delete(id)),
      executeScript: async () => [],
    },
    action: { setIcon: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    tabs: { query: async () => [], onRemoved: hook('removed'), onUpdated: hook('updated') },
    commands: { onCommand: hook('command') },
    permissions: { onAdded: hook('added'), onRemoved: hook('removedPermission'), contains: async (d) => d.permissions.includes('alarms') && alarms.granted },
    i18n: { getMessage: () => '' },
  };
  if (alarms.api) {
    globalThis.chrome.alarms = {
      onAlarm: hook('alarm'),
      create: async (name, info) => void set.set(name, { name, ...info }),
      get: async (name) => set.get(name),
      clear: async (name) => set.delete(name),
    };
  }
  listeners.changed = (...args) => changed.forEach((fn) => fn(...args));
  return { listeners, scripts, set, local };
}

