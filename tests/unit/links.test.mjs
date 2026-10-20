import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { isLink, walkFiles } from '../../scripts/lib/walk.mjs';
import { listPackageFiles } from '../../scripts/lib/package-files.mjs';
import { runChecks } from '../../scripts/validate.mjs';
import { makeTree } from '../helpers/tree.mjs';

const rel = (root, f) => relative(root, f).split(sep).join('/');

/** A folder with `real/f.txt` and a `dir` folder; skips the test when links are not allowed. */
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'dk-link-'));
  mkdirSync(join(root, 'real'));
  writeFileSync(join(root, 'real', 'f.txt'), 'x');
  mkdirSync(join(root, 'dir', 'sub'), { recursive: true });
  writeFileSync(join(root, 'dir', 'a.txt'), 'a');
  writeFileSync(join(root, 'dir', 'sub', 'b.txt'), 'b');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = (from, to) => {
    try {
      symlinkSync(join(root, from), join(root, to), 'junction');
      return true;
    } catch {
      t.skip('links are not allowed here');
      return false;
    }
  };
  return { root, link };
}

test('walkFiles lists the files, does not enter a linked folder, and reports the link', (t) => {
  const { root, link } = sandbox(t);
  if (!link('real', 'dir/sub/out')) return;
  const links = [];
  const files = walkFiles(join(root, 'dir'), links);
  assert.deepEqual(files.map((f) => rel(root, f)), ['dir/a.txt', 'dir/sub/b.txt']);
  assert.deepEqual(links.map((f) => rel(root, f)), ['dir/sub/out']);
  assert.ok(isLink(join(root, 'dir', 'sub', 'out')));
  assert.ok(!isLink(join(root, 'dir', 'a.txt')));
  assert.ok(!isLink(join(root, 'missing')));
});

test('walkFiles skips the names it is told to skip', (t) => {
  const { root } = sandbox(t);
  writeFileSync(join(root, 'dir', '.hidden'), 'h');
  assert.deepEqual(walkFiles(join(root, 'dir'), [], (n) => n.startsWith('.')).length, 2);
});

test('a link in the extension folder stops the package list', (t) => {
  const { root, link } = sandbox(t);
  assert.deepEqual(listPackageFiles(join(root, 'dir')), ['a.txt', 'sub/b.txt']);
  if (!link('real', 'dir/sub/out')) return;
  assert.throws(() => listPackageFiles(join(root, 'dir')), /symbolic link in the extension folder: sub\/out/);
});

test('the static check refuses a link inside the extension folder', async (t) => {
  const tree = makeTree();
  t.after(() => tree.remove());
  try {
    mkdirSync(join(tree.dir, 'outside'));
    symlinkSync(join(tree.dir, 'outside'), join(tree.dir, 'extension', 'shared', 'linked'), 'junction');
  } catch {
    t.skip('links are not allowed here');
    return;
  }
  const errors = await runChecks(tree.dir);
  assert.ok(errors.some((e) => e.startsWith('link:') && e.includes('extension/shared/linked')), errors.join('\n'));
});

test('the static check refuses a linked folder in the repository root', async (t) => {
  const tree = makeTree();
  t.after(() => tree.remove());
  try {
    mkdirSync(join(tree.dir, 'elsewhere'));
    symlinkSync(join(tree.dir, 'elsewhere'), join(tree.dir, 'docs'), 'junction');
  } catch {
    t.skip('links are not allowed here');
    return;
  }
  const errors = await runChecks(tree.dir);
  assert.ok(errors.some((e) => e === 'link: symbolic link in the repository root: docs'), errors.join('\n'));
});
