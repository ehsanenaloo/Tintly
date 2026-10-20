// Paired timing of the popup page for two builds: first paint and end of loading, warm and with a stopped worker, on a light and on a
// busy page. The two builds run in two browsers and alternate run by run, so the load of the machine hits both the same way.
//   DK_A=<unpacked baseline> [DK_B=<unpacked build, default the working tree>] [RUNS=9] [ONLY=light|heavy] [DK_CPU_THROTTLE=4]
//   node --test tests/perf/popup-paired.mjs
import { test } from 'node:test';
import { startServers, launch, waitState, cpuThrottle } from '../browser/harness.mjs';

const RUNS = Number(process.env.RUNS ?? 7);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function stopWorker(browser, probe) {
  const cdp = await browser.context.newCDPSession(probe);
  const status = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', (e) => { for (const v of e.versions) status.set(v.versionId, v.runningStatus); });
  await cdp.send('ServiceWorker.enable');
  await new Promise((r) => setTimeout(r, 100));
  await cdp.send('ServiceWorker.stopAllWorkers');
  let stopped = false;
  for (let i = 0; i < 100 && !stopped; i++) { stopped = status.size > 0 && [...status.values()].every((v) => v === 'stopped'); await new Promise((r) => setTimeout(r, 30)); }
  await cdp.detach();
  return stopped;
}

async function setup(servers, extension, path, busy) {
  const browser = await launch({ extension });
  const id = new URL(browser.worker.url()).host;
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}${path}`);
  await waitState(web, 'ready', 60000).catch(() => {});
  if (busy) await web.evaluate(() => { setInterval(() => { const t = performance.now(); while (performance.now() - t < 60); }, 70); });
  return { browser, id, web };
}

async function once(ctx, cold) {
  const { browser, id, web } = ctx;
  if (cold) {
    const probe = await browser.context.newPage();
    if (!(await stopWorker(browser, probe))) console.log('worker did not stop');
    await probe.close();
  }
  const popup = await browser.context.newPage();
  if (Number(process.env.DK_CPU_THROTTLE) > 1) await cpuThrottle(popup, Number(process.env.DK_CPU_THROTTLE));
  await popup.addInitScript(() => {
    new MutationObserver((_, o) => {
      const b = document.body;
      if (b && b.hasAttribute('data-painted') && window.__painted === undefined) window.__painted = performance.now();
      if (b && !b.hasAttribute('data-loading')) { window.__interactive = performance.now(); o.disconnect(); }
    }).observe(document, { subtree: true, attributes: true, childList: true });
  });
  await web.bringToFront();
  await popup.goto(`chrome-extension://${id}/pages/popup/popup.html`);
  await popup.waitForFunction(() => window.__interactive !== undefined, undefined, { timeout: 30000 });
  const m = await popup.evaluate(() => ({ interactive: window.__interactive, painted: window.__painted ?? window.__interactive }));
  await popup.close();
  await web.bringToFront();
  return m;
}

test('popup timing', { timeout: 1500000 }, async () => {
  const servers = await startServers();
  const A = process.env.DK_A;
  const B = process.env.DK_B;
  const pages = { light: ['/basic.html', false], heavy: ['/gen/site-dark-large.html?rules=12000', true] };
  for (const [pname, [path, busy]] of Object.entries(pages)) {
    if (process.env.ONLY && process.env.ONLY !== pname) continue;
    const a = await setup(servers, A, path, busy);
    const b = await setup(servers, B, path, busy);
    for (const cold of [false, true]) {
      const ra = [], rb = [];
      for (let i = 0; i < RUNS; i++) {
        ra.push(await once(a, cold));
        rb.push(await once(b, cold));
      }
      const f = (rows, key) => rows.map((r) => Math.round(r[key]));
      const line = (n, rows) => `${n} painted min ${Math.min(...f(rows, 'painted'))} med ${med(f(rows, 'painted'))} max ${Math.max(...f(rows, 'painted'))} | loaded min ${Math.min(...f(rows, 'interactive'))} med ${med(f(rows, 'interactive'))} max ${Math.max(...f(rows, 'interactive'))}`;
      console.log(`${pname}/${cold ? 'cold' : 'warm'}  A: ${line('', ra)}   B: ${line('', rb)}`);
    }
    await a.browser.close();
    await b.browser.close();
  }
  await servers.close();
});
