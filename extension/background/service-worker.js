// @ts-check
// The service worker. It owns every write to the settings, the toolbar icon, the shortcuts, the context menu, the site
// data and the only network access. All listeners are registered here, at the top level, as the browser requires.
import { createState } from './modules/state.js';
import { createNet } from './modules/net.js';
import { createRouter } from './modules/router.js';
import { createIcon } from './modules/icon.js';
import { createData } from './modules/data.js';
import { createVerifier } from './modules/verify.js';
import { createCommands, createMenu, MENU_ID } from './modules/commands.js';
import { createSync } from './modules/sync.js';
import { createEarly } from './modules/early.js';
import { createOnDemand } from './modules/ondemand.js';
import { createRegister } from './modules/register.js';
import { createAlarms, NEXT as ALARM_NEXT, CHECK as ALARM_CHECK, SYNC_RETRY as ALARM_SYNC } from './modules/alarms.js';
import { createLoading } from './modules/loading.js';
import { createGate } from './modules/gate.js';
import { createSitePages } from './modules/site-pages.js';
import { siteEnabled } from '../shared/match.js';

const extensionOrigin = chrome.runtime.getURL('');
const state = createState({ local: chrome.storage.local, session: chrome.storage.session });
const net = createNet({ verifyUsed: createVerifier({ scripting: chrome.scripting }) });
const icon = createIcon({ action: chrome.action });
const data = createData({
  readJson: async (path) => {
    const response = await fetch(chrome.runtime.getURL(path));
    return response.ok ? response.json() : null;
  },
});
const ondemand = createOnDemand({ scripting: chrome.scripting });
// A failed background job is logged and does not stop the ones after it.
const warn = (/** @type {unknown} */ error) => console.warn('Tintly background job failed', error);
// The slice of the site data that a page reads, kept in keys of its own (gate.js).
const gate = createGate({ local: chrome.storage.local, warn: (e) => console.warn('Tintly gate index failed', e) });
const early = createEarly({ scripting: chrome.scripting, warn });
// The alarms of the schedule exist only with the optional `alarms` permission; the API is looked up at each use.
const alarms = createAlarms({ api: () => chrome.alarms, permissions: chrome.permissions, warn });
const readRules = async () => {
  const read = await state.read();
  return read.ok ? { settings: read.state.settings, siteRules: read.state.siteRules, idle: alarms.idleFor(read.state.settings) } : null;
};
const register = createRegister({ scripting: chrome.scripting, tabs: chrome.tabs, warn, read: readRules });
const router = createRouter({ runtimeId: chrome.runtime.id, extensionOrigin, state, net, icon, data, tabs: chrome.tabs, ondemand, register });
const loading = createLoading({
  register,
  siteEnabled,
  read: readRules,
  setStatus: (tabId, status) => state.setTabStatus(tabId, status),
  clearStatus: (tabId) => state.clearTab(tabId),
  icon,
  // The registration was made for an earlier time than now (a late alarm, a changed clock or time zone): bring it up to date before judging the page.
  stale: async () => {
    if (!alarms.armed) return false;
    const stored = await readRules();
    return stored !== null && stored.idle !== register.idle;
  },
  refresh: () => refreshFromSettings(true),
});
// Read-only handle for the tests of the registration; a page cannot reach the globals of the worker.
Object.defineProperty(globalThis, 'tintlyRegister', { value: register });
Object.defineProperty(globalThis, 'tintlyGate', { value: gate });
const sitePages = createSitePages({
  runtime: chrome.runtime,
  local: chrome.storage.local,
  tabs: chrome.tabs,
  lang: () => chrome.i18n.getUILanguage?.() ?? '',
  warn,
});
const sync = createSync({ local: chrome.storage.local, sync: chrome.storage.sync, state, retryAlarm: alarms.retry });
const activeTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
const commands = createCommands({ state, activeTab });
const menu = createMenu({
  // Looked up at each use: the API appears in a running worker when the optional permission is granted.
  contextMenus: () => chrome.contextMenus ?? /** @type {any} */ (chrome).menus,
  // Firefox names the optional permission `menus`.
  permission: (chrome.runtime.getManifest().permissions ?? []).includes(/** @type {any} */ ('menus')) ? 'menus' : 'contextMenus',
  permissions: chrome.permissions,
  title: () => chrome.i18n.getMessage('menuToggleSite'),
});

