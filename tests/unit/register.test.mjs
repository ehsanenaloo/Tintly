import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { loadContent } from '../helpers/content.mjs';
import { siteEnabled } from '../../extension/shared/match.js';

const dk = await loadContent('core/match.js');
const reg = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'register.js')).href);
const early = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'early.js')).href);
const { planFor, covers, narrows, createRegister, withoutAddresses, ENGINE_FILES, HOOK_FILES, IDS, RETRY_MS, RETIRE_MS } = reg;

const ALL = '<all_urls>';

/* ----- the plan ----- */

test('the extension off: nowhere; the default: everywhere', () => {
  assert.equal(planFor({ enabled: false }, {}), null);
  assert.deepEqual(planFor({ enabled: true }, {}), { matches: [ALL], excludeMatches: [] });
  assert.deepEqual(planFor({}, null), { matches: [ALL], excludeMatches: [] });
  assert.deepEqual(planFor(undefined, undefined), { matches: [ALL], excludeMatches: [] });
});

test('a bare host that is off is left out with its subdomains, any port and any path', () => {
  const plan = planFor({ enabled: true }, { 'example.com': { enabled: false }, 'a.org': { enabled: true } });
  assert.deepEqual(plan, { matches: [ALL], excludeMatches: ['*://*.example.com/*'] });
  assert.equal(covers(plan, 'https://example.com/'), false);
  assert.equal(covers(plan, 'https://www.example.com:8443/x?y=1'), false);
  assert.equal(covers(plan, 'https://notexample.com/'), true);
  assert.equal(covers(plan, 'https://example.com.evil.net/'), true);
});

test('a rule that a match pattern cannot say exactly leaves the host in the set', () => {
  const rules = {
    'path.com/docs': { enabled: false },
    'port.com:8080': { enabled: false },
    '*.wild.com': { enabled: false },
    'nested.com': { enabled: false },
    'www.nested.com': { enabled: true },
    'quiet.com': { enabled: false },
    'sub.quiet.com': { theme: { mode: 'light' } },
    'xn--bcher-kva.de': { enabled: false },
    'bücher.de': { enabled: false },
    '[::1]:9000': { enabled: false },
    '[::1]/docs': { enabled: false },
  };
  const plan = planFor({ enabled: true }, rules);
  assert.deepEqual(plan.excludeMatches, ['*://*.xn--bcher-kva.de/*']);
});

test('a key of one label stands for that host only, as in the gate (a top-level domain is never a parent)', () => {
  const plan = planFor({ enabled: true }, { com: { enabled: false }, localhost: { enabled: false } });
  assert.deepEqual(plan.excludeMatches, ['*://com/*', '*://localhost/*']);
  assert.equal(covers(plan, 'https://a.com/'), true);
  assert.equal(covers(plan, 'https://www.a.com/x'), true);
  assert.equal(covers(plan, 'https://localhost:3000/'), false);
  assert.equal(covers(plan, 'https://a.localhost/'), true);
  assert.deepEqual(planFor({ listMode: 'onlyListed' }, { com: { enabled: true } }).matches, ['*://com/*']);
  // The same on the gate side.
  assert.equal(gateOn({ enabled: true }, { com: { enabled: false } }, 'a.com', '/'), true);
});

test('two off hosts, one below the other, are both left out', () => {
  const plan = planFor({ enabled: true }, { 'a.com': { enabled: false }, 'b.a.com': { enabled: false } });
  assert.deepEqual(plan.excludeMatches, ['*://*.a.com/*', '*://*.b.a.com/*']);
});

test('only listed sites: the hosts of the rules that are on', () => {
  const plan = planFor({ enabled: true, listMode: 'onlyListed' }, { 'a.com': { enabled: true }, 'b.org/docs': { enabled: true }, 'c.net:81': { enabled: true }, '*.d.io': { enabled: true }, 'e.com': { enabled: false }, 'f.com': { theme: {} } });
  assert.deepEqual(plan, { matches: ['*://*.a.com/*', '*://*.b.org/*', '*://*.c.net/*', '*://*.d.io/*'], excludeMatches: [] });
  assert.equal(covers(plan, 'https://x.a.com/'), true);
  assert.equal(covers(plan, 'https://e.com/'), false);
  assert.equal(covers(plan, 'file:///a.html'), false);
  assert.equal(planFor({ enabled: true, listMode: 'onlyListed' }, {}), null);
  assert.equal(planFor({ enabled: true, listMode: 'onlyListed' }, { 'e.com': { enabled: false } }), null);
});

test('only listed sites: a key that is not a host name puts every page in the set', () => {
  assert.deepEqual(planFor({ listMode: 'onlyListed' }, { 'bücher.de': { enabled: true } }), { matches: [ALL], excludeMatches: [] });
  assert.deepEqual(planFor({ listMode: 'onlyListed' }, { '[zz]': { enabled: true } }), { matches: [ALL], excludeMatches: [] });
  assert.deepEqual(planFor({ listMode: 'onlyListed' }, { '*.[::1]': { enabled: true } }), { matches: [ALL], excludeMatches: [] });
});

