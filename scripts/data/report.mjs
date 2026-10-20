// Summarize a crawl: one line per page and a count of each kind of failure.
//   node scripts/data/report.mjs [corpus-folder]
// Rules (a page fails when one holds):
//   error      the page could not be opened or the run threw
//   fault      the engine reported a fault or ended without being ready
//   light      the page is still mostly light after theming (more than 45 percent of the screenshot) although the engine ran
//   contrast   more than 5 text elements have a contrast ratio under 3
//   capped     a limit was reached and a sheet was left as it was
// A page that is dark by itself (the extension left it alone) passes when it is dark in both screenshots.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function judge(r) {
  const fails = [];
  if (r.error) return ['error'];
  const left = r.state === null && (r.lightBefore ?? 1) < 0.45;
  if (!left) {
    if (r.state !== 'ready' && r.state !== null) fails.push('fault');
    if (r.stats && r.stats.faults > 0) fails.push('fault');
    if ((r.lightAfter ?? 0) > 0.45) fails.push('light');
    if ((r.checks?.lowCount ?? 0) > 5) fails.push('contrast');
  }
  if (r.stats && r.stats.capped > 0) fails.push('capped');
  return [...new Set(fails)];
}

export function summarize(records) {
  const rows = records.map((r) => ({ name: r.name, line: r.line, fails: judge(r), state: r.state ?? '-', before: r.lightBefore, after: r.lightAfter, low: r.checks?.lowCount ?? 0, readyMs: r.stats?.readyMs ?? null }));
  const counts = {};
  for (const row of rows) for (const f of row.fails) counts[f] = (counts[f] ?? 0) + 1;
  return { rows, counts, pass: rows.filter((r) => r.fails.length === 0).length, total: rows.length };
}

export function loadCorpus(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'report.json')
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((r) => r && r.name);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(ROOT, 'corpus');
  const s = summarize(loadCorpus(dir));
  const lines = s.rows.map((r) => `${r.fails.length ? 'FAIL' : 'pass'}  ${r.line.padEnd(40)} state ${String(r.state).padEnd(6)} light ${(r.before ?? 0).toFixed(2)} -> ${(r.after ?? 0).toFixed(2)}  low-contrast ${String(r.low).padStart(3)}  ${r.fails.join(',')}`);
  const text = `${lines.join('\n')}\n\n${s.pass} of ${s.total} pages pass. Failures: ${JSON.stringify(s.counts)}\n`;
  console.log(text);
  writeFileSync(join(dir, 'report.json'), JSON.stringify(s, null, 2));
}
