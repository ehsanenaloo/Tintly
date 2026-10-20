// The text path and the CSSOM path must write the same copy of a sheet. Every style sheet of the fixtures and of the
// extension itself, and a few generated ones, are themed once through each path and the two copies are compared after the
// browser has parsed them again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { startServers, launch, waitState, largeCss } from './harness.mjs';
import { REPO } from '../helpers/tree.mjs';

let servers;
let browser;

before(async () => {
  servers = await startServers();
  browser = await launch();
  console.log(`# browser ${browser.browserVersion}`);
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const ON = { settings: { enabled: true } };

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

/** Every `<style>` block of the fixture pages, as [name, text]. */
function fixtureStyles() {
  const out = [];
  for (const file of walk(join(REPO, 'tests', 'browser', 'fixtures'), '.html')) {
    const html = readFileSync(file, 'utf8');
    let k = 0;
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      if (m[1].trim() !== '') out.push([`${relative(join(REPO, 'tests', 'browser', 'fixtures'), file)}#${k++}`, m[1]]);
    }
  }
  for (const file of walk(join(REPO, 'tests', 'browser', 'fixtures'), '.css')) {
    out.push([relative(join(REPO, 'tests', 'browser', 'fixtures'), file), readFileSync(file, 'utf8')]);
  }
  return out;
}

const FEATURES = `
@charset "utf-8";
/* a comment with a { brace } and a "quote */
:root{--bg:#fff;--fg:#111;--rgb:12 34 56;--accent:rgb(var(--rgb) / .5)}
html{color:var(--fg);background:var(--bg)}
.a,.b>.c{color:#123;background:#fff url("a b.png") no-repeat 0 0/cover;border:1px solid #ccc;margin:0}
.d{border-top:2px dashed red;border-left:0;border-color:#000 #111;outline:2px solid blue;text-decoration:underline wavy #f00}
.e{background:linear-gradient(to right,#fff,rgba(0,0,0,.5)),url(x.png) #eee;box-shadow:0 0 4px #000,inset 0 1px #fff}
.f{background:var(--bg);border:1px solid var(--fg);color:rgb(var(--rgb))}
.f2{background:var(--bg) url(i.png);border-bottom:var(--w) solid #abc}
@media (min-width:600px) and (max-width:900px){.g{color:red}.h{background:#fafafa}}
@media print{.p{color:#000}}
@supports (display:grid){@media screen{.i{color:#ff0}}}
@layer base,theme;
@layer base{.j{color:#222}@layer inner{.k{background:#eee}}}
@layer{.anon{color:#444}}
@container card (min-width:400px){.l{color:#333;border:1px solid #ddd}}
@scope (.card) to (.foot){.m{color:#555}}
@starting-style{.n{background:#fff}}
@keyframes pulse{from{background:#fff;opacity:0}50%{color:#f00}to{background-color:#000;opacity:1}}
@keyframes plain{from{opacity:0}to{opacity:1}}
@font-face{font-family:"X";src:url(x.woff2) format("woff2")}
@property --c{syntax:"<color>";inherits:false;initial-value:#fff}
@page{margin:1cm}
.nest{color:#111;background:#fff;&:hover{color:#222}.child &{background:#eee}@media (min-width:500px){color:#333}border:1px solid #ccc;> .x{color:#444}}
.mask{background:#000;-webkit-mask:url(m.svg) center/contain no-repeat;mask:url(m.svg) center/contain no-repeat}
.bar{height:2px;background:#000}.dot{width:6px;height:6px;background-color:#222}.line{width:1px;height:20px;background:#ccc}
input,select,textarea{border:1px solid #bbb;outline:1px solid #00f;background:#fff;color:#000}
.btn:focus{outline:2px solid #1a73e8}.form-control{border-color:#ced4da}
.imp{color:red!important;background:#fff !important;border:1px solid #000 ! important}
.dup{background:#fff;background:rgba(255,255,255,.9);color:red;color:blue}
.u1{color:RED;BACKGROUND-COLOR:#FFF;Border-Color:BLUE}
.u2{--Mixed-Case:#abc;color:var(--Mixed-Case)}
.cm{color:color-mix(in srgb,#fff 50%,var(--fg));background:light-dark(#fff,#000)}
.sb{scrollbar-color:#888 #eee;caret-color:#f00;accent-color:#0f0;fill:#123;stroke:#456;stop-color:#789}
.str::before{content:"a;b}c{d";color:#fff}
.str2::after{content:'x/*y*/z';color:#eee}
.esc\\:hover\\:bg{background:#fff}
.attr[data-x="a{b}"],.attr2[title='}']{color:#999}
.url{background-image:url(data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><rect fill='%23fff'/></svg>);color:#000}
.imageset{background-image:image-set(url(a.png) 1x,url(b.png) 2x)}
.border-none{border:none;border:0}.bs{border-style:solid;border-width:1px}
.tb{background:none}.tc{background:transparent}.ti{background:inherit}.tu{border:unset}
.ws    .sel   >   .x   ~  .y   +   .z  {  color : #fff  ;  }
.pv1{border:1px solid var(--c);border-top:0}.pv2{background:var(--c) url(i.png) no-repeat;background-size:20px}.pv3{border:var(--b);border-width:2px;border-radius:3px}.pv4{outline:2px solid var(--c);outline-offset:1px!important}
.pv5{border:1px solid var(--c)}.pv5{border-width:0}.pv6{background:var(--bg);background-clip:text;color:var(--c)}.pv7{text-decoration:underline wavy var(--c);text-decoration-thickness:3px}.pv8{border-color:var(--c);border-style:solid}
.wk{-webkit-box-shadow:0 0 10px #fff}.dot2::before{content:"";width:12px;height:12px;background:#606060;display:inline-block}.dot3::after{content:'';width:40px;height:40px;background:#606060}
@property --pc{syntax:'<color>';inherits:false;initial-value:#fff}@property --pn{syntax:'<color>';inherits:true;initial-value:rgb(10 20 30)}
.nv{--n:none;--k:currentColor;--p:url(a.png)}
.part{background:hsl(var(--h) 100% 95%);color:rgb(var(--r), var(--g), var(--b));border-color:oklch(var(--l) .02 var(--h))}
.last{color:#fff}
`;

/** The generated and borrowed sheets, as [name, text]. */
function corpus() {
  const list = [...fixtureStyles(), ['features', FEATURES]];
  list.push(['gen-large-1500', largeCss(1500, 40)]);
  list.push(['gen-large-unique-600', largeCss(600, 0)]);
  let code = '';
  for (let i = 0; i < 400; i++) code += `.t${i % 5}{color:#${((i * 40503) & 0xffffff).toString(16).padStart(6, '0')}}.b${i}{background:#f6f8fa;border-left:3px solid #d0d7de}`;
  list.push(['gen-code', code]);
  for (const file of [...walk(join(REPO, 'extension'), '.css')]) {
    if (file.includes('fonts')) continue;
    list.push([`ext:${relative(join(REPO, 'extension'), file).replace(/\\/g, '/')}`, readFileSync(file, 'utf8')]);
  }
  return list;
}

/** In the page: parse a copy again and print its rules in a form that does not depend on how they were written. */
async function normalizedCopies(page) {
  return page.evaluate(() => {
    const decl = (style) => {
      const rows = [];
      for (let i = 0; i < style.length; i++) {
        const n = style[i];
        rows.push(`${n}:${style.getPropertyValue(n)}${style.getPropertyPriority(n) ? '!' : ''}`);
      }
      return rows.sort().join(';');
    };
    const flat = (rules, prefix, out) => {
      for (const r of rules) {
        const kind = r.constructor.name;
        if (kind === 'CSSStyleRule') {
          const own = decl(r.style);
          if (own !== '') out.push(`${prefix}${r.selectorText}{${own}}`);
          flat(r.cssRules, `${prefix}${r.selectorText} > `, out);
        } else if (kind === 'CSSNestedDeclarations') {
          out.push(`${prefix}(nested){${decl(r.style)}}`);
        } else if (kind === 'CSSKeyframesRule') {
          out.push(`${prefix}@keyframes ${r.name}{${[...r.cssRules].map((f) => `${f.keyText}{${decl(f.style)}}`).join('')}}`);
        } else if (r.cssRules) {
          const head = r.cssText.slice(0, r.cssText.indexOf('{')).trim();
          flat(r.cssRules, `${prefix}${head} > `, out);
        } else out.push(`${prefix}${r.cssText}`);
      }
    };
    const result = {};
    for (const node of document.querySelectorAll('[data-test-sheet]')) {
      let text = '';
      for (let el = node.nextElementSibling; el && el.getAttribute('data-dk') === 'sheet'; el = el.nextElementSibling) text += el.textContent;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      const out = [];
      flat(sheet.cssRules, '', out);
      result[node.getAttribute('data-test-sheet')] = out;
    }
    return result;
  });
}

async function addSheets(page, styles, links) {
  await page.evaluate(
    ({ styles: list, links: hrefs }) => {
      list.forEach(([name, text]) => {
        const style = document.createElement('style');
        style.setAttribute('data-test-sheet', `style:${name}`);
        style.textContent = text;
        document.head.append(style);
      });
      hrefs.forEach((href) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.setAttribute('data-test-sheet', `link:${href}`);
        document.head.append(link);
      });
    },
    { styles, links },
  );
}