test('an IPv6 host is an address: its pattern names that host only, with any port and path, and no sub-host', () => {
  const on = planFor({ listMode: 'onlyListed' }, { '[::1]': { enabled: true }, '[2001:db8::1]:8080': { enabled: true }, 'a.com': { enabled: true } });
  assert.deepEqual(on.matches, ['*://*.a.com/*', '*://[2001:db8::1]/*', '*://[::1]/*']);
  assert.equal(covers(on, 'http://[::1]:8080/x'), true);
  assert.equal(covers(on, 'https://[2001:db8::1]/'), true);
  assert.equal(covers(on, 'http://[2001:db8::2]/'), false);
  assert.equal(covers(on, 'http://127.0.0.1/'), false);
  const off = planFor({ enabled: true }, { '[::1]': { enabled: false } });
  assert.deepEqual(off, { matches: [ALL], excludeMatches: ['*://[::1]/*'] });
  assert.equal(covers(off, 'http://[::1]:3000/'), false);
  assert.equal(covers(off, 'http://[::2]:3000/'), true);
  // A rule with a port or a path is left to the gate, as for any host.
  assert.deepEqual(planFor({ enabled: true }, { '[::1]:8080': { enabled: false }, '[::1]/docs': { enabled: false } }).excludeMatches, []);
  // No parent domain: a rule for a DNS name does not cover an address and the other way round.
  assert.equal(covers(planFor({ enabled: true }, { '1': { enabled: false } }), 'http://[::1]/'), true);
});

test('a browser that refuses an IPv6 host in a match pattern keeps the registration: the set grows and the gate decides', async () => {
  const wide = withoutAddresses(planFor({ listMode: 'onlyListed' }, { '[::1]': { enabled: true } }));
  assert.deepEqual(wide, { matches: [ALL], excludeMatches: [] });
  assert.deepEqual(withoutAddresses(planFor({ enabled: true }, { '[::1]': { enabled: false }, 'a.com': { enabled: false } })), { matches: [ALL], excludeMatches: ['*://*.a.com/*'] });
  const scripting = fakeScripting();
  const reject = scripting.registerContentScripts.bind(scripting);
  scripting.registerContentScripts = async (list) => {
    if (list.some((s) => [...s.matches, ...s.excludeMatches].some((m) => m.includes('[')))) throw new Error("Invalid value for 'matches'");
    return reject(list);
  };
  const warned = [];
  const register = createRegister({
    scripting,
    tabs: { query: async () => [] },
    read: async () => ({ settings: { enabled: true, listMode: 'onlyListed' }, siteRules: { '[::1]': { enabled: true } } }),
    schedule: () => 0,
    warn: (e) => warned.push(String(e?.message ?? e)),
  });
  await register.sync();
  assert.equal(register.failed, false);
  assert.deepEqual(register.plan, { matches: [ALL], excludeMatches: [] });
  assert.equal(scripting.scripts.get('dk-engine').matches[0], ALL);
  assert.equal(warned.length, 1);
});

test('an automation does not narrow the set', () => {
  const plan = planFor({ enabled: true, automation: { mode: 'time', behavior: 'onOff' } }, { 'example.com': { enabled: false } });
  assert.deepEqual(plan, { matches: [ALL], excludeMatches: ['*://*.example.com/*'] });
});

test('the number of patterns is bounded', () => {
  const rules = {};
  for (let i = 0; i < 700; i++) rules[`h${i}.com`] = { enabled: false };
  assert.ok(planFor({ enabled: true }, rules).excludeMatches.length <= 500);
  const listed = {};
  for (let i = 0; i < 700; i++) listed[`h${i}.com`] = { enabled: true };
  assert.deepEqual(planFor({ listMode: 'onlyListed' }, listed), { matches: [ALL], excludeMatches: [] });
});

test('the scripts cover every address of every kind that the gate themes', () => {
  const plan = planFor({ enabled: true }, {});
  for (const u of ['http://a.com/', 'https://a.com:81/x#y', 'file:///c:/a.html', 'ftp://a.com/']) assert.equal(covers(plan, u), true, u);
  for (const u of ['chrome://extensions/', 'about:blank', 'data:text/html,x', 'not an address', 7, null]) assert.equal(covers(plan, u), false, String(u));
  assert.equal(covers(null, 'https://a.com/'), false);
});

/* ----- the plan against the gate ----- */

/** The decision of the gate that the registration can know: master switch, list mode, site rule. */
function gateOn(settings, rules, host, pathname) {
  if (settings.enabled === false) return false;
  const rule = dk.match.find(rules, host, pathname);
  return rule && typeof rule.enabled === 'boolean' ? rule.enabled : settings.listMode !== 'onlyListed';
}

