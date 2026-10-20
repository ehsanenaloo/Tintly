// Runs the unit tests. The private repository has a second folder, tests/dev, that the public tree does not have.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/package-files.mjs';

const files = ['tests/unit', 'tests/dev'].flatMap((dir) =>
  existsSync(join(ROOT, dir))
    ? readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.test.mjs')).sort().map((n) => `${dir}/${n}`)
    : [],
);
if (!files.length) {
  console.error('no unit test files found');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status ?? 1);
