// Check the site data in data-src/ and write the shards under extension/data/.
//   node scripts/data/build.mjs           write
//   node scripts/data/build.mjs --check   check only, write nothing, fail if the files on disk differ
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (p) => import(pathToFileURL(join(ROOT, 'extension', p)).href);

// A shipped fix is on for every user without a question, so its CSS may only recolor: no request, no escape that hides one.
const SHIPPED_CSS_BANNED = /@import|@font-face|@namespace|\\|url\s*\(|image-set\s*\(|src\s*\(|element\s*\(|cross-fade\s*\(|paint\s*\(|expression\s*\(|-moz-binding|behavior\s*:/i;

/** @param {unknown} text @returns {string | null} what is wrong with the CSS of a shipped fix */
export function shippedCssProblem(text) {
  if (typeof text !== 'string') return null;
  const bare = text.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');
  const hit = SHIPPED_CSS_BANNED.exec(bare) ?? SHIPPED_CSS_BANNED.exec(text);
  return hit ? `css may not use "${hit[0].trim()}"` : null;
}

/** Read, check and shard the data. Returns `{ errors, files }` where `files` maps a path under extension/data to its text. */
export async function buildData(root = ROOT) {
  const { sanitizeSection, normalizePattern } = await load('shared/settings.js');
  const { shardOf } = await load('background/modules/data.js');
  const errors = [];
  const merged = Object.create(null);
  const srcDir = join(root, 'data-src', 'fixes');
  const names = existsSync(srcDir) ? readdirSync(srcDir).filter((f) => f.endsWith('.json')).sort() : [];
  for (const name of names) {
    let data;
    try {
      data = JSON.parse(readFileSync(join(srcDir, name), 'utf8'));
    } catch (e) {
      errors.push(`${name}: not valid JSON`);
      continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      errors.push(`${name}: must be an object that maps a site pattern to a fix`);
      continue;
    }
    for (const [pattern, fix] of Object.entries(data)) {
      const key = normalizePattern(pattern);
      if (!key || key !== pattern) errors.push(`${name}: "${pattern}" is not a normalized site pattern${key ? ` (use "${key}")` : ''}`);
      if (typeof fix?.note !== 'string' || fix.note.trim() === '') errors.push(`${name}: ${pattern} needs a note`);
      if (!fix?.verified) errors.push(`${name}: ${pattern} needs a verified field (date, browsers, test)`);
      if (key && merged[key]) errors.push(`${name}: ${pattern} is already defined in another file`);
      if (key) merged[key] = fix;
    }
  }
  for (const [pattern, fix] of Object.entries(merged)) {
    const problem = shippedCssProblem(fix?.dynamic?.css);
    if (problem) errors.push(`${pattern}: ${problem}`);
  }
  const checked = sanitizeSection('userFixes', merged, { strict: true });
  for (const e of checked.errors) errors.push(`fix: ${e}`);

  const shards = new Map();
  for (const [pattern, fix] of Object.entries(merged)) {
    const shard = shardOf(pattern.split('/')[0]);
    if (!shards.has(shard)) shards.set(shard, Object.create(null));
    shards.get(shard)[pattern] = fix;
  }
  const files = new Map();
  for (const shard of [...shards.keys()].sort()) {
    const sorted = Object.fromEntries(Object.entries(shards.get(shard)).sort(([a], [b]) => a.localeCompare(b)));
    files.set(`fixes/${shard}.json`, `${JSON.stringify(sorted, null, 1)}\n`);
  }

  let dark = [];
  const darkPath = join(root, 'data-src', 'dark-sites.json');
  if (existsSync(darkPath)) {
    try {
      dark = JSON.parse(readFileSync(darkPath, 'utf8'));
    } catch {
      errors.push('dark-sites.json: not valid JSON');
    }
  }
  const darkChecked = sanitizeSection('darkSites', { add: Array.isArray(dark) ? dark : [], remove: [] }, { strict: true });
  for (const e of darkChecked.errors) errors.push(`dark-sites: ${e}`);
  if (!Array.isArray(dark)) errors.push('dark-sites.json: must be a list of patterns');
  files.set('dark-sites.json', `${JSON.stringify(darkChecked.value?.add ?? [], null, 1)}\n`);

  const index = { version: 1, fixes: Object.keys(merged).length, shards: [...shards.keys()].sort(), darkSites: (darkChecked.value?.add ?? []).length };
  files.set('index.json', `${JSON.stringify(index, null, 1)}\n`);
  return { errors, files, index };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const { errors, files, index } = await buildData();
  if (errors.length) {
    console.error(errors.map((e) => `FAIL ${e}`).join('\n'));
    process.exit(1);
  }
  const out = join(ROOT, 'extension', 'data');
  if (check) {
    const stale = [];
    for (const [name, text] of files) {
      const p = join(out, name);
      if (!existsSync(p) || readFileSync(p, 'utf8') !== text) stale.push(name);
    }
    const present = existsSync(join(out, 'fixes')) ? readdirSync(join(out, 'fixes')).map((f) => `fixes/${f}`) : [];
    for (const f of present) if (!files.has(f)) stale.push(`${f} (extra)`);
    if (stale.length) {
      console.error(`FAIL the files under extension/data are out of date: ${stale.join(', ')}. Run npm run data:build.`);
      process.exit(1);
    }
    console.log(`data: ${index.fixes} fixes in ${index.shards.length} shards, ${index.darkSites} dark sites, up to date`);
  } else {
    rmSync(join(out, 'fixes'), { recursive: true, force: true });
    mkdirSync(join(out, 'fixes'), { recursive: true });
    for (const [name, text] of files) writeFileSync(join(out, name), text);
    console.log(`data: ${index.fixes} fixes in ${index.shards.length} shards, ${index.darkSites} dark sites written`);
  }
}
