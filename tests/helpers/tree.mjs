import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(fileURLToPath(import.meta.url), '..', '..', '..');

/** A throwaway copy of the parts of the repository that `runChecks` reads. */
export function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'dk-tree-'));
  cpSync(join(REPO, 'extension'), join(dir, 'extension'), { recursive: true });
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(REPO, 'scripts', 'url-allowlist.txt'), join(dir, 'scripts', 'url-allowlist.txt'));
  cpSync(join(REPO, 'package.json'), join(dir, 'package.json'));
  cpSync(join(REPO, 'CHANGELOG.md'), join(dir, 'CHANGELOG.md'));
  // The public tree has no technical-docs folder; the permission document check then does not run.
  const doc = join(REPO, 'technical-docs', 'permissions-and-publication.md');
  if (existsSync(doc)) {
    mkdirSync(join(dir, 'technical-docs'));
    cpSync(doc, join(dir, 'technical-docs', 'permissions-and-publication.md'));
  }
  mkdirSync(join(dir, 'docs'));
  cpSync(join(REPO, 'docs', 'PRIVACY.md'), join(dir, 'docs', 'PRIVACY.md'));
  return {
    dir,
    has: (p) => existsSync(join(dir, p)),
    read: (p) => readFileSync(join(dir, p), 'utf8'),
    write: (p, text) => {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), text);
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
