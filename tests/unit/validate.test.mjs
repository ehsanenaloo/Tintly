import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../../scripts/validate.mjs';
import { makeTree, REPO } from '../helpers/tree.mjs';

async function errorsAfter(mutate) {
  const tree = makeTree();
  try {
    mutate(tree);
    return await runChecks(tree.dir);
  } finally {
    tree.remove();
  }
}

const withManifest = (change) => (tree) => {
  const m = JSON.parse(tree.read('extension/manifest.json'));
  change(m);
  tree.write('extension/manifest.json', JSON.stringify(m, null, 2));
};

test('the repository passes every check', async () => {
  assert.deepEqual(await runChecks(REPO), []);
});

test('an unused permission fails', async () => {
  const errors = await errorsAfter(withManifest((m) => (m.optional_permissions = ['fontSettings'])));
  assert.ok(errors.some((e) => e.includes('fontSettings') && e.includes('unused')), errors.join('\n'));
});

test('a forbidden permission fails', async () => {
  const errors = await errorsAfter(withManifest((m) => m.permissions.push('tabs')));
  assert.ok(errors.some((e) => e.includes('tabs') && e.includes('forbidden')));
});

test('alarms may only be an optional permission', async () => {
  const errors = await errorsAfter(
    withManifest((m) => {
      m.optional_permissions = m.optional_permissions.filter((p) => p !== 'alarms');
      m.permissions.push('alarms');
    }),
  );
  assert.ok(errors.some((e) => e.includes('alarms') && e.includes('must be optional')), errors.join('\n'));
});

test('the optional alarms permission needs its row in the privacy policy', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'docs/PRIVACY.md';
    tree.write(f, tree.read(f).replace(/^\| Alarms, optional \|.*\r?\n/m, ''));
  });
  assert.ok(errors.some((e) => e.includes('alarms') && e.includes('PRIVACY.md')), errors.join('\n'));
});

test('an inline script fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'extension/pages/popup/popup.html';
    tree.write(f, tree.read(f).replace('</body>', '<script>alert(1)</script></body>'));
  });
  assert.ok(errors.some((e) => e.includes('inline script')));
});

test('a script without type module fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'extension/pages/popup/popup.html';
    tree.write(f, tree.read(f).replace(' type="module"', ''));
  });
  assert.ok(errors.some((e) => e.includes('type="module"')));
});

test('a missing locale key fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'extension/shared/locales/fa.js';
    tree.write(f, tree.read(f).replace(/\s*"fixes\.title": "[^"]*",/, ''));
  });
  assert.ok(errors.some((e) => e.includes('fa differs from en')));
});

test('a lost placeholder fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'extension/shared/locales/en.js';
    tree.write(f, tree.read(f).replace('"Site fixes"', '"Site {count} fixes"'));
  });
  assert.ok(errors.some((e) => e.includes('placeholders')));
});

test('an empty browser-level message fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'extension/_locales/he/messages.json';
    const m = JSON.parse(tree.read(f));
    m.extName.message = ' ';
    tree.write(f, JSON.stringify(m));
  });
  assert.ok(errors.some((e) => e.includes('he.extName is empty')));
});

test('a version mismatch fails', async () => {
  const errors = await errorsAfter((tree) => {
    const pkg = JSON.parse(tree.read('package.json'));
    pkg.version = '9.9.9';
    tree.write('package.json', JSON.stringify(pkg));
  });
  assert.ok(errors.some((e) => e.includes('version')));
});

test('a forbidden root file fails', async () => {
  const errors = await errorsAfter((tree) => tree.write('notes.txt', 'x'));
  assert.ok(errors.some((e) => e.includes('notes.txt')));
});

test('innerHTML and eval fail', async () => {
  const errors = await errorsAfter((tree) => {
    tree.write('extension/shared/bad.js', '// @ts-check\nel.innerHTML = x;\neval(y);\n');
  });
  assert.ok(errors.some((e) => e.includes('innerHTML')));
  assert.ok(errors.some((e) => e.includes('eval')));
});

