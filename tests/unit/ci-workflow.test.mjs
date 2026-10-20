import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const text = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
const jobsText = text.slice(text.indexOf('\njobs:'));
/** Job id to the text of its block (a job starts at two spaces of indent). */
const jobs = Object.fromEntries(
  [...jobsText.matchAll(/^ {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/gm)].map((m) => [m[1], m[2]]),
);

test('the workflow reads the repository and nothing else by default', () => {
  assert.match(text, /^permissions:\n {2}contents: read\n/m);
  assert.ok(!/:\s*(?:write|write-all)\b/.test(text), 'no job asks for write access');
});

test('every action is pinned to a full commit hash', () => {
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${u} is not pinned`);
});

test('every job runs only in the public repository, so the private one spends no quota', () => {
  for (const [name, body] of Object.entries(jobs)) assert.match(body, /^ {4}if: github\.repository == 'ehsanenaloo\/Tintly'$/m, `${name} has no repository condition`);
});

test('every job has a time limit', () => {
  assert.ok(Object.keys(jobs).length >= 4, Object.keys(jobs).join());
  for (const [name, body] of Object.entries(jobs)) assert.match(body, /^ {4}timeout-minutes: \d+$/m, `${name} has no timeout-minutes`);
});

test('the jobs cover validation, both builds, a Chromium smoke and a Firefox smoke', () => {
  const all = Object.values(jobs).join('\n');
  for (const command of ['npm run check', 'npm run audit', 'npm run lint:firefox', 'npm run build', 'npm run build:firefox', 'npm run version:check', 'npx playwright install', 'npm run test:firefox']) {
    assert.ok(all.includes(command), `missing: ${command}`);
  }
});

test('the Chromium smoke names its tests, and a failure leaves a report in the run', () => {
  const body = Object.values(jobs).find((b) => b.includes('playwright install'));
  for (const name of ['popup-cold', 'worker', 'ondemand', 'security', 'footer-source', 'mixed-build']) assert.ok(body.includes(name), name);
  assert.match(body, /if: failure\(\)/);
  assert.match(body, /GITHUB_STEP_SUMMARY/);
});

test('the Firefox job does not hide a missing Firefox', () => {
  const body = Object.values(jobs).find((b) => b.includes('npm run test:firefox'));
  assert.match(body, /firefox --version/);
  assert.ok(!/continue-on-error/.test(body));
  assert.ok(!/DK_SKIP|skip/i.test(body));
});

test('no step ignores a failure', () => {
  assert.ok(!/continue-on-error:\s*true/.test(text));
  assert.ok(!/\|\|\s*true/.test(text));
});

test('every test file named in a job exists', () => {
  for (const m of text.matchAll(/tests\/(?:browser|firefox|unit)\/[\w-]+\.test\.mjs/g)) {
    assert.doesNotThrow(() => readFileSync(join(REPO, m[0])), m[0]);
  }
});

test('the version check compares with the base of the pull request or the commit before the push, with full history', () => {
  const build = jobs.build;
  assert.match(build, /fetch-depth: 0/);
  assert.ok(build.includes('github.event.pull_request.base.sha'));
  assert.ok(build.includes('github.event.before'));
  assert.match(build, /npm run version:check -- --base "\$\{BASE\}"/);
});
