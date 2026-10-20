// Paired comparison of the script cost of two unpacked builds: loads alternate between the two browsers, so a busy machine
// slows both alike. Reports the median and the middle half of the script time (compile and run of the content files, from a
// browser trace) and of the time from navigation to engine start and to ready, and of the difference of each pair.
// Usage: node tests/perf/script-ab.mjs --a=<dir> --b=<dir> [--loads=30] [--rates=1,4] [--page=/gen/blank.html]
import { startServers, launch } from '../browser/harness.mjs';
import { loadTraced, median, round } from './trace.mjs';

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const A = arg('a', '');
const B = arg('b', '');
const LOADS = Number(arg('loads', 30));
const RATES = arg('rates', '1,4').split(',').map(Number);
const PAGE = arg('page', '/gen/blank.html');
// --big=1 stores 2 000 site rules and 2 000 fixes (the limits) in both builds.
const BIG = arg('big', '0') === '1';
const quartiles = (l) => {
  const s = [...l].sort((x, y) => x - y);
  return [s[Math.floor(s.length / 4)], s[Math.floor(s.length * 0.75)]];
};

const servers = await startServers();
const a = await launch({ extension: A });
const b = await launch({ extension: B });
const seed = { settings: { enabled: true } };
if (BIG) {
  seed.siteRules = {};
  seed.userFixes = {};
  for (let i = 0; i < 2000; i++) seed.siteRules[`site${i}.example.com`] = { enabled: i % 7 !== 0, theme: { mode: 'dark', brightness: 90 } };
  for (let i = 0; i < 2000; i++) seed.userFixes[`fix${i}.example.org`] = { engine: 'dynamic', dynamic: { css: `.a${i}{color:red}`.repeat(100), invert: ['img.logo'] } };
}
for (const x of [a, b]) {
  await x.setStorage(seed);
  await x.worker.evaluate(() => globalThis.tintlyGate?.settled());
}
const url = `${servers.origin}${PAGE}`;
for (const rate of RATES) {
  for (const x of [a, b]) for (let i = 0; i < 3; i++) await loadTraced(x, url, rate);
  const rows = { a: [], b: [] };
  for (let i = 0; i < LOADS; i++) {
    const order = i % 2 ? [['b', b], ['a', a]] : [['a', a], ['b', b]];
    for (const [name, x] of order) rows[name].push(await loadTraced(x, url, rate));
  }
  const pick = (name, f) => rows[name].map(f);
  const report = (label, f) => {
    const pa = pick('a', f);
    const pb = pick('b', f);
    const diff = pa.map((v, i) => pb[i] - v);
    const [lo, hi] = quartiles(diff);
    console.log(`${rate}x ${label.padEnd(12)} A ${round(median(pa))}  B ${round(median(pb))}  B-A median ${round(median(diff))} (middle half ${round(lo)} to ${round(hi)})`);
  };
  report('scripts ms', (r) => r.scripts);
  report('engine start', (r) => r.stats.startedAt);
  report('ready', (r) => r.stats.readyAt);
}
await a.close();
await b.close();
await servers.close();