/** The parts of the worker that follow the settings, one pass at a time. The icon and the menu change only when what they show changed (a slider drag writes the settings many times). */
let followChain = Promise.resolve();
let shownSig = '';
/** @param {boolean} [force] also redo the alarms, the icon and the menu (a permission changed, an alarm fired) */
function refreshFromSettings(force = false) {
  const run = async () => {
    const read = await state.read();
    if (!read.ok) return;
    const { settings, siteRules } = read.state;
    await alarms.sync(settings, force);
    bindAlarms();
    await early.refresh(settings, siteRules);
    await register.sync();
    const sig = `${settings.enabled}|${settings.contextMenu}`;
    if (force || sig !== shownSig) {
      shownSig = sig;
      await icon.setDefault(settings.enabled);
      await menu.refresh(settings.contextMenu);
      bindMenuClicks();
    }
  };
  followChain = followChain.then(run, run);
  return followChain;
}

async function start() {
  await state.init();
  await state.pruneMarks().catch(() => 0);
  if ((await state.read()).ok) await sync.pull().catch(warn);
  await refreshFromSettings();
  void gate.start();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  router.handle(message, sender).then(sendResponse, () => sendResponse({ ok: false, code: 'error' }));
  // The reply is sent later.
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  void sitePages.onInstall(details?.reason ?? '').catch(warn);
  void start()
    .catch(warn)
    .finally(() => register.injectOpenTabs().catch(warn));
});

chrome.runtime.onStartup.addListener(() => {
  void sitePages.survey().catch(warn);
  void start().catch(warn);
});

chrome.commands.onCommand.addListener((command, tab) => {
  void commands.handle(command, tab).catch(warn);
});

// The click handler needs the API, which is there at the start of the worker or after the permission was granted in a running one.
let menuBound = false;
function bindMenuClicks() {
  const api = chrome.contextMenus ?? /** @type {any} */ (chrome).menus;
  if (menuBound || !api?.onClicked) return;
  menuBound = true;
  api.onClicked.addListener((/** @type {any} */ info, /** @type {any} */ tab) => {
    if (info.menuItemId === MENU_ID) void commands.handle('toggle_site', tab).catch(warn);
  });
}
bindMenuClicks();

// An alarm wakes the worker, so the listener must be added at the top level of a start. The API is there at the start of the worker
// or after the permission was granted in a running one.
let alarmsBound = false;
function bindAlarms() {
  const api = chrome.alarms;
  if (alarmsBound || !api?.onAlarm) return;
  alarmsBound = true;
  api.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NEXT || alarm.name === ALARM_CHECK) void refreshFromSettings(true).catch(warn);
    else if (alarm.name === ALARM_SYNC) void sync.recover().catch(warn);
  });
}
bindAlarms();

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'loading') return;
  void loading.started(tabId, tab.url ?? change.url).catch(warn);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void state.clearTab(tabId).catch(warn);
  net.forgetTab(tabId);
  ondemand.forgetTab(tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  void gate.follow(changes);
  if (changes.siteRules && !changes.settings) void refreshFromSettings().catch(warn);
  if (changes.settings) {
    void refreshFromSettings().catch(warn);
    // Turning Sync on here takes the account's data first; turning it off drops the waiting push; any other change is pushed later.
    const was = /** @type {any} */ (changes.settings.oldValue)?.syncEnabled === true;
    const on = /** @type {any} */ (changes.settings.newValue)?.syncEnabled === true;
    if (on && !was) void sync.join().catch(warn);
    else if (was && !on) void sync.cancel().catch(warn);
    else if (on) sync.schedulePush();
  } else if (changes.presets || changes.siteRules || changes.userFixes || changes.darkSites) {
    sync.schedulePush();
  }
});

chrome.storage.sync?.onChanged.addListener(() => {
  void sync.pull().catch(warn);
});

chrome.permissions.onAdded?.addListener(() => {
  // A granted host permission can make pages reachable that were not: look at the open tabs again.
  void refreshFromSettings(true)
    .then(() => register.injectOpenTabs())
    .catch(warn);
});
chrome.permissions.onRemoved?.addListener(() => {
  void refreshFromSettings(true).catch(warn);
});

// Every start of the worker brings the registration, the icon and the menu to the settings, also after a sleep or a refused try.
void refreshFromSettings().catch(warn);
// A push to the account that an earlier worker left waiting is planned again, whatever event started this worker.
void sync.recover().catch(warn);
