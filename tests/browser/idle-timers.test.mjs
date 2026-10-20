// P-17: a themed page that nobody touches runs no timer of ours: no interval, and no timer that fires again and again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

let servers;
let browser;
before(async () => {
  servers = await startServers();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

/** The timers that fired in a quiet window of `ms`, by timer id. */
async function quietTimers(page, ms) {
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline'] }, transferMode: 'ReportEvents' });
  await page.waitForTimeout(ms);
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  const fires = new Map();
  for (const e of events) if (e.name === 'TimerFire') fires.set(e.args?.data?.timerId, (fires.get(e.args?.data?.timerId) ?? 0) + 1);
  return fires;
}

for (const path of ['dynamic.html', 'shadow-many.html#5', 'photo-text.html']) {
  test(`an idle themed page has no repeating timer (${path})`, { timeout: 120000 * SLOW }, async () => {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true } });
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/${path}`);
    await waitState(page, 'ready', 30000 * SLOW);
    // Let the passes of the first seconds finish.
    await page.waitForTimeout(8000 * SLOW);
    const fires = await quietTimers(page, 8000);
    const repeating = [...fires.entries()].filter(([, n]) => n > 1);
    console.log(`# ${path}: ${[...fires.values()].reduce((a, b) => a + b, 0)} timer fires in 8 s, ${repeating.length} repeating`);
    assert.deepEqual(repeating, [], 'a timer fired again and again');
    await page.close();
  });
}