test('every page that the gate would theme is inside the set (random rules, hosts and paths)', () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const labels = ['a', 'b', 'c'];
  const hosts = [];
  for (const x of labels) {
    hosts.push(`${x}.com`, `www.${x}.com`, `m.www.${x}.com`);
    for (const y of labels) hosts.push(`${y}.${x}.com`);
  }
  hosts.push('a.com:8080', 'www.a.com:81', 'localhost', 'localhost:3000', 'a.localhost', 'com', 'b.net');
  const paths = ['/', '/docs', '/docs/x', '/docsx', '/other/y'];
  const keys = [...hosts, 'net', ...hosts.filter((h) => !h.includes(':')).map((h) => `*.${h}`), ...hosts.flatMap((h) => [`${h}/docs`, `${h}/other`])];
  for (let round = 0; round < 400; round++) {
    const rules = {};
    for (let n = rnd(8); n > 0; n--) {
      const key = keys[rnd(keys.length)];
      const kind = rnd(4);
      rules[key] = kind === 0 ? { enabled: true } : kind === 1 ? { enabled: false } : kind === 2 ? { enabled: false, engine: 'filter' } : { theme: { mode: 'light' } };
    }
    for (const settings of [{ enabled: true }, { enabled: true, listMode: 'onlyListed' }, { enabled: false }]) {
      const plan = planFor(settings, rules);
      for (const host of hosts) {
        for (const path of paths) {
          const on = gateOn(settings, rules, host, path);
          const inside = covers(plan, `https://${host}${path}`);
          if (on) assert.ok(inside, `gate on, outside the set: ${JSON.stringify(settings)} ${JSON.stringify(rules)} ${host}${path}`);
        }
        // A bare host that is off, with nothing nested, is exactly left out.
        if (settings.enabled !== false && settings.listMode !== 'onlyListed' && plan && !host.includes(':')) {
          const off = !gateOn(settings, rules, host, '/');
          const alone = !Object.keys(rules).some((k) => k.includes('/') || k.startsWith('*.'));
          if (off && alone && Object.values(rules).every((r) => r.enabled === false)) assert.equal(covers(plan, `https://${host}/`), false, `${JSON.stringify(rules)} ${host}`);
        }
      }
    }
  }
});

test('the first-paint registration is inside the engine registration', () => {
  let seed = 11;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const hosts = ['a.com', 'www.a.com', 'b.org', 'x.b.org', 'c.net'];
  const keys = [...hosts, ...hosts.map((h) => `*.${h}`), ...hosts.map((h) => `${h}/docs`), 'a.com:81'];
  for (let round = 0; round < 300; round++) {
    const rules = {};
    for (let n = rnd(6); n > 0; n--) rules[keys[rnd(keys.length)]] = rnd(3) === 0 ? { enabled: true } : rnd(2) ? { enabled: false } : { theme: { mode: rnd(2) ? 'light' : 'dark' } };
    for (const listMode of ['allExcept', 'onlyListed']) {
      const settings = { enabled: true, listMode };
      const hold = early.planFor(settings, rules);
      const engine = planFor(settings, rules);
      if (!hold) continue;
      assert.ok(engine, `hold without engine: ${JSON.stringify(rules)}`);
      for (const host of hosts) {
        const url = `https://${host}/docs/x`;
        const held = hold.matches.some((m) => m === 'https://*/*' || m === 'http://*/*' || early.matchPatternsFor(host).includes(m) || coversPattern(m, host)) && !hold.excludeMatches.some((m) => coversPattern(m, host));
        if (held) assert.ok(covers(engine, url), `held page without engine: ${JSON.stringify({ rules, listMode })} ${host}`);
      }
    }
  }
});

/** A match pattern of the forms the first-paint plan makes, against a host. */
function coversPattern(pattern, host) {
  const m = /^(?:\*|https?):\/\/(\*\.)?([^/]+)\//.exec(pattern);
  if (!m) return false;
  return m[1] ? host === m[2] || host.endsWith(`.${m[2]}`) : host === m[2];
}

/* ----- the registration ----- */

