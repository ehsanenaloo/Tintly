import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/rewrite.js', 'engine/sitedark.js', 'engine/sitetheme.js', 'engine/sheettext.js');
const S = dk.sitedark;

/** The rewritten selector list of a rule, as an array. */
const moved = (selector) => S.rewriteSelectors(selector);

test('a dark state on the root or the body is replaced by an always true condition of the same weight', () => {
  assert.equal(moved('html.dark body'), 'html:not(.dk-x) body');
  assert.equal(moved('body.dark-mode'), 'body:not(.dk-x)');
  assert.equal(moved(':root[data-theme=dark] .card'), ':root:not(.dk-x) .card');
  assert.equal(moved('[data-theme="dark"] .card'), ':not(.dk-x) .card');
  assert.equal(moved('[data-bs-theme=dark] .navbar'), ':not(.dk-x) .navbar');
  assert.equal(moved('html[data-color-mode=dark]'), 'html:not(.dk-x)');
  assert.equal(moved('[data-mode="dark"] a'), ':not(.dk-x) a');
  assert.equal(moved('.theme-dark .x'), ':not(.dk-x) .x');
  assert.equal(moved('.dark > .x'), ':not(.dk-x) > .x');
  assert.equal(moved('.dark-mode .x'), ':not(.dk-x) .x');
});

test('the weight of the selector does not change', () => {
  // A class and an attribute selector weigh (0,1,0), and so does :not() of a class.
  assert.equal(moved('.dark .a'), ':not(.dk-x) .a');
  assert.equal(moved('html.dark .a'), 'html:not(.dk-x) .a');
  assert.equal(moved('html[data-theme=dark]:not(.x) .a'), 'html:not(.dk-x):not(.x) .a');
});

test('a bare state styles the root or the body, not every element', () => {
  assert.equal(moved('.dark'), ':where(html,body):not(.dk-x)');
  assert.equal(moved('[data-theme=dark]'), ':where(html,body):not(.dk-x)');
  assert.equal(moved('.dark, .other'), ':where(html,body):not(.dk-x)');
});

test('a list keeps only the selectors that hold a dark state', () => {
  assert.equal(moved('.a, .dark .b, html.dark .c'), ':not(.dk-x) .b,html:not(.dk-x) .c');
  assert.equal(moved('.a, .b'), '');
});

test('light states and component variants are left alone', () => {
  assert.equal(moved('[data-theme=light] .a'), '');
  assert.equal(moved('html.light body'), '');
  assert.equal(moved('.card.dark'), '');
  assert.equal(moved('.card.dark .title'), '');
  assert.equal(moved('#app.dark .x'), '');
  assert.equal(moved('.x .dark .y'), '');
  assert.equal(moved('.darkroom .a'), '');
  assert.equal(moved('[data-other=dark] .a'), '');
  assert.equal(moved('a[href*="dark"]'), '');
});

test('a list of states on the element itself is read (class strategy of utility frameworks)', () => {
  assert.equal(moved('.dark\\:bg-black:where(.dark,.dark *)'), '.dark\\:bg-black:where(*)');
  assert.equal(moved('.dark\\:text-white:is(.dark,.dark *)'), '.dark\\:text-white:not(.dk-x)');
  assert.equal(moved('.x:where([data-theme=dark], [data-theme=dark] *)'), '.x:where(*)');
});

test('strings, escapes and groups in a selector are not mistaken for a state', () => {
  assert.equal(moved('[data-x="a .dark b"] .y'), '');
  assert.equal(moved('.a:not(.dark) .b'), '');
  assert.equal(moved('.dark\\:x'), '');
});

test('a media query for the dark scheme gives the rest of its condition', () => {
  assert.equal(S.darkMedia('(prefers-color-scheme: dark)'), '');
  assert.equal(S.darkMedia(' (prefers-color-scheme:dark) '), '');
  assert.equal(S.darkMedia('screen and (prefers-color-scheme: dark)'), 'screen');
  assert.equal(S.darkMedia('(prefers-color-scheme: dark) and (min-width: 600px)'), '(min-width: 600px)');
  assert.equal(S.darkMedia('(min-width: 600px) and (prefers-color-scheme: dark)'), '(min-width: 600px)');
  assert.equal(S.darkMedia('(prefers-color-scheme: light)'), null);
  assert.equal(S.darkMedia('(min-width: 600px)'), null);
  assert.equal(S.darkMedia('print, (prefers-color-scheme: dark)'), null);
  assert.equal(S.darkMedia('not (prefers-color-scheme: dark)'), null);
  assert.equal(S.darkMedia('(prefers-color-scheme: dark) and (prefers-color-scheme: light)'), null);
  assert.equal(S.unwrappedHead(''), '@media screen');
  assert.equal(S.unwrappedHead('screen'), '@media screen');
  assert.equal(S.unwrappedHead('(min-width: 600px)'), '@media (min-width: 600px)');
});

test('addresses in a copy are made absolute', () => {
  assert.equal(S.absolutize('a{background:url(i/a.png)}', 'https://a.test/css/x.css'), 'a{background:url("https://a.test/css/i/a.png")}');
  assert.equal(S.absolutize("a{background:url('../b.svg') ,url(\"/c.png\")}", 'https://a.test/css/x.css'), 'a{background:url("https://a.test/b.svg") ,url("https://a.test/c.png")}');
  assert.equal(S.absolutize('a{background:url(data:image/png;base64,AAAA)}', 'https://a.test/x.css'), 'a{background:url(data:image/png;base64,AAAA)}');
  assert.equal(S.absolutize('a{fill:url(#g)}', 'https://a.test/x.css'), 'a{fill:url(#g)}');
});

