import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoading, quietStatus, tabReports } from '../../extension/background/modules/loading.js';
import { covers, planFor } from '../../extension/background/modules/register.js';
import { siteEnabled } from '../../extension/shared/match.js';

test('the status of a page that gets no script comes from the settings', () => {
  const q = (s, r, u) => quietStatus(s, r, u, siteEnabled);
  assert.equal(q({ enabled: false }, {}, 'https://a.com/'), 'off');
  assert.equal(q({ enabled: true }, { 'a.com': { enabled: false } }, 'https://www.a.com/x'), 'site-off');
  assert.equal(q({ enabled: true, listMode: 'onlyListed' }, {}, 'https://a.com/'), 'site-off');
  assert.equal(q({ enabled: true }, {}, 'https://a.com/'), null);
  for (const u of ['chrome://extensions/', 'about:blank', undefined, 7]) assert.equal(q({ enabled: false }, {}, u), null);
});

/** The worker's registration, as the loading code sees it. `known: false` is a worker whose first pass has not worked yet. */
function make({ settings = { enabled: true }, siteRules = {}, failed = false, known = true, injects = true }) {
  const shown = [];
  const injected = [];
  const plan = planFor(settings, siteRules);
  const loading = createLoading({
    register: { settled: async () => {}, plan: known ? plan : undefined, failed, covers: (address) => covers(plan, address), injectLoading: async (id) => (injected.push(id), injects) },
    read: async () => ({ settings, siteRules }),
    siteEnabled,
    setStatus: async (id, status) => shown.push(['status', id, status]),
    clearStatus: async (id) => shown.push(['clear', id]),
    icon: { apply: async (id, status) => shown.push(['icon', id, status]) },
  });
  return { loading, shown, injected };
}

test('a page the scripts do not cover gets its status and icon from the worker', async () => {
  const off = make({ settings: { enabled: false } });
  await off.loading.started(4, 'https://a.com/');
  assert.deepEqual(off.shown, [['status', 4, 'off'], ['icon', 4, 'off']]);
  const rule = make({ siteRules: { 'a.com': { enabled: false } } });
  await rule.loading.started(5, 'https://a.com/');
  assert.deepEqual(rule.shown.map((x) => x[2]), ['site-off', 'site-off']);
});

test('a page the scripts cover is left to the page, and the status of the page before is cleared', async () => {
  const on = make({});
  await on.loading.started(1, 'https://a.com/');
  assert.deepEqual(on.shown, [['clear', 1]]);
  assert.deepEqual(on.injected, []);
});

test('nothing is said before the first registration has worked', async () => {
  const unknown = make({ settings: { enabled: false }, known: false });
  await unknown.loading.started(1, 'https://a.com/');
  assert.deepEqual(unknown.shown, []);
});

test('a refused registration: the files go into the loading page, and a failure of that is shown', async () => {
  const ok = make({ failed: true, known: false });
  await ok.loading.started(8, 'https://a.com/');
  assert.deepEqual(ok.injected, [8]);
  assert.deepEqual(ok.shown, []);
  const bad = make({ failed: true, known: false, injects: false });
  await bad.loading.started(9, 'https://a.com/');
  assert.deepEqual(bad.shown.map((x) => x[2]), ['start-failed', 'start-failed']);
  // A site that is off needs no files and no alarm.
  const quiet = make({ failed: true, known: false, siteRules: { 'a.com': { enabled: false } }, injects: false });
  await quiet.loading.started(10, 'https://a.com/');
  assert.deepEqual(quiet.injected, []);
  assert.deepEqual(quiet.shown.map((x) => x[2]), ['site-off', 'site-off']);
});

test('addresses without a site are ignored', async () => {
  const x = make({ settings: { enabled: false } });
  await x.loading.started(1, 'chrome://extensions/');
  await x.loading.started(1, undefined);
  assert.deepEqual(x.shown, []);
});

