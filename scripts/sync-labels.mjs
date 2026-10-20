// Creates or updates the issue labels listed in .github/labels.yml.
// Run by the "Sync labels" workflow. It uses the GitHub CLI (gh), which is
// already installed on GitHub-hosted runners, and needs no extra packages.
//
//   node scripts/sync-labels.mjs            create or update the labels
//   node scripts/sync-labels.mjs --dry-run  only print what would be done
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const text = fs.readFileSync(path.join(root, '.github', 'labels.yml'), 'utf8');

// labels.yml is a flat list of "- name / color / description" entries.
const labels = [];
let current = null;
for (const raw of text.split(/\r?\n/)) {
  const line = raw.replace(/\s+$/, '');
  if (!line || line.trimStart().startsWith('#')) continue;
  const start = line.match(/^- name:\s*(.+)$/);
  if (start) {
    current = { name: unquote(start[1]), color: '', description: '' };
    labels.push(current);
    continue;
  }
  const field = line.match(/^\s+(color|description):\s*(.*)$/);
  if (field && current) current[field[1]] = unquote(field[2]);
}

function unquote(value) {
  const v = value.trim();
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
}

const problems = labels.filter(l => !l.name || !/^[0-9a-fA-F]{6}$/.test(l.color));
if (!labels.length || problems.length) {
  console.error('labels.yml is not valid. Each label needs a name and a 6-digit hex color.', JSON.stringify(problems));
  process.exit(1);
}

let failed = 0;
for (const label of labels) {
  const args = ['label', 'create', label.name, '--color', label.color, '--description', label.description, '--force'];
  if (dryRun) {
    console.log('gh ' + args.map(a => JSON.stringify(a)).join(' '));
    continue;
  }
  const result = spawnSync('gh', args, { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}
console.log(`${labels.length} labels ${dryRun ? 'checked' : 'processed'}${failed ? `, ${failed} failed` : ''}.`);
process.exit(failed ? 1 : 0);
