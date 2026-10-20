import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/rewrite.js', 'engine/sitedark.js', 'engine/sitetheme.js');
const C = dk.color;
const theme = C.createTheme({ mode: 'dark' });
const rw = dk.rewrite.createRewriter(C.createTransformer(theme));
const BASE = 'http://site.test/css/sheet.css';

const bg = (hex) => C.toCss(C.transformColor(theme, C.parseColor(hex), 'background'));
const fg = (hex) => C.toCss(C.transformColor(theme, C.parseColor(hex), 'foreground'));
const bd = (hex) => C.toCss(C.transformColor(theme, C.parseColor(hex), 'border'));

test('plain colors are rewritten by the role of the property', () => {
  assert.equal(rw.declaration('color', '#000', BASE), fg('#000'));
  assert.equal(rw.declaration('background-color', '#fff', BASE), bg('#fff'));
  assert.equal(rw.declaration('border-top-color', '#ddd', BASE), bd('#ddd'));
  assert.equal(rw.declaration('outline-color', 'red', BASE), bd('red'));
  assert.equal(rw.declaration('fill', 'rgb(0, 0, 0)', BASE), fg('#000'));
  assert.equal(rw.declaration('stop-color', 'white', BASE), bg('#fff'));
  assert.equal(rw.declaration('caret-color', 'hsl(0 0% 0%)', BASE), fg('#000'));
});

test('every color form in a shorthand is found, other words are left alone', () => {
  const out = rw.declaration('border', '1px solid #ddd', BASE);
  assert.equal(out, `1px solid ${bd('#ddd')}`);
  assert.equal(rw.declaration('border', '2px dashed red', BASE), `2px dashed ${bd('red')}`);
  assert.equal(rw.declaration('outline', 'none', BASE), 'none');
  assert.equal(rw.declaration('text-decoration', 'underline wavy blue', BASE), `underline wavy ${fg('blue')}`);
});

test('currentcolor and wide keywords stay as they are', () => {
  for (const v of ['currentcolor', 'currentColor', 'inherit', 'initial', 'unset', 'transparent']) {
    const out = rw.declaration('color', v, BASE);
    assert.ok(out === v || v === 'transparent', `${v} -> ${out}`);
  }
  assert.equal(rw.declaration('color', 'inherit', BASE), 'inherit');
});