/** Run the text reader with the dark stream on. */
function read(css, base = 'https://a.test/dir/x.css') {
  const rw = dk.rewrite.createRewriter(dk.color.createTransformer(dk.color.createTheme({})));
  const reader = dk.sheettext.createReader({ rw, isControl: () => false, maxRules: 60000, maxDepth: 32, chunkChars: 40000 });
  const run = reader.start(css, base, { rules: 0, capped: false }, true);
  let step = run.steps.next();
  while (!step.done) step = run.steps.next(typeof step.value === 'object' ? '' : undefined);
  return { themed: run.state.out.join(''), site: run.state.site.join(''), found: step.value.found, verdict: step.value };
}

test('the reader writes the dark media rules unwrapped, in a plain screen media block', () => {
  const r = read(':root{--bg:#fff}@media (prefers-color-scheme: dark){:root{--bg:#111;color:#eee}.a{background:url(i.png)}}');
  assert.equal(r.verdict.ok, true);
  assert.equal(r.site, '@media screen{:root{--bg:#111;color:#eee}.a{background:url("https://a.test/dir/i.png")}}');
  assert.equal(r.found.media, 1);
  assert.equal(r.found.rules, 2);
  // The themed stream still holds the rule, as before.
  assert.match(r.themed, /@media \(prefers-color-scheme: dark\)\{/);
});

test('the reader keeps the layer and the support condition around a dark rule', () => {
  const r = read('@layer theme{@media (prefers-color-scheme: dark){.a{color:#fff}}}@supports (display:grid){.dark .b{color:#fff}}');
  assert.equal(r.site, '@layer theme{@media screen{.a{color:#fff}}}@supports (display:grid){:not(.dk-x) .b{color:#fff}}');
});

test('the reader writes state rules with the state made always true', () => {
  const r = read('.a{color:#000}[data-theme=dark] .a{color:#fff;background:#000}html.dark{color-scheme:dark}[data-theme=light] .a{color:#111}');
  assert.equal(r.site, ':not(.dk-x) .a{color:#fff;background:#000}html:not(.dk-x){color-scheme:dark}');
  assert.equal(r.found.state, 2);
  assert.equal(r.found.scheme, 1);
});

test('the reader counts color-scheme and light-dark, and notes only light', () => {
  const r = read(':root{color-scheme:light dark;--c:light-dark(#fff,#000)}body{color:light-dark(#111,#eee);background:light-dark(white,black)}');
  assert.equal(r.found.scheme, 1);
  assert.equal(r.found.lightDark, 3);
  const only = read(':root{color-scheme:only light}');
  assert.equal(only.found.onlyLight, 1);
  assert.equal(only.found.scheme, 0);
  assert.equal(S.schemeOnlyLight('light only'), true);
  assert.equal(S.schemeOnlyLight('only light'), true);
  assert.equal(S.schemeOnlyLight('light dark'), false);
  assert.equal(S.schemeOnlyLight('dark only'), false);
  const plain = read('.a{color:#000;width:3px}');
  assert.deepEqual([plain.found.media, plain.found.state, plain.found.scheme, plain.found.lightDark, plain.found.rules], [0, 0, 0, 0, 0]);
  assert.equal(plain.site, '');
});

test('without the dark stream the reader writes exactly what it wrote before', () => {
  const css = '@media (prefers-color-scheme: dark){.a{color:#fff}}.dark .b{color:#fff}:root{color-scheme:dark}';
  const rw = dk.rewrite.createRewriter(dk.color.createTransformer(dk.color.createTheme({})));
  const reader = dk.sheettext.createReader({ rw, isControl: () => false, maxRules: 60000, maxDepth: 32, chunkChars: 40000 });
  const run = reader.start(css, 'https://a.test/x.css', { rules: 0, capped: false });
  let step = run.steps.next();
  while (!step.done) step = run.steps.next();
  assert.equal(run.state.site.length, 0);
  assert.equal(step.value.found, null);
  const withSite = read(css);
  assert.equal(run.state.out.join(''), withSite.themed);
});

test('addresses are made absolute in url() and in the strings of image-set(), and nowhere else', () => {
  const base = 'https://a.test/css/x.css';
  assert.equal(S.absolutize('a{background-image:image-set("i/a.png" 1x,\'i/b.png\' 2x)}', base), 'a{background-image:image-set("https://a.test/css/i/a.png" 1x,"https://a.test/css/i/b.png" 2x)}');
  assert.equal(S.absolutize('a{background-image:-webkit-image-set(url(i/a.png) 1x)}', base), 'a{background-image:-webkit-image-set(url("https://a.test/css/i/a.png") 1x)}');
  // A string that only names a type inside image-set() is not an address.
  assert.equal(S.absolutize('a{background-image:image-set("a.avif" type("image/avif"))}', base), 'a{background-image:image-set("https://a.test/css/a.avif" type("image/avif"))}');
  // Text in a content string stays text.
  assert.equal(S.absolutize('a::before{content:"url(x.png)";background:url(y.png)}', base), 'a::before{content:"url(x.png)";background:url("https://a.test/css/y.png")}');
  assert.equal(S.absolutize("a::after{content:'see url(z)'}", base), "a::after{content:'see url(z)'}");
  // An escaped parenthesis is part of the address.
  assert.equal(S.absolutize('a{background:url(i/a\\)b.png) no-repeat}', base), 'a{background:url("https://a.test/css/i/a)b.png") no-repeat}');
  assert.equal(S.absolutize('a{background:url("i/q\\"x.png")}', base), 'a{background:url("https://a.test/css/i/q%22x.png")}');
  // A comment is not read.
  assert.equal(S.absolutize('a{/* url(c.png) */color:red}', base), 'a{/* url(c.png) */color:red}');
  assert.equal(S.absolutize('a{background:URL(i.png)}', base), 'a{background:url("https://a.test/css/i.png")}');
});
