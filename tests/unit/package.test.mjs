import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, crc32, readZip } from '../../scripts/lib/zip.mjs';
import { toFirefoxManifest, GECKO_ID, GECKO_MIN_VERSION } from '../../scripts/lib/firefox-manifest.mjs';
import { listPackageFiles, packageEntries, readManifest, writePackage } from '../../scripts/lib/package-files.mjs';
import { REPO } from '../helpers/tree.mjs';

const ext = join(REPO, 'extension');

test('crc32 of a known string', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('the zip is deterministic and independent of entry order', () => {
  const a = { name: 'a.txt', data: Buffer.from('hello hello hello hello') };
  const b = { name: 'b/c.txt', data: Buffer.from('world') };
  assert.ok(createZip([a, b]).equals(createZip([b, a])));
});

test('the zip has the end record and the right count', () => {
  const zip = createZip([{ name: 'x', data: Buffer.from('1') }]);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 1);
});

test('the Firefox manifest uses background scripts and the gecko block', () => {
  const out = toFirefoxManifest(readManifest(ext));
  assert.deepEqual(out.background.scripts, ['background/service-worker.js']);
  assert.equal(out.background.service_worker, undefined);
  assert.equal(out.minimum_chrome_version, undefined);
  assert.equal(out.browser_specific_settings.gecko.id, GECKO_ID);
  assert.deepEqual(out.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
});

test('Firefox for Android is declared with the same minimum version as desktop', () => {
  const out = toFirefoxManifest(readManifest(ext));
  assert.equal(out.browser_specific_settings.gecko.strict_min_version, GECKO_MIN_VERSION);
  assert.deepEqual(out.browser_specific_settings.gecko_android, { strict_min_version: GECKO_MIN_VERSION });
});

test('Chrome-only optional permissions are removed for Firefox', () => {
  const src = { ...readManifest(ext), optional_permissions: ['contextMenus', 'fontSettings', 'geolocation'] };
  const out = toFirefoxManifest(src);
  assert.deepEqual(out.optional_permissions, ['geolocation']);
  assert.ok(out.permissions.includes('menus'));
});

test('the alarms permission is optional for Chrome and a quiet permission of the Firefox build', () => {
  const chrome = readManifest(ext);
  assert.ok(chrome.optional_permissions.includes('alarms'));
  assert.ok(!(chrome.permissions ?? []).includes('alarms'), 'never required on Chrome and Edge');
  const out = toFirefoxManifest(chrome);
  assert.ok(out.permissions.includes('alarms'), 'Firefox does not take it as an optional permission');
  assert.ok(!(out.optional_permissions ?? []).includes('alarms'));
});

test('an unknown manifest key stops the Firefox build', () => {
  assert.throws(() => toFirefoxManifest({ ...readManifest(ext), side_panel: {} }), /unknown manifest key/);
});

test('the package list has the manifest and no dotfiles', () => {
  const files = listPackageFiles(ext);
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.every((f) => !f.split('/').some((p) => p.startsWith('.'))));
});

// A Windows checkout may hold CRLF where Linux holds LF. The package must not show it.
// The source is the extension folder, which other work may change at any time: later copies come from the first one.
function copyExtension(t, toCrlf, source = ext) {
  const dir = mkdtempSync(join(tmpdir(), 'dk-pkg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'extension');
  cpSync(source, out, { recursive: true });
  for (const name of listPackageFiles(out)) {
    if (!/\.(?:js|json|html|css|svg|md|txt)$/.test(name)) continue;
    const file = join(out, name);
    const text = readFileSync(file, 'latin1').replace(/\r\n/g, '\n');
    writeFileSync(file, toCrlf ? text.replace(/\n/g, '\r\n') : text, 'latin1');
  }
  return { dir, out };
}

test('a CRLF working copy and an LF copy give byte-identical packages', (t) => {
  const lf = copyExtension(t, false);
  const crlf = copyExtension(t, true, lf.out);
  const lfPackage = writePackage('chrome', lf.out, join(lf.dir, 'dist'));
  const crlfPackage = writePackage('chrome', crlf.out, join(crlf.dir, 'dist'));
  assert.ok(readFileSync(lfPackage.file).equals(readFileSync(crlfPackage.file)));
  const lfFirefox = writePackage('firefox', lf.out, join(lf.dir, 'dist'));
  const crlfFirefox = writePackage('firefox', crlf.out, join(crlf.dir, 'dist'));
  assert.ok(readFileSync(lfFirefox.file).equals(readFileSync(crlfFirefox.file)));
});

test('the package holds no CR byte in a text file and keeps binary files as they are', (t) => {
  const crlf = copyExtension(t, true, ext);
  const entries = packageEntries(crlf.out, readManifest(crlf.out));
  for (const { name, data } of entries) {
    if (/\.(?:js|json|html|css|svg|md|txt)$/.test(name)) assert.ok(!data.includes(13), `${name} has a CR byte`);
  }
  const png = entries.find((e) => e.name.endsWith('.png'));
  assert.ok(png.data.equals(readFileSync(join(crlf.out, png.name))));
});

test('the package does not depend on file times or the order the system lists files', (t) => {
  const a = copyExtension(t, false);
  const b = copyExtension(t, false, a.out);
  utimesSync(join(b.out, 'manifest.json'), new Date(2001, 1, 1), new Date(2001, 1, 1));
  const one = createZip(packageEntries(a.out, readManifest(a.out)));
  const two = createZip(packageEntries(b.out, readManifest(b.out)).reverse());
  assert.ok(one.equals(two));
});

test('readZip returns what createZip wrote, and refuses a damaged archive', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello hello hello hello hello') },
    { name: 'b/c.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const back = readZip(createZip(entries));
  assert.deepEqual(back.map((e) => e.name), ['a.txt', 'b/c.bin', 'empty.txt']);
  for (const e of entries) assert.ok(back.find((b) => b.name === e.name).data.equals(e.data));
  assert.throws(() => readZip(Buffer.from('not a zip')), /end record/);
});
