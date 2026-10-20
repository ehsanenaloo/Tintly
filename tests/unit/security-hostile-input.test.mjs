import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js', 'engine/rewrite.js', 'engine/sheettext.js');

/** Read a sheet text to the end and return the verdict and the time it took. */
function read(css, options = {}) {
  const rw = dk.rewrite.createRewriter(dk.color.createTransformer(dk.color.createTheme({})));
  const reader = dk.sheettext.createReader({ rw, isControl: () => false, maxRules: 60000, maxDepth: 32, chunkChars: 40000, ...options });
  const started = performance.now();
  const { state, steps } = reader.start(css, 'https://a.test/x.css', { rules: 0, capped: false });
  let step = steps.next();
  while (!step.done) step = steps.next(null);
  return { ms: performance.now() - started, out: state.out.join(''), verdict: step.value };
}

const MAX_MS = 1500;

test('SEC: a style sheet full of unterminated url( openings is read in linear time', () => {
  for (const css of [`a{background:${'url('.repeat(24000)}}`, `a{background:${'url(\)'.repeat(16000)}}`, `a{background:red}/*x*/ ${'a{background:url(x'.repeat(8000)}`]) {
    const r = read(css);
    assert.ok(r.ms < MAX_MS, `took ${Math.round(r.ms)} ms`);
  }
});

test('SEC: a comment-stripped value with many unterminated url( openings is read in linear time', () => {
  const r = read(`a{background:/* c */${'url('.repeat(24000)}}`);
  assert.ok(r.ms < MAX_MS, `took ${Math.round(r.ms)} ms`);
});

test('SEC: deeply nested var() fallbacks neither throw nor take quadratic time', () => {
  const depth = 9000;
  const r = read(`a{color:${'var(--a,'.repeat(depth)}red${')'.repeat(depth)}}`);
  assert.ok(r.ms < MAX_MS, `took ${Math.round(r.ms)} ms`);
  assert.equal(typeof r.verdict.ok, 'boolean');
});

test('SEC: a legitimate unquoted data address is still read whole', () => {
  const data = 'A'.repeat(200000);
  const r = read(`a{background:url(data:image/png;base64,${data}) red}`);
  assert.equal(r.verdict.ok, true);
  assert.ok(r.ms < MAX_MS);
  assert.ok(r.out.includes(data));
});

test('SEC: the search for shorthands that hold var() takes linear time on repeated names', () => {
  for (const css of [' background:x'.repeat(30000), '{border-a:'.repeat(30000), ' outline :'.repeat(30000)]) {
    const started = performance.now();
    dk.rewrite.parseVarShorthands(css);
    assert.ok(performance.now() - started < MAX_MS, `took ${Math.round(performance.now() - started)} ms`);
  }
});

test('SEC: shorthands that hold var() are still found, and only inside one declaration', () => {
  const found = (css) => [...dk.rewrite.parseVarShorthands(css).keys()];
  assert.deepEqual(found('.a{background:var(--x);background-color:red}'), ['.a']);
  assert.deepEqual(found('.a{BORDER-top : 1px solid var(--x)}'), ['.a']);
  assert.deepEqual(found('.a{background:red;color:var(--x)}'), []);
  assert.deepEqual(found('.a{background:red}.b{color:var(--x)}'), []);
  assert.deepEqual(found('@media screen{.a{outline:2px solid var(--c)}}'), ['.a']);
});

test('SEC: the request counters of the injector do not grow with the number of frames a page makes', async () => {
  const { createOnDemand } = await import('../../extension/background/modules/ondemand.js');
  let now = 0;
  const od = createOnDemand({ scripting: { executeScript: async () => [{}] }, now: () => now });
  for (let tab = 1; tab <= 3000; tab++) await od.inject('schedule', { tabId: tab, frameId: 1 });
  assert.ok(od.tracked >= 3000);
  now = 120_000;
  await od.inject('schedule', { tabId: 1, frameId: 1 });
  assert.ok(od.tracked < 100, `${od.tracked} entries are kept`);
});

test('SEC: the search for a mask or background picture takes linear time on repeated names', () => {
  const heard = [];
  for (const body of ['mask:'.repeat(400000), 'background:mask-image :'.repeat(100000), `mask:${'x '.repeat(300000)}`, '-webkit-mask '.repeat(200000)]) {
    // Fastest of three runs: a busy machine slows one run, not all three; quadratic work stays far above the limit.
    let ms = Infinity;
    for (let i = 0; i < 3 && ms >= MAX_MS; i++) ms = Math.min(ms, read(`a{${body}}`, { onBackground: (selector) => heard.push(selector) }).ms);
    assert.ok(ms < MAX_MS, `took ${Math.round(ms)} ms`);
  }
});

test('a mask or background picture is found in its own declaration only', () => {
  const heard = [];
  const options = { onBackground: (selector) => heard.push(selector) };
  read('.m{mask:url(a.svg) center}.n{-webkit-mask-image:url(a.svg)}.b{background:url(a.png)}.c{color:red;mask:none}.d{color:url(x);mask:url(a.svg)}.e{mask:none;color:url(x)}', options);
  assert.deepEqual(heard, ['.m', '.n', '.b', '.d']);
});
