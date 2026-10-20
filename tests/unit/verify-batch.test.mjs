import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { createVerifier } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'verify.js')).href);

/** A scripting fake: each call runs `answer(urls)` after the test lets it. */
function scripting(answer) {
  const calls = [];
  return {
    calls,
    executeScript: async (details) => {
      calls.push(details);
      const urls = details.args[0];
      return [{ result: await answer(urls, details) }];
    },
  };
}

const who = { tabId: 3, frameId: 0, documentId: 'D' };
const tick = () => new Promise((r) => setImmediate(r));

test('urls asked while a check runs are answered together by one more script call', async () => {
  let release;
  const first = new Promise((r) => (release = r));
  let n = 0;
  const s = scripting(async (urls) => {
    if (n++ === 0) await first;
    return urls.map((u) => u.endsWith('/used.png'));
  });
  const verify = createVerifier({ scripting: s, now: () => 0 });
  const asks = [verify(who, 'https://cdn.example/used.png')];
  await tick();
  for (let i = 0; i < 39; i++) asks.push(verify(who, `https://cdn.example/${i}.png`));
  asks.push(verify(who, 'https://cdn.example/2/used.png'));
  release();
  const answers = await Promise.all(asks);
  assert.equal(answers[0], true);
  assert.deepEqual(answers.slice(1, 40), new Array(39).fill(false));
  assert.equal(answers[40], true);
  assert.equal(s.calls.length, 2, 'one for the first, one for the 40 that waited');
  assert.equal(s.calls[1].args[0].length, 40);
  assert.deepEqual(Object.keys(s.calls[1]).sort(), ['args', 'func', 'injectImmediately', 'target', 'world']);
});

test('the same url asked twice at once is sent once', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const s = scripting(async (urls) => {
    await gate;
    return urls.map(() => true);
  });
  const verify = createVerifier({ scripting: s, now: () => 0 });
  const asks = [verify(who, 'https://a.example/a.css'), verify(who, 'https://a.example/b.css'), verify(who, 'https://a.example/b.css'), verify(who, 'https://a.example/b.css')];
  await tick();
  release();
  assert.deepEqual(await Promise.all(asks), [true, true, true, true]);
  assert.deepEqual(s.calls.map((c) => c.args[0]), [['https://a.example/a.css'], ['https://a.example/b.css']]);
});

test('frames do not share a check, and a failing script answers false for every waiting url', async () => {
  let fail = true;
  const s = scripting(async (urls) => {
    if (fail) throw new Error('frame gone');
    return urls.map(() => true);
  });
  const verify = createVerifier({ scripting: s, now: () => 0 });
  const bad = await Promise.all([verify(who, 'https://a.example/1'), verify(who, 'https://a.example/2'), verify(who, 'https://a.example/3')]);
  assert.deepEqual(bad, [false, false, false]);
  fail = false;
  const other = await Promise.all([verify({ ...who, frameId: 1 }, 'https://a.example/1'), verify({ ...who, tabId: 4 }, 'https://a.example/1')]);
  assert.deepEqual(other, [true, true]);
  assert.equal(s.calls.at(-1).target.tabId, 4);
});

test('a batch is at most 100 urls', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let n = 0;
  const s = scripting(async (urls) => {
    if (n++ === 0) await gate;
    return urls.map(() => false);
  });
  const verify = createVerifier({ scripting: s, now: () => 0 });
  const asks = [verify(who, 'https://a.example/first')];
  await tick();
  for (let i = 0; i < 250; i++) asks.push(verify(who, `https://a.example/${i}`));
  release();
  await Promise.all(asks);
  assert.deepEqual(s.calls.map((c) => c.args[0].length), [1, 100, 100, 50]);
});

