import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/rewrite.js', 'engine/sheettext.js');

function reader(options = {}) {
  const rw = dk.rewrite.createRewriter(dk.color.createTransformer(dk.color.createTheme({})));
  return dk.sheettext.createReader({ rw, isControl: (s) => /input|button/.test(s), maxRules: 60000, maxDepth: 32, chunkChars: 40000, ...options });
}

/** Run the reader to the end. `imports` answers the @import requests in order; `null` stands for a refusal. */
function run(css, { imports = [], base = 'https://a.test/dir/x.css', options } = {}) {
  const budget = { rules: 0, capped: false };
  const { state, steps } = reader(options).start(css, base, budget);
  let step = steps.next();
  let yields = 0;
  const requests = [];
  while (!step.done) {
    if (typeof step.value === 'object') {
      requests.push(step.value.importIndex);
      step = steps.next(imports[step.value.importIndex] ?? null);
    } else {
      yields += 1;
      step = steps.next();
    }
  }
  return { out: state.out.join(''), yields, requests, budget, ...step.value };
}

const hex = '#[0-9a-f]{6}';

test('declarations are rewritten and the rest of the rule is left out', () => {
  const r = run('.a{margin:0;color:#fff;padding:1px;background-color:#000}');
  assert.equal(r.ok, true);
  assert.match(r.out, new RegExp(`^\\.a\\{color:${hex};background-color:${hex};\\}$`));
  assert.equal(run('.a{margin:0;padding:1px}').out, '');
});