test('a js file without ts-check fails', async () => {
  const errors = await errorsAfter((tree) => tree.write('extension/shared/plain.js', 'export const a = 1;\n'));
  assert.ok(errors.some((e) => e.includes('@ts-check')));
});

test('a physical direction property in UI css fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'extension/shared/ui.css';
    tree.write(f, `${tree.read(f)}\n.x { margin-left: 4px; }\n`);
  });
  assert.ok(errors.some((e) => e.includes('physical direction')));
});

test('a url that is not on the allowlist fails', async () => {
  const errors = await errorsAfter((tree) =>
    tree.write('extension/shared/net.js', "// @ts-check\nexport const u = 'https://example.org/x';\n"),
  );
  assert.ok(errors.some((e) => e.includes('example.org')));
});

test('a content script with import fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'extension/content/core/boot.js';
    tree.write(f, `${tree.read(f)}\nimport './x.js';\n`);
  });
  assert.ok(errors.some((e) => e.includes('import or export')));
});

test('a changed CSP fails', async () => {
  const errors = await errorsAfter(
    withManifest((m) => (m.content_security_policy.extension_pages = "script-src 'self' 'unsafe-eval'")),
  );
  assert.ok(errors.some((e) => e.includes('CSP')));
});

test('a missing referenced file fails', async () => {
  const errors = await errorsAfter(withManifest((m) => (m.icons['16'] = 'icons/none.png')));
  assert.ok(errors.some((e) => e.includes('icons/none.png')));
});

test('an unknown UI key and an orphan key fail', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'extension/pages/popup/popup.html';
    tree.write(f, tree.read(f).replace('popup.master', 'popup.nothing'));
  });
  assert.ok(errors.some((e) => e.includes('popup.nothing')));
  assert.ok(errors.some((e) => e.includes('orphan')));
});

test('a regular expression built at run time fails, in a content script and in a page', async () => {
  for (const f of ['extension/content/engine/dynamic.js', 'extension/shared/dom.js']) {
    const errors = await errorsAfter((tree) => tree.write(f, `${tree.read(f)}\nconst bad = (p) => new RegExp(p);\n`));
    assert.ok(errors.some((e) => e.includes('RegExp built at run time') && e.includes(f)), errors.join('\n'));
  }
});

test('a constant pattern at the top level of the settings module passes', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'extension/shared/settings.js';
    tree.write(f, `${tree.read(f)}\nconst EXTRA = new RegExp('^a$');\n`);
  });
  assert.deepEqual(errors, []);
});

test('a content script that nobody loads fails, and so does one that is loaded twice', async () => {
  const orphan = await errorsAfter((tree) => tree.write('extension/content/engine/orphan.js', '// @ts-check\n'));
  assert.ok(orphan.some((e) => e.includes('orphan.js') && e.includes('not registered')), orphan.join('\n'));
  const twice = await errorsAfter((tree) => tree.write('extension/background/modules/register.js', tree.read('extension/background/modules/register.js').replace("'content/core/boot.js',", "'content/core/boot.js', 'content/engine/images.js',")));
  assert.ok(twice.some((e) => e.includes('images.js') && e.includes('also injected')), twice.join('\n'));
});

test('a control character in source fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'extension/content/engine/rewrite.js';
    tree.write(f, tree.read(f).replace('use strict', 'use' + String.fromCharCode(8) + 'strict'));
  });
  assert.ok(errors.some((e) => e.includes('control character U+0008')), errors.join(String.fromCharCode(10)));
});

test('SEC: the static check refuses more ways to turn text into code or markup', async () => {
  const bad = {
    'setTimeout with a string': "setTimeout('run()', 1);",
    'setInterval with a template': 'setInterval(`run()`, 1);',
    'Function call': 'const f = Function("return 1");',
    'createContextualFragment': 'range.createContextualFragment(x);',
    'DOMParser': 'new DOMParser().parseFromString(x, "text/html");',
    'srcdoc': 'frame.srcdoc = x;',
    'inline handler attribute': "el.setAttribute('onclick', x);",
    'importScripts': 'importScripts("a.js");',
    'Worker': 'new Worker("a.js");',
  };
  for (const [name, code] of Object.entries(bad)) {
    const tree = makeTree();
    try {
      tree.write('extension/shared/bad.js', `// @ts-check\n${code}\n`);
      const errors = await runChecks(tree.dir);
      assert.ok(errors.some((e) => e.includes('bad.js') && e.startsWith('code:')), `${name} was accepted`);
    } finally {
      tree.remove();
    }
  }
});