/** A fake `scripting` with the registered scripts of one extension. */
function fakeScripting({ refuseFallback = false, failures = 0 } = {}) {
  const scripts = new Map();
  const calls = [];
  let fail = failures;
  const api = {
    calls,
    scripts,
    async getRegisteredContentScripts(filter) {
      calls.push(['get']);
      return [...scripts.values()].filter((s) => !filter?.ids || filter.ids.includes(s.id)).map((s) => structuredClone(s));
    },
    async registerContentScripts(list) {
      calls.push(['register', list.map((s) => s.id)]);
      if (fail > 0) {
        fail -= 1;
        throw new Error('The browser is busy');
      }
      if (refuseFallback && list.some((s) => 'matchOriginAsFallback' in s)) throw new Error("Unexpected property: 'matchOriginAsFallback'");
      for (const s of list) {
        if (scripts.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
        const { matchOriginAsFallback, ...stored } = s;
        scripts.set(s.id, structuredClone(stored));
      }
    },
    async updateContentScripts(list) {
      calls.push(['update', list.map((s) => s.id)]);
      if (refuseFallback && list.some((s) => 'matchOriginAsFallback' in s)) throw new Error("Unexpected property: 'matchOriginAsFallback'");
      for (const s of list) {
        if (!scripts.has(s.id)) throw new Error(`Nonexistent script ID '${s.id}'`);
        const { matchOriginAsFallback, ...stored } = s;
        scripts.set(s.id, structuredClone({ ...scripts.get(s.id), ...stored }));
      }
    },
    async unregisterContentScripts(filter) {
      calls.push(['unregister', filter?.ids]);
      for (const id of filter?.ids ?? [...scripts.keys()]) {
        if (!scripts.has(id)) throw new Error(`Nonexistent script ID '${id}'`);
        scripts.delete(id);
      }
    },
    injected: [],
    /** The frames where the engine was stopped: `{ tabId, frames }`. */
    retired: [],
    /** The frames each probe of the engine reached: `{ tabId, frames }`. */
    probed: [],
    /**
     * The frames of each tab: `{ url, engine, origin?, doc? }`. `engine` says that the engine of this build runs there; `origin` is the one
     * the frame inherits when it has no address of its own; `doc` is its document id, for a browser that names documents.
     */
    has: new Map(),
    async executeScript(injection) {
      const tabId = injection.target.tabId;
      const frames = api.has.get(tabId);
      if (!frames) throw new Error('Cannot access contents of the page');
      const { frameIds, documentIds } = injection.target;
      const picked = frameIds ?? (documentIds ? documentIds.map((id) => frames.findIndex((f) => f.doc === id)) : null);
      if (picked && picked.some((i) => !frames[i])) throw new Error('No frame or document with that id');
      if (injection.func?.name === 'frameAddress') {
        assert.equal(injection.world, 'MAIN', 'the addresses are read in the page world, which makes no isolated world');
        return frames.map((f, frameId) => ({ frameId, ...(f.doc ? { documentId: f.doc } : {}), result: { href: f.url, origin: f.origin ?? (/^https?:/.test(f.url) ? new URL(f.url).origin : 'null'), born: f.born ?? 0 } }));
      }
      if (injection.func?.name === 'engineReady') {
        api.probed.push({ tabId, frames: picked });
        return picked.map((frameId) => ({ frameId, result: frames[frameId].engine === true }));
      }
      if (injection.func?.name === 'retireEngine') {
        api.retired.push({ tabId, frames: picked });
        return [];
      }
      if (injection.func) throw new Error(`unknown probe ${injection.func.name}`);
      api.injected.push({ tabId, frames: picked ?? 'all', world: injection.world, files: injection.files, ...(documentIds ? { documents: documentIds } : {}) });
      return [];
    },
  };
  return api;
}

function setup({ settings = { enabled: true }, siteRules = {}, tabs = [], ...options } = {}) {
  const scripting = fakeScripting(options);
  const stored = { settings, siteRules, readable: true };
  const timers = [];
  const warned = [];
  const register = createRegister({
    scripting,
    tabs: { query: async () => tabs },
    read: async () => (stored.readable ? { settings: stored.settings, siteRules: stored.siteRules } : null),
    schedule: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    warn: (e) => warned.push(String(e?.message ?? e)),
  });
  return { scripting, stored, register, timers, warned };
}

test('the first pass registers the hook in the page world and the engine in the isolated world, once each', async () => {
  const { scripting, register } = setup();
  await register.sync();
  const registered = [...scripting.scripts.values()];
  assert.deepEqual(registered.map((s) => s.id).sort(), [IDS.engine, IDS.hook].sort());
  const hook = scripting.scripts.get(IDS.hook);
  const engine = scripting.scripts.get(IDS.engine);
  assert.deepEqual(hook.js, [...HOOK_FILES]);
  assert.equal(hook.world, 'MAIN');
  assert.deepEqual(engine.js, [...ENGINE_FILES]);
  assert.equal(engine.world, 'ISOLATED');
  for (const s of registered) {
    assert.deepEqual(s.matches, [ALL]);
    assert.equal(s.runAt, 'document_start');
    assert.equal(s.allFrames, true);
    assert.equal(s.persistAcrossSessions, true);
  }
  assert.deepEqual(scripting.calls.filter((c) => c[0] !== 'get'), [['register', [IDS.hook, IDS.engine]]]);
});

test('a second pass with the same settings does nothing, also from a new run of the worker', async () => {
  const a = setup();
  await a.register.sync();
  a.scripting.calls.length = 0;
  await a.register.sync();
  assert.deepEqual(a.scripting.calls, [], 'same run: no call at all');
  // The worker slept and started again: the browser still holds the scripts.
  const again = createRegister({ scripting: a.scripting, tabs: { query: async () => [] }, read: async () => ({ settings: { enabled: true }, siteRules: {} }) });
  await again.sync();
  assert.deepEqual(a.scripting.calls.filter((c) => c[0] !== 'get'), []);
  assert.equal(a.scripting.scripts.size, 2);
});

test('a change updates the scripts in place, and the master switch removes them', async () => {
  const { scripting, stored, register } = setup();
  await register.sync();
  scripting.calls.length = 0;
  stored.siteRules = { 'example.com': { enabled: false } };
  await register.sync();
  assert.deepEqual(scripting.calls.filter((c) => c[0] !== 'get'), [['update', [IDS.hook, IDS.engine]]]);
  assert.deepEqual(scripting.scripts.get(IDS.engine).excludeMatches, ['*://*.example.com/*']);
  // Taking the exclusion away again must reach the browser, which keeps a field that an update leaves out.
  stored.siteRules = {};
  await register.sync();
  assert.deepEqual(scripting.scripts.get(IDS.engine).excludeMatches, []);
  stored.siteRules = { 'example.com': { enabled: false } };
  await register.sync();
  scripting.calls.length = 0;
  stored.settings = { enabled: false };
  await register.sync();
  assert.deepEqual(scripting.calls.filter((c) => c[0] !== 'get'), [['unregister', [IDS.hook, IDS.engine]]]);
  assert.equal(scripting.scripts.size, 0);
  await register.sync();
  stored.settings = { enabled: true };
  await register.sync();
  assert.equal(scripting.scripts.size, 2);
});

test('no duplicate: scripts left by an older build with other files or other sites are brought to the plan, not registered twice', async () => {
  const { scripting, register } = setup({ siteRules: { 'a.com': { enabled: false } } });
  scripting.scripts.set(IDS.engine, { id: IDS.engine, js: ['content/core/namespace.js'], matches: ['<all_urls>'], world: 'ISOLATED', runAt: 'document_start', allFrames: true });
  await register.sync();
  assert.equal(scripting.scripts.size, 2);
  assert.deepEqual(scripting.scripts.get(IDS.engine).js, [...ENGINE_FILES]);
  assert.deepEqual(scripting.scripts.get(IDS.engine).excludeMatches, ['*://*.a.com/*']);
  assert.deepEqual(scripting.calls.filter((c) => c[0] === 'register'), [['register', [IDS.hook]]]);
  assert.deepEqual(scripting.calls.filter((c) => c[0] === 'update'), [['update', [IDS.engine]]]);
});

test('a browser that does not know matchOriginAsFallback still gets the scripts', async () => {
  const { scripting, register } = setup({ refuseFallback: true });
  await register.sync();
  assert.equal(scripting.scripts.size, 2);
  assert.equal(register.failed, false);
});

test('storage that cannot be read changes nothing', async () => {
  const { scripting, stored, register } = setup();
  await register.sync();
  scripting.calls.length = 0;
  stored.readable = false;
  stored.settings = { enabled: false };
  await register.sync();
  assert.deepEqual(scripting.calls, []);
  assert.equal(scripting.scripts.size, 2);
});

test('calls queue up and the newest settings win', async () => {
  const { scripting, stored, register } = setup();
  const done = [];
  stored.settings = { enabled: true };
  done.push(register.sync());
  stored.siteRules = { 'a.com': { enabled: false } };
  done.push(register.sync());
  stored.settings = { enabled: false };
  done.push(register.sync());
  await Promise.all(done);
  assert.equal(scripting.scripts.size, 0);
  stored.settings = { enabled: true };
  await Promise.all([register.sync(), register.sync(), register.sync()]);
  assert.equal(scripting.scripts.size, 2);
  assert.deepEqual(scripting.scripts.get(IDS.engine).excludeMatches, ['*://*.a.com/*']);
});

/* ----- refusal and retry ----- */

test('a refusal is reported, retried with a growing wait, and ends when it works', async () => {
  const { scripting, register, timers, warned } = setup({ failures: 2 });
  await register.sync();
  assert.equal(register.failed, true);
  assert.equal(register.plan, undefined);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, RETRY_MS[0]);
  assert.equal(warned.length, 1);
  // The timers of the worker fire.
  timers.shift().fn();
  await register.settled();
  assert.equal(register.failed, true);
  assert.equal(timers[0].ms, RETRY_MS[1]);
  timers.shift().fn();
  await register.settled();
  assert.equal(register.failed, false);
  assert.equal(register.attempts, 0);
  assert.equal(scripting.scripts.size, 2);
  assert.equal(timers.length, 0);
});

