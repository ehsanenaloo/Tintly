// Runs the browser tests in several processes at once. Each process runs its files one after the other, as
// `npm run test:browser` does, and has its own browser and servers (random ports, own profile folder).
// Usage: node scripts/test-browser.mjs [--shards N] [file ...]
import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitShards } from './lib/shards.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'tests', 'browser');
const args = process.argv.slice(2);
let shards = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 4)));
const given = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shards') shards = Number(args[++i]) || shards;
  else given.push(args[i]);
}
const files = given.length ? given : readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => join('tests', 'browser', f));
const groups = splitShards(files.map((file) => ({ file, weight: statSync(join(root, file)).size })), shards);

const started = Date.now();
const results = await Promise.all(
  groups.map(
    (group, index) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...group], { cwd: root, env: process.env });
        let text = '';
        child.stdout.on('data', (d) => (text += d));
        child.stderr.on('data', (d) => (text += d));
        child.on('close', (code) => resolve({ index, code, text, files: group.length }));
      }),
  ),
);

let pass = 0;
let fail = 0;
const failed = [];
for (const r of results) {
  const count = (/** @type {string} */ name) => Number(new RegExp(`^ℹ ${name} (\\d+)`, 'm').exec(r.text)?.[1] ?? 0);
  pass += count('pass');
  fail += count('fail');
  for (const m of r.text.matchAll(/^\s*✖ (.+?) \(\d+(?:\.\d+)?ms\)$/gm)) if (!failed.includes(m[1])) failed.push(m[1]);
  if (r.code !== 0) process.stdout.write(`\n--- shard ${r.index + 1} output ---\n${r.text}\n`);
}
console.log(`\n${groups.length} shards, ${files.length} files, ${pass} passed, ${fail} failed, ${Math.round((Date.now() - started) / 1000)} s`);
if (failed.length) console.log(`failed:\n${[...new Set(failed)].map((f) => `  ${f}`).join('\n')}`);
process.exit(results.some((r) => r.code !== 0) || fail > 0 ? 1 : 0);
