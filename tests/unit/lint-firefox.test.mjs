import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { lintFirefox, linterScript } from '../../scripts/lint-firefox.mjs';
import { readManifest, writePackage } from '../../scripts/lib/package-files.mjs';
import { REPO } from '../helpers/tree.mjs';

test('the linter runs on the package it just built, not on an old zip next to it', () => {
  const dist = mkdtempSync(join(tmpdir(), 'dk-dist-'));
  try {
    for (const old of ['tintly-0.1.0-firefox.zip', 'tintly-0.0.1-firefox.zip', 'tintly-9.9.9-firefox.zip']) writeFileSync(join(dist, old), 'old');
    const calls = [];
    const status = lintFirefox({
      build: () => writePackage('firefox', join(REPO, 'extension'), dist),
      run: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { status: 0 };
      },
      script: 'linter.js',
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    const { version } = readManifest(join(REPO, 'extension'));
    const [script, target] = calls[0].args;
    assert.equal(calls[0].cmd, process.execPath);
    assert.equal(script, 'linter.js');
    assert.equal(target, join(dist, `tintly-${version}-firefox.zip`));
    assert.equal(basename(target), `tintly-${version}-firefox.zip`);
    assert.ok(existsSync(target));
    assert.ok(statSync(target).size > 1000, 'the built package, not a stand-in');
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('the linter status passes through, and a failed start is an error', () => {
  const build = () => ({ file: 'x.zip' });
  assert.equal(lintFirefox({ build, run: () => ({ status: 1 }), script: 's' }), 1);
  assert.equal(lintFirefox({ build, run: () => ({ status: null }), script: 's' }), 1);
  assert.throws(() => lintFirefox({ build, run: () => ({ error: new Error('spawn failed') }), script: 's' }), /spawn failed/);
});

test('the linter is started through node with its own script', () => {
  const script = linterScript();
  assert.ok(existsSync(script));
  assert.ok(!/\.cmd$/i.test(script));
});