test('the retries are bounded, and a later change tries again', async () => {
  const { scripting, register, timers } = setup({ failures: 1000 });
  await register.sync();
  for (let i = 0; i < 20 && timers.length; i++) {
    timers.shift().fn();
    await register.settled();
  }
  assert.equal(timers.length, 0);
  assert.equal(register.failed, true);
  assert.equal(register.attempts, RETRY_MS.length);
  scripting.calls.length = 0;
  await register.sync();
  assert.ok(scripting.calls.some((c) => c[0] === 'register'), 'a new trigger tries again');
});

test('a refused update leaves the failure visible and the scripts it had', async () => {
  const { scripting, stored, register } = setup();
  await register.sync();
  const update = scripting.updateContentScripts;
  scripting.updateContentScripts = async () => {
    throw new Error('refused');
  };
  stored.siteRules = { 'a.com': { enabled: false } };
  await register.sync();
  assert.equal(register.failed, true);
  scripting.updateContentScripts = update;
  await register.sync();
  assert.equal(register.failed, false);
  assert.deepEqual(scripting.scripts.get(IDS.engine).excludeMatches, ['*://*.a.com/*']);
});

/* ----- open tabs ----- */

const tab = (id, url) => ({ id, url });

/** Let the quiet time pass: run the timers that let the engine go, and wait for them. */
async function quiet(register, timers) {
  for (const t of timers.splice(0)) if (t.ms === RETIRE_MS) t.fn();
  await register.settled();
}

