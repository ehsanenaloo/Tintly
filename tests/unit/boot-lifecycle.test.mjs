// The gate's decision sequence: the first-load hold, the data a decision keeps, a schedule that cannot be judged, hidden tabs,
// pages back from the back-forward cache and prerendered pages, and the root style watch. The real boot.js runs against stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootRig } from '../helpers/boot-rig.mjs';

test('a settings change during the first read keeps the first-paint hold for the decision that lands', async () => {
  const r = bootRig({ settings: { theme: { mode: 'dark' } } });
  r.hold();
  r.run();
  await r.flush();
  // A sync pull or a popup slider writes while the first read waits.
  r.write({ settings: { theme: { mode: 'dark', contrast: 1.1 } } });
  await r.flush();
  r.open();
  await r.flush();
  assert.equal(r.starts.length, 1, 'only the newest decision starts the engine');
  assert.equal(r.starts[0].theme.contrast, 1.1);
  assert.equal(r.starts[0].opts.early, true, 'the landing decision is the first load');
  assert.equal(r.starts[0].opts.hold, true, 'the page stays held until it is themed');
  assert.ok(!r.log.includes('release'), 'the page is not released before it is themed');
});

test('the first load ends with the decision that lands: a later change is not a first load', async () => {
  const r = bootRig({ settings: { theme: { mode: 'dark' } } });
  r.run();
  await r.flush();
  assert.equal(r.starts[0].opts.hold, true);
  r.write({ settings: { theme: { mode: 'dark', contrast: 1.2 } } });
  await r.flush();
  assert.equal(r.starts.length, 2);
  assert.equal(r.starts[1].opts.early, false);
  assert.equal(r.starts[1].opts.hold, false);
});

test('a read that a change overtook is not kept: a deferred change in a hidden tab survives an older decision', async () => {
  const r = bootRig({ settings: { theme: { mode: 'dark' } }, readyState: 'complete' });
  r.run();
  await r.flush();
  assert.equal(r.starts.length, 1);
  // A change while the tab is shown: its read is held.
  r.hold();
  r.write({ settings: { theme: { mode: 'dark', contrast: 1.1 } } });
  await r.flush();
  // The read of the slice ends; the read of the whole data is on its way with the data of this moment.
  r.step();
  await r.flush();
  // The tab is hidden and a second change comes; it waits for the tab to be shown.
  r.show('hidden');
  r.write({ settings: { theme: { mode: 'light' } } });
  await r.flush();
  r.open();
  await r.flush();
  r.show('visible');
  await r.advance(1000);
  assert.equal(r.starts.at(-1).theme.mode, 'light', 'the shown tab has the newest settings');
});

test('a schedule whose module cannot be loaded leaves the page as written and says so', async () => {
  const automation = { mode: 'time', behavior: 'onOff', time: { from: '20:00', to: '07:00' } };
  const r = bootRig({ settings: { automation }, need: async (name) => name !== 'schedule' });
  r.run();
  await r.flush();
  assert.equal(r.starts.length, 0, 'not themed while the hours cannot be judged');
  assert.ok(r.log.includes('clear'), 'the hold leaves and no mark of ours stays');
  assert.deepEqual(r.statuses(), ['pending']);
  r.giveUp('schedule');
  await r.flush();
  assert.deepEqual(r.statuses(), ['pending', 'start-failed']);
});

test('a schedule that only switches the scheme keeps the page themed while its module is missing', async () => {
  const automation = { mode: 'time', behavior: 'scheme', time: { from: '20:00', to: '07:00' } };
  const r = bootRig({ settings: { automation }, need: async (name) => name !== 'schedule' });
  r.run();
  await r.flush();
  assert.equal(r.starts.length, 1);
  assert.deepEqual(r.statuses(), ['pending']);
});

