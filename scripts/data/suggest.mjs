// Propose fix entries for pages that failed. A proposal is a draft: it has no `verified` field, so `build.mjs` refuses it
// until a person has read it, tried it and added that field.
//   node scripts/data/suggest.mjs [corpus-folder]
// Writes corpus/suggestions/<name>.json. Only one kind of proposal is made: large light areas that stayed light become
// the `static.bg` list of a static theme for the host.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { judge, loadCorpus } from './report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function suggestFor(record) {
  const fails = judge(record);
  if (!fails.includes('light') && !fails.includes('contrast')) return null;
  const boxes = (record.checks?.lightBoxes ?? []).filter((p) => p && !/^(html|body)$/i.test(p.trim()));
  if (boxes.length === 0) return null;
  const host = record.line.replace(/^\//, '');
  return { [host]: { note: `suggested: ${boxes.length} large light areas stayed light`, engine: 'static', static: { bg: boxes.slice(0, 10).map((p) => p.split(' > ').slice(-1)[0]) } } };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(ROOT, 'corpus');
  const out = join(dir, 'suggestions');
  mkdirSync(out, { recursive: true });
  let n = 0;
  for (const record of loadCorpus(dir)) {
    const s = suggestFor(record);
    if (!s) continue;
    writeFileSync(join(out, `${record.name}.json`), `${JSON.stringify(s, null, 2)}\n`);
    n += 1;
  }
  console.log(`${n} proposals written to ${out}`);
}