/** A frame at this address, with or without the engine of this build. */
const frame = (url, engine = false, extra = {}) => ({ url, engine, ...extra });

test('switching a site on puts the files into the open tabs it covers, in the frames that lack them', async () => {
  const tabs = [tab(1, 'https://a.com/'), tab(2, 'https://b.org/'), tab(3, 'https://c.net/x'), tab(4, 'chrome://extensions/'), { id: 5 }];
  const { scripting, stored, register } = setup({ settings: { enabled: true, listMode: 'onlyListed' }, siteRules: { 'a.com': { enabled: true } }, tabs });
  scripting.has.set(1, [frame('https://a.com/', true)]);
  await register.sync();
  assert.deepEqual(scripting.injected, [], 'a.com already has them');
  stored.siteRules = { 'a.com': { enabled: true }, 'b.org': { enabled: true }, 'c.net': { enabled: false } };
  scripting.has.set(2, [frame('https://b.org/'), frame('https://b.org/in', true), frame('https://www.b.org/x')]);
  await register.sync();
  assert.deepEqual(
    scripting.injected.map((i) => [i.tabId, i.frames, i.world, i.files[0]]),
    [
      [2, [0, 2], 'MAIN', HOOK_FILES[0]],
      [2, [0, 2], 'ISOLATED', ENGINE_FILES[0]],
    ],
  );
});

test('a frame of a site that is off gets nothing, also inside an open page that is on', async () => {
  // video.example.com is off and is a frame of blog.example.org; an ad frame without an address inherits the origin of video.example.com,
  // a sandboxed frame has an opaque origin, and a frame without an address inherits the blog's origin.
  const tabs = [tab(1, 'https://blog.example.org/post')];
  const { scripting, register } = setup({ siteRules: { 'video.example.com': { enabled: false } }, tabs });
  scripting.has.set(1, [
    frame('https://blog.example.org/post'),
    frame('https://video.example.com/embed/1'),
    frame('about:blank', false, { origin: 'https://video.example.com' }),
    frame('about:srcdoc', false, { origin: 'null' }),
    frame('about:blank', false, { origin: 'https://blog.example.org' }),
  ]);
  await register.sync();
  assert.deepEqual(scripting.probed, [{ tabId: 1, frames: [0, 4] }], 'the engine probe runs only in the frames the plan covers');
  assert.deepEqual(
    scripting.injected.map((i) => [i.tabId, i.frames, i.world]),
    [
      [1, [0, 4], 'MAIN'],
      [1, [0, 4], 'ISOLATED'],
    ],
  );
  // The same after an install or an update, and for a site switched off while the tab was open.
  scripting.injected.length = 0;
  await register.injectOpenTabs();
  assert.ok(scripting.injected.every((i) => i.frames.every((f) => f === 0 || f === 4)));
});

test('the files go into a frame by its document when the browser names documents, so a frame that moved on gets nothing', async () => {
  const tabs = [tab(1, 'https://a.com/')];
  const { scripting, register } = setup({ tabs });
  scripting.has.set(1, [frame('https://a.com/', false, { doc: 'd0' }), frame('https://b.org/', true, { doc: 'd1' })]);
  await register.sync();
  assert.deepEqual(scripting.injected.map((i) => [i.world, i.documents]), [['MAIN', ['d0']], ['ISOLATED', ['d0']]]);
  // The frame loads another page between the probe and the injection: its document is gone and nothing is injected by frame.
  scripting.injected.length = 0;
  const real = scripting.executeScript;
  scripting.executeScript = async (injection) => {
    if (injection.files) throw new Error('No document with id d0');
    return real(injection);
  };
  await register.injectOpenTabs();
  assert.deepEqual(scripting.injected, []);
  // A browser that does not take documentIds in this call is asked by frame.
  scripting.executeScript = async (injection) => {
    if (injection.target.documentIds) throw new Error("Unexpected property: 'documentIds'");
    return real(injection);
  };
  await register.injectOpenTabs();
  assert.deepEqual(scripting.injected.map((i) => [i.world, i.frames]), [['MAIN', [0]], ['ISOLATED', [0]]]);
});

