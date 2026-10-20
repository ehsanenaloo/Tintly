// The alarms of the schedule: the plan at the boundaries, the alarms against a fake API, and the registration that follows them.
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const modules = (name) => import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', name)).href);
const { outlook, usesClock, createAlarms, NEXT, CHECK, LEAD_MS, SETTLE_MS, CHECK_MINUTES } = await modules('alarms.js');
const { planFor, createRegister, IDS } = await modules('register.js');
const { quietStatus, createLoading } = await modules('loading.js');

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const HOURS = { mode: 'time', behavior: 'onOff', time: { from: '22:00', to: '06:00' } };

/* ----- the plan at the boundaries ----- */

test('only hours and sun times that switch Tintly on and off can take the engine away', () => {
  assert.equal(usesClock(HOURS), true);
  assert.equal(usesClock({ mode: 'location', behavior: 'onOff', location: { lat: 1, lon: 2 } }), true);
  assert.equal(usesClock({ ...HOURS, behavior: 'scheme' }), false, 'the scheme behavior keeps Tintly on');
  assert.equal(usesClock({ mode: 'system', behavior: 'onOff' }), false, 'the system scheme is known to the page only');
  assert.equal(usesClock({ mode: 'none' }), false);
  assert.equal(usesClock(undefined), false);
});

test('hours across midnight: idle by day, back one minute before the start, gone just after the end', () => {
  const day = (h, mi = 0, s = 0) => at(2026, 5, 20, h, mi, s);
  assert.deepEqual(outlook(HOURS, day(12)), { idle: true, at: day(21, 59) });
  assert.deepEqual(outlook(HOURS, day(21, 58, 59)), { idle: true, at: day(21, 59) });
  // From the lead on, the registration is back; the gate keeps the page off until the start.
  assert.deepEqual(outlook(HOURS, day(21, 59)), { idle: false, at: day(22, 0, 0) + SETTLE_MS });
  assert.deepEqual(outlook(HOURS, day(21, 59, 59)), { idle: false, at: day(22, 0, 0) + SETTLE_MS });
  assert.deepEqual(outlook(HOURS, day(22, 0, 1)), { idle: false, at: at(2026, 5, 21, 6, 0, 0) + SETTLE_MS });
  assert.deepEqual(outlook(HOURS, at(2026, 5, 21, 5, 59, 59)), { idle: false, at: at(2026, 5, 21, 6, 0, 0) + SETTLE_MS });
  // The exact end: the window is over, the next start is far away.
  assert.deepEqual(outlook(HOURS, at(2026, 5, 21, 6, 0, 0)), { idle: true, at: at(2026, 5, 21, 21, 59) });
});

test('a schedule that cannot narrow, or has nothing to follow, never says idle', () => {
  for (const automation of [undefined, { mode: 'none' }, { ...HOURS, behavior: 'scheme' }, { mode: 'system', behavior: 'onOff' }, { mode: 'location', behavior: 'onOff' }]) {
    assert.deepEqual(outlook(automation, at(2026, 5, 20, 12)), { idle: false, at: null });
  }
});

test('hours with a bad time or an empty window are off for good', () => {
  assert.deepEqual(outlook({ mode: 'time', behavior: 'onOff', time: { from: '25:00', to: '06:00' } }, at(2026, 5, 20, 12)), { idle: true, at: null });
  const empty = outlook({ mode: 'time', behavior: 'onOff', time: { from: '08:00', to: '08:00' } }, at(2026, 5, 20, 12));
  assert.equal(empty.idle, true);
});

test('the day the clocks go forward: a start inside the gap is the first minute after it', () => {
  // 2026-03-08, New York: 02:00 becomes 03:00, so 02:30 does not exist and the browser's calendar puts it at 03:30.
  const automation = { mode: 'time', behavior: 'onOff', time: { from: '02:30', to: '05:00' } };
  const start = new Date(2026, 2, 8, 2, 30).getTime();
  assert.equal(new Date(start).getHours(), 3);
  const answer = outlook(automation, at(2026, 3, 8, 0, 10));
  assert.deepEqual(answer, { idle: true, at: start - LEAD_MS });
  assert.ok(answer.at > at(2026, 3, 8, 0, 10));
});

