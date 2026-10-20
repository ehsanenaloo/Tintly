import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { bumped, hooksDir, needsBump } from '../../scripts/version.mjs';
import { REPO } from '../helpers/tree.mjs';

test('bump patch, minor and major', () => {
  assert.equal(bumped('0.2.9', 'patch'), '0.2.10');
  assert.equal(bumped('0.2.9', 'minor'), '0.3.0');
  assert.equal(bumped('0.9.4', 'major'), '1.0.0');
});

test('a change to the extension with the version of the last commit needs a bump', () => {
  assert.equal(needsBump('0.2.0', '0.2.0', ['extension/content/core/boot.js']), true);
  assert.equal(needsBump('0.2.1', '0.2.0', ['extension/content/core/boot.js']), false);
  assert.equal(needsBump('0.2.0', '0.2.0', []), false);
  assert.equal(needsBump('0.2.0', '0.2.0', ['extension/manifest.json']), false);
  assert.equal(needsBump('0.2.0', '', ['extension/a.js']), false);
});

const run = (...args) => spawnSync(process.execPath, [join(REPO, 'scripts', 'version.mjs'), ...args], { cwd: REPO, encoding: 'utf8' });

test('check --base refuses a missing or unknown revision instead of passing', () => {
  assert.equal(run('check', '--base').status, 2);
  assert.equal(run('check', '--base', '0000000000000000000000000000000000000000').status, 2);
  const unknown = run('check', '--base', 'no-such-revision-1f2e3d');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Fetch more history/);
});

test('the hooks folder comes from git, so it works in a worktree and follows core.hooksPath', () => {
  const dir = hooksDir();
  assert.equal(basename(dir), 'hooks');
  const git = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  assert.equal(dir, resolve(REPO, git));
});
