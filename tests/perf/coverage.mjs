// Functions of the extension's content scripts that no page load of the fixture set ran (V8 precise coverage over the renderer, which
// also sees the isolated worlds of the extension). The result is a list, not a verdict: a function that guards a hostile case or a late
// event is run by no fixture and still has to stay. Usage: node tests/perf/coverage.mjs [--json=file] [--limit=N]
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServers, launch } from '../browser/harness.mjs';
import { REPO } from '../helpers/tree.mjs';

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const LIMIT = Number(arg('limit', 1000));
const JSON_OUT = arg('json', '');
const pages = readdirSync(join(REPO, 'tests', 'browser', 'fixtures'))
  .filter((f) => f.endsWith('.html'))
  .sort()
  .slice(0, LIMIT);

/** The settings of the runs: every fixture in the dark mode, a part of them in the other modes and engines. */
const RUNS = [
  { name: 'dark', settings: { enabled: true }, all: true },
  { name: 'light', settings: { enabled: true, theme: { mode: 'light' } }, every: 4 },
  { name: 'paper', settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'paper' } }, every: 6 },
  { name: 'eink', settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'eink' } }, every: 9 },
  { name: 'filter', settings: { enabled: true, engine: 'filter' }, every: 5 },
  { name: 'filterPlus', settings: { enabled: true, engine: 'filterPlus' }, every: 7 },
];

const servers = await startServers();
const browser = await launch();
/** @type {Map<string, Map<string, { name: string, start: number, end: number, count: number }>>} */
const files = new Map();

for (const run of RUNS) {
  await browser.clearStorage();
  await browser.setStorage({ settings: run.settings });
  for (const [index, name] of pages.entries()) {
    if (!run.all && index % run.every !== 0) continue;
    const page = await browser.context.newPage();
    const cdp = await browser.context.newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
    try {
      await page.goto(`${servers.origin}/${name}`, { timeout: 20000 });
      await page.waitForTimeout(1800);
    } catch {
      // A fixture that does not load in time still counts for what ran.
    }
    const { result } = await cdp.send('Profiler.takePreciseCoverage').catch(() => ({ result: [] }));
    for (const script of result) {
      if (!script.url.includes('chrome-extension://') || !script.url.includes('/content/')) continue;
      const file = script.url.slice(script.url.indexOf('/content/') + 1);
      const map = files.get(file) ?? new Map();
      files.set(file, map);
      for (const fn of script.functions) {
        const range = fn.ranges[0];
        const key = `${range.startOffset}:${range.endOffset}`;
        const old = map.get(key);
        if (!old || old.count < range.count) map.set(key, { name: fn.functionName || '(anonymous)', start: range.startOffset, end: range.endOffset, count: range.count });
      }
    }
    await cdp.send('Profiler.stopPreciseCoverage').catch(() => {});
    await page.close();
  }
  console.error(`run ${run.name} done`);
}

const report = {};
for (const [file, map] of [...files].sort()) {
  const never = [...map.values()].filter((f) => f.count === 0 && f.name !== '(anonymous)' && f.end - f.start > 40).sort((a, b) => a.start - b.start);
  report[file] = { functions: map.size, never: never.map((f) => ({ name: f.name, bytes: f.end - f.start, start: f.start })) };
  console.log(`${file}: ${never.length} of ${map.size} named functions never ran (${never.reduce((n, f) => n + f.end - f.start, 0)} bytes)`);
  for (const f of never) console.log(`  ${f.name} ${f.end - f.start}`);
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
await browser.close();
await servers.close();