/* The function that runs in the page, against a fake page of 1 500 images. */
function fakePage({ images, entries = [], styles = [], styled = [], base = 'https://page.example/dir/', onRead = () => {} }) {
  const el = (attrs) => ({
    getAttribute: (name) => {
      onRead();
      return name in attrs ? attrs[name] : null;
    },
  });
  const nodes = images.map((attrs) => el(attrs));
  const styleNodes = styles.map((textContent) => ({ textContent }));
  const styledNodes = styled.map((style) => el({ style }));
  const saved = { document: globalThis.document, performance: globalThis.performance };
  const select = (selector) => (selector === 'style' ? styleNodes : selector.startsWith('[style') ? styledNodes : nodes);
  globalThis.document = { baseURI: base, querySelectorAll: select };
  Object.defineProperty(globalThis, 'performance', { value: { getEntriesByType: () => entries.map((name) => ({ name })) }, configurable: true });
  return () => {
    globalThis.document = saved.document;
    Object.defineProperty(globalThis, 'performance', { value: saved.performance, configurable: true });
  };
}

async function pageFunction() {
  let func;
  const verify = createVerifier({
    scripting: { executeScript: async (d) => ((func = d.func), [{ result: [] }]) },
    now: () => 0,
  });
  await verify(who, 'https://x.example/');
  return func;
}

/* The function that loads each used address in the page. */
async function readFunction() {
  let func;
  const verify = createVerifier({
    scripting: { executeScript: async (d) => ((func = d.func), [{ result: null }]) },
    now: () => 0,
  });
  await verify.read(who, 'https://x.example/', 'text/css', 10, 50);
  assert.equal(func.name, 'pageReads');
  return func;
}

test('the page function answers a batch from one pass over the page', async () => {
  const images = [];
  for (let i = 0; i < 1500; i++) images.push({ src: `/img/${i}.jpg`, srcset: `/img/${i}.jpg 1x, https://cdn.example/${i}@2x.jpg 2x` });
  images.push({ href: 'styles/site.css#top' });
  images.push({ poster: 'https://video.example/p.png' });
  const undo = fakePage({ images, entries: ['https://res.example/timing.css#x'] });
  try {
    const run = await pageFunction();
    const urls = [
      'https://page.example/img/7.jpg',
      'https://cdn.example/1499@2x.jpg',
      'https://page.example/dir/styles/site.css',
      'https://video.example/p.png',
      'https://res.example/timing.css',
      'https://page.example/img/9999.jpg',
      'https://evil.example/x.png',
    ];
    assert.deepEqual(run(urls), [true, true, true, true, true, false, false]);
    assert.deepEqual(run([]), []);
    assert.deepEqual(run(['https://evil.example/x.png']), [false]);
  } finally {
    undo();
  }
});

test('the page function reads each attribute of the page once for a batch of 40 unmatched urls', async () => {
  let reads = 0;
  const images = [];
  for (let i = 0; i < 1500; i++) images.push({ src: `/img/${i}.jpg` });
  const undo = fakePage({ images, onRead: () => reads++ });
  try {
    const run = await pageFunction();
    const urls = Array.from({ length: 40 }, (_, i) => `https://evil.example/${i}.png`);
    assert.deepEqual(run(urls), new Array(40).fill(false));
    assert.ok(reads <= 1500 * 5, `${reads} attribute reads`);
  } finally {
    undo();
  }
});

test('the page function takes an address that a style element or a style attribute names in url()', async () => {
  const undo = fakePage({
    images: [],
    styles: ['.a::before{background:url(icons/a.svg) no-repeat}', `.b{background-image:url("https://cdn.example/b.png")}`, '.c{color:red}'],
    styled: [`background:url('/c.png')`],
  });
  try {
    const run = await pageFunction();
    const urls = ['https://page.example/dir/icons/a.svg', 'https://cdn.example/b.png', 'https://page.example/c.png', 'https://evil.example/x.png'];
    assert.deepEqual(run(urls), [true, true, true, false]);
  } finally {
    undo();
  }
});

test('the style text read for one batch is capped', async () => {
  const big = `.x{background:url(https://cdn.example/late.png)}${' '.repeat(4_000_000)}`;
  const undo = fakePage({ images: [], styles: [big] });
  try {
    const run = await pageFunction();
    assert.deepEqual(run(['https://cdn.example/late.png']), [false]);
  } finally {
    undo();
  }
});