test('the day the clocks go back: the end and the next start follow the local clock, not 24 hours', () => {
  // 2026-11-01, New York: 02:00 EDT becomes 01:00 EST, the day has 25 hours.
  const night = { mode: 'time', behavior: 'onOff', time: { from: '20:00', to: '07:00' } };
  assert.deepEqual(outlook(night, at(2026, 11, 1, 3, 0)), { idle: false, at: at(2026, 11, 1, 7, 0) + SETTLE_MS });
  assert.deepEqual(outlook(night, at(2026, 11, 1, 8, 0)), { idle: true, at: at(2026, 11, 1, 19, 59) });
  // The window from 20:00 to 07:00 lasts 12 hours on that night, not 11.
  assert.equal(at(2026, 11, 1, 7, 0) - at(2026, 10, 31, 20, 0), 12 * 3600_000);
});

test('sun times: idle by day, back one minute before the sunset, active at night (London, June)', () => {
  const place = { mode: 'location', behavior: 'onOff', location: { lat: 51.5, lon: -0.12 } };
  const utc = (d, h, mi) => Date.UTC(2026, 5, d, h, mi);
  const noon = outlook(place, utc(21, 12, 0));
  assert.equal(noon.idle, true);
  // Sunset at 20:21 UTC, within three minutes of the published value.
  assert.ok(Math.abs(noon.at + LEAD_MS - utc(21, 20, 21)) < 3 * 60_000, new Date(noon.at).toISOString());
  assert.equal(outlook(place, utc(21, 21, 30)).idle, false);
  assert.equal(outlook(place, utc(22, 2, 0)).idle, false, 'night');
  const morning = outlook(place, utc(22, 5, 0));
  assert.equal(morning.idle, true);
  assert.ok(morning.at > utc(22, 5, 0));
});

test('sun times at the pole: a polar day is idle and looked at again in hours, a polar night is active', () => {
  const pole = { mode: 'location', behavior: 'onOff', location: { lat: 80, lon: 15 } };
  const june = outlook(pole, Date.UTC(2026, 5, 21, 12));
  assert.equal(june.idle, true);
  assert.ok(june.at - Date.UTC(2026, 5, 21, 12) > 3 * 3600_000);
  assert.equal(outlook(pole, Date.UTC(2026, 11, 21, 12)).idle, false);
});

/* ----- the alarms against a fake API ----- */

function fakeAlarmsApi({ failCreate = false } = {}) {
  const set = new Map();
  const calls = [];
  return {
    calls,
    set,
    async create(name, info) {
      calls.push(['create', name, info]);
      if (failCreate) throw new Error('quota');
      set.set(name, { name, ...info });
    },
    async get(name) {
      calls.push(['get', name]);
      return set.get(name);
    },
    async clear(name) {
      calls.push(['clear', name]);
      return set.delete(name);
    },
  };
}

function setupAlarms({ granted = true, api = fakeAlarmsApi(), time = at(2026, 5, 20, 12) } = {}) {
  const clock = { now: time };
  const permission = { granted };
  const warned = [];
  const alarms = createAlarms({
    api: () => api,
    permissions: { contains: async (d) => (assert.deepEqual(d, { permissions: ['alarms'] }), permission.granted) },
    now: () => clock.now,
    warn: (e) => warned.push(e),
  });
  return { alarms, api, clock, permission, warned };
}
const settings = (automation = HOURS, extra = {}) => ({ enabled: true, automation, ...extra });

test('with the permission, an hours schedule sets the boundary alarm and the safety alarm', async () => {
  const { alarms, api, clock } = setupAlarms();
  assert.equal(await alarms.sync(settings()), true);
  assert.equal(alarms.armed, true);
  assert.equal(api.set.get(NEXT).when, outlook(HOURS, clock.now).at);
  assert.equal(api.set.get(CHECK).periodInMinutes, CHECK_MINUTES);
  assert.equal(api.set.get(CHECK).delayInMinutes, CHECK_MINUTES);
  assert.equal(alarms.idleFor(settings()), true);
});

test('a slider drag writes the settings again: no call to the alarm API', async () => {
  const { alarms, api } = setupAlarms();
  await alarms.sync(settings());
  api.calls.length = 0;
  await alarms.sync(settings(HOURS, { theme: { brightness: 90 } }));
  assert.deepEqual(api.calls, []);
});

test('an alarm that fired or a permission change sets the boundary alarm again and keeps the safety alarm', async () => {
  const { alarms, api, clock } = setupAlarms();
  await alarms.sync(settings());
  api.calls.length = 0;
  clock.now = at(2026, 5, 20, 21, 59, 5);
  await alarms.sync(settings(), true);
  assert.deepEqual(api.calls.map((c) => c.slice(0, 2)), [['create', NEXT], ['get', CHECK]]);
  assert.equal(api.set.get(NEXT).when, at(2026, 5, 20, 22, 0, 0) + SETTLE_MS);
  assert.equal(alarms.idleFor(settings()), false, 'in the lead before the start the engine is wanted');
});