test('gradients keep their shape and get new colors', () => {
  const out = rw.declaration('background-image', 'linear-gradient(90deg, #fff 0%, rgba(0, 0, 0, 0.5) 100%)', BASE);
  assert.equal(out, `linear-gradient(90deg, ${bg('#fff')} 0%, ${bg('rgba(0,0,0,0.5)')} 100%)`);
  const radial = rw.declaration('background', 'radial-gradient(circle at 10% 20%, red, blue), #fff', BASE);
  assert.equal(radial, `radial-gradient(circle at 10% 20%, ${bg('red')}, ${bg('blue')}), ${bg('#fff')}`);
  assert.match(rw.declaration('background-image', 'repeating-linear-gradient(45deg, #000, #fff 10px)', BASE), /^repeating-linear-gradient\(45deg, #/);
});

test('url() is made absolute against the sheet, except data, hash and blob', () => {
  assert.equal(rw.declaration('background-image', 'url(../img/a.png)', BASE), 'url("http://site.test/img/a.png")');
  assert.equal(rw.declaration('background-image', 'url("img/a b.png")', BASE), 'url("http://site.test/css/img/a%20b.png")');
  assert.equal(rw.declaration('background-image', "url('/x.svg')", BASE), 'url("http://site.test/x.svg")');
  assert.equal(rw.declaration('background-image', 'url(data:image/png;base64,AAAA)', BASE), 'url(data:image/png;base64,AAAA)');
  assert.equal(rw.declaration('fill', 'url(#grad) red', BASE), `url(#grad) ${fg('red')}`);
  assert.equal(rw.declaration('background', 'url(a.png) no-repeat red', BASE), `url("http://site.test/css/a.png") no-repeat ${bg('red')}`);
});

test('values that must not be copied give null', () => {
  assert.equal(rw.declaration('background-image', 'image-set("a.png" 1x, "b.png" 2x)', BASE), null);
  assert.equal(rw.declaration('background-image', '-webkit-image-set(url(a.png) 1x)', BASE), null);
  assert.equal(rw.declaration('color', '', BASE), null);
  assert.equal(rw.declaration('color', '   ', BASE), null);
});

test('properties that are not about color give null', () => {
  for (const p of ['width', 'margin', 'font', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'content', '']) {
    assert.equal(rw.declaration(p, '#fff', BASE), null, p);
    assert.equal(rw.isRelevant(p), false, p);
  }
});

test('var() gets a derived variable first and the original as the fallback', () => {
  assert.equal(rw.declaration('color', 'var(--ink)', BASE), 'var(--dk-fg--ink,var(--ink))');
  assert.equal(rw.declaration('background-color', 'var(--page, #fff)', BASE), `var(--dk-bg--page,var(--page, ${bg('#fff')}))`);
  assert.equal(rw.declaration('border-top-color', 'var(--line)', BASE), 'var(--dk-bd--line,var(--line))');
  assert.equal(rw.declaration('border', '1px solid var(--line)', BASE), '1px solid var(--dk-bd--line,var(--line))');
  assert.equal(rw.declaration('box-shadow', '0 0 2px var(--s), 0 0 1px #000', BASE), '0 0 2px var(--dk-sh--s,var(--dk-bg--s,var(--s))), 0 0 1px #000000');
  assert.equal(rw.declaration('color', 'var(not-a-name)', BASE), 'var(not-a-name)');
});

test('the fallback of a var() is themed too, including nested var() and colors inside gradients', () => {
  assert.equal(
    rw.declaration('background', 'var(--a, var(--b, rgb(250,250,252)))', BASE),
    `var(--dk-bg--a,var(--a, var(--dk-bg--b,var(--b, ${bg('rgb(250,250,252)')}))))`,
  );
  const gradient = rw.declaration('background-image', 'linear-gradient(var(--nope, #fff), var(--nope2, #eee))', BASE);
  assert.ok(!/#fff\b|#eee\b/.test(gradient), gradient);
  assert.equal(rw.declaration('color', 'var(--x,)', BASE), 'var(--dk-fg--x,var(--x,))');
});

test('rgb(var(--x)) and hsl(var(--x)) use a themed channel list, and a custom property with channels makes one', () => {
  assert.equal(rw.declaration('background-color', 'rgb(var(--rgb))', BASE), 'rgb(var(--dk-bg-ch--rgb,var(--rgb)))');
  assert.equal(rw.declaration('background-color', 'rgba(var(--rgb), 0.5)', BASE), 'rgba(var(--dk-bg-ch--rgb,var(--rgb)), 0.5)');
  assert.equal(rw.declaration('color', 'hsl(var(--c) / 80%)', BASE), 'hsl(var(--dk-fg-ch--c,var(--c)) / 80%)');
  const out = rw.customProperty('--rgb', '255 255 255', BASE);
  assert.match(out, /--dk-bg-ch--rgb:22 24 29;/);
  assert.match(out, /--dk-fg-ch--rgb:\d+ \d+ \d+;/);
  const commas = rw.customProperty('--rgb', '255, 255, 255', BASE);
  assert.match(commas, /--dk-bg-ch--rgb:22, 24, 29;/);
  const hsl = rw.customProperty('--surface', '0 0% 100%', BASE);
  assert.match(hsl, /--dk-bg-ch--surface:\d+ \d+% \d+%;/);
  assert.equal(rw.customProperty('--n', '300 20 10', BASE).includes('-ch--'), false);
  assert.equal(rw.customProperty('--m', '12px 4px 2px', BASE).includes('-ch--'), false);
});

test('an rgb() with a variable alpha keeps the alpha and gets the new color', () => {
  const out = rw.declaration('background-color', 'rgb(255 255 255 / var(--o, 1))', BASE);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg('#fff').slice(i, i + 2), 16));
  assert.equal(out, `rgb(${r} ${g} ${b} / var(--o, 1))`);
  // A variable in a color channel cannot be resolved here: the browser moves the color it makes.
  assert.match(rw.declaration('color', 'rgb(var(--r) 0 0)', BASE), /^oklch\(from rgb\(var\(--r\) 0 0\) calc\(/);
});

test('a black shadow stays black with a stronger alpha, a white one follows the background curve', () => {
  const out = rw.declaration('box-shadow', '0 1px 3px rgba(0, 0, 0, 0.25), inset 0 0 0 1px #fff', BASE);
  assert.equal(out, `0 1px 3px rgba(0, 0, 0, 0.4), inset 0 0 0 1px ${bg('#fff')}`);
});

test('scrollbar-color takes two colors, one per part', () => {
  assert.equal(rw.declaration('scrollbar-color', '#888 #eee', BASE), `${bd('#888')} ${bg('#eee')}`);
  assert.equal(rw.declaration('scrollbar-color', 'auto', BASE), null);
});

test('strings are never read as colors', () => {
  assert.equal(rw.declaration('background', 'url("red.png") #fff', BASE), `url("http://site.test/css/red.png") ${bg('#fff')}`);
  assert.equal(rw.declaration('text-shadow', '0 0 1px red', BASE), `0 0 1px ${bg('red')}`);
});

test('a custom property that holds colors gets three derived properties', () => {
  const out = rw.customProperty('--card', '#f6f8fa', BASE);
  assert.equal(out, `--dk-bg--card:${bg('#f6f8fa')};--dk-fg--card:${fg('#f6f8fa')};--dk-bd--card:${bd('#f6f8fa')};`);
});

test('a custom property with a gradient, a shadow or an alias is handled, other values are skipped', () => {
  assert.match(rw.customProperty('--brand', 'linear-gradient(90deg, #0b57d0, #7b3fe4)', BASE), /^--dk-bg--brand:linear-gradient\(90deg, #/);
  assert.match(rw.customProperty('--shadow', '0 1px 3px rgba(0,0,0,.25)', BASE), /^--dk-bg--shadow:0 1px 3px rgba\(/);
  assert.equal(rw.customProperty('--ink-alias', 'var(--ink)', BASE), '--dk-bg--ink-alias:var(--dk-bg--ink,var(--ink));--dk-fg--ink-alias:var(--dk-fg--ink,var(--ink));--dk-bd--ink-alias:var(--dk-bd--ink,var(--ink));');
  for (const v of ['10px', 'Roboto, sans-serif', '1.5', '"hello"', '']) assert.equal(rw.customProperty('--x', v, BASE), '', v);
});

test('!important is carried to the derived properties', () => {
  assert.equal(rw.customProperty('--c', '#fff', BASE, 'important'), `--dk-bg--c:${bg('#fff')}!important;--dk-fg--c:${fg('#fff')}!important;--dk-bd--c:${bd('#fff')}!important;`);
});

test('very long custom property names and values are skipped', () => {
  assert.equal(rw.customProperty(`--${'a'.repeat(300)}`, '#fff', BASE), '');
  assert.equal(rw.customProperty('--big', `#fff ${'x '.repeat(3000)}`, BASE), '');
});

test('broken values never throw and come back readable', () => {
  const junk = ['rgb(1, 2', 'linear-gradient(', 'url(', 'url("a', '#', '#zzz', 'var(', 'var(--a', ')))', '((((', '"', "'", 'red red red', '\\', 'rgb()', 'calc(1px + red)'];
  for (const v of junk) {
    assert.doesNotThrow(() => rw.declaration('background', v, BASE), v);
    assert.doesNotThrow(() => rw.declaration('color', v, BASE), v);
    assert.doesNotThrow(() => rw.customProperty('--x', v, BASE), v);
  }
});

test('random text never throws', () => {
  let seed = 99;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const alphabet = '#()%/,.- 0123456789abcdefrgbhslurlvar-"\'\\;{}:!';
  for (let i = 0; i < 3000; i++) {
    let s = '';
    for (let j = Math.floor(rand() * 50); j > 0; j--) s += alphabet[Math.floor(rand() * alphabet.length)];
    assert.doesNotThrow(() => rw.declaration('background', s, BASE), s);
    assert.doesNotThrow(() => rw.customProperty('--x', s, BASE), s);
  }
});

test('shorthand names are known, longhands are not', () => {
  for (const n of ['background', 'border', 'border-top', 'outline', 'text-decoration', 'column-rule']) assert.equal(rw.isShorthand(n), true, n);
  for (const n of ['color', 'background-color', 'border-top-color']) assert.equal(rw.isShorthand(n), false, n);
});

test('a light theme gives light results for the same input', () => {
  const light = C.createTheme({ mode: 'light' });
  const lrw = dk.rewrite.createRewriter(C.createTransformer(light));
  const out = lrw.declaration('background-color', '#000', BASE);
  assert.ok(C.toOklch(C.parseColor(out))[0] > 0.8);
});

const edge = (hex) => C.toCss(C.transformColor(theme, C.parseColor(hex), 'edge'));

test('outlines and the borders of form controls keep a contrast floor; other borders stay quiet', () => {
  assert.equal(rw.declaration('outline-color', '#ddd', BASE), edge('#ddd'));
  assert.equal(rw.declaration('outline', '2px solid #ddd', BASE), `2px solid ${edge('#ddd')}`);
  assert.equal(rw.declaration('border', '1px solid #ddd', BASE), `1px solid ${bd('#ddd')}`);
  assert.equal(rw.declaration('border', '1px solid #ddd', BASE, true), `1px solid ${edge('#ddd')}`);
  assert.equal(rw.declaration('border-bottom-color', '#ccc', BASE, true), edge('#ccc'));
  // The flag changes borders only.
  assert.equal(rw.declaration('background-color', '#fff', BASE, true), bg('#fff'));
  assert.equal(rw.declaration('color', '#000', BASE, true), fg('#000'));
  assert.ok(C.contrastRatio(C.parseColor(edge('#ddd')), C.surfaceColors(theme).page) >= 3);
});

test('a relative color is turned into a plain one by the resolver and then themed; without a resolver it is left alone', () => {
  const calls = [];
  const resolving = dk.rewrite.createRewriter(C.createTransformer(theme), {
    resolve: (text) => {
      calls.push(text);
      return text.includes('#fff') ? 'rgb(255, 255, 255)' : null;
    },
  });
  assert.equal(resolving.declaration('background-color', 'rgb(from #fff r g b)', BASE), bg('#fff'));
  assert.equal(resolving.declaration('background-color', 'oklch(from #fff l c h)', BASE), bg('#fff'));
  assert.equal(resolving.declaration('border', '1px solid rgb(from #fff r g b / 0.5)', BASE), `1px solid ${bd('#fff')}`);
  // A resolver that has no answer leaves the value as the page wrote it.
  assert.equal(resolving.declaration('background-color', 'rgb(from #234 r g b)', BASE), 'rgb(from #234 r g b)');
  // A value that depends on a variable is not sent to the resolver.
  calls.length = 0;
  assert.equal(resolving.declaration('color', 'rgb(from var(--x) r g b)', BASE).includes('from'), true);
  assert.deepEqual(calls, []);
  assert.equal(rw.declaration('background-color', 'rgb(from #fff r g b)', BASE), 'rgb(from #fff r g b)');
});

test('all is not a color property: a rule with all: revert adds nothing, and its expanded colors stay as they are', () => {
  assert.equal(rw.isRelevant('all'), false);
  assert.equal(rw.declaration('all', 'revert', BASE), null);
  assert.equal(rw.declaration('color', 'revert', BASE), 'revert');
  assert.equal(rw.declaration('background-color', 'revert-layer', BASE), 'revert-layer');
});

test('repair mode: a variable that is a light plain color on the root is darkened at the place of use', () => {
  const roots = { '--card': '#ffffff', '--ink': '#222222', '--dark': '#202428', '--grad': 'linear-gradient(#fff,#eee)', '--other': 'var(--card)' };
  const repairing = dk.rewrite.createRewriter(C.createTransformer(theme), { rootValue: (name) => roots[name] ?? '' });
  repairing.setRepair(true);
  const bgLook = repairing.declaration('background', 'var(--card)', BASE);
  assert.match(bgLook, /^oklch\(from var\(--card\) calc\(l - clamp/);
  assert.match(repairing.declaration('color', 'var(--ink)', BASE), /^oklch\(from var\(--ink\) calc\(l \+ clamp/);
  // A dark value, a variable of variables, an unknown name and a role without a rule are left to the page.
  assert.equal(repairing.declaration('background-color', 'var(--dark)', BASE), null);
  // A light gradient in a variable is replaced by its themed form, an unthemed call keeps the variable.
  assert.match(repairing.declaration('background-image', 'var(--grad)', BASE), /^linear-gradient\(#[0-9a-f]{6},#[0-9a-f]{6}\)$/);
  assert.equal(repairing.declaration('background', 'var(--other)', BASE), null);
  assert.equal(repairing.declaration('background', 'var(--missing)', BASE), null);
  assert.match(repairing.declaration('border-color', 'var(--card)', BASE), /^oklch\(from var\(--card\) calc\(l - clamp/);
  // The fallback of a variable that is not set is a value like any other.
  assert.match(repairing.declaration('background', 'var(--missing, #fff)', BASE), /^var\(--missing,/);
  // Without the root value, or with repair off, nothing changes.
  const plain = dk.rewrite.createRewriter(C.createTransformer(theme));
  plain.setRepair(true);
  assert.equal(plain.declaration('background', 'var(--card)', BASE), null);
});

test('the variants of a custom property come by role, and customProperty is all of them in order', () => {
  const v = rw.customVariants('--card', '#f6f8fa', BASE);
  assert.deepEqual(v.channels, ['', '', '', '']);
  assert.match(v.values[0], /^--dk-bg--card:#/);
  assert.match(v.values[1], /^--dk-fg--card:#/);
  assert.match(v.values[2], /^--dk-bd--card:#/);
  assert.equal(rw.customProperty('--card', '#f6f8fa', BASE), v.values[0] + v.values[1] + v.values[2] + v.values[3]);
  const channels = rw.customVariants('--rgb', '255 255 255', BASE);
  assert.match(channels.channels[0], /^--dk-bg-ch--rgb:/);
  assert.equal(rw.customProperty('--rgb', '255 255 255', BASE), channels.channels.join('') + channels.values.join(''));
  assert.equal(rw.customVariants('--size', '12px', BASE).free, true);
  assert.equal(rw.customVariants('--x', '', BASE), null);
});

test('the variables that the value of a custom property reads are listed for each role', () => {
  const v = rw.customVariants('--alias', 'var(--ink)', BASE);
  assert.deepEqual(v.uses.slice(0, 3), [['--ink', 1], ['--ink', 2], ['--ink', 4]]);
  assert.equal(v.uses[3], null);
  const plain = rw.customVariants('--card', '#f6f8fa', BASE);
  assert.deepEqual(plain.uses, [null, null, null, null]);
});

test('a rewriter reports the roles that a var() is read for, and does not report the reads of a custom property', () => {
  const heard = [];
  const listening = dk.rewrite.createRewriter(C.createTransformer(theme), { onUse: (name, bits) => heard.push([name, bits]) });
  listening.declaration('background-color', 'var(--page)', BASE);
  listening.declaration('color', 'var(--ink, #222)', BASE);
  listening.declaration('border-top-color', 'var(--line)', BASE);
  listening.declaration('outline-color', 'var(--ring)', BASE);
  listening.declaration('box-shadow', '0 0 4px var(--glow)', BASE);
  listening.declaration('background-color', 'rgb(var(--rgb) / 50%)', BASE);
  assert.deepEqual(heard, [['--page', 1], ['--ink', 2], ['--line', 4], ['--ring', 4], ['--glow', 9], ['--rgb', 1]]);
  heard.length = 0;
  listening.customProperty('--alias', 'var(--page)', BASE);
  listening.customVariants('--other', 'var(--page)', BASE);
  assert.deepEqual(heard, [], 'the reads of a custom property are listed with its variants instead');
});

test('repair mode: reads of the root are limited in time, and a variable the limit skipped is not remembered as plain', () => {
  let reads = 0;
  const slow = (name) => {
    reads += 1;
    const end = performance.now() + 4;
    while (performance.now() < end);
    return name === '--late' ? '#ffffff' : '#fafafa';
  };
  const repairing = dk.rewrite.createRewriter(C.createTransformer(theme), { rootValue: slow, relativeColor: true });
  repairing.setRepair(true);
  for (let i = 0; i < 100; i++) repairing.declaration('background', `var(--v${i})`, BASE);
  assert.ok(reads <= 8, `${reads} reads in a burst of 100 variables`);
  const skipped = repairing.declaration('background', 'var(--late)', BASE);
  assert.equal(skipped, null, 'a variable past the limit is left alone');
  const before = reads;
  repairing.declaration('background', 'var(--late)', BASE);
  assert.equal(reads, before, 'the limit is still on, so nothing is read');
});

test('repair mode: an answer that is not text is not remembered', () => {
  const answers = { '--card': undefined };
  let calls = 0;
  const repairing = dk.rewrite.createRewriter(C.createTransformer(theme), {
    rootValue: (name) => {
      calls += 1;
      return answers[name];
    },
    relativeColor: true,
  });
  repairing.setRepair(true);
  assert.equal(repairing.declaration('background', 'var(--card)', BASE), null);
  answers['--card'] = '#ffffff';
  assert.match(repairing.declaration('background', 'var(--card)', BASE), /^oklch\(from var\(--card\)/);
  assert.equal(calls, 2);
});

test('repair mode: without relative colors in the browser nothing is written for a variable', () => {
  const repairing = dk.rewrite.createRewriter(C.createTransformer(theme), { rootValue: () => '#ffffff', relativeColor: false });
  repairing.setRepair(true);
  assert.equal(repairing.declaration('background', 'var(--card)', BASE), null);
});

test('shorthand() names the color longhand, or keeps the whole shorthand and says so', () => {
  const sh = (name, value) => rw.shorthand(name, value, BASE);
  assert.deepEqual(sh('border', '1px solid var(--c)'), { list: [['border-color', 'var(--dk-bd--c,var(--c))']], whole: false });
  assert.deepEqual(sh('border-left', 'var(--w) solid red').list.map((p) => p[0]), ['border-left-color']);
  assert.deepEqual(sh('border', 'var(--b)'), { list: [['border', 'var(--dk-bd--b,var(--b))']], whole: true });
  assert.deepEqual(sh('border', '1px var(--c)').whole, true);
  assert.deepEqual(sh('border', 'solid var(--c)').whole, true);
  assert.deepEqual(sh('border', 'var(--w) solid var(--c)').whole, true);
  assert.deepEqual(sh('outline', '2px solid var(--c)').list, [['outline-color', 'var(--dk-bd--c,var(--c))']]);
  assert.deepEqual(sh('-webkit-text-stroke', '2px var(--c)').list, [['-webkit-text-stroke-color', 'var(--dk-fg--c,var(--c))']]);
  assert.deepEqual(sh('-webkit-text-stroke', 'var(--c)').whole, true);
  assert.deepEqual(sh('text-emphasis', 'filled var(--c)').list.map((p) => p[0]), ['text-emphasis-color']);
  assert.deepEqual(sh('text-decoration', 'underline solid var(--c)').list.map((p) => p[0]), ['text-decoration-color']);
  assert.deepEqual(sh('text-decoration', 'underline var(--c)').whole, true);
  assert.deepEqual(sh('border-color', 'var(--c)'), { list: [['border-color', 'var(--dk-bd--c,var(--c))']], whole: false });
  // Parts inside functions are not parts of the value, and a string is one word.
  assert.deepEqual(sh('border', 'calc(var(--w) * 2) solid var(--c)').list.map((p) => p[0]), ['border-color']);
  assert.deepEqual(sh('text-emphasis', '"a b" var(--c)').list.map((p) => p[0]), ['text-emphasis-color']);
  assert.equal(sh('background', 'var(--c) url(a.png)').whole, true);
  const parts = sh('background', 'linear-gradient(var(--a), #fff) no-repeat 0 0 / 5px');
  assert.deepEqual(parts.list.map((p) => p[0]), ['background-image', 'background-color']);
  assert.equal(parts.whole, false);
  assert.equal(parts.list[1][1], 'initial');
  assert.equal(dk.rewrite.resets('border', 'border-top-width'), true);
  assert.equal(dk.rewrite.resets('border', 'border-radius'), false);
  assert.equal(dk.rewrite.resets('border-top', 'border-left-width'), false);
  assert.equal(dk.rewrite.resets('background', 'background-size'), true);
  assert.equal(dk.rewrite.resets('border-color', 'border-width'), false);
});

test('a value with no color gives reset declarations that are written for the roles in demand only', () => {
  for (const value of ['none', 'currentColor', 'initial', 'CanvasText', 'url(a.png)', '12px 4px 2px', '8px']) {
    const v = rw.customVariants('--s', value, BASE);
    assert.equal(v.free, true, value);
    assert.deepEqual(v.values, ['--dk-bg--s:initial;', '--dk-fg--s:initial;', '--dk-bd--s:initial;', '--dk-sh--s:initial;'], value);
    assert.deepEqual(v.channels, ['--dk-bg-ch--s:initial;', '--dk-fg-ch--s:initial;', '--dk-bd-ch--s:initial;', '--dk-sh-ch--s:initial;'], value);
    assert.equal(rw.customProperty('--s', value, BASE), '', 'the plain builder writes nothing for it');
  }
  assert.equal(rw.customVariants('--s', 'none', BASE, 'important').values[0], '--dk-bg--s:initial!important;');
  for (const value of ['inherit', 'unset', 'revert', 'revert-layer', '', '  ']) assert.equal(rw.customVariants('--s', value, BASE), null, value);
  assert.equal(rw.customVariants('--s', '#fff', BASE).free, undefined);
  assert.equal(rw.customVariants('--s', 'var(--other)', BASE).free, undefined);
});

/** The three channel expressions of a relative look, evaluated for an origin color (l, c, h). */
function evalLook(look, prefix, l, c, h) {
  const body = look.slice(look.indexOf(prefix) + prefix.length, -1);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (body[i] === ' ' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  const clp = (a, b, x) => Math.min(Math.max(b, a), x);
  return parts.map((p) => new Function('l', 'c', 'h', 'clp', `return ${p.replace(/calc\(/g, '(').replace(/max\(/g, 'Math.max(').replace(/clamp\(/g, 'clp(')}`)(l, c, h, clp));
}

test('a color built from var() and literals is moved by a relative color that follows the transformer', () => {
  const origin = 'hsl(var(--h) 100% 95%)';
  const themes = { dark: { mode: 'dark' }, light: { mode: 'light' }, paper: { mode: 'eink', einkPreset: 'paper' } };
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const [name, th] of Object.entries(themes)) {
    const tr = C.createTransformer(C.createTheme(th));
    const own = dk.rewrite.createRewriter(tr, { relativeColor: true });
    for (const [property, role] of [['background-color', 'background'], ['color', 'foreground'], ['border-color', 'border']]) {
      const look = own.declaration(property, origin, BASE);
      assert.match(look, /^oklch\(from hsl\(var\(--h\) 100% 95%\) calc\(/, `${name} ${role}`);
      assert.ok(look.length < 2000, `${name} ${role}: ${look.length} characters`);
      assert.ok(!look.includes('pow(') && !look.includes('hypot(') && !look.includes('sqrt('), 'only functions of Chrome 119');
      let n = 0;
      let sumL = 0;
      let sumC = 0;
      let maxL = 0;
      for (let i = 0; i < 1500; i++) {
        const l = rand();
        const h = rand() * 360;
        const c = rand() < 0.3 ? rand() * 0.03 : rand() * 0.25;
        const plain = C.parseColor(`oklch(${l} ${c} ${h})`);
        if (plain.r < 0 || plain.r > 1 || plain.g < 0 || plain.g > 1 || plain.b < 0 || plain.b > 1) continue;
        const truth = C.toOklch(C.parseColor(tr.transform(`oklch(${l} ${c} ${h})`, role)));
        const [L, Cc] = evalLook(look, '95%) ', l, c, h);
        n++;
        sumL += Math.abs(L - truth[0]);
        sumC += Math.abs(Cc - truth[1]);
        maxL = Math.max(maxL, Math.abs(L - truth[0]));
      }
      assert.ok(n > 800);
      assert.ok(sumL / n < 0.004, `${name} ${role}: mean lightness error ${sumL / n}`);
      assert.ok(sumC / n < 0.012, `${name} ${role}: mean chroma error ${sumC / n}`);
      assert.ok(maxL < 0.07, `${name} ${role}: largest lightness error ${maxL}`);
    }
  }
});

test('every function that mixes var() with literals is moved, and nothing else changes', () => {
  const t = C.createTransformer(C.createTheme({ mode: 'dark' }));
  const own = dk.rewrite.createRewriter(t, { relativeColor: true });
  for (const v of ['hsl(var(--h) 100% 95%)', 'rgb(var(--r), var(--g), var(--b))', 'oklch(var(--l) .02 var(--h))', 'rgb(var(--r) var(--g) var(--b)/.9)', 'hwb(var(--h) 90% 5%)', 'rgb(from var(--c) r g b / .5)']) {
    assert.ok(own.declaration('background-color', v, BASE).startsWith(`oklch(from ${v} calc(`), v);
  }
  // A whole var() channel list, a var() alpha and color-mix keep the ways they have.
  assert.equal(own.declaration('background-color', 'rgb(var(--rgb))', BASE), 'rgb(var(--dk-bg-ch--rgb,var(--rgb)))');
  assert.match(own.declaration('background-color', 'rgb(255 255 255 / var(--o))', BASE), /^rgb\(\d+ \d+ \d+ \/ var\(--o\)\)$/);
  // Inside a gradient and a shadow too.
  assert.match(own.declaration('background-image', 'linear-gradient(hsl(var(--h) 50% 50%), #fff)', BASE), /^linear-gradient\(oklch\(from hsl\(var\(--h\) 50% 50%\) calc\(/);
  assert.match(own.declaration('box-shadow', '0 0 8px hsl(var(--h) 50% 50% / .3)', BASE), /^0 0 8px oklch\(from hsl\(var\(--h\) 50% 50% \/ \.3\) calc\(/);
  // A browser that cannot read relative colors leaves the color as the page wrote it.
  const old = dk.rewrite.createRewriter(C.createTransformer(C.createTheme({ mode: 'dark' })), { relativeColor: false });
  assert.equal(old.declaration('background-color', 'hsl(var(--h) 100% 95%)', BASE), 'hsl(var(--h) 100% 95%)');
  // Repair mode leaves it alone, because the page's dark theme sets the variables.
  const repairing = dk.rewrite.createRewriter(C.createTransformer(C.createTheme({ mode: 'dark' })), { relativeColor: true });
  repairing.setRepair(true);
  assert.equal(repairing.declaration('background-color', 'hsl(var(--h) 100% 95%)', BASE), null);
  // The look does not depend on the color: it is made once for a role.
  assert.equal(own.declaration('color', 'hsl(var(--h) 100% 95%)', BASE).replace('hsl(var(--h) 100% 95%)', '##'), own.declaration('color', 'rgb(var(--r), 0, 0)', BASE).replace('rgb(var(--r), 0, 0)', '##'));
});

test('a registered color gets registered derived variables with the themed initial value', () => {
  const out = rw.registeredText('--bg', "syntax:'<color>';inherits:false;initial-value:#fff");
  assert.equal(out, `@property --dk-bg--bg{syntax:"<color>";inherits:false;initial-value:${bg('#fff')}}@property --dk-fg--bg{syntax:"<color>";inherits:false;initial-value:${fg('#fff')}}@property --dk-bd--bg{syntax:"<color>";inherits:false;initial-value:${bd('#fff')}}`);
  assert.match(rw.registeredText('--x', '/* c */ syntax : "<color>" ; inherits : TRUE ; initial-value : rgb(10 20 30)'), /inherits:true;initial-value:#[0-9a-f]{6}\}/);
  // Registered with the CSSOM values: the syntax comes with quotes.
  assert.match(rw.registered('--x', '"<color>"', false, 'black'), /^@property --dk-bg--x\{syntax:"<color>";inherits:false;initial-value:#/);
  for (const [syntax, initial] of [['<length>', '0px'], ['*', 'red'], ['<color> | none', 'red'], ['<color>', null], ['<color>', 'var(--y)']]) assert.equal(rw.registered('--x', syntax, true, initial), '', `${syntax} ${initial}`);
  assert.equal(rw.registered('--x y', '<color>', true, 'red'), '');
  const repairing = dk.rewrite.createRewriter(C.createTransformer(theme));
  repairing.setRepair(true);
  assert.equal(repairing.registered('--x', '<color>', true, 'red'), '');
});

test('the prefixed names of box-shadow and column-rule are themed like the names without a prefix', () => {
  assert.equal(rw.declaration('-webkit-box-shadow', '0 0 10px #fff', BASE), rw.declaration('box-shadow', '0 0 10px #fff', BASE));
  assert.notEqual(rw.declaration('-webkit-box-shadow', '0 0 10px #fff', BASE), '0 0 10px #fff');
  assert.equal(rw.declaration('-webkit-column-rule-color', '#ddd', BASE), rw.declaration('column-rule-color', '#ddd', BASE));
  assert.equal(rw.isRelevant('-webkit-box-shadow'), true);
});

test('the variants are made for the roles asked for, and the parts add up to the whole', () => {
  const full = rw.customVariants('--card', '#f6f8fa', BASE);
  const one = rw.customVariants('--card', '#f6f8fa', BASE, '', 1);
  assert.deepEqual(one.values, [full.values[0], '', '', '']);
  const rest = rw.customVariants('--card', '#f6f8fa', BASE, '', 6);
  assert.deepEqual([one.values[0], rest.values[1], rest.values[2], rest.values[3]], full.values.slice(0, 3).concat(['']).map((v, i) => (i === 3 ? full.values[3] : v)));
  const shadow = rw.customVariants('--shade', '0 1px 3px rgba(0,0,0,.25)', BASE, '', 9);
  assert.deepEqual(shadow.values, rw.customVariants('--shade', '0 1px 3px rgba(0,0,0,.25)', BASE).values.map((v, i) => (i === 1 || i === 2 ? '' : v)));
  // A list of channels.
  const channels = rw.customVariants('--rgb', '12 34 56', BASE, '', 2);
  assert.deepEqual(channels.channels.map((c) => c !== ''), [false, true, false, false]);
  // A value with no color is still found out from the one role asked for.
  assert.equal(rw.customVariants('--s', 'none', BASE, '', 4).free, true);
  // Another name with the same value gets the same text.
  assert.equal(rw.customVariants('--other', '#f6f8fa', BASE, '', 1).values[0], full.values[0].replace('--card', '--other'));
});

test('a variable with a unique color costs far less when only the role in demand is made', () => {
  const hex = (i) => `#${(((i * 2654435761) >>> 8) & 0xffffff).toString(16).padStart(6, '0')}`;
  const time = (want) => {
    const own = dk.rewrite.createRewriter(C.createTransformer(C.createTheme({ mode: 'dark' })));
    const began = performance.now();
    for (let i = 0; i < 2000; i++) own.customVariants(`--c${i}`, hex(i), BASE, '', want);
    return performance.now() - began;
  };
  time(1);
  const all = time(15);
  const wanted = time(1);
  assert.ok(wanted < 1500, `${wanted.toFixed(0)} ms for 2000 variables`);
  assert.ok(wanted < all * 0.8, `${wanted.toFixed(0)} ms against ${all.toFixed(0)} ms for all the roles`);
});

test('the colors inside -webkit-gradient(), cross-fade() and image() are themed like a gradient', () => {
  const old = rw.declaration('background-image', '-webkit-gradient(linear, 0% 0%, 0% 100%, from(rgb(255, 255, 255)), color-stop(0.5, #eee), to(rgb(0, 0, 0)))', BASE);
  assert.equal(old, `-webkit-gradient(linear, 0% 0%, 0% 100%, from(${bg('#fff')}), color-stop(0.5, ${bg('#eee')}), to(${bg('#000')}))`);
  assert.equal(rw.declaration('background-image', 'cross-fade(url(a.png) 50%, #fff)', BASE), `cross-fade(url("http://site.test/css/a.png") 50%, ${bg('#fff')})`);
  assert.equal(rw.declaration('background-image', '-webkit-cross-fade(url(a.png), url(b.png), 50%)', BASE), '-webkit-cross-fade(url("http://site.test/css/a.png"), url("http://site.test/css/b.png"), 50%)');
  assert.equal(rw.declaration('background-image', 'image(#fff)', BASE), `image(${bg('#fff')})`);
  // In a background shorthand they are pictures, not the color of the layer.
  const parts = rw.shorthand('background', '-webkit-gradient(linear, 0 0, 0 100%, from(#fff), to(#eee)) #fafafa', BASE).list;
  assert.equal(parts[0][0], 'background-image');
  assert.equal(parts[1][1], bg('#fafafa'));
});

test('the pair floor moves the text color of a rule that sets an opaque background, and only then', () => {
  const ratio = (a, b) => C.contrastRatio(C.parseColor(a), C.parseColor(b));
  const paired = rw.pairColor('#212529', '#ffc107');
  assert.ok(paired !== null);
  assert.ok(ratio(rw.declaration('color', '#212529', BASE), bg('#ffc107')) < 4.5, 'the plain text color was already fine; the case proves nothing');
  assert.ok(ratio(paired, bg('#ffc107')) >= 4.5, `${paired} on ${bg('#ffc107')}`);
  // Dark text on white keeps the plain color: the floor is reached already.
  assert.equal(rw.pairColor('#222', '#fff'), null);
  assert.equal(rw.pairColor('#222', 'rgba(255, 193, 7, 0.5)'), null);
  assert.equal(rw.pairColor('var(--x)', '#ffc107'), null);
  assert.equal(rw.pairColor('#222', 'currentcolor'), null);
  assert.equal(dk.rewrite.plainBackgroundColor('#ffc107'), '#ffc107');
  assert.equal(dk.rewrite.plainBackgroundColor('none #ffc107'), '#ffc107');
  assert.equal(dk.rewrite.plainBackgroundColor('url(a.png) #ffc107'), null);
  assert.equal(dk.rewrite.plainBackgroundColor('linear-gradient(#fff, #000)'), null);
  assert.equal(dk.rewrite.plainBackgroundColor('var(--b)'), null);
});

test('the layer namer keeps the order of the layers of a sheet in its copy', () => {
  const scope = { names: new Map(), next: 0, tag: 'q' };
  const earlier = new Set(['old']);
  const namer = dk.rewrite.layerNamer(scope, (path) => earlier.has(path));
  // Before any anonymous layer, names stay.
  assert.equal(namer.open('reset'), 'reset');
  namer.close();
  assert.equal(namer.statement(['base', 'theme']), '');
  // An anonymous layer gets a name of its own.
  assert.equal(namer.open(''), 'dk-lq-1');
  // Inside a layer of our own every name is new already.
  assert.equal(namer.open('inner'), 'inner');
  namer.close();
  namer.close();
  // After it: a name seen before it, or declared by an earlier sheet, stays; a new one gets a stand-in.
  assert.equal(namer.open('base'), 'base');
  namer.close();
  assert.equal(namer.open('old.x'), 'old.x');
  namer.close();
  assert.equal(namer.open('fresh.part'), 'dk-lq-2.part');
  namer.close();
  assert.equal(namer.statement(['fresh', 'other']), '@layer dk-lq-2,dk-lq-3;');
  assert.deepEqual([...namer.paths].sort(), ['base', 'old', 'old.x', 'reset', 'theme']);
  // The next sheet of the tree uses the same stand-ins.
  const next = dk.rewrite.layerNamer(scope, () => false);
  assert.equal(next.open('fresh'), 'dk-lq-2');
  next.close();
  // Nested levels follow the same rule inside a named layer.
  const nested = dk.rewrite.layerNamer({ names: new Map(), next: 0, tag: 'n' }, () => false);
  assert.equal(nested.open('app'), 'app');
  assert.equal(nested.open(''), 'dk-ln-1');
  nested.close();
  assert.equal(nested.open('late'), 'dk-ln-2');
  nested.close();
  nested.close();
  assert.equal(nested.open('late'), 'late');
  nested.close();
});
