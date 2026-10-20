import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from './tree.mjs';

/**
 * Run content script files in Node the way the browser runs them: one shared namespace object.
 * Call once per test file; each test file runs in its own process.
 */
export async function loadContent(...files) {
  globalThis.__dk = Object.create(null);
  for (const file of files) {
    await import(pathToFileURL(join(REPO, 'extension', 'content', file)).href);
  }
  return globalThis.__dk;
}