test('a schedule boundary in a hidden tab waits until the tab is shown', async () => {
  let active = true;
  const schedule = { evaluate: (_a, now) => ({ active, behavior: 'onOff', next: now.getTime() + 5000 }) };
  const r = bootRig({ settings: { automation: { mode: 'time' } }, schedule, readyState: 'complete' });
  r.run();
  await r.flush();
  assert.equal(r.starts.length, 1);
  r.show('hidden');
  active = false;
  const stops = r.log.filter((x) => x === 'dynamic.stop').length;
  await r.advance(6000);
  assert.equal(r.log.filter((x) => x === 'dynamic.stop').length, stops, 'nothing runs in the hidden tab');
  r.show('visible');
  await r.flush();
  assert.ok(r.log.filter((x) => x === 'dynamic.stop').length > stops, 'the boundary is taken when the tab is shown');
});

test('a hidden page that was open before the build came decides after a spread wait, not at once', async () => {
  const r = bootRig({ settings: {}, readyState: 'complete', visibility: 'hidden', random: 0.5 });
  r.run();
  await r.flush();
  assert.equal(r.starts.length, 0);
  assert.equal(r.reads.length, 0, 'not even the read');
  await r.advance(3999);
  assert.equal(r.starts.length, 0);
  await r.advance(1);
  assert.equal(r.starts.length, 1);
});

test('a hidden page that was open before decides at once when it is shown, and a change meanwhile does not start it early', async () => {
  const r = bootRig({ settings: {}, readyState: 'complete', visibility: 'hidden', random: 0.99 });
  r.run();
  await r.flush();
  r.write({ settings: { theme: { contrast: 1.1 } } });
  await r.flush();
  assert.equal(r.starts.length, 0);
  r.show('visible');
  await r.flush();
  assert.equal(r.starts.length, 1);
  assert.equal(r.starts[0].theme.contrast, 1.1);
  await r.advance(20000);
  assert.equal(r.starts.length, 1, 'the spread timer does not run a second decision');
});

test('a hidden page that showed the look of the build this one replaced decides at once', async () => {
  const r = bootRig({ settings: {}, readyState: 'complete', visibility: 'hidden' });
  r.dk.replaced = true;
  r.run();
  await r.flush();
  assert.equal(r.starts.length, 1);
});

test('a frame the page made after its load (complete at once, young clock) decides at once in a hidden tab', async () => {
  const r = bootRig({ settings: {}, readyState: 'complete', visibility: 'hidden', startedAt: 40 });
  r.run();
  await r.flush();
  assert.equal(r.starts.length, 1);
});

test('a superseded decision that fails does not tear down the newer one', async () => {
  const r = bootRig({ settings: { theme: { mode: 'dark' } }, readyState: 'complete' });
  r.run();
  await r.flush();
  r.hold();
  // The older read fails, after a newer decision began.
  r.data.__fail = true;
  r.write({ settings: { theme: { mode: 'dark', contrast: 1.1 } } });
  await r.flush();
  delete r.data.__fail;
  r.write({ settings: { theme: { mode: 'dark', contrast: 1.2 } } });
  await r.flush();
  r.open();
  await r.flush();
  assert.equal(r.starts.at(-1).theme.contrast, 1.2);
  assert.ok(!r.log.includes('clear'), 'the page is not left by the older failure');
});

test('a site that a rule turns off says site-off while the schedule module is missing', async () => {
  const automation = { mode: 'time', behavior: 'onOff', time: { from: '20:00', to: '07:00' } };
  const r = bootRig({ settings: { automation, listMode: 'onlyListed' }, need: async (name) => name !== 'schedule' });
  r.run();
  await r.flush();
  assert.deepEqual(r.statuses(), ['site-off']);
});

test('a hidden page that is loading decides at once, so its first paint is held', async () => {
  const r = bootRig({ settings: {}, readyState: 'loading', visibility: 'hidden' });
  r.run();
  await r.flush();
  assert.equal(r.starts.length, 1);
  assert.equal(r.starts[0].opts.hold, true);
});

