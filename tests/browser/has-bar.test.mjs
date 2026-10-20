// A bar that moves through inline styles, deep inside an application box whose sheets hold `:has()` rules, restyles only the bar
// when the Dynamic engine has inserted its copies: the style work of one frame is not spread over the ancestors.
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

const median = (list) => list.slice().sort((a, b) => a - b)[list.length >> 1];

/** The number of elements each style recalculation touched during `ms` of frames. */
async function recalcSizes(enabled, ms) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled, theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  const cdp = await browser.context.newCDPSession(page);
  await page.goto(`${servers.origin}/has-bar.html`);
  if (enabled) await waitState(page, 'ready', 30000 * SLOW);
  // The sweeps that follow the load (pictures, the net) restyle the page a few times; the steady state is measured.
  await page.waitForTimeout(4500 * SLOW);
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline'] }, transferMode: 'ReportEvents' });
  await page.waitForTimeout(ms);
  const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  await done;
  await page.close();
  return events.filter((e) => e.name === 'UpdateLayoutTree' && e.ph === 'X').map((e) => e.args?.elementCount ?? 0);
}

test('the moving bar restyles as few elements per frame with the engine as without it', { timeout: 120000 * SLOW }, async () => {
  const off = await recalcSizes(false, 2000);
  const on = await recalcSizes(true, 2000);
  assert.ok(off.length > 10 && on.length > 10, `${off.length} and ${on.length} recalculations`);
  assert.ok(median(on) <= median(off) + 2, `median ${median(on)} elements with the engine, ${median(off)} without`);
  assert.ok(on.filter((n) => n > 11).length <= 3, 'at most a few larger recalculations in the steady state');
});