test('comments, strings and braces inside them do not confuse the reader', () => {
  const r = run('/* .no{color:red} */.s::before{content:"}{;/*";color:red}.t[data-x="a{b}"]{color:blue /* c */;}');
  assert.equal(r.ok, true);
  assert.match(r.out, /^\.s::before\{color:#[0-9a-f]{6};\}\.t\[data-x="a\{b\}"\]\{color:#[0-9a-f]{6};\}$/);
  assert.equal(r.top, 2);
});

test('a shorthand is cut down to its color so it never resets the rest', () => {
  const border = run('.a{border:2px dashed #ff0000}').out;
  assert.match(border, new RegExp(`^\\.a\\{border-color:${hex};\\}$`));
  assert.ok(!/2px|dashed/.test(border));
  const bg = run('.a{background:#fff url(i.png) no-repeat 50% 50%/cover}').out;
  assert.match(bg, new RegExp(`background-image:url\\("https://a\\.test/dir/i\\.png"\\);background-color:${hex};`));
  assert.ok(!/no-repeat|cover/.test(bg));
  assert.match(run('.a{background:none}').out, /background-image:none;background-color:initial;/);
  assert.match(run('.a{background:url(a.png),url(b.png) #fff}').out, /background-image:url\("[^"]*a\.png"\),url\("[^"]*b\.png"\);background-color:#/);
  assert.match(run('.a{outline:1px solid blue}').out, /^\.a\{outline-color:#[0-9a-f]{6};\}$/);
  assert.match(run('.a{text-decoration:underline wavy red}').out, /^\.a\{text-decoration-color:#[0-9a-f]{6};\}$/);
  assert.match(run('.a{border:none}').out, /^\.a\{border-color:currentcolor;\}$/);
  assert.match(run('.a{border-block-start:0}').out, /^\.a\{border-block-start-color:initial;\}$/);
});

test('a shorthand with var() writes the color longhand only, so widths and styles of the page stay', () => {
  const out = (css) => run(css).out;
  assert.equal(out('.a{border:1px solid var(--c);border-top:0}'), '.a{border-color:var(--dk-bd--c,var(--c));border-top-color:currentcolor;}');
  assert.equal(out('.a{border:1px solid var(--c);border-width:5px}'), '.a{border-color:var(--dk-bd--c,var(--c));}');
  assert.equal(out('.a{border-bottom:2px dashed var(--c)}'), '.a{border-bottom-color:var(--dk-bd--c,var(--c));}');
  assert.equal(out('.a{outline:2px solid var(--c)}'), '.a{outline-color:var(--dk-bd--c,var(--c));}');
  assert.equal(out('.a{border:var(--w) solid red}').replace(/#[0-9a-f]{6}/, '#x'), '.a{border-color:#x;}');
  assert.match(out('.a{background:var(--c) url(i.png) no-repeat;background-size:20px 20px}'), /^\.a\{background:var\(--dk-bg--c,var\(--c\)\) url\("https:\/\/a\.test\/dir\/i\.png"\) no-repeat;background-size:20px 20px;\}$/);
  assert.match(out('.a{background:linear-gradient(var(--a),#fff) no-repeat 0 0/20px}'), /^\.a\{background-image:linear-gradient\(var\(--dk-bg--a,var\(--a\)\),#[0-9a-f]{6}\);background-color:initial;\}$/);
  assert.match(out('.a{text-decoration:underline solid var(--c)}'), /^\.a\{text-decoration-color:var\(--dk-fg--c,var\(--c\)\);\}$/);
});

test('where the place of the color is not sure, the whole shorthand is kept and what it resets is written again', () => {
  const out = (css) => run(css).out;
  assert.equal(out('.a{border:var(--b);border-width:0;border-radius:4px}'), '.a{border:var(--dk-bd--b,var(--b));border-width:0;}');
  assert.equal(out('.a{border:1px var(--c);border-top:0}'), '.a{border:1px var(--dk-bd--c,var(--c));border-top:0;border-top-color:currentcolor;}');
  assert.equal(out('.a{border-width:3px;border:var(--b)}'), '.a{border:var(--dk-bd--b,var(--b));}');
  assert.match(out('.a{background:var(--bg);background-size:cover;background-position:center!important}'), /^\.a\{background:var\(--dk-bg--bg,var\(--bg\)\);background-size:cover;background-position:center!important;\}$/);
  assert.equal(out('.a{text-decoration:var(--t);text-decoration-thickness:2px;text-underline-offset:3px}'), '.a{text-decoration:var(--dk-fg--t,var(--t));text-decoration-thickness:2px;}');
  assert.equal(out('.a{border-color:var(--c);border-width:2px}'), '.a{border-color:var(--dk-bd--c,var(--c));}');
  assert.equal(out('.a{margin:0;border:var(--b)}.b{border-width:2px}'), '.a{border:var(--dk-bd--b,var(--b));}');
});

test('a shorthand with var() is kept whole in the cases above and a custom property gets its derived declarations', () => {
  assert.match(run('.a{border:var(--b)}').out, /^\.a\{border:var\(--dk-bd--b,var\(--b\)\);\}$/);
  const custom = run(':root{--Mixed-Case:#abc}').out;
  assert.match(custom, /--dk-bg--Mixed-Case:#/);
  assert.match(custom, /--dk-fg--Mixed-Case:#/);
});

test('!important is kept, any spacing', () => {
  assert.match(run('.a{color:red ! important;background:#fff!important}').out, /color:#[0-9a-f]{6}!important;background-image:initial!important;background-color:#[0-9a-f]{6}!important;/);
});

test('groups, layers, containers, scopes and nesting are followed', () => {
  const css = '@media (min-width:600px){.b{color:red}}@supports (display:grid){@media screen{.c{color:red}}}@layer base,theme;@layer base{.d{color:red}}@layer{.e{color:red}}@container card (min-width:400px){.f{color:red}}@scope (.x) to (.y){.g{color:red}}@starting-style{.h{color:red}}';
  const r = run(css);
  assert.equal(r.ok, true);
  assert.equal(r.top, 8);
  for (const head of ['@media (min-width:600px){.b', '@supports (display:grid){@media screen{.c', '@layer base{.d', '@layer{.e', '@container card (min-width:400px){.f', '@scope (.x) to (.y){.g', '@starting-style{.h']) {
    assert.ok(r.out.includes(head), head);
  }
  const nested = run('.n{color:red;&:hover{color:blue}background-color:#000;@media (x){color:green}border:1px solid #ccc}').out;
  assert.match(nested, new RegExp(`^\\.n\\{color:${hex};&:hover\\{color:${hex};\\}background-color:${hex};@media \\(x\\)\\{color:${hex};\\}border-color:${hex};\\}$`));
});

test('keyframes are copied whole when one of them holds a color', () => {
  const r = run('@keyframes k{from{color:red;top:0}to{color:blue;top:1px}}@keyframes plain{from{top:0}to{top:1px}}');
  assert.match(r.out, /^@keyframes k\{from\{color:#[0-9a-f]{6};top:0;\}to\{color:#[0-9a-f]{6};top:1px;\}\}$/);
  assert.equal(r.top, 2);
});

test('rules without a color, font faces and properties count but write nothing', () => {
  const r = run('@charset "utf-8";@font-face{font-family:x;src:url(a)}@property --c{syntax:"<length>";inherits:false;initial-value:0px}@page{margin:1cm}.a{margin:0}');
  assert.equal(r.out, '');
  assert.equal(r.top, 4);
});

test('a mark box takes the border curve and a masked box takes the text curve', () => {
  const plain = run('.a{background:#000}').out;
  const bar = run('.a{height:2px;background:#000}').out;
  const mask = run('.a{mask:url(m.svg) center/contain;background:#000}').out;
  assert.notEqual(bar, plain);
  assert.notEqual(mask, plain);
  // A box of an ordinary size is a surface, not a mark.
  assert.equal(run('.a{height:20px;width:100px;background:#000}').out, plain);
});

test('form controls keep a floor on their borders', () => {
  assert.notEqual(run('input{border:1px solid #ddd}').out.replace('input', '.x'), run('.x{border:1px solid #ddd}').out);
});

test('urls become absolute against the base', () => {
  assert.ok(run('.a{background-image:url(../i/a.png)}', { base: 'https://a.test/css/x.css' }).out.includes('url("https://a.test/i/a.png")'));
  assert.ok(run('.a{background-image:url(data:image/png;base64,AAAA)}').out.includes('url(data:image/png;base64,AAAA)'));
});

test('an @import asks the caller, in order, and a refusal ends the read', () => {
  const css = '@charset "utf-8";@import url(a.css);@layer x;@import url(b.css) screen;.r{color:red}';
  const r = run(css, { imports: ['@media a{.i{color:red}}', ''] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.requests, [0, 1]);
  assert.ok(r.out.startsWith('@media a{.i{color:red}}.r{'));
  assert.equal(r.top, 4);
  const refused = run(css, { imports: [] });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'import');
  // An import after a rule is invalid and is not asked for.
  const late = run('.r{color:red}@import url(a.css);');
  assert.deepEqual(late.requests, []);
  assert.equal(late.top, 1);
});

test('what it does not understand makes it stop and say why', () => {
  assert.equal(run('.a{color:red}}').reason, 'stray');
  assert.equal(run('.a{content:"open\n;color:red}').reason, 'string');
  assert.equal(run('.a{content:"open').reason, 'string');
  const half = run('.a{color:red');
  assert.equal(half.ok, true);
  assert.match(half.out, /^\.a\{color:#/);
  assert.equal(run('').out, '');
  assert.equal(run('/* only a comment */').top, 0);
});

test('limits drop the sheet, as the CSSOM walk does', () => {
  let css = '';
  for (let i = 0; i < 20; i++) css += `.r${i}{color:red}`;
  const many = run(css, { options: { maxRules: 10 } });
  assert.equal(many.ok, false);
  assert.equal(many.reason, 'capped');
  assert.equal(many.budget.capped, true);
  const deep = run('@media screen{'.repeat(40) + '.p{color:red}' + '}'.repeat(40));
  assert.equal(deep.reason, 'capped');
});

test('the output comes in pieces and hostile text neither hangs nor throws', () => {
  let css = '';
  for (let i = 0; i < 3000; i++) css += `.c${i}{color:#${(i * 40503 & 0xffffff).toString(16).padStart(6, '0')};background:#fff}`;
  const r = run(css);
  assert.equal(r.ok, true);
  assert.equal(r.top, 3000);
  assert.ok(r.yields > 100);
  for (const junk of ['{'.repeat(5000), '}'.repeat(5000), '('.repeat(5000), '@'.repeat(5000), '/*'.repeat(5000), '"'.repeat(5001), '.a{' + 'b:('.repeat(4000)]) {
    const result = run(junk);
    assert.equal(typeof result.ok, 'boolean');
  }
});

test('declarations written before are remembered, per property and per kind of rule', () => {
  const r = run('.a{color:#123456}.b{color:#123456}.c{color:#123456!important}');
  const values = [...r.out.matchAll(/color:(#[0-9a-f]{6})(!important)?;/g)];
  assert.equal(values.length, 3);
  assert.equal(values[0][1], values[1][1]);
  assert.equal(values[2][2], '!important');
});

test('an unquoted address is not scanned for comments or strings', () => {
  const r = run('.a{background-image:url(data:image/svg+xml;utf8,<svg>/*x\'y</svg>);color:red}.b{color:blue}');
  assert.equal(r.ok, true);
  assert.equal(r.top, 2);
  assert.match(r.out, /\.a\{background-image:url\(data:image\/svg\+xml;utf8,<svg>\/\*x'y<\/svg>\);color:#[0-9a-f]{6};\}\.b\{color:#[0-9a-f]{6};\}/);
});

test('a byte order mark at the start is ignored', () => {
  const r = run('﻿.a{color:red}');
  assert.equal(r.ok, true);
  assert.match(r.out, /^\.a\{color:#/);
});

test('the Images module is told the selectors that set a picture, also through a custom property', () => {
  const told = [];
  const css = ':root{--tile:url("data:image/svg+xml,x")}.a{background:url(/p.png) #fff}.b{background:linear-gradient(#fff,#eee),var(--tile),#fafaff}.c{background-color:var(--c)}.d{color:red}';
  run(css, { options: { onBackground: (s) => told.push(s) } });
  assert.ok(told.includes('.a'), told.join('|'));
  assert.ok(told.includes('?.b'), told.join('|'));
  assert.ok(!told.some((s) => s.includes('.c') || s.includes('.d')), told.join('|'));
  const note = (d) => {
    const got = [];
    dk.sheettext.pictureNote(d, '.x', (v) => got.push(v));
    return got;
  };
  assert.deepEqual(note('background:url(a.png)'), ['.x']);
  assert.deepEqual(note('background-image:var(--p)'), ['?.x']);
  assert.deepEqual(note('background:#fff'), []);
  assert.deepEqual(note('mask-image:url(a.svg)'), []);
});

test('an @property rule of a color writes the derived registrations, other registered properties write nothing', () => {
  const r = run("@property --bg{syntax:'<color>';inherits:false;initial-value:#fff}@property --len{syntax:'<length>';inherits:false;initial-value:0px}.a{color:red}");
  assert.equal(r.ok, true);
  assert.equal(r.top, 3);
  assert.match(r.out, /^@property --dk-bg--bg\{syntax:"<color>";inherits:false;initial-value:#[0-9a-f]{6}\}@property --dk-fg--bg\{[^}]*\}@property --dk-bd--bg\{[^}]*\}\.a\{color:#[0-9a-f]{6};\}$/);
});

test('a prefixed box-shadow is written by the text path like the one without a prefix', () => {
  const out = run('.a{-webkit-box-shadow:0 0 10px #fff;box-shadow:0 0 10px #fff}').out;
  assert.match(out, /^\.a\{-webkit-box-shadow:0 0 10px #[0-9a-f]{6};box-shadow:0 0 10px #[0-9a-f]{6};\}$/);
  const [a, b] = out.match(/#[0-9a-f]{6}/g);
  assert.equal(a, b);
  assert.notEqual(a, '#ffffff');
});

test('a keyframe copy keeps the prefix of its rule and leaves out what a keyframe ignores', () => {
  // A keyframe ignores an important declaration: the copy must not make it count.
  const imp = run('@keyframes a{from{color:#fff!important;background:#fff}}').out;
  assert.match(imp, /^@keyframes a\{from\{background:#[0-9a-f]{6};\}\}$/);
  // A prefix the browser does not read stays as the page wrote it, so the copy stays unread too.
  assert.match(run('@-moz-keyframes b{from{color:#000}}').out, /^@-moz-keyframes b\{from\{color:#[0-9a-f]{6};\}\}$/);
  assert.match(run('@-o-keyframes c{to{color:#000}}').out, /^@-o-keyframes c\{to\{color:#[0-9a-f]{6};\}\}$/);
  assert.match(run('@-webkit-keyframes d{to{color:#000}}').out, /^@-webkit-keyframes d\{to\{color:#[0-9a-f]{6};\}\}$/);
});

test('a text color and a background in one rule keep their contrast in the copy (the pair floor)', () => {
  const C = dk.color;
  const read = (out, name) => new RegExp(`(?:^|[;{])${name}:(#[0-9a-f]{6})`).exec(out)?.[1];
  for (const css of ['.w{color:#212529;background:#ffc107}', '.w{background-color:#ffc107;color:#212529}', '.w{color:#fff;background:#1a73e8}']) {
    const out = run(css).out;
    const ratio = C.contrastRatio(C.parseColor(read(out, 'color')), C.parseColor(read(out, 'background-color')));
    assert.ok(ratio >= 4.5, `${css} -> ${out}: ${ratio.toFixed(2)}`);
  }
  // A picture over the color, or a background that is not opaque, makes no pair: the plain text color stays.
  const plain = run('.p{color:#212529}').out;
  const fg = read(plain, 'color');
  assert.equal(read(run('.w{color:#212529;background:url(a.png) #ffc107}').out, 'color'), fg);
  assert.equal(read(run('.w{color:#212529;background-color:rgba(255,193,7,.5)}').out, 'color'), fg);
});

test('a copied anonymous layer, and a layer first declared after it, get stand-in names that keep the order', () => {
  const scope = { names: new Map(), next: 0, tag: 't' };
  const namer = () => dk.rewrite.layerNamer(scope, () => false);
  const css = '@layer{.x{color:#c00}}@layer named{.x{color:#00c}}';
  const budget = { rules: 0, capped: false, layers: namer() };
  const { state, steps } = reader().start(css, 'https://a.test/x.css', budget);
  let step = steps.next();
  while (!step.done) step = steps.next();
  const out = state.out.join('');
  assert.match(out, /^@layer dk-lt-1\{\.x\{color:#[0-9a-f]{6};\}\}@layer dk-lt-2\{\.x\{color:#[0-9a-f]{6};\}\}$/);
  // A later sheet that adds to the layer writes into the same stand-in.
  const later = { rules: 0, capped: false, layers: namer() };
  const second = reader().start('@layer named{.y{color:#000}}', 'https://a.test/y.css', later);
  step = second.steps.next();
  while (!step.done) step = second.steps.next();
  assert.match(second.state.out.join(''), /^@layer dk-lt-2\{\.y\{/);
});