test('a tab that cannot be probed is skipped, and the first pass of a worker with no scripts covers every open tab', async () => {
  const tabs = [tab(1, 'https://a.com/'), tab(2, 'https://b.org/')];
  const { scripting, register } = setup({ tabs });
  scripting.has.set(2, [frame('https://b.org/')]);
  await register.sync();
  assert.deepEqual([...new Set(scripting.injected.map((i) => i.tabId))], [2]);
  assert.deepEqual(scripting.injected[0].frames, [0]);
});

test('a restart of the browser with the scripts in place injects nothing, an install does', async () => {
  const tabs = [tab(1, 'https://a.com/')];
  const first = setup({ tabs });
  first.scripting.has.set(1, [frame('https://a.com/')]);
  await first.register.sync();
  first.scripting.injected.length = 0;
  const later = createRegister({ scripting: first.scripting, tabs: { query: async () => tabs }, read: async () => ({ settings: { enabled: true }, siteRules: {} }) });
  await later.sync();
  assert.deepEqual(first.scripting.injected, []);
  await later.injectOpenTabs();
  assert.equal(first.scripting.injected.length, 2, 'install and update look at every covered tab');
});

test('a switch-off removes the scripts and injects nothing', async () => {
  const tabs = [tab(1, 'https://a.com/')];
  const { scripting, stored, register } = setup({ tabs });
  scripting.has.set(1, [frame('https://a.com/', true)]);
  await register.sync();
  stored.settings = { enabled: false };
  await register.sync();
  assert.deepEqual(scripting.injected, []);
  assert.equal(scripting.scripts.size, 0);
});

test('narrows says when a plan leaves out a page that the old one covered', () => {
  const all = { matches: [ALL], excludeMatches: [] };
  assert.equal(narrows(null, all), false);
  assert.equal(narrows(all, null), true);
  assert.equal(narrows(all, all), false);
  assert.equal(narrows(all, { matches: [ALL], excludeMatches: ['*://*.a.com/*'] }), true);
  assert.equal(narrows({ matches: [ALL], excludeMatches: ['*://*.a.com/*'] }, all), false, 'a wider plan');
  assert.equal(narrows({ matches: ['*://*.a.com/*', '*://*.b.com/*'], excludeMatches: [] }, { matches: ['*://*.a.com/*'], excludeMatches: [] }), true);
  assert.equal(narrows({ matches: ['*://*.a.com/*'], excludeMatches: [] }, { matches: ['*://*.a.com/*', '*://*.b.com/*'], excludeMatches: [] }), false);
  assert.equal(narrows(all, { matches: ['*://*.a.com/*'], excludeMatches: [] }), true, 'all pages to a list');
});

test('a switch-off stops the engine in the open frames the new plan leaves out, and in no other frame', async () => {
  const tabs = [tab(1, 'https://a.com/'), tab(2, 'https://b.org/'), tab(3, 'https://c.net/')];
  const { scripting, stored, register, timers } = setup({ tabs });
  // Tab 1 holds a frame of the excluded host and one of a host that stays; tab 2 is a frame with no address of its own next to its page.
  scripting.has.set(1, [frame('https://a.com/', true), frame('https://other.org/x', true)]);
  scripting.has.set(2, [frame('https://b.org/', true), frame('about:blank', true, { origin: 'https://b.org' })]);
  scripting.has.set(3, [frame('https://c.net/', true)]);
  await register.sync();
  assert.deepEqual(scripting.retired, [], 'the first pass retires nothing');
  stored.siteRules = { 'a.com': { enabled: false } };
  await register.sync();
  assert.deepEqual(scripting.retired, [], 'not at once: a quick switch back keeps the gate');
  await quiet(register, timers);
  assert.deepEqual(scripting.retired, [{ tabId: 1, frames: [0] }]);
  scripting.retired.length = 0;
  // The master switch: every frame with a web address goes, a frame without one stays idle.
  stored.settings = { enabled: false };
  await register.sync();
  await quiet(register, timers);
  const byTab = Object.fromEntries(scripting.retired.map((r) => [r.tabId, r.frames]));
  assert.deepEqual(byTab, { 1: [1], 2: [0], 3: [0] }, 'a.com was let go already: only what the last plan still covered');
  // A plan that grows retires nothing.
  scripting.retired.length = 0;
  stored.settings = { enabled: true };
  await register.sync();
  await quiet(register, timers);
  assert.deepEqual(scripting.retired, []);
});