test('a page back from the back-forward cache says its status again and reads the data again', async () => {
  const r = bootRig({ settings: {} });
  r.run();
  await r.flush();
  assert.deepEqual(r.statuses(), ['on']);
  const reads = r.reads.length;
  r.fireWindow('pageshow', { persisted: false });
  await r.flush();
  assert.deepEqual(r.statuses(), ['on']);
  r.fireWindow('pageshow', { persisted: true });
  await r.flush();
  assert.deepEqual(r.statuses(), ['on', 'on']);
  assert.ok(r.reads.length > reads, 'the data is read again');
});

test('a prerendered page reports only once it is shown in the tab', async () => {
  const r = bootRig({ settings: {}, prerendering: true });
  r.run();
  await r.flush();
  assert.equal(r.starts.length, 1, 'the page is themed while it is prerendered');
  assert.deepEqual(r.statuses(), []);
  r.doc.prerendering = false;
  r.fireDocument('prerenderingchange');
  await r.flush();
  assert.deepEqual(r.statuses(), ['on']);
});

test('a page that writes its root style often is not looked at again while its color-scheme stays', async () => {
  const r = bootRig({ settings: {}, readyState: 'complete' });
  r.run();
  await r.flush();
  const watch = r.observers.at(-1);
  const before = r.headQueries();
  for (let i = 0; i < 50; i++) watch.fn([{ type: 'attributes', attributeName: 'style' }]);
  assert.equal(r.headQueries(), before, 'no query for writes that leave the color-scheme alone');
  r.setRootScheme('only light');
  const reads = r.reads.length;
  watch.fn([{ type: 'attributes', attributeName: 'style' }]);
  await r.flush();
  assert.ok(r.reads.length > reads || r.starts.length > 1 || r.log.includes('release'), 'a new color-scheme is decided again');
  const after = r.headQueries();
  watch.fn([{ type: 'attributes', attributeName: 'data-tintly' }]);
  assert.ok(r.headQueries() > after, 'other changes are looked at');
});

test('a retired gate ends the loader tries and its timers', async () => {
  const r = bootRig({ settings: {}, readyState: 'complete', visibility: 'hidden' });
  r.run();
  await r.flush();
  r.dk.retire();
  await r.advance(20000);
  assert.equal(r.starts.length, 0, 'the first decision that waited does not run');
  assert.ok(r.log.includes('optional.stop'));
});

test('a retired gate leaves no listener on the page', async () => {
  const r = bootRig({ settings: {}, readyState: 'complete' });
  r.run();
  await r.flush();
  r.dk.retire();
  const before = r.starts.length;
  r.fireWindow('pageshow', { persisted: true });
  r.show('hidden');
  r.show('visible');
  r.fireWindow('popstate', {});
  await r.advance(5000);
  assert.equal(r.starts.length, before);
  assert.equal(r.statuses().length, 1, 'nothing is said after the retire');
});

test('a frame with what a dead build left is cleaned before the first decision, and a change meanwhile waits for it', async () => {
  let release;
  const order = [];
  const r = bootRig({
    settings: { theme: { mode: 'dark' } },
    readyState: 'complete',
    need: async (name) => {
      if (name !== 'leftovers') return true;
      await new Promise((resolve) => (release = resolve));
      r.dk.leftovers = { sweep: () => order.push('sweep') };
      return true;
    },
  });
  r.dk.replaced = true;
  r.dk.leftover = true;
  const start = r.dk.dynamic.start;
  r.dk.dynamic.start = (theme, opts) => {
    order.push('start');
    start(theme, opts);
  };
  r.run();
  await r.flush();
  r.write({ settings: { theme: { mode: 'dark', contrast: 1.1 } } });
  await r.flush();
  assert.deepEqual(order, [], 'no decision runs while the frame is not clean');
  release();
  await r.flush();
  assert.deepEqual(order, ['sweep', 'start']);
  assert.equal(r.starts[0].theme.contrast, 1.1);
});

test('a frame whose cleaning module cannot come is still decided', async () => {
  const r = bootRig({ settings: { theme: { mode: 'dark' } }, readyState: 'complete', need: async (name) => name !== 'leftovers' });
  r.dk.leftover = true;
  r.run();
  await r.flush();
  assert.equal(r.starts.length, 1);
});