test('a status the new page reported while the worker waited is not cleared by the start of its own load', async () => {
  const plan = planFor({ enabled: true }, {});
  const shown = [];
  let settle;
  const loading = createLoading({
    register: { settled: () => new Promise((r) => (settle = r)), plan, failed: false, covers: (address) => covers(plan, address), injectLoading: async () => true },
    read: async () => ({ settings: { enabled: true }, siteRules: {} }),
    siteEnabled,
    setStatus: async (id, status) => shown.push(['status', id, status]),
    clearStatus: async (id) => shown.push(['clear', id]),
    icon: { apply: async () => {} },
  });
  const started = loading.started(31, 'https://a.com/page#top');
  // The page is quick: its report arrives before the worker has settled.
  assert.equal(tabReports.accept(31, Date.now(), 'https://a.com/page'), true);
  settle();
  await started;
  assert.deepEqual(shown, [], 'the fresh status stays');
  // The next page in the tab has not reported yet: the status of the page before is cleared.
  const next = loading.started(31, 'https://a.com/other');
  settle();
  await next;
  assert.deepEqual(shown, [['clear', 31]]);
});

test('the shared clock drops an older report and one the page before sent before the tab moved on', () => {
  const t = 32;
  assert.equal(tabReports.accept(t, 100, 'https://a.com/'), true);
  assert.equal(tabReports.accept(t, 90, 'https://a.com/'), false, 'older than the newest report');
  tabReports.navigated(t, 'https://b.com/');
  // A late report of the page before does not count as the new page's.
  assert.equal(tabReports.accept(t, 150, 'https://a.com/'), true);
  assert.equal(tabReports.reportedBy(t, 'https://b.com/'), false);
  assert.equal(tabReports.accept(t, 160, 'https://b.com/?tab=1#x'), true, 'the new page, after it changed its query');
  assert.equal(tabReports.reportedBy(t, 'https://b.com/'), true);
  tabReports.forget(t);
  assert.equal(tabReports.reportedBy(t, 'https://b.com/'), false);
});

test('a report that came after the worker heard of the navigation keeps the status, also from a page that moved to another path', async () => {
  const plan = planFor({ enabled: true }, {});
  const shown = [];
  let settle;
  const loading = createLoading({
    register: { settled: () => new Promise((r) => (settle = r)), plan, failed: false, covers: (address) => covers(plan, address), injectLoading: async () => true },
    read: async () => ({ settings: { enabled: true }, siteRules: {} }),
    siteEnabled,
    setStatus: async () => {},
    clearStatus: async (id) => shown.push(['clear', id]),
    icon: { apply: async () => {} },
  });
  const started = loading.started(33, 'https://a.com/start');
  // A client-side redirect changed the path before the page reported.
  assert.equal(tabReports.accept(33, Date.now() + 5, 'https://a.com/home'), true);
  settle();
  await started;
  assert.deepEqual(shown, []);
});

test('a redirected page that reported before the worker heard of the load keeps its status; a page that never reports does not inherit one', () => {
  const t = 34;
  tabReports.accept(t, 100, 'https://search.example/');
  // The new page (after a redirect) reports before the worker handles the start of the load of the first address.
  tabReports.accept(t, 200, 'https://www.a.com/');
  tabReports.navigated(t, 'http://a.com/');
  assert.equal(tabReports.reportedBy(t, 'http://a.com/'), false, 'by address alone this cannot be told; the status is cleared and the page is not known');
  // The usual order: the start of the load first, then the redirected page reports.
  tabReports.navigated(t, 'http://b.com/');
  tabReports.accept(t, 300, 'https://www.b.com/');
  assert.equal(tabReports.reportedBy(t, 'http://b.com/'), true);
  // The next load is a file that never reports; the page before is still alive and reports late.
  tabReports.navigated(t, 'https://www.b.com/file.pdf');
  tabReports.accept(t, 400, 'https://www.b.com/');
  assert.equal(tabReports.reportedBy(t, 'https://www.b.com/file.pdf'), false);
});
