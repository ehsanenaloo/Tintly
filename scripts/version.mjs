// The version of the extension. Every change to the shipped extension raises it, so the version a person sees (popup,
// About, the extensions page) says which build is loaded. 0.x.y is the development line; 1.0.0 is the public beta.
// Usage: node scripts/version.mjs status | bump [patch|minor|major] | check [--staged | --base <rev>] | hook
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['extension/manifest.json', 'package.json'];
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const read = (file) => readFileSync(join(root, file), 'utf8');

/** @param {string} text @returns {string} */
const versionOf = (text) => /"version":\s*"(\d+\.\d+\.\d+)"/.exec(text)?.[1] ?? '';

/** @param {string} v @param {'patch' | 'minor' | 'major'} kind */
export function bumped(v, kind) {
  const [a, b, c] = v.split('.').map(Number);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

/** Version in `rev` (the last commit by default), or '' when there is none. */
function headVersion(rev = 'HEAD') {
  try {
    return versionOf(git('show', `${rev}:extension/manifest.json`));
  } catch {
    return '';
  }
}

/**
 * Files of the shipped extension that differ from `rev` (working tree, or the index with `staged`). With an explicit
 * revision an unknown revision is an error, so a check never passes on missing history.
 */
function changedFiles(staged, rev = 'HEAD', strict = false) {
  try {
    const out = staged ? git('diff', '--cached', '--name-only', '--', 'extension') : git('diff', rev, '--name-only', '--', 'extension');
    return out.split('\n').filter(Boolean);
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

/** The folder git runs hooks from: a worktree has no .git folder, and core.hooksPath moves it. */
export function hooksDir() {
  return resolve(root, git('rev-parse', '--git-path', 'hooks'));
}

/** Is the version still the one of the last commit while the extension changed? */
export function needsBump(current, head, changed) {
  return head !== '' && current === head && changed.some((f) => f !== 'extension/manifest.json');
}

function setVersion(next) {
  for (const file of FILES) {
    const path = join(root, file);
    const text = read(file);
    writeFileSync(path, text.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${next}$2`));
  }
  const lock = join(root, 'package-lock.json');
  if (existsSync(lock)) {
    const text = read('package-lock.json');
    // The first two `version` fields belong to the project itself (the root and the "" package).
    let n = 0;
    writeFileSync(lock, text.replace(/("version":\s*")\d+\.\d+\.\d+(")/g, (m, a, b) => (n++ < 2 ? `${a}${next}${b}` : m)));
  }
}

const [command = 'status', ...rest] = process.argv.slice(2);
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const current = versionOf(read('extension/manifest.json'));
  if (command === 'status') {
    const head = headVersion();
    const stale = needsBump(current, head, changedFiles(false));
    console.log(`version ${current} (last commit: ${head || 'none'})${stale ? ' - the extension changed since this version: run "npm run version:bump"' : ''}`);
  } else if (command === 'bump') {
    const kind = /** @type {'patch' | 'minor' | 'major'} */ (rest[0] ?? 'patch');
    if (!['patch', 'minor', 'major'].includes(kind)) throw new Error('bump takes patch, minor or major');
    const next = bumped(current, kind);
    setVersion(next);
    console.log(`version ${current} -> ${next}`);
  } else if (command === 'check') {
    const staged = rest.includes('--staged');
    const baseAt = rest.indexOf('--base');
    const base = baseAt === -1 ? '' : (rest[baseAt + 1] ?? '');
    if (baseAt !== -1 && (staged || !base || base.startsWith('-') || /^0+$/.test(base))) {
      console.error('--base needs a revision');
      process.exit(2);
    }
    let head = '';
    let changed = [];
    try {
      if (base) git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
      head = headVersion(base || 'HEAD');
      changed = changedFiles(staged, base || 'HEAD', Boolean(base));
    } catch {
      console.error(`Cannot compare with ${base}: the revision is not in this clone. Fetch more history.`);
      process.exit(1);
    }
    if (needsBump(current, head, changed)) {
      console.error(`The extension changed but the version is still ${current}. Run: npm run version:bump (patch for a fix, minor for a feature)`);
      process.exit(1);
    }
  } else if (command === 'hook') {
    const dir = hooksDir();
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nnode scripts/version.mjs check --staged || exit 1\n');
    try {
      chmodSync(hook, 0o755);
    } catch {
      // Windows has no file mode.
    }
    console.log(`pre-commit hook installed in ${dir}`);
  } else {
    console.error('usage: node scripts/version.mjs status | bump [patch|minor|major] | check [--staged | --base <rev>] | hook');
    process.exit(2);
  }
}
