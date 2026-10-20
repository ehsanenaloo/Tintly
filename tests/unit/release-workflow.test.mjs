import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const read = (name) => readFileSync(join(REPO, '.github', 'workflows', name), 'utf8');
const release = read('release.yml');
const labels = read('sync-labels.yml');

test('release and label workflows pin every action to a full commit hash', () => {
  for (const text of [release, labels]) {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${u} is not pinned`);
  }
});

test('the release workflow runs on a version tag only and has a time limit', () => {
  assert.match(release, /on:\n {2}push:\n {4}tags:\n {6}- 'v\*\.\*\.\*'\n/);
  assert.ok(!/branches:|pull_request|workflow_dispatch/.test(release));
  assert.match(release, /^ {4}timeout-minutes: \d+$/m);
});

test('the release workflow checks the tag against the manifest, builds both packages and publishes to no store', () => {
  for (const part of ['extension/manifest.json', 'npm run check', 'npm run build', 'npm run build:firefox', 'sha256sum -c', 'CHANGELOG.md', '--notes-file', '--verify-tag']) {
    assert.ok(release.includes(part), `missing: ${part}`);
  }
  assert.ok(!/chrome-webstore|web-ext sign|addons\.mozilla|edge-addons|publish-extension/i.test(release));
  assert.ok(!/continue-on-error:\s*true|\|\|\s*true/.test(release));
});

test('the label workflow uses only the token of the run and the labels file', () => {
  assert.match(labels, /permissions:\n {2}contents: read\n {2}issues: write\n/);
  assert.ok(labels.includes('github.token'));
  assert.ok(!/secrets\./.test(labels + release));
  assert.match(labels, /^ {4}timeout-minutes: \d+$/m);
  const script = readFileSync(join(REPO, 'scripts', 'sync-labels.mjs'), 'utf8');
  assert.ok(script.includes('labels.yml'));
});

test('only the release job can write, and it runs no project code', () => {
  assert.match(release, /^permissions:\n {2}contents: read\n/m);
  const [build, publish] = release.split(/^ {2}release:\n/m);
  assert.ok(publish, 'the release job is missing');
  assert.ok(!/contents:\s*write/.test(build));
  assert.match(publish, /^ {4}permissions:\n {6}contents: write\n/m);
  assert.ok(publish.includes('needs: build'));
  assert.ok(!/npm |checkout|setup-node/.test(publish));
  assert.ok(publish.includes('gh release create') && publish.includes('--verify-tag'));
});