test('a new run of the worker finds the alarms of the browser and sets the boundary alarm without a second safety alarm', async () => {
  const { api, clock } = setupAlarms();
  const first = createAlarms({ api: () => api, permissions: { contains: async () => true }, now: () => clock.now });
  await first.sync(settings());
  api.calls.length = 0;
  const second = createAlarms({ api: () => api, permissions: { contains: async () => true }, now: () => clock.now });
  assert.equal(second.idleFor(settings()), false, 'before the first pass nothing is known, so the engine stays');
  await second.sync(settings());
  assert.deepEqual(api.calls.filter((c) => c[0] === 'create').map((c) => c[1]), [NEXT]);
  assert.equal(second.idleFor(settings()), true);
});

test('without the permission no alarm is made and the engine stays in place', async () => {
  const { alarms, api } = setupAlarms({ granted: false });
  assert.equal(await alarms.sync(settings()), false);
  assert.equal(alarms.armed, false);
  assert.equal(alarms.idleFor(settings()), false);
  assert.equal(api.set.size, 0);
  assert.deepEqual(api.calls.filter((c) => c[0] === 'create'), []);
});

test('without the API at all nothing throws', async () => {
  const alarms = createAlarms({ api: () => undefined, permissions: { contains: async () => true } });
  assert.equal(await alarms.sync(settings()), false);
  assert.equal(alarms.idleFor(settings()), false);
});

test('turning the schedule off, the master switch off or a schedule that cannot narrow removes the alarms', async () => {
  for (const next of [settings({ mode: 'none' }), { enabled: false, automation: HOURS }, settings({ ...HOURS, behavior: 'scheme' }), settings({ mode: 'system', behavior: 'onOff' })]) {
    const { alarms, api } = setupAlarms();
    await alarms.sync(settings());
    assert.equal(api.set.size, 2);
    assert.equal(await alarms.sync(next), false);
    assert.equal(api.set.size, 0, JSON.stringify(next));
    assert.equal(alarms.armed, false);
    assert.equal(alarms.idleFor(next), false);
  }
});

test('a permission that is taken away removes the alarms and the engine comes back', async () => {
  const { alarms, api, permission } = setupAlarms();
  await alarms.sync(settings());
  assert.equal(alarms.idleFor(settings()), true);
  permission.granted = false;
  await alarms.sync(settings(), true);
  assert.equal(api.set.size, 0);
  assert.equal(alarms.idleFor(settings()), false);
});

test('a schedule is changed: the engine is never idle on the word of alarms made for the old one', async () => {
  const { alarms } = setupAlarms();
  await alarms.sync(settings());
  assert.equal(alarms.idleFor(settings({ ...HOURS, time: { from: '10:00', to: '14:00' } })), false);
});

test('an alarm that comes late: when the clock is past the time it was made for, the engine is wanted again', async () => {
  const { alarms, clock } = setupAlarms();
  await alarms.sync(settings());
  assert.equal(alarms.idleFor(settings()), true);
  clock.now = at(2026, 5, 20, 22, 0, 30);
  assert.equal(alarms.idleFor(settings()), false);
});

test('a clock moved far (time zone or system time): the next look at the clock decides, not the old time', async () => {
  const { alarms, clock } = setupAlarms();
  await alarms.sync(settings());
  clock.now = at(2026, 5, 21, 1, 0);
  assert.equal(alarms.idleFor(settings()), false);
  await alarms.sync(settings(), true);
  assert.equal(alarms.idleFor(settings()), false);
});

test('an alarm API that refuses: the engine stays, nothing is idle', async () => {
  const { alarms, warned } = setupAlarms({ api: fakeAlarmsApi({ failCreate: true }) });
  assert.equal(await alarms.sync(settings()), false);
  assert.equal(alarms.idleFor(settings()), false);
  assert.equal(warned.length, 1);
});

/* ----- the registration follows the alarms ----- */

