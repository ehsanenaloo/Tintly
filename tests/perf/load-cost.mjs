// Cost of the files that a page where the extension is ON loads: compile and run time of each content file (browser trace),
// the time to the engine start and to ready, by page size, with a cold and a warm browser, at 1x and 4x CPU.
// Usage: node tests/perf/load-cost.mjs [--runs=N] [--cold=N] [--rates=1,4] [--pages=empty,medium,heavy] [--json=file]
// DK_EXTENSION names another unpacked copy (to compare two builds, run twice and compare the JSON files).
import { writeFileSync } from 'node:fs';
import { startServers, launch, waitState, cpuThrottle } from '../browser/harness.mjs';

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const RUNS = Number(arg('runs', 7));
const COLD = Number(arg('cold', 3));
const RATES = arg('rates', '1,4').split(',').map(Number);
const ALL = { empty: '/gen/blank.html', medium: '/gen/large.html?rules=1500&palette=40', heavy: '/gen/large.html?rules=30000&palette=40' };
const PAGES = arg('pages', 'empty,medium,heavy').split(',');
const median = (l) => (l.length ? [...l].sort((a, b) => a - b)[Math.floor(l.length / 2)] : null);
const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Trace one load; resolves to { files: { name: { compile, run, total } }, total, consumed } in milliseconds. */
async function traced(browser, page, url, rate) {
  const cdp = await browser.context.browser().newBrowserCDPSession();
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.compile'], recordMode: 'recordAsMuchAsPossible' }, transferMode: 'ReportEvents' });
  await page.goto(url);
  await waitState(page, 'ready', 120000);
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  const files = {};
  let consumed = 0;
  for (const e of events) {
    const file = e.args?.fileName ?? e.args?.data?.url;
    if (typeof file !== 'string' || !file.includes('chrome-extension://') || e.ph !== 'X') continue;
    if (!/\/content\//.test(file)) continue;
    const name = file.slice(file.indexOf('/content/') + 9);
    const f = (files[name] ??= { compile: 0, run: 0, total: 0, produce: 0 });
    const ms = (e.dur ?? 0) / 1000;
    if (e.name === 'v8.compile') {
      f.compile += ms;
      if (e.args?.data?.cacheConsumeOptions || e.args?.data?.consumedCacheSize) consumed++;
    } else if (e.name === 'v8.run') f.run += ms;
    else if (e.name === 'EvaluateScript') f.total += ms;
    else if (e.name === 'v8.produceCache') f.produce += ms;
  }
  return { files, consumed };
}

async function load(browser, servers, path, rate) {
  const page = await browser.context.newPage();
  if (rate > 1) await cpuThrottle(page, rate);
  const url = `${servers.origin}${path}`;
  const t = await traced(browser, page, url, rate);
  const s = await browser.stats(url);
  await page.close();
  const total = Object.values(t.files).reduce((n, f) => n + f.total, 0);
  const produce = Object.values(t.files).reduce((n, f) => n + f.produce, 0);
  return { ...t, scripts: total, produce, stats: s };
}

function summarize(samples) {
  const names = new Set(samples.flatMap((s) => Object.keys(s.files)));
  const files = {};
  for (const n of names) files[n] = { compile: round(median(samples.map((s) => s.files[n]?.compile ?? 0)), 2), run: round(median(samples.map((s) => s.files[n]?.run ?? 0)), 2), total: round(median(samples.map((s) => s.files[n]?.total ?? 0)), 2) };
  const startAt = (s) => s.stats.startedAt;
  return {
    n: samples.length,
    scripts: round(median(samples.map((s) => s.scripts))),
    produce: round(median(samples.map((s) => s.produce)), 2),
    consumed: round(median(samples.map((s) => s.consumed)), 0),
    engineStart: round(median(samples.map(startAt))),
    gateStart: round(median(samples.map((s) => s.stats.startedAt - (s.stats.gateMs ?? 0)))),
    ready: round(median(samples.map((s) => s.stats.readyAt))),
    files,
  };
}

const servers = await startServers();
const out = { when: new Date().toISOString(), extension: process.env.DK_EXTENSION ? 'another build (DK_EXTENSION)' : 'working tree', runs: RUNS, cold: COLD, results: {} };

for (const rate of RATES) {
  for (const key of PAGES) {
    const path = ALL[key];
    // Cold: the first load of a fresh browser profile (nothing cached for the extension's files).
    const cold = [];
    for (let i = 0; i < COLD; i++) {
      const b = await launch();
      await b.setStorage({ settings: { enabled: true } });
      cold.push(await load(b, servers, path, rate));
      await b.close();
    }
    const b = await launch();
    await b.setStorage({ settings: { enabled: true } });
    for (let i = 0; i < 3; i++) await load(b, servers, path, rate);
    const warm = [];
    for (let i = 0; i < RUNS; i++) warm.push(await load(b, servers, path, rate));
    await b.close();
    out.results[`${key}-${rate}x`] = { cold: summarize(cold), warm: summarize(warm) };
    const r = out.results[`${key}-${rate}x`];
    console.log(`${key} ${rate}x  cold: scripts ${r.cold.scripts} ms, gate start ${r.cold.gateStart}, engine start ${r.cold.engineStart}, ready ${r.cold.ready}  |  warm: scripts ${r.warm.scripts} ms, produce ${r.warm.produce}, cache consumed ${r.warm.consumed}, gate start ${r.warm.gateStart}, engine start ${r.warm.engineStart}, ready ${r.warm.ready}`);
  }
}
const file = arg('json', '');
if (file) writeFileSync(file, JSON.stringify(out, null, 1));
else console.log(JSON.stringify(out.results['empty-1x'] ?? Object.values(out.results)[0], null, 1));
await servers.close();
