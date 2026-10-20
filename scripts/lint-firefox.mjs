// Builds the Firefox package and runs addons-linter on exactly that file.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, writePackage } from './lib/package-files.mjs';

/** The linter's script path, so it runs through node and not through a .cmd shim. */
export function linterScript(root = ROOT) {
  const dir = join(root, 'node_modules', 'addons-linter');
  const { bin } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const rel = typeof bin === 'string' ? bin : bin['addons-linter'];
  const file = join(dir, rel);
  if (!existsSync(file)) throw new Error(`addons-linter is not installed (${file}); run npm ci`);
  return file;
}

/** Returns the exit status of the linter. `build`, `run` and `script` can be replaced in tests. */
export function lintFirefox({ build = () => writePackage('firefox'), run = spawnSync, script = linterScript() } = {}) {
  const { file } = build();
  const result = run(process.execPath, [script, file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(lintFirefox());
}
