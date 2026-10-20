// Static checks for the repository. `runChecks(root)` returns a list of error strings.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep, extname, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isLink, walkFiles } from './lib/walk.mjs';
import { toFirefoxManifest } from './lib/firefox-manifest.mjs';

export const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' http: https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const FORBIDDEN_PERMISSIONS = new Set([
  'tabs',
  'activeTab',
  'webRequest',
  'webRequestBlocking',
  'declarativeNetRequest',
  'cookies',
  'history',
  'bookmarks',
  'downloads',
  'nativeMessaging',
  'unlimitedStorage',
]);

// Permissions the owner allows only as optional ones: asked for when the person turns the feature on.
const REQUIRED_FORBIDDEN = new Set(['alarms']);

// How each permission shows up in code.
const PERMISSION_USE = {
  storage: /\bchrome\.storage\b/,
  scripting: /\bchrome\.scripting\b/,
  contextMenus: /\bchrome\.contextMenus\b/,
  alarms: /\bchrome\.alarms\b/,
  fontSettings: /\bchrome\.fontSettings\b/,
  theme: /\b(chrome|browser)\.theme\b/,
};

// The row of docs/PRIVACY.md (first words of the first cell) that explains each permission, Chrome and Firefox names.
const PRIVACY_LABEL = {
  storage: 'Storage',
  scripting: 'Scripting',
  contextMenus: 'Context menu',
  menus: 'Context menu',
  alarms: 'Alarms',
  '<all_urls>': 'Access to all sites',
};

// Root entries that exist only in the private repository: the file is not part of the public tree.
/** @type {string[]} */
let PRIVATE_ROOT = [];
try {
  PRIVATE_ROOT = JSON.parse(readFileSync(new URL('./lib/private-root.json', import.meta.url), 'utf8'));
} catch {
  // The public tree has no such file.
}
const ROOT_ALLOWED = new Set([
  ...PRIVATE_ROOT,
  '.editorconfig',
  '.git',
  '.gitattributes',
  '.github',
  '.gitignore',
  '.npmrc',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'corpus',
  'data-src',
  'dist',
  'docs',
  'extension',
  'guides',
  'node_modules',
  'package-lock.json',
  'package.json',
  'schemas',
  'scripts',
  'technical-docs',
  'tests',
  'tsconfig.json',
  'types',
]);

const ALLOWED_EXTENSIONS = new Set(['.js', '.json', '.html', '.css', '.png', '.svg', '.woff2', '.ttf', '.md']);

