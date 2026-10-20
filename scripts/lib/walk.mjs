import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** True for a symbolic link or a junction. A missing path is not a link. */
export function isLink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Files below `dir`, sorted by name, without following links. A link (to a file or a folder) is not entered; its path
 * goes to `links` when that array is given, and is not returned as a file. `skip(name)` leaves out an entry.
 */
export function walkFiles(dir, links = [], skip = () => false) {
  const out = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (skip(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink() || isLink(full)) links.push(full);
      else if (entry.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(dir);
  return out;
}