async function parity(theme) {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  const url = `${servers.origin}/gen/blank.html`;
  await page.goto(url);
  await waitState(page, 'ready');
  const sheets = corpus().filter(([name, text]) => !/@import/.test(text) || name === 'features');
  const links = ['/ext/pages/popup/popup.css', '/gen/large.css?rules=400&palette=30'];
  const external = [];
  for (const href of links) {
    const r = await fetch(servers.origin + href);
    if (r.ok) external.push(href);
  }
  await addSheets(page, sheets, external.map((h) => servers.origin + h));
  // The engine themes the new sheets by itself (text path); wait until it is done with all of them.
  await page.waitForFunction(() => document.querySelectorAll('[data-test-sheet]').length > 0);
  const text = await browser.restartEngine(url, { early: false, hold: false }, theme);
  const viaText = await normalizedCopies(page);
  const cssom = await browser.restartEngine(url, { early: false, hold: false, textPath: false }, theme);
  const viaCssom = await normalizedCopies(page);
  console.log(`# text path: ${text.textSheets} sheets, ${text.textFallbacks} fallbacks ${JSON.stringify(text.textReasons)}, ${text.cssomSheets} through the CSSOM; reference run: ${cssom.cssomSheets} through the CSSOM`);
  assert.deepEqual(problems, []);
  assert.equal(cssom.textSheets, 0);
  assert.ok(text.textSheets >= sheets.length * 0.8, `only ${text.textSheets} of ${sheets.length + external.length} sheets took the text path`);

  const differences = [];
  // Stand-in layer names carry a tag that is new for each run of the engine.
  const untag = (list) => list.map((r) => r.replace(/dk-l[0-9a-z]+-(\d+)/g, 'dk-l-$1'));
  for (const name of Object.keys(viaCssom)) {
    const a = untag(viaText[name] ?? []);
    const b = untag(viaCssom[name]);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const only = (x, y) => x.filter((r) => !y.includes(r));
    differences.push(`${name}\n  text only:  ${JSON.stringify(only(a, b).slice(0, 4))}\n  cssom only: ${JSON.stringify(only(b, a).slice(0, 4))}`);
  }
  assert.deepEqual(differences, [], `${differences.length} sheets differ:\n${differences.slice(0, 12).join('\n')}`);
  const rules = Object.values(viaCssom).reduce((n, list) => n + list.length, 0);
  console.log(`# compared ${Object.keys(viaCssom).length} sheets, ${rules} rules`);
  assert.ok(rules > 3000);
  await page.close();
}

test('the text path writes the same copy as the CSSOM path for every sheet of the corpus', { timeout: 240000 }, () => parity({}));

test('the same holds for the E-ink and Paper mode, with every style and the gray levels', { timeout: 480000 }, async () => {
  await parity({ mode: 'eink', einkPreset: 'paper' });
  await parity({ mode: 'eink', einkPreset: 'eink', einkLevels: 4 });
});
