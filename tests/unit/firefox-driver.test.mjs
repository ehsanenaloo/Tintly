import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debugPort, firefoxSkip } from '../firefox/driver.mjs';

const fake = (script) => spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
const profile = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dk-drv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the debug port is the one Firefox reports, never a guessed number', async (t) => {
  const child = fake("console.error('WebDriver BiDi listening on ws://127.0.0.1:41234'); setTimeout(() => {}, 5000)");
  t.after(() => child.kill());
  assert.equal(await debugPort(child, profile(t)), 41234);
});

test('the port is read from the profile file when the output has none', async (t) => {
  const dir = profile(t);
  writeFileSync(join(dir, 'WebDriverBiDiServer.json'), JSON.stringify({ ws_host: '127.0.0.1', ws_port: 40555 }));
  const child = fake('setTimeout(() => {}, 5000)');
  t.after(() => child.kill());
  assert.equal(await debugPort(child, dir), 40555);
});

test('a Firefox that exits before it reports a port is an error with its output', async (t) => {
  const child = fake("console.error('profile locked'); process.exit(3)");
  await assert.rejects(debugPort(child, profile(t), 5000), /exited.*profile locked/s);
});

test('a Firefox that stays silent is an error after the time limit', async (t) => {
  const child = fake('setTimeout(() => {}, 5000)');
  t.after(() => child.kill());
  await assert.rejects(debugPort(child, profile(t), 300), /did not report/);
});

test('a missing Firefox skips the tests on a developer machine and fails them in CI', () => {
  assert.equal(firefoxSkip({ installed: true, ci: false }), false);
  assert.equal(firefoxSkip({ installed: true, ci: true }), false);
  assert.equal(typeof firefoxSkip({ installed: false, ci: false }), 'string');
  assert.equal(firefoxSkip({ installed: false, ci: true }), false);
});