function fakeScripting() {
  const scripts = new Map();
  const injected = [];
  const retired = [];
  return {
    scripts,
    injected,
    retired,
    async getRegisteredContentScripts(filter) {
      return [...scripts.values()].filter((s) => !filter?.ids || filter.ids.includes(s.id)).map((s) => structuredClone(s));
    },
    async registerContentScripts(list) {
      for (const s of list) scripts.set(s.id, structuredClone(s));
    },
    async updateContentScripts(list) {
      for (const s of list) scripts.set(s.id, structuredClone({ ...scripts.get(s.id), ...s }));
    },
    async unregisterContentScripts(filter) {
      for (const id of filter?.ids ?? [...scripts.keys()]) scripts.delete(id);
    },
    async executeScript(injection) {
      if (injection.func?.name === 'retireEngine') return retired.push(injection.target.tabId), [];
      if (injection.func?.name === 'frameAddress') return [{ frameId: 0, result: { href: 'https://example.com/', origin: 'https://example.com' } }];
      if (injection.func) return [{ frameId: 0, result: false }];
      injected.push({ tabId: injection.target.tabId, world: injection.world });
      return [];
    },
  };
}

test('across a day: no script by day, scripts a minute before the start, none after the end; open tabs are filled and let go', async () => {
  const { alarms, clock } = setupAlarms();
  const scripting = fakeScripting();
  const stored = { settings: settings(), siteRules: {} };
  const timers = [];
  const register = createRegister({
    scripting,
    tabs: { query: async () => [{ id: 7, url: 'https://example.com/', active: true }] },
    read: async () => ({ ...stored, idle: alarms.idleFor(stored.settings) }),
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  const pass = async (force) => {
    await alarms.sync(stored.settings, force);
    await register.sync();
  };
  await pass(true);
  assert.equal(scripting.scripts.size, 0, 'noon: the page that is off loads nothing of ours');
  assert.equal(register.idle, true);

  clock.now = at(2026, 5, 20, 21, 59, 5);
  await pass(true);
  assert.deepEqual([...scripting.scripts.keys()].sort(), [IDS.engine, IDS.hook].sort());
  assert.deepEqual(scripting.injected.map((i) => i.tabId), [7, 7], 'the tab that was open gets the files');
  assert.equal(register.idle, false);

  clock.now = at(2026, 5, 21, 6, 0, 3);
  await pass(true);
  assert.equal(scripting.scripts.size, 0, 'after the end the files are gone');
  assert.ok(timers.some((t) => t.ms === 2000), 'the engine of an open tab is let go after a short wait');
});

test('a start after a boundary that no alarm announced: the page that loads decides again', async () => {
  const { alarms, clock } = setupAlarms();
  const stored = { settings: settings(), siteRules: {} };
  const scripting = fakeScripting();
  const register = createRegister({ scripting, tabs: { query: async () => [] }, read: async () => ({ ...stored, idle: alarms.idleFor(stored.settings) }) });
  await alarms.sync(stored.settings);
  await register.sync();
  assert.equal(scripting.scripts.size, 0);
  clock.now = at(2026, 5, 20, 22, 0, 30);
  const status = [];
  let refreshed = 0;
  const loading = createLoading({
    register,
    read: async () => ({ ...stored, idle: alarms.idleFor(stored.settings) }),
    siteEnabled: () => true,
    setStatus: async (tab, s) => status.push(s),
    clearStatus: async () => {},
    icon: { apply() {} },
    stale: async () => alarms.idleFor(stored.settings) !== register.idle,
    refresh: async () => {
      refreshed += 1;
      await alarms.sync(stored.settings, true);
      await register.sync();
    },
  });
  await loading.started(3, 'https://example.com/');
  assert.equal(refreshed, 1);
  assert.equal(scripting.scripts.size, 2, 'the registration is back before the page is judged');
  assert.deepEqual(status, []);
});

test('a page the schedule keeps off is called off, not site-off', () => {
  const siteEnabled = () => false;
  assert.equal(quietStatus({ enabled: true }, {}, 'https://a.com/', siteEnabled, true), 'off');
  assert.equal(quietStatus({ enabled: true }, {}, 'https://a.com/', siteEnabled, false), 'site-off');
  assert.equal(quietStatus({ enabled: true }, {}, 'about:blank', siteEnabled, true), null);
});

test('the plan: idle means nowhere, whatever the rules say', () => {
  assert.equal(planFor({ enabled: true }, {}, true), null);
  assert.deepEqual(planFor({ enabled: true }, {}, false), { matches: ['<all_urls>'], excludeMatches: [] });
  assert.deepEqual(planFor({ enabled: true }, {}), { matches: ['<all_urls>'], excludeMatches: [] });
});
