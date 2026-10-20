// @ts-check
import { sanitizeSection } from './settings.js';

const KEY = 'localhost';

/** The form field that holds a part of a fix, by the path the worker reports. @type {Record<string, string>} */
const STATIC_FIELD = { bg: 'sBg', fg: 'sFg', border: 'sBorder', skip: 'sSkip' };

/**
 * What the worker would refuse in a fix, by the same rules it uses to save. `field` is the id of the form control,
 * `index` is the position in a list, and both are absent for a problem that no control shows.
 * @param {unknown} fix
 * @returns {Array<{ field: string | null, index: number | null, message: string }>}
 */
export function fixProblems(fix) {
  const { errors } = sanitizeSection('userFixes', { [KEY]: fix }, { strict: true });
  return errors.map(fromError);
}

/** @param {string} error */
function fromError(error) {
  const at = error.indexOf(': ');
  const path = (at < 0 ? error : error.slice(0, at)).split('.').slice(2);
  const message = at < 0 ? '' : error.slice(at + 2);
  const [group, name, item] = path;
  const index = /^\d+$/.test(item ?? '') ? Number(item) : /^\d+$/.test(name ?? '') ? Number(name) : null;
  /** @type {string | null} */
  let field = null;
  if (group === 'note' || group === 'engine') field = group;
  else if (group === 'dynamic' && name === 'theme') field = item === undefined ? null : item;
  else if (group === 'dynamic') field = name ?? null;
  else if (group === 'static') field = (name && STATIC_FIELD[name]) || null;
  return { field, index, message };
}