const JS_BANNED = [
  [/\.innerHTML\b/, 'innerHTML'],
  [/\.outerHTML\b/, 'outerHTML'],
  [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
  [/\beval\s*\(/, 'eval'],
  [/\bnew\s+Function\b/, 'new Function'],
  [/\bdocument\.write(ln)?\s*\(/, 'document.write'],
  [/javascript:/i, 'javascript: URL'],
  [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'a timer that runs a string'],
  [/\bFunction\s*\(/, 'Function'],
  [/\bcreateContextualFragment\b/, 'createContextualFragment'],
  [/\bDOMParser\b/, 'DOMParser'],
  [/\.srcdoc\b/, 'srcdoc'],
  [/setAttribute\(\s*['"]on/i, 'an inline event handler attribute'],
  [/\bimportScripts\s*\(/, 'importScripts'],
  [/\bnew\s+(?:Shared)?Worker\b/, 'a worker'],
];

// Files that may build a pattern once from constants (a top-level `const NAME = new RegExp(...)`).
const REGEXP_CONSTANT_FILES = new Set(['extension/shared/settings.js']);

const PHYSICAL_CSS = [
  /(^|[\s;{])(margin|padding|border)-(left|right)\b/,
  /(^|[\s;{])(left|right)\s*:/,
  /float\s*:\s*(left|right)/,
  /text-align\s*:\s*(left|right)/,
  /border-(top|bottom)-(left|right)-radius/,
];

// Links are not followed; they go to `links`.
function walk(dir, links = []) {
  return existsSync(dir) ? walkFiles(dir, links) : [];
}

// Private or ignored entries of the root that may be links on a developer machine.
const LINK_OK_AT_ROOT = new Set(['.git', 'corpus', 'dist', 'guides', 'node_modules', 'technical-docs']);

const rel = (root, file) => relative(root, file).split(sep).join('/');
const read = (file) => readFileSync(file, 'utf8');

function keysOf(obj) {
  return Object.keys(obj).sort();
}

function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
}

export async function runChecks(root) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  const extDir = join(root, 'extension');
  const links = [];
  const files = walk(extDir, links);
  const textFiles = files.filter((f) => ['.js', '.html', '.css', '.json', '.svg'].includes(extname(f)));

  // Root layout
  for (const name of readdirSync(root)) {
    if (!ROOT_ALLOWED.has(name)) fail(`root: file or folder not allowed in the repository root: ${name}`);
    if (!LINK_OK_AT_ROOT.has(name) && isLink(join(root, name))) fail(`link: symbolic link in the repository root: ${name}`);
  }
  for (const l of links) fail(`link: symbolic link in the extension folder: ${rel(root, l)}`);

  // Package files
  for (const f of files) {
    if (!ALLOWED_EXTENSIONS.has(extname(f))) fail(`package: file type not allowed: ${rel(root, f)}`);
  }

  // Manifest
  let manifest;
  try {
    manifest = JSON.parse(read(join(extDir, 'manifest.json')));
  } catch (error) {
    fail(`manifest: cannot read manifest.json (${error.message})`);
    return errors;
  }
  if (manifest.manifest_version !== 3) fail('manifest: manifest_version must be 3');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) fail('manifest: version must be x.y.z');
  try {
    const pkg = JSON.parse(read(join(root, 'package.json')));
    if (pkg.version !== manifest.version) {
      fail(`version: manifest ${manifest.version} and package.json ${pkg.version} differ`);
    }
  } catch (error) {
    fail(`package.json: cannot read (${error.message})`);
  }
  // From 1.0.0 the changelog has a section for the version (the release workflow copies it into the release notes).
  // A 0.x version is a development line and needs none.
  if (/^[1-9]\d*\./.test(manifest.version ?? '') && existsSync(join(root, 'CHANGELOG.md'))) {
    const escaped = manifest.version.replace(/\./g, '\\.');
    const heading = new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, 'm');
    if (!heading.test(read(join(root, 'CHANGELOG.md')))) fail(`changelog: CHANGELOG.md has no section "## [${manifest.version}] - YYYY-MM-DD"`);
  }
  if (manifest.content_security_policy?.extension_pages !== EXPECTED_CSP) {
    fail('manifest: extension_pages CSP differs from the required policy');
  }
  if (manifest.web_accessible_resources) fail('manifest: web_accessible_resources is not planned');
  if (manifest.externally_connectable) fail('manifest: externally_connectable must not be declared');

  // Referenced files
  const referenced = new Set();
  const add = (p) => p && referenced.add(p);
  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  add(manifest.options_ui?.page);
  Object.values(manifest.icons ?? {}).forEach(add);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  // The content scripts are registered by the worker (background/modules/register.js); their files are listed there.
  if (manifest.content_scripts) fail('manifest: content_scripts must not be declared, the worker registers them (register.js)');
  const registerFile = join(extDir, 'background', 'modules', 'register.js');
  const registered = [];
  if (existsSync(registerFile)) for (const m of read(registerFile).matchAll(/'(content\/[a-z-]+\/[a-z-]+\.js)'/g)) registered.push(m[1]);
  else fail('register: background/modules/register.js is missing');
  registered.forEach(add);
  for (const p of referenced) {
    if (!existsSync(join(extDir, p))) fail(`manifest: referenced file is missing: ${p}`);
  }

  // Content scripts are classic scripts
  for (const p of registered) {
    const file = join(extDir, p);
    if (existsSync(file) && /^\s*(import|export)\s/m.test(read(file))) fail(`content script uses import or export: ${p}`);
  }
  // Every content script is registered by the worker or injected on request (background/modules/ondemand.js), never both.
  {
    const onDemandFile = join(extDir, 'background', 'modules', 'ondemand.js');
    const injectable = new Set();
    if (existsSync(onDemandFile)) for (const m of read(onDemandFile).matchAll(/'(content\/[a-z-]+\/[a-z-]+\.js)'/g)) injectable.add(m[1]);
    const listed = new Set(registered);
    for (const p of injectable) {
      if (!existsSync(join(extDir, p))) fail(`ondemand: injectable file is missing: ${p}`);
      if (listed.has(p)) fail(`ondemand: ${p} is registered and also injected on request`);
    }
    for (const dir of ['core', 'engine']) {
      for (const f of walk(join(extDir, 'content', dir))) {
        const p = `content/${dir}/${basename(f)}`;
        if (f.endsWith('.js') && !listed.has(p) && !injectable.has(p)) fail(`ondemand: ${p} is not registered or injected on request`);
      }
    }
  }

  // HTML and CSS references, inline code
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const text = read(f);
    for (const m of text.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
      const target = m[1];
      if (/^(https?:|data:|#)/.test(target)) continue;
      if (!existsSync(join(dirname(f), target.split(/[#?]/)[0]))) fail(`html: ${rel(root, f)} references a missing file: ${target}`);
    }
    for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc=/.test(m[1])) fail(`html: inline script in ${rel(root, f)}`);
      else if (!/type="module"/.test(m[1])) fail(`html: script in ${rel(root, f)} must be type="module"`);
    }
    if (/\son[a-z]+\s*=/i.test(text)) fail(`html: inline event handler in ${rel(root, f)}`);
    if (/\sstyle\s*=/i.test(text)) fail(`html: inline style attribute in ${rel(root, f)}`);
  }
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    const text = read(f);
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/g)) {
      const target = m[1] ?? m[2];
      if (/^(https?:|data:|#)/.test(target)) continue;
      if (!existsSync(join(dirname(f), target))) fail(`css: ${rel(root, f)} references a missing file: ${target}`);
    }
  }

  // A control character in source is almost always a mistake (a lost escape).
  for (const f of textFiles) {
    const text = read(f);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 32 && c !== 9 && c !== 10 && c !== 13) {
        fail(`code: control character U+${c.toString(16).padStart(4, '0').toUpperCase()} in ${rel(root, f)} at offset ${i}`);
        break;
      }
    }
  }

  // One file, one line ending. A whole CRLF file (a Windows checkout) is fine, the package writes LF; a mix is a bad merge.
  for (const f of textFiles) {
    const text = read(f);
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/\n/g) ?? []).length - crlf;
    if (crlf && lf) fail(`code: mixed line endings in ${rel(root, f)} (${crlf} CRLF, ${lf} LF)`);
  }

  // Code rules
  const jsFiles = files.filter((f) => f.endsWith('.js'));
  for (const f of jsFiles) {
    const text = read(f);
    const first = text.split('\n').find((line) => line.trim() !== '') ?? '';
    if (first.trim() !== '// @ts-check') fail(`code: ${rel(root, f)} must start with // @ts-check`);
    for (const [re, name] of JS_BANNED) {
      if (re.test(text)) fail(`code: ${name} is not allowed (${rel(root, f)})`);
    }
    // No regular expression is built at run time from settings, page text or addresses. A constant pattern at the top
    // level of a listed file is the one exception.
    for (const line of text.split('\n')) {
      if (!/\bRegExp\s*\(/.test(line)) continue;
      const top = /^const [A-Z][A-Z0-9_]* = new RegExp\(/.test(line);
      if (!(top && REGEXP_CONSTANT_FILES.has(rel(root, f)))) fail(`code: RegExp built at run time (${rel(root, f)}): ${line.trim().slice(0, 80)}`);
    }
  }

  // Physical direction in UI CSS
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    const r = rel(root, f);
    if (!/^extension\/(pages|shared)\//.test(r)) continue;
    const text = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const re of PHYSICAL_CSS) {
      if (re.test(text)) fail(`css: physical direction property in ${r} (use logical properties)`);
    }
  }

  // URLs
  const allowFile = join(root, 'scripts', 'url-allowlist.txt');
  const allowed = existsSync(allowFile) ? read(allowFile).split('\n').map((s) => s.trim()).filter(Boolean) : [];
  for (const f of textFiles) {
    for (const m of read(f).matchAll(/https?:\/\/[A-Za-z0-9][^\s"'`)<>]*/g)) {
      if (!allowed.some((a) => m[0].startsWith(a))) fail(`url: not on the allowlist: ${m[0]} (${rel(root, f)})`);
    }
  }

  // Permissions
  const declared = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
  const hosts = manifest.host_permissions ?? [];
  const codeText = jsFiles.map(read).join('\n');
  const docFile = join(root, 'technical-docs', 'permissions-and-publication.md');
  const doc = existsSync(docFile) ? read(docFile) : null;
  for (const p of declared) {
    if (FORBIDDEN_PERMISSIONS.has(p)) fail(`permission: ${p} is forbidden by the design`);
    if (REQUIRED_FORBIDDEN.has(p) && (manifest.permissions ?? []).includes(p)) fail(`permission: ${p} must be optional`);
    const use = PERMISSION_USE[p];
    if (!use) fail(`permission: ${p} has no usage rule in validate.mjs`);
    else if (!use.test(codeText)) fail(`permission: ${p} is declared but unused in code`);
  }

  // Every permission and host has a row in the privacy policy and in the permissions document, and every row
  // belongs to a permission of the Chrome manifest or of the Firefox manifest generated from it.
  let firefoxNames = [];
  try {
    const fx = toFirefoxManifest(manifest);
    firefoxNames = [...(fx.permissions ?? []), ...(fx.optional_permissions ?? [])];
    const gecko = fx.browser_specific_settings?.gecko;
    const android = fx.browser_specific_settings?.gecko_android;
    if (!gecko?.strict_min_version || android?.strict_min_version !== gecko.strict_min_version) {
      fail('manifest: the Firefox manifest needs gecko_android.strict_min_version equal to the desktop minimum');
    }
  } catch (error) {
    fail(`manifest: the Firefox manifest cannot be generated (${error.message})`);
  }
  const everyName = new Set([...declared, ...firefoxNames, ...hosts]);
  if (doc) {
    const rows = new Set([...doc.matchAll(/^\| (?:host )?`([^`]+)` \|/gm)].map((m) => m[1]));
    for (const name of [...declared, ...hosts]) {
      if (!rows.has(name)) fail(`permission: ${name} has no row in permissions-and-publication.md`);
    }
    for (const name of rows) {
      if (!everyName.has(name)) fail(`permission: ${name} has a row in permissions-and-publication.md but is not declared`);
    }
  }
  const privacyFile = join(root, 'docs', 'PRIVACY.md');
  if (!existsSync(privacyFile)) fail('permission: docs/PRIVACY.md is missing');
  else {
    const section = /^## Permissions\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(read(privacyFile))?.[1] ?? '';
    const labels = new Set([...section.matchAll(/^\| ([^|\n]+?) \|/gm)].map((m) => m[1]).filter((l) => l !== 'Permission' && !/^-+$/.test(l)));
    const needed = new Set();
    for (const name of everyName) {
      const label = PRIVACY_LABEL[name];
      if (!label) fail(`permission: ${name} has no label for docs/PRIVACY.md in validate.mjs`);
      else {
        needed.add(label);
        if (![...labels].some((l) => l === label || l.startsWith(`${label},`))) fail(`permission: ${name} has no row "${label}" in docs/PRIVACY.md`);
      }
    }
    for (const l of labels) {
      if (![...needed].some((n) => l === n || l.startsWith(`${n},`))) fail(`permission: docs/PRIVACY.md has a row "${l}" for a permission that is not declared`);
    }
  }

  // Locales (page catalogs)
  const localeDir = join(extDir, 'shared', 'locales');
  const catalogs = {};
  for (const f of walk(localeDir).filter((x) => x.endsWith('.js'))) {
    catalogs[basename(f, '.js')] = (await import(`${pathToFileURL(f).href}?t=${Date.now()}`)).default;
  }
  const i18nFile = join(extDir, 'shared', 'i18n.js');
  const listed = existsSync(i18nFile)
    ? (await import(`${pathToFileURL(i18nFile).href}?t=${Date.now()}`)).LOCALES
    : [];
  if (keysOf(Object.fromEntries(listed.map((l) => [l, 1]))).join() !== Object.keys(catalogs).sort().join()) {
    fail(`i18n: LOCALES (${[...listed].sort()}) and catalog files (${Object.keys(catalogs).sort()}) differ`);
  }
  const en = catalogs.en;
  if (!en) fail('i18n: the English catalog is missing');
  else {
    for (const [code, cat] of Object.entries(catalogs)) {
      const a = keysOf(en).join('|');
      const b = keysOf(cat).join('|');
      if (a !== b) {
        const missing = keysOf(en).filter((k) => !(k in cat));
        const extra = keysOf(cat).filter((k) => !(k in en));
        fail(`i18n: ${code} differs from en (missing: ${missing.join(',') || '-'}; extra: ${extra.join(',') || '-'})`);
      }
      for (const [k, v] of Object.entries(cat)) {
        if (typeof v !== 'string' || v.trim() === '') fail(`i18n: ${code}.${k} is empty`);
        else if (en[k] !== undefined && placeholders(v) !== placeholders(en[k])) {
          fail(`i18n: ${code}.${k} has different placeholders from en`);
        }
      }
    }
    const used = new Set();
    for (const f of files) {
      if (!['.js', '.html'].includes(extname(f))) continue;
      const text = read(f);
      for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
      for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1]);
    }
    for (const k of used) if (!(k in en)) fail(`i18n: key used in code but missing in en: ${k}`);
    for (const k of Object.keys(en)) if (!used.has(k)) fail(`i18n: orphan key never used in code: ${k}`);
  }

  // Locales (browser level)
  const browserLocales = existsSync(join(extDir, '_locales')) ? readdirSync(join(extDir, '_locales')).sort() : [];
  if (browserLocales.join() !== [...listed].sort().join()) {
    fail(`_locales: folders (${browserLocales}) differ from LOCALES (${[...listed].sort()})`);
  }
  const enMsg = existsSync(join(extDir, '_locales', 'en', 'messages.json'))
    ? JSON.parse(read(join(extDir, '_locales', 'en', 'messages.json')))
    : null;
  if (!enMsg) fail('_locales: en/messages.json is missing');
  else {
    for (const code of browserLocales) {
      const file = join(extDir, '_locales', code, 'messages.json');
      if (!existsSync(file)) {
        fail(`_locales: ${code}/messages.json is missing`);
        continue;
      }
      const msg = JSON.parse(read(file));
      if (keysOf(msg).join('|') !== keysOf(enMsg).join('|')) fail(`_locales: ${code} keys differ from en`);
      for (const [k, v] of Object.entries(msg)) {
        if (!v?.message || v.message.trim() === '') fail(`_locales: ${code}.${k} is empty`);
      }
    }
    for (const m of read(join(extDir, 'manifest.json')).matchAll(/__MSG_(\w+)__/g)) {
      if (!(m[1] in enMsg)) fail(`_locales: manifest uses a missing message: ${m[1]}`);
    }
  }

  // Data
  const dataIndex = join(extDir, 'data', 'index.json');
  if (existsSync(dataIndex)) {
    try {
      const idx = JSON.parse(read(dataIndex));
      if (typeof idx.version !== 'number') fail('data: index.json needs a numeric version');
    } catch (error) {
      fail(`data: index.json is not valid JSON (${error.message})`);
    }
  }

  return errors;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = await runChecks(root);
  if (errors.length) {
    console.error(errors.map((e) => `FAIL ${e}`).join('\n'));
    console.error(`\n${errors.length} problem(s)`);
    process.exit(1);
  }
  console.log('validate: all checks passed');
}
