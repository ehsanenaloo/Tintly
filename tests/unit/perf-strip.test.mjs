// The size rows of the performance harness count code without comments. The stripper must never touch code: strings, templates and
// regular expressions that look like comments stay whole, and every file of the extension has the same tokens before and after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import vm from 'node:vm';
import { REPO } from '../helpers/tree.mjs';
import { stripComments, codeBytes } from '../perf/strip.mjs';

test('comments go, code that looks like a comment stays', () => {
  const cases = [
    ['a = 1; // note\nb = 2;', 'a = 1; \nb = 2;'],
    ['a /* x */ = 1;', 'a   = 1;'],
    ['s = "// not a comment"; t = \'/* nor this */\';', 's = "// not a comment"; t = \'/* nor this */\';'],
    [String.raw`r = /\/\*[/]*/g; // end`, String.raw`r = /\/\*[/]*/g; `],
    ['x = a / b / c; // y', 'x = a / b / c; '],
    ['x = (a) / 2; y = [1] / 2; // z', 'x = (a) / 2; y = [1] / 2; '],
    ['x = `a // ${ b /* c */ + `d ${e} //` } /* f */`;', 'x = `a // ${ b   + `d ${e} //` } /* f */`;'],
    ['if (x) { return /re/.test(y); } // z', 'if (x) { return /re/.test(y); } '],
  ];
  for (const [input, expected] of cases) assert.equal(stripComments(input), expected, input);
});

test('a block comment over several lines leaves one line break', () => {
  assert.equal(stripComments('a\n/* one\ntwo */\nb'), 'a\n\n\nb');
  assert.equal(stripComments('a/* one\ntwo */b'), 'a\nb');
});

test('the code bytes ignore comments, line ends and blank lines', () => {
  const lf = '// header\nconst a = 1; // one\n\n/* block */\nconst b = 2;\n';
  assert.equal(codeBytes(lf), Buffer.byteLength('const a = 1;\nconst b = 2;'));
  assert.equal(codeBytes(lf.replace(/\n/g, '\r\n')), codeBytes(lf));
});

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test('every script of the extension has the same tokens without its comments', async () => {
  let acorn = null;
  try {
    acorn = await import('acorn');
  } catch {
    // The parser is a dependency of the Firefox linter; without it the check below still compiles the result.
  }
  const files = walk(join(REPO, 'extension')).filter((f) => extname(f) === '.js');
  assert.ok(files.length > 40);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const stripped = stripComments(source);
    if (acorn) {
      const tokens = (text, type) =>
        [...acorn.tokenizer(text, { ecmaVersion: 'latest', sourceType: type, allowHashBang: true })].map((t) => `${t.type.label}:${text.slice(t.start, t.end)}`);
      const type = /^\s*(import|export)\s/m.test(source) ? 'module' : 'script';
      assert.deepEqual(tokens(stripped, type), tokens(source, type), file);
    } else {
      assert.doesNotThrow(() => new vm.Script(stripped.replace(/^\s*(import|export)\s[^\n]*\n/gm, '')), file);
    }
    assert.ok(codeBytes(source) < Buffer.byteLength(source), file);
  }
});