test('a file with mixed line endings fails, a whole CRLF file does not', async () => {
  const mixed = await errorsAfter((tree) => {
    const f = 'extension/shared/dom.js';
    tree.write(f, `${tree.read(f).replace(/\r\n/g, '\n')}\r\nconst x = 1;\n`);
  });
  assert.ok(mixed.some((e) => e.includes('mixed line endings') && e.includes('dom.js')), mixed.join('\n'));
  const crlf = await errorsAfter((tree) => {
    const f = 'extension/shared/dom.js';
    tree.write(f, tree.read(f).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  });
  assert.deepEqual(crlf, []);
});

test('a permission without a row in the privacy policy fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'docs/PRIVACY.md';
    tree.write(f, tree.read(f).replace(/^\| Scripting \|.*\r?\n/m, ''));
  });
  assert.ok(errors.some((e) => e.includes('scripting') && e.includes('PRIVACY.md')), errors.join('\n'));
});

test('a host permission without a row in the privacy policy fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'docs/PRIVACY.md';
    tree.write(f, tree.read(f).replace(/^\| Access to all sites \|.*\r?\n/m, ''));
  });
  assert.ok(errors.some((e) => e.includes('<all_urls>') && e.includes('PRIVACY.md')), errors.join('\n'));
});

test('a row of the privacy policy for a permission that is not declared fails', async () => {
  const errors = await errorsAfter((tree) => {
    const f = 'docs/PRIVACY.md';
    tree.write(f, tree.read(f).replace('| Access to all sites |', '| Fonts | To read the font list |\n| Access to all sites |'));
  });
  assert.ok(errors.some((e) => e.includes('Fonts') && e.includes('PRIVACY.md')), errors.join('\n'));
});

const atVersion = (version, changelog) => (tree) => {
  const m = JSON.parse(tree.read('extension/manifest.json'));
  m.version = version;
  tree.write('extension/manifest.json', JSON.stringify(m, null, 2));
  const pkg = JSON.parse(tree.read('package.json'));
  pkg.version = version;
  tree.write('package.json', JSON.stringify(pkg, null, 2));
  if (changelog !== undefined) tree.write('CHANGELOG.md', changelog);
};
const changelogErrors = (errors) => errors.filter((e) => e.startsWith('changelog:'));

test('a development version (0.x) needs no changelog section', async () => {
  const errors = await errorsAfter(atVersion('0.9.0', '# Changelog\n\n## [Unreleased]\n'));
  assert.deepEqual(changelogErrors(errors), []);
});

test('from 1.0.0 the changelog needs a dated section for the version', async () => {
  const missing = await errorsAfter(atVersion('1.0.0', '# Changelog\n\n## [Unreleased]\n\n## [0.9.0] - 2026-01-01\n'));
  assert.equal(changelogErrors(missing).length, 1, missing.join('\n'));
  const undated = await errorsAfter(atVersion('1.0.0', '# Changelog\n\n## [1.0.0]\n'));
  assert.equal(changelogErrors(undated).length, 1);
  const wrongVersion = await errorsAfter(atVersion('1.0.1', '# Changelog\n\n## [1.0.10] - 2026-01-01\n'));
  assert.equal(changelogErrors(wrongVersion).length, 1);
  const present = await errorsAfter(atVersion('1.0.0', '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-11-01\n\n### Added\n\n- A line.\n'));
  assert.deepEqual(changelogErrors(present), []);
});

test('the manifest and package.json versions must match', async () => {
  const errors = await errorsAfter((tree) => {
    const pkg = JSON.parse(tree.read('package.json'));
    pkg.version = '9.9.9';
    tree.write('package.json', JSON.stringify(pkg, null, 2));
  });
  assert.ok(errors.some((e) => e.startsWith('version:')), errors.join('\n'));
});
