import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEarly, planFor } from '../../extension/background/modules/early.js';
import { covers, planFor as enginePlan } from '../../extension/background/modules/register.js';

const base = { enabled: true, listMode: 'allExcept', holdPaint: true, automation: { mode: 'none' }, theme: { mode: 'dark' } };
const listed = { ...base, listMode: 'onlyListed' };

test('only listed: a rule with a port, a path or a wildcard gives no hold, the gate decides', () => {
  assert.equal(planFor(listed, { 'localhost:3000': { enabled: true } }), null);
  assert.equal(planFor(listed, { 'www.a.com/admin': { enabled: true } }), null);
  assert.equal(planFor(listed, { '*.www.a.com': { enabled: true } }), null);
  const plan = planFor(listed, { 'a.com': { enabled: true }, 'localhost:3000': { enabled: true } });
  assert.deepEqual(plan.matches, ['*://*.a.com/*']);
});

test('only listed: a bare host with a more specific rule below it gives no hold', () => {
  assert.equal(planFor(listed, { 'a.com': { enabled: true }, 'x.a.com': { enabled: false } }), null);
  assert.deepEqual(planFor(listed, { 'a.com': { enabled: true }, 'x.a.com': { enabled: true } }).matches, ['*://*.a.com/*', '*://*.x.a.com/*']);
});

test('all except: a host with an off rule of any shape is left out of the hold whole', () => {
  const plan = planFor(base, { 'a.com:8080': { enabled: false }, 'b.org/admin': { enabled: false }, '*.c.net': { enabled: false } });
  assert.deepEqual(plan.excludeMatches, ['*://*.a.com/*', '*://*.b.org/*', '*://*.c.net/*']);
});

test('over the cap there is no hold at all, and the number counts hosts, not patterns', () => {
  const rules = {};
  for (let i = 0; i < 400; i++) rules[`h${i}.com`] = { enabled: false };
  assert.equal(planFor(base, rules).excludeMatches.length, 400, 'one pattern for each host');
  for (let i = 0; i < 400; i++) rules[`g${i}.com`] = { enabled: false };
  assert.equal(planFor(base, rules), null);
});

test('the hold is never wider than the engine registration', () => {
  const rules = { 'a.com': { enabled: false }, 'www.a.com': { enabled: true }, 'b.com:81': { enabled: false }, 'c.com': { enabled: false } };
  for (const settings of [base, listed]) {
    const hold = planFor(settings, rules);
    const engine = enginePlan(settings, rules);
    if (!hold) continue;
    assert.ok(engine);
    for (const host of ['a.com', 'www.a.com', 'b.com', 'c.com', 'x.c.com', 'd.org']) {
      const url = `https://${host}/`;
      const held = covers({ matches: hold.matches.map((m) => (m === 'http://*/*' || m === 'https://*/*' ? '<all_urls>' : m)), excludeMatches: hold.excludeMatches }, url);
      if (held) assert.ok(covers(engine, url), `${host} is held without an engine`);
    }
  }
});

/** A fake `scripting` that holds the registered scripts and counts the calls. */
function fake({ failures = 0 } = {}) {
  const scripts = new Map();
  const calls = [];
  let fail = failures;
  return {
    calls,
    scripts,
    async getRegisteredContentScripts(f) {
      return [...scripts.values()].filter((s) => !f?.ids || f.ids.includes(s.id)).map((s) => structuredClone(s));
    },
    async registerContentScripts(list) {
      calls.push(['register', list.map((s) => s.id)]);
      if (fail > 0) {
        fail -= 1;
        throw new Error('busy');
      }
      for (const s of list) scripts.set(s.id, structuredClone(s));
    },
    async updateContentScripts(list) {
      calls.push(['update', list.map((s) => s.id)]);
      for (const s of list) scripts.set(s.id, { ...scripts.get(s.id), ...structuredClone(s) });
    },
    async unregisterContentScripts(f) {
      calls.push(['unregister', f.ids]);
      for (const id of f.ids) scripts.delete(id);
    },
  };
}

test('a worker that starts again changes nothing that is already registered (no gap, no flash)', async () => {
  const scripting = fake();
  const a = createEarly({ scripting });
  await a.refresh(base, {});
  assert.deepEqual(scripting.calls, [['register', ['dk-early', 'dk-early-respect']]]);
  scripting.calls.length = 0;
  const cold = createEarly({ scripting });
  await cold.refresh(base, {});
  assert.deepEqual(scripting.calls, [], 'the browser holds the same plan: no unregister, no register');
});

test('a change updates in place; leaving the mode removes the scripts', async () => {
  const scripting = fake();
  const early = createEarly({ scripting });
  await early.refresh(base, {});
  scripting.calls.length = 0;
  await early.refresh(base, { 'x.com': { enabled: false } });
  assert.deepEqual(scripting.calls, [['update', ['dk-early', 'dk-early-respect']]]);
  assert.deepEqual(scripting.scripts.get('dk-early').excludeMatches, ['*://*.x.com/*']);
  scripting.calls.length = 0;
  await early.refresh({ ...base, respectOnlyLight: false }, { 'x.com': { enabled: false } });
  assert.deepEqual(scripting.calls, [['unregister', ['dk-early-respect']]]);
  await early.refresh({ ...base, theme: { mode: 'light' } }, {});
  assert.equal(scripting.scripts.size, 0);
});

test('a refused registration is tried again after a wait', async () => {
  const scripting = fake({ failures: 1 });
  const timers = [];
  const early = createEarly({ scripting, schedule: (fn, ms) => (timers.push({ fn, ms }), timers.length), warn: () => {} });
  await early.refresh(base, {});
  assert.equal(scripting.scripts.size, 0);
  assert.equal(timers.length, 1);
  timers[0].fn();
  await early.refresh(base, {});
  assert.equal(scripting.scripts.size, 2);
});
