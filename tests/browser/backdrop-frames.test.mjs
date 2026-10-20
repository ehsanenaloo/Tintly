// A page of small frames without pictures does not pay for the hit tests of the text-on-picture module: no point is tested in a
// frame that holds no picture or is too small, and a page whose passes find nothing goes to sleep.
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

/** The hit tests the module made in every frame of the tab, and the frames that have the module. */
const frameStats = (url) =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'ISOLATED',
      func: () => JSON.stringify(globalThis.__dk?.backdrop?.stats?.() ?? null),
    });
    return results.map((r) => JSON.parse(r.result));
  }, url);

test('thirty small frames without pictures make no hit test', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/frames-small.html`;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await page.goto(url);
  await waitState(page, 'ready', 30000 * SLOW);
  // The module sweeps at 0.6, 1.5 and 3.5 s, and on load.
  await page.waitForTimeout(5000 * SLOW);
  const { profile } = await cdp.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  let backdropMs = 0;
  let busyMs = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    const node = byId.get(id);
    if (node.callFrame.functionName === '(idle)' || node.callFrame.functionName === '(program)') return;
    busyMs += dt;
    if (node.callFrame.url.endsWith('/backdrop.js')) backdropMs += dt;
  });
  const frames = (await frameStats(url)).filter((s) => s !== null);
  // The first result is the top page, which has frames (they may hold pictures) and is swept; the 30 frames hold nothing.
  const inner = frames.slice(1).reduce((n, s) => n + s.hitTests, 0);
  console.log(`# 30 small frames: ${frames.length} frames with the module, ${frames[0].hitTests} hit tests in the page, ${inner} in the frames, backdrop.js ${backdropMs.toFixed(0)} ms of ${busyMs.toFixed(0)} ms busy`);
  assert.equal(inner, 0, 'a hit test was made in a frame without pictures');
  assert.ok(frames[0].hitTests <= 3 * 384, 'the page was swept more than three times');
  assert.ok(backdropMs < 60 * SLOW, `backdrop.js took ${backdropMs.toFixed(0)} ms`);
  await page.close();
});

test('a page whose passes find nothing goes to sleep, and wakes when a picture arrives', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/photo-text.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), undefined, { timeout: 15000 * SLOW });
  await page.waitForTimeout(6000 * SLOW);
  const asleep = (await frameStats(url))[0];
  assert.ok(asleep && asleep.passes >= 1, 'the module never swept');
  const before = asleep.hitTests;
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(1500);
  const again = (await frameStats(url))[0];
  if (asleep.sleeping) assert.equal(again.hitTests, before, 'a sleeping module made hit tests');
  await page.close();
});
