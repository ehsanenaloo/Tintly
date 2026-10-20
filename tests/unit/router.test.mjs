import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { createState } = await load('background/modules/state.js');
const { createRouter } = await load('background/modules/router.js');
const { createIcon, LOOKS } = await load('background/modules/icon.js');
const { createData, shardOf } = await load('background/modules/data.js');
const { createCommands, createMenu, MENU_ID } = await load('background/modules/commands.js');
const { createSync } = await load('background/modules/sync.js');
const { createVerifier } = await load('background/modules/verify.js');
const S = await load('shared/settings.js');

const RID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${RID}/`;

const senders = {
  page: { id: RID, url: `${ORIGIN}pages/popup/popup.html` },
  pageInTab: { id: RID, url: `${ORIGIN}pages/options/options.html`, tab: { id: 9, url: `${ORIGIN}pages/options/options.html` }, frameId: 0 },
  content: { id: RID, url: 'https://site.example/a/b?x=1', tab: { id: 3, url: 'https://site.example/' }, frameId: 0 },
  subframe: { id: RID, url: 'https://ads.example/x', tab: { id: 3, url: 'https://site.example/' }, frameId: 4 },
  blankFrame: { id: RID, url: 'about:blank', tab: { id: 3, url: 'https://top.example/p' }, frameId: 2 },
};

function make() {
  const local = fakeArea();
  const session = fakeArea();
  const state = createState({ local, session });
  const calls = { net: [], icon: [], data: [] };
  const net = {
    text: async (url, who, charset) => (calls.net.push(['text', url, who, charset]), { ok: true, text: 'a{}', url }),
    image: async (url, who) => (calls.net.push(['image', url, who]), { ok: true, mime: 'image/png', base64: 'AA==', url }),
  };
  const icon = { apply: async (tab, status) => calls.icon.push([tab, status]) };
  const data = { forHost: async (host, path, fixes) => (calls.data.push([host, path]), { builtin: { note: 'b' }, user: fixes ? fixes[host] ?? null : null, paths: true }) };
  const ondemand = { inject: async (name, who) => (calls.data.push(['inject', name, who.tabId, who.frameId]), { ok: true }) };
  const register = { sync: async () => calls.data.push(['register']), failed: false };
  const router = createRouter({ runtimeId: RID, extensionOrigin: ORIGIN, state, net, icon, data, ondemand, register });
  return { router, state, local, session, calls };
}

/** One valid message for each type, and who is allowed to send it. */
const VALID = {
  'dk.state.get': { from: 'page', message: { type: 'dk.state.get', url: 'https://a.com/', tabId: 3 } },
  'dk.settings.patch': { from: 'page', message: { type: 'dk.settings.patch', patch: { theme: { brightness: 90 } } } },
  'dk.site.set': { from: 'page', message: { type: 'dk.site.set', pattern: 'a.com', rule: { enabled: false } } },
  'dk.preset.save': { from: 'page', message: { type: 'dk.preset.save', preset: { name: 'N', theme: S.defaultTheme() } } },
  'dk.preset.delete': { from: 'page', message: { type: 'dk.preset.delete', id: 'p-1' } },
  'dk.import': { from: 'page', message: { type: 'dk.import', text: S.serializeExport(S.defaultState()), confirmed: true } },
  'dk.fix.set': { from: 'page', message: { type: 'dk.fix.set', pattern: 'a.com', fix: { note: 'n', dynamic: { css: 'a{}' } } } },
  'dk.css.enable': { from: 'page', message: { type: 'dk.css.enable', scope: 'settings', css: '' } },
  'dk.ui.set': { from: 'page', message: { type: 'dk.ui.set', ui: { locale: 'fa' } } },
  'dk.reset': { from: 'page', message: { type: 'dk.reset', confirmed: true } },
  'dk.export': { from: 'page', message: { type: 'dk.export' } },
  'dk.register.sync': { from: 'page', message: { type: 'dk.register.sync' } },
  'dk.tab.preview': { from: 'page', message: { type: 'dk.tab.preview' } },
  'dk.fix.forHost': { from: 'content', message: { type: 'dk.fix.forHost' } },
  'dk.net.text': { from: 'content', message: { type: 'dk.net.text', url: 'https://cdn.example/a.css' } },
  'dk.net.image': { from: 'content', message: { type: 'dk.net.image', url: 'https://cdn.example/a.png' } },
  'dk.inject': { from: 'content', message: { type: 'dk.inject', module: 'images' } },
  'dk.page.status': { from: 'content', message: { type: 'dk.page.status', status: 'on' } },
};

test('every type works for its sender', async () => {
  for (const [type, { from, message }] of Object.entries(VALID)) {
    const { router } = make();
    await router.handle({ type: 'dk.export' }, senders.page); // make sure state exists
    const sender = from === 'page' ? senders.page : senders.content;
    const reply = await router.handle(message, sender);
    if (type === 'dk.tab.preview') assert.deepEqual(reply, { ok: false, code: 'unsupported' });
    else assert.equal(reply.ok, true, `${type}: ${JSON.stringify(reply)}`);
  }
});

test('an extension page in a tab (the settings page) is a page sender', async () => {
  const { router } = make();
  assert.equal((await router.handle(VALID['dk.export'].message, senders.pageInTab)).ok, true);
});

test('a type is denied for the other kind of sender', async () => {
  for (const [type, { from, message }] of Object.entries(VALID)) {
    const { router } = make();
    const wrong = from === 'page' ? senders.content : senders.page;
    assert.deepEqual(await router.handle(message, wrong), { ok: false, code: 'denied' }, type);
  }
});

test('page types change nothing when a content script sends them', async () => {
  const { router, local } = make();
  const before = local.peek();
  for (const type of ['dk.settings.patch', 'dk.site.set', 'dk.preset.save', 'dk.preset.delete', 'dk.import']) {
    await router.handle(VALID[type].message, senders.content);
    await router.handle(VALID[type].message, senders.subframe);
  }
  assert.deepEqual(local.peek(), before);
});

test('senders that are not ours are denied: other extension, no sender, no tab, no frame, no usable page address', async () => {
  const { router } = make();
  const bad = [
    { ...senders.page, id: 'otherextensionidotherextensionid' },
    { ...senders.content, id: 'other' },
    { id: RID },
    { id: RID, url: 'https://evil.example/' },
    { id: RID, url: 'https://evil.example/', tab: { id: 1, url: 'https://evil.example/' } },
    { id: RID, url: 'https://evil.example/', frameId: 0 },
    { ...senders.content, tab: { id: 'x', url: 'https://a.example/' } },
    { ...senders.content, frameId: '0' },
    { id: RID, url: 'about:blank', tab: { id: 1, url: 'chrome://newtab' }, frameId: 0 },
    { id: RID, url: `${ORIGIN.slice(0, -1)}.evil.example/`, tab: { id: 1, url: 'https://a.example/' }, frameId: 0 },
    null,
    undefined,
    'sender',
    5,
  ];
  for (const sender of bad) {
    for (const type of ['dk.export', 'dk.net.text', 'dk.settings.patch']) {
      const message = type === 'dk.net.text' ? { type, url: 'https://a.example/x.css' } : type === 'dk.settings.patch' ? { type, patch: {} } : { type };
      const reply = await router.handle(message, sender);
      assert.deepEqual(reply, { ok: false, code: 'denied' }, `${JSON.stringify(sender)} ${type}`);
    }
  }
});

test('messages that are not objects with a string type are invalid', async () => {
  const { router } = make();
  for (const m of [null, undefined, 5, 'dk.export', [], [{ type: 'dk.export' }], {}, { type: 5 }, { type: null }, { type: {} }]) {
    assert.deepEqual(await router.handle(m, senders.page), { ok: false, code: 'invalid' }, JSON.stringify(m));
  }
});

test('unknown types, and names that exist on every object, are unknown', async () => {
  const { router } = make();
  for (const type of ['dk.nope', '', 'dk.', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'dk.export ', 'DK.EXPORT']) {
    assert.deepEqual(await router.handle({ type }, senders.page), { ok: false, code: 'unknown' }, type);
  }
});

test('extra fields are refused, so a message cannot carry more than its type expects', async () => {
  const { router } = make();
  assert.deepEqual(await router.handle({ type: 'dk.export', extra: 1 }, senders.page), { ok: false, code: 'invalid' });
  assert.deepEqual(await router.handle({ type: 'dk.net.text', url: 'https://a.example/x.css', credentials: 'include' }, senders.content), { ok: false, code: 'invalid' });
  assert.deepEqual(await router.handle(JSON.parse('{"type":"dk.export","__proto__":{"a":1}}'), senders.page), { ok: false, code: 'invalid' });
});

const BAD_PAYLOADS = {
  'dk.state.get': [{ url: 5 }, { url: 'x'.repeat(5000) }, { tabId: -1 }, { tabId: 1.5 }, { tabId: '1' }],
  'dk.settings.patch': [{}, { patch: null }, { patch: 'x' }, { patch: [] }, { patch: 5 }],
  'dk.site.set': [{ pattern: 'a.com' }, { rule: null }, { pattern: 5, rule: null }, { pattern: 'a.com', rule: 'x' }, { pattern: 'a.com', rule: [] }, { pattern: 'x'.repeat(400), rule: null }],
  'dk.preset.save': [{}, { preset: null }, { preset: 'x' }, { preset: [] }],
  'dk.preset.delete': [{}, { id: 5 }, { id: 'x'.repeat(100) }, { id: null }],
  'dk.import': [{}, { text: 5 }, { text: 'x', confirmed: 'yes' }, { text: 'x'.repeat(1024 * 1024 + 5000) }, { confirmed: true }],
  'dk.css.enable': [{}, { scope: 'settings' }, { css: '' }, { scope: 'other', css: '' }, { scope: 'settings', css: 5 }, { scope: 'siteRules', pattern: 5, css: '' }, { scope: 'settings', css: 'x'.repeat(100_001) }],
  'dk.net.text': [{}, { url: 5 }, { url: 'x'.repeat(3000) }, { url: null }, { url: {} }],
  'dk.net.image': [{}, { url: 5 }, { url: 'x'.repeat(3000) }, { url: 'https://cdn.example/a.png', sample: 'yes' }, { url: 'https://cdn.example/a.png', sample: true, extra: 1 }],
  'dk.page.status': [{}, { status: 'dark' }, { status: 5 }, { status: 'ON' }, { status: '__proto__' }],
};

test('a payload of the wrong shape is invalid for every type that takes one', async () => {
  for (const [type, list] of Object.entries(BAD_PAYLOADS)) {
    const from = VALID[type].from;
    const { router } = make();
    const sender = from === 'page' ? senders.page : senders.content;
    for (const extra of list) {
      assert.deepEqual(await router.handle({ type, ...extra }, sender), { ok: false, code: 'invalid' }, `${type} ${JSON.stringify(extra).slice(0, 60)}`);
    }
  }
});

test('invalid settings that pass the shape check are refused by the settings rules, and nothing is written', async () => {
  const { router, local } = make();
  await router.handle({ type: 'dk.export' }, senders.page);
  const before = local.peek();
  const reply = await router.handle({ type: 'dk.settings.patch', patch: { theme: { brightness: 5000 } } }, senders.page);
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'invalid');
  assert.deepEqual(local.peek(), before);
});

/* ---------- what the handlers do ---------- */

test('state.get returns the state, the site decision and the tab status', async () => {
  const { router, state } = make();
  await state.init();
  await state.setSite('a.com', { enabled: false });
  await state.setTabStatus(3, 'fallback');
  const r = await router.handle({ type: 'dk.state.get', url: 'https://www.a.com/x', tabId: 3 }, senders.page);
  assert.equal(r.ok, true);
  assert.deepEqual(r.site, { enabled: false, pattern: 'www.a.com' });
  assert.equal(r.tab.status, 'fallback');
  assert.equal(r.settings.engine, 'auto');
  assert.ok(!('userFixes' in r), 'the user fixes are not part of the popup state');
  const none = await router.handle({ type: 'dk.state.get' }, senders.page);
  assert.equal(none.site, null);
  assert.equal(none.tab, null);
});

test('state.get tells whether the site theme is off for the site, and the rules that switch it', async () => {
  const get = async (state, router) => (await router.handle({ type: 'dk.state.get', url: 'https://www.a.com/x', tabId: 3 }, senders.page)).siteDark;
  {
    const { router, state } = make();
    await state.init();
    assert.deepEqual(await get(state, router), { off: false, key: 'www.a.com', offRule: { theme: { useSiteDark: false } }, onRule: null });
  }
  {
    const { router, state } = make();
    await state.init();
    await state.setSite('www.a.com', { css: 'a{}', theme: { brightness: 90, useSiteDark: false } });
    assert.deepEqual(await get(state, router), {
      off: true,
      key: 'www.a.com',
      offRule: { css: 'a{}', theme: { brightness: 90, useSiteDark: false } },
      onRule: { css: 'a{}', theme: { brightness: 90 } },
    });
  }
  {
    // A fix that turns it off: the rule that turns it on beats the fix.
    const { router, state } = make();
    await state.init();
    await state.setFix('www.a.com', { dynamic: { theme: { useSiteDark: false } } });
    const info = await get(state, router);
    assert.equal(info.off, true);
    assert.deepEqual(info.onRule, { theme: { useSiteDark: true } });
    await state.setSite('www.a.com', info.onRule);
    assert.equal((await get(state, router)).off, false);
  }
  const { router } = make();
  assert.equal((await router.handle({ type: 'dk.state.get' }, senders.page)).siteDark, null);
});

test('the two site theme statuses are accepted and keep the normal icon', async () => {
  const { router, calls } = make();
  for (const status of ['site-theme', 'site-theme-repaired']) assert.deepEqual(await router.handle({ type: 'dk.page.status', status }, senders.content), { ok: true });
  assert.deepEqual(calls.icon, [[3, 'site-theme'], [3, 'site-theme-repaired']]);
  assert.deepEqual(LOOKS['site-theme'], LOOKS.on);
  assert.deepEqual(LOOKS['site-theme-repaired'], LOOKS.on);
});

test('net requests pass the tab, the frame and the page address of the sender, never values from the message', async () => {
  const { router, calls } = make();
  await router.handle({ type: 'dk.net.text', url: 'https://cdn.example/a.css' }, senders.subframe);
  await router.handle({ type: 'dk.net.image', url: 'https://cdn.example/a.png' }, senders.blankFrame);
  assert.deepEqual(calls.net[0][2], { tabId: 3, frameId: 4, pageUrl: 'https://ads.example/x', host: 'ads.example', pathname: '/x', rights: 'https://ads.example/x', top: 'https://site.example/' });
  // An empty frame has no address of its own, so the address of the tab is used. Its origin is not known, so it has no network rights.
  assert.deepEqual(calls.net[1][2], { tabId: 3, frameId: 2, pageUrl: 'https://top.example/p', host: 'top.example', pathname: '/p', rights: '', top: 'https://top.example/p' });
});

test('page.status is accepted from the top frame only, and sets the icon and the stored status', async () => {
  const { router, calls, state } = make();
  assert.deepEqual(await router.handle({ type: 'dk.page.status', status: 'safe-mode' }, senders.subframe), { ok: false, code: 'denied' });
  assert.equal(calls.icon.length, 0);
  assert.deepEqual(await router.handle({ type: 'dk.page.status', status: 'safe-mode' }, senders.content), { ok: true });
  assert.deepEqual(calls.icon, [[3, 'safe-mode']]);
  assert.equal((await state.getTabStatus(3)).status, 'safe-mode');
});

test('page.status from a prerendered page: refused while it is prerendered, taken from its main frame once it is shown', async () => {
  const { router, calls, state } = make();
  // Chrome keeps the frame id of a prerendered main frame after activation; the frame type says it is the tab's page.
  const prerendered = { ...senders.content, tab: { id: 21, url: 'https://site.example/' }, frameId: 7, frameType: 'outermost_frame' };
  assert.deepEqual(await router.handle({ type: 'dk.page.status', status: 'on', at: Date.now() }, { ...prerendered, documentLifecycle: 'prerender' }), { ok: false, code: 'denied' });
  assert.equal(calls.icon.length, 0);
  assert.deepEqual(await router.handle({ type: 'dk.page.status', status: 'on', at: Date.now() }, { ...prerendered, documentLifecycle: 'active' }), { ok: true });
  assert.deepEqual(calls.icon, [[21, 'on']]);
  assert.equal((await state.getTabStatus(21)).status, 'on');
  // A frame inside a page, or a fenced frame, is not the page, whatever its frame id.
  for (const frameType of ['sub_frame', 'fenced_frame']) {
    assert.deepEqual(await router.handle({ type: 'dk.page.status', status: 'off' }, { ...senders.content, tab: { id: 21, url: 'https://site.example/' }, frameId: 0, frameType }), { ok: false, code: 'denied' });
  }
});

test('page.status older than the newest report of the tab is dropped', async () => {
  const { router, state } = make();
  const tab = { id: 22, url: 'https://next.example/' };
  const sent = Date.now();
  assert.deepEqual(await router.handle({ type: 'dk.page.status', status: 'on', at: sent + 20 }, { ...senders.content, url: 'https://next.example/', tab }), { ok: true });
  // A slow message of the page before.
  assert.deepEqual(await router.handle({ type: 'dk.page.status', status: 'site-off', at: sent }, { ...senders.content, url: 'https://site.example/a', tab }), { ok: true });
  assert.equal((await state.getTabStatus(22)).status, 'on');
});

test('the unused watchdog message is gone: it is refused like any unknown type', async () => {
  const { router, local } = make();
  const before = local.peek();
  const reply = await router.handle({ type: 'dk.watchdog.mark', mode: 'fallback' }, senders.content);
  assert.equal(reply.ok, false);
  assert.deepEqual(local.peek(), before);
});

test('fix.forHost answers for the host of the sender with built-in and user fixes', async () => {
  const { router, state, calls } = make();
  await state.init();
  const r = await router.handle({ type: 'dk.fix.forHost' }, senders.content);
  assert.deepEqual([r.ok, r.builtin, r.user, r.mark], [true, { note: 'b' }, null, null]);
  assert.deepEqual(calls.data[0], ['site.example', '/a/b']);
});

test('import needs the confirmation, and applies after it', async () => {
  const { router, local } = make();
  const source = S.defaultState();
  source.settings.theme.brightness = 70;
  const text = S.serializeExport(source);
  const preview = await router.handle({ type: 'dk.import', text }, senders.page);
  assert.deepEqual([preview.ok, preview.applied], [true, false]);
  assert.equal(local.peek().settings, undefined);
  const applied = await router.handle({ type: 'dk.import', text, confirmed: true }, senders.page);
  assert.equal(applied.applied, true);
  assert.equal(local.peek().settings.theme.brightness, 70);
});

test('an error inside a handler becomes a code, not an exception', async () => {
  const state = { ...createState({ local: fakeArea(), session: fakeArea() }), read: async () => { throw new Error('boom'); } };
  const router = createRouter({ runtimeId: RID, extensionOrigin: ORIGIN, state, net: {}, icon: {}, data: {} });
  assert.deepEqual(await router.handle({ type: 'dk.state.get' }, senders.page), { ok: false, code: 'error' });
});

/* ---------- the smaller modules ---------- */

test('the icon: each status has a look, and a closed tab does not throw', async () => {
  const log = [];
  const action = {
    setIcon: async (d) => log.push(['icon', d]),
    setBadgeText: async (d) => log.push(['text', d]),
    setBadgeBackgroundColor: async (d) => log.push(['color', d]),
  };
  const icon = createIcon({ action });
  await icon.apply(4, 'fallback');
  assert.deepEqual(log.map((l) => l[0]), ['icon', 'text', 'color']);
  assert.equal(log[1][1].text, 'F');
  await icon.apply(4, 'on');
  assert.equal(log.at(-1)[1].text, '');
  await icon.apply(4, 'nonsense');
  assert.equal(log.length, 5);
  assert.ok(LOOKS['site-off'].icon[16].includes('off'));
  const broken = createIcon({ action: { ...action, setIcon: async () => { throw new Error('No tab with id'); } } });
  await assert.doesNotReject(() => broken.apply(4, 'on'));
  await assert.doesNotReject(() => broken.setDefault(false));
});

test('the data shard of a host is the same for the same two last labels, and in range', () => {
  assert.equal(shardOf('www.example.com'), shardOf('example.com'));
  assert.equal(shardOf('A.Example.COM:8080'), shardOf('example.com'));
  assert.match(shardOf('x.org'), /^[0-9a-f]{2}$/);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(shardOf(`host${i}.example${i}.net`));
  assert.ok(seen.size > 200, `only ${seen.size} different shards for 2000 hosts`);
});

test('site data: found by host and path, missing files and bad files give nothing', async () => {
  const files = {};
  const data = createData({ readJson: async (p) => { if (!(p in files)) throw new Error('404'); return files[p]; } });
  const name = `data/fixes/${shardOf('a.com')}.json`;
  files[name] = { 'a.com': { note: 'host' }, 'a.com/docs': { note: 'docs' } };
  assert.equal((await data.forHost('www.a.com', '/', undefined)).builtin.note, 'host');
  assert.equal((await data.forHost('a.com', '/docs/x', undefined)).builtin.note, 'docs');
  assert.equal((await data.forHost('a.com', '/', { 'a.com': { note: 'mine' } })).user.note, 'mine');
  assert.deepEqual(await data.forHost('nodata.org', '/', undefined), { builtin: null, user: null, dark: false, paths: false });
  files[`data/fixes/${shardOf('bad.org')}.json`] = 'not an object';
  assert.deepEqual(await data.forHost('bad.org', '/', undefined), { builtin: null, user: null, dark: false, paths: false });
});

test('site data: the answer says when the host has a rule with a path, in the fixes or in the dark list', async () => {
  const files = { [`data/fixes/${shardOf('a.com')}.json`]: { 'a.com/docs': { note: 'docs' }, 'other.com/x': { note: 'x' } }, 'data/dark-sites.json': ['night.org/dark'] };
  const data = createData({ readJson: async (p) => { if (p in files) return files[p]; throw new Error('404'); } });
  assert.equal((await data.forHost('a.com', '/', undefined)).paths, true);
  assert.equal((await data.forHost('www.a.com', '/other', undefined)).paths, true);
  assert.equal((await data.forHost('a.com:8080', '/', undefined)).paths, true);
  assert.equal((await data.forHost('night.org', '/', undefined)).paths, true);
  assert.equal((await data.forHost('plain.net', '/docs', undefined)).paths, false);
  files[`data/fixes/${shardOf('b.com')}.json`] = { 'b.com': { note: 'whole host' } };
  assert.equal((await data.forHost('b.com', '/docs', undefined)).paths, false);
});

test('fix.forHost passes the paths flag of the data on', async () => {
  const { router, state } = make();
  await state.init();
  const r = await router.handle({ type: 'dk.fix.forHost' }, senders.content);
  assert.equal(r.paths, true);
});

test('site data: the built-in dark list is matched by host and path, and a missing or bad list means none', async () => {
  const withList = createData({ readJson: async (p) => { if (p === 'data/dark-sites.json') return ['dark.example', 'mixed.example/night', 7]; throw new Error('404'); } });
  assert.equal((await withList.forHost('www.dark.example', '/', undefined)).dark, true);
  assert.equal((await withList.forHost('mixed.example', '/night/x', undefined)).dark, true);
  assert.equal((await withList.forHost('mixed.example', '/day', undefined)).dark, false);
  assert.equal((await withList.forHost('other.example', '/', undefined)).dark, false);
  const bad = createData({ readJson: async () => 'not a list' });
  assert.equal((await bad.forHost('dark.example', '/', undefined)).dark, false);
});

test('commands: toggle the extension, toggle the site, switch the engine, and unknown names', async () => {
  const { state } = make();
  await state.init();
  const cmds = createCommands({ state, activeTab: async () => ({ url: 'https://tab.example/' }) });
  assert.deepEqual(await cmds.handle('toggle_extension'), { ok: true, enabled: false });
  assert.equal((await cmds.handle('toggle_site', { url: 'https://given.example/' })).pattern, 'given.example');
  assert.equal((await cmds.handle('toggle_site')).pattern, 'tab.example');
  assert.equal((await cmds.handle('switch_engine')).engine, 'dynamic');
  assert.deepEqual(await cmds.handle('nope'), { ok: false, code: 'unknown' });
});

test('the context menu is made only when the setting and the permission are both there', async () => {
  const log = [];
  const make2 = (granted) => createMenu({
    contextMenus: { removeAll: async () => log.push('removeAll'), create: (d) => log.push(['create', d.id, d.contexts]) },
    permissions: { contains: async () => granted },
    title: () => 'Toggle',
  });
  assert.equal(await make2(true).refresh(true), true);
  assert.deepEqual(log, ['removeAll', ['create', MENU_ID, ['page', 'action']]]);
  log.length = 0;
  assert.equal(await make2(false).refresh(true), false);
  assert.equal(await make2(true).refresh(false), false);
  assert.deepEqual(log, ['removeAll', 'removeAll']);
  const broken = createMenu({ contextMenus: { removeAll: async () => { throw new Error('x'); }, create() {} }, permissions: { contains: async () => { throw new Error('y'); } }, title: () => '' });
  assert.equal(await broken.refresh(true), false);
});

test('sync: pushes only when enabled, not right after a pull, and a burst is one push', async () => {
  const local = fakeArea();
  const remote = fakeArea({ quota: true });
  const timers = [];
  const state = createState({ local, session: fakeArea(), now: () => 5000 });
  const sync = createSync({ local, sync: remote, state, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => timers.pop() });
  await state.init();
  assert.deepEqual(await sync.push(), { ok: false, code: 'disabled' });
  await state.patchSettings({ syncEnabled: true });
  assert.equal((await sync.push()).ok, true);
  assert.ok(Object.keys(remote.peek()).length > 0);
  sync.schedulePush();
  sync.schedulePush();
  sync.schedulePush();
  assert.equal(timers.length, 1);
});

test('the verifier asks the frame, remembers a yes for a while, and says no on any failure', async () => {
  const calls = [];
  let answer = true;
  let t = 0;
  const verify = createVerifier({
    now: () => t,
    scripting: { executeScript: async (d) => { calls.push(d); if (answer === 'throw') throw new Error('no frame'); return [{ result: [answer] }]; } },
  });
  const who = { tabId: 2, frameId: 3 };
  assert.equal(await verify(who, 'https://a.example/a.css'), true);
  assert.equal(await verify(who, 'https://a.example/a.css'), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target, { tabId: 2, frameIds: [3] });
  assert.equal(calls[0].world, 'ISOLATED');
  assert.deepEqual(calls[0].args, [['https://a.example/a.css']]);
  t += 61_000;
  assert.equal(await verify(who, 'https://a.example/a.css'), true);
  assert.equal(calls.length, 2);
  answer = false;
  assert.equal(await verify(who, 'https://a.example/other.css'), false);
  answer = 'throw';
  assert.equal(await verify(who, 'https://a.example/third.css'), false);
  answer = 'yes';
  assert.equal(await verify(who, 'https://a.example/fourth.css'), false, 'only a real true counts');
});

test('reset needs a confirmation', async () => {
  const { router } = make();
  assert.deepEqual(await router.handle({ type: 'dk.reset', confirmed: false }, senders.page), { ok: false, code: 'unconfirmed' });
  assert.deepEqual(await router.handle({ type: 'dk.ui.set', ui: { locale: 'zz' } }, senders.page), { ok: false, code: 'invalid', errors: (await router.handle({ type: 'dk.ui.set', ui: { locale: 'zz' } }, senders.page)).errors });
});

test('dk.net.text takes an optional charset string of at most 64 characters, and hands it to the proxy', async () => {
  const { router, calls } = make();
  const url = 'https://cdn.example/a.css';
  assert.equal((await router.handle({ type: 'dk.net.text', url, charset: 'windows-1252' }, senders.content)).ok, true);
  assert.equal(calls.net.at(-1)[3], 'windows-1252');
  for (const charset of [5, null, {}, 'x'.repeat(65)]) {
    assert.deepEqual(await router.handle({ type: 'dk.net.text', url, charset }, senders.content), { ok: false, code: 'invalid' }, String(charset));
  }
  assert.deepEqual(await router.handle({ type: 'dk.net.text', url, extra: 1 }, senders.content), { ok: false, code: 'invalid' });
});