test('a narrowing touches only the frames that the old plan covered and the new one does not', async () => {
  const tabs = [tab(1, 'https://a.com/'), tab(2, 'https://b.org/')];
  const { scripting, stored, register, timers } = setup({ siteRules: { 'off.net': { enabled: false } }, tabs });
  // off.net was never covered, so it never had the engine: no isolated world is made there to stop it.
  scripting.has.set(1, [frame('https://a.com/', true), frame('https://off.net/x'), frame('https://c.com/', true)]);
  scripting.has.set(2, [frame('https://b.org/', true)]);
  await register.sync();
  stored.siteRules = { 'off.net': { enabled: false }, 'c.com': { enabled: false } };
  await register.sync();
  stored.siteRules = { 'off.net': { enabled: false }, 'c.com': { enabled: false }, 'b.org': { enabled: false } };
  await register.sync();
  await quiet(register, timers);
  assert.deepEqual(scripting.retired, [{ tabId: 1, frames: [2] }, { tabId: 2, frames: [0] }], 'both narrowings of the quiet time, nothing else');
});

test('a document of the site that began after the switch-off never had the files and is not touched', async () => {
  const tabs = [tab(1, 'https://a.com/'), tab(2, 'https://a.com/x')];
  const { scripting, stored, register, timers } = setup({ tabs });
  scripting.has.set(1, [frame('https://a.com/', true)]);
  await register.sync();
  stored.siteRules = { 'a.com': { enabled: false } };
  await register.sync();
  // Tab 2 is reloaded within the quiet time: its document began after the registration left a.com out.
  scripting.has.set(2, [frame('https://a.com/x', false, { born: Date.now() + 1000 })]);
  await quiet(register, timers);
  assert.deepEqual(scripting.retired, [{ tabId: 1, frames: [0] }]);
});

test('a page loaded while a retire waits, then left out by a later narrowing of the same wait, is stopped', async () => {
  const tabs = [tab(1, 'https://x.com/'), tab(2, 'https://y.com/')];
  const { scripting, stored, register, timers } = setup({ tabs });
  scripting.has.set(1, [frame('https://x.com/', true)]);
  await register.sync();
  stored.siteRules = { 'x.com': { enabled: false } };
  await register.sync();
  // y.com loads now and gets the files from the registration, which still covers it; then it is switched off too.
  scripting.has.set(2, [frame('https://y.com/', true, { born: Date.now() + 1 })]);
  await new Promise((r) => setTimeout(r, 5));
  stored.siteRules = { 'x.com': { enabled: false }, 'y.com': { enabled: false } };
  await register.sync();
  await quiet(register, timers);
  assert.deepEqual(scripting.retired, [{ tabId: 1, frames: [0] }, { tabId: 2, frames: [0] }]);
});

test('a site switched off and on again within the quiet time keeps its gate', async () => {
  const tabs = [tab(1, 'https://a.com/')];
  const { scripting, stored, register, timers } = setup({ tabs });
  scripting.has.set(1, [frame('https://a.com/', true)]);
  await register.sync();
  stored.siteRules = { 'a.com': { enabled: false } };
  await register.sync();
  stored.siteRules = {};
  await register.sync();
  await quiet(register, timers);
  assert.deepEqual(scripting.retired, []);
});

test('a tab that cannot be probed does not stop the others from being stopped', async () => {
  const tabs = [tab(1, 'https://a.com/'), tab(2, 'https://b.org/')];
  const { scripting, stored, register, timers } = setup({ tabs });
  scripting.has.set(2, [frame('https://b.org/', true)]);
  await register.sync();
  stored.settings = { enabled: false };
  await register.sync();
  await quiet(register, timers);
  assert.deepEqual(scripting.retired, [{ tabId: 2, frames: [0] }]);
});

test('files go into a loading page by document, and only once its top address is the one that began to load', async () => {
  const targets = [];
  let asked = 0;
  const base = fakeScripting();
  const scripting = Object.assign(base, {
    async executeScript(injection) {
      if (injection.func) {
        asked += 1;
        return asked < 3
          ? [{ frameId: 0, documentId: 'old', result: { href: 'https://old.com/', origin: 'https://old.com' } }]
          : [
              { frameId: 0, documentId: 'new', result: { href: 'https://a.com/x#h', origin: 'https://a.com' } },
              { frameId: 1, documentId: 'sub', result: { href: 'about:blank', origin: 'https://a.com' } },
              { frameId: 2, documentId: 'off', result: { href: 'https://off.org/ad', origin: 'https://off.org' } },
            ];
      }
      targets.push([injection.target, injection.world]);
      return [];
    },
  });
  const register = createRegister({ scripting, tabs: { query: async () => [] }, read: async () => ({ settings: { enabled: true }, siteRules: { 'off.org': { enabled: false } } }), schedule: (fn) => fn() });
  assert.equal(await register.injectLoading(3, 'https://a.com/x'), true);
  assert.equal(asked, 3, 'the page being left is not touched');
  assert.deepEqual(targets, [[{ tabId: 3, documentIds: ['new', 'sub'] }, 'MAIN'], [{ tabId: 3, documentIds: ['new', 'sub'] }, 'ISOLATED']], 'the frame of the site that is off gets nothing');
  // A page that never shows the address is not injected, and the answer is no.
  asked = -100;
  targets.length = 0;
  assert.equal(await register.injectLoading(3, 'https://never.com/'), false);
  assert.deepEqual(targets, []);
});
