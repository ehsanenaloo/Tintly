import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip.mjs';
import { toFirefoxManifest } from './firefox-manifest.mjs';
import { walkFiles } from './walk.mjs';

export const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

/** All shipped files of the extension folder, relative with forward slashes, sorted. A link is an error. */
export function listPackageFiles(extDir) {
  const links = [];
  const files = walkFiles(extDir, links, (name) => name.startsWith('.'));
  if (links.length) throw new Error(`symbolic link in the extension folder: ${links.map((l) => relative(extDir, l).split(sep).join('/')).join(', ')}`);
  return files.map((f) => relative(extDir, f).split(sep).join('/'));
}

export function readManifest(extDir) {
  return JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
}

const TEXT_FILE = /\.(?:js|json|html|css|svg|md|txt)$/;

/**
 * File bytes for a package. A text file leaves with LF line endings whatever the checkout has (git on Windows may
 * write CRLF), so the same source gives the same package on every system. Other files are kept as they are.
 */
export function packageBytes(name, data) {
  if (!TEXT_FILE.test(name) || !data.includes(13)) return data;
  return Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

/** Entries for a store package. `manifest` replaces the source manifest. */
export function packageEntries(extDir, manifest) {
  return listPackageFiles(extDir).map((name) => ({
    name,
    data:
      name === 'manifest.json'
        ? Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        : packageBytes(name, readFileSync(join(extDir, name))),
  }));
}

export function writePackage(target, extDir = join(ROOT, 'extension'), dist = join(ROOT, 'dist')) {
  const source = readManifest(extDir);
  const { version } = source;
  const manifest = target === 'firefox' ? toFirefoxManifest(source) : stripForStore(source);
  const zip = createZip(packageEntries(extDir, manifest));
  mkdirSync(dist, { recursive: true });
  const file = join(dist, `tintly-${version}-${target}.zip`);
  writeFileSync(file, zip);
  return { file, bytes: zip.length, version };
}

function stripForStore(manifest) {
  const copy = structuredClone(manifest);
  delete copy.key;
  return copy;
}