/** A fetch of the page that answers from a table; each answer is a Response with its address. */
function fakeFetch(table, asked) {
  return (url, init) => {
    asked.push({ url, ...init, accept: init.headers?.Accept });
    const make = table[url.split('?')[0]];
    if (!make) return Promise.reject(new TypeError('blocked by the browser'));
    return make(init);
  };
}
const respond = (body, init = {}, url = '') => {
  const r = new Response(body, init);
  Object.defineProperty(r, 'url', { value: url });
  return r;
};

test('the page reads the file itself with CORS and no cookies, and gives the bytes, the type and the address it ended at', async () => {
  const saved = globalThis.fetch;
  const asked = [];
  globalThis.fetch = fakeFetch(
    {
      'https://cdn.example/a.css': async () => respond('a{color:red}', { headers: { 'content-type': 'text/css' } }, 'https://cdn.example/final.css'),
      'https://cdn.example/gone.css': async () => respond('', { status: 404 }, 'https://cdn.example/gone.css'),
      'https://cdn.example/big.css': async () => respond('x'.repeat(20), { headers: { 'content-type': 'text/css', 'content-length': '20' } }),
      'https://cdn.example/stream.css': async () => respond('y'.repeat(20), { headers: { 'content-type': 'text/css' } }),
      'https://cdn.example/slow.css': (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    },
    asked,
  );
  try {
    const read = await readFunction();
    const ok = await read('https://cdn.example/a.css', 'text/css,*/*;q=0.1', 100, 50);
    assert.deepEqual(ok, { status: 200, url: 'https://cdn.example/final.css', type: 'text/css', b64: Buffer.from('a{color:red}').toString('base64') });
    assert.deepEqual(await read('https://cdn.example/gone.css', 'text/css', 100, 50), { status: 404, url: 'https://cdn.example/gone.css' });
    assert.deepEqual(await read('https://cdn.example/big.css', 'text/css', 10, 50), { code: 'too-large' }, 'by the header');
    assert.deepEqual(await read('https://cdn.example/stream.css', 'text/css', 10, 50), { code: 'too-large' }, 'by the bytes read');
    assert.deepEqual(await read('https://cdn.example/slow.css', 'text/css', 100, 20), { code: 'timeout' });
    assert.equal(await read('https://inner.example/b.css', 'text/css', 100, 50), null, 'what the browser or CORS refuses is not read');
    assert.ok(asked.every((a) => a.mode === 'cors' && a.credentials === 'omit' && a.referrerPolicy === 'no-referrer'));
    assert.equal(asked[0].accept, 'text/css,*/*;q=0.1');
  } finally {
    globalThis.fetch = saved;
  }
});

test('the page read gives the same base64 with and without the engine encoder', async () => {
  const saved = { fetch: globalThis.fetch, to: Uint8Array.prototype.toBase64 };
  const bytes = new Uint8Array(70_000).map((_, i) => (i * 7) & 255);
  globalThis.fetch = async () => respond(bytes, { headers: { 'content-type': 'image/png' } }, 'https://cdn.example/a.png');
  try {
    const read = await readFunction();
    const want = Buffer.from(bytes).toString('base64');
    assert.equal((await read('https://cdn.example/a.png', 'image/*', 1e6, 50)).b64, want);
    delete Uint8Array.prototype.toBase64;
    assert.equal((await read('https://cdn.example/a.png', 'image/*', 1e6, 50)).b64, want);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.to) Uint8Array.prototype.toBase64 = saved.to;
  }
});

test('read runs in the document that asked, every time: nothing is kept', async () => {
  const calls = [];
  const verify = createVerifier({
    now: () => 0,
    scripting: { executeScript: async (d) => (calls.push({ func: d.func.name, args: d.args, target: d.target }), [{ result: { status: 200 } }]) },
  });
  assert.deepEqual(await verify.read(who, 'https://cdn.example/a.css', 'text/css', 10, 25000), { status: 200 });
  await verify.read(who, 'https://cdn.example/a.css', 'text/css', 10, 25000);
  assert.deepEqual(calls.map((c) => c.func), ['pageReads', 'pageReads']);
  assert.deepEqual(calls[0].args, ['https://cdn.example/a.css', 'text/css', 10, 25000]);
  assert.deepEqual(calls[0].target, { tabId: 3, documentIds: ['D'] });
});
