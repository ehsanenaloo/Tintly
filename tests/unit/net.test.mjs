import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { createNet, checkTarget, isPrivateHost, LIMITS } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'net.js')).href);

const PUBLIC_PAGE = 'https://site.example/page';
const who = (extra = {}) => ({ tabId: 1, frameId: 0, pageUrl: PUBLIC_PAGE, ...extra });

/** A response that behaves like the part of `Response` the code uses. */
function res({ body = 'a{color:red}', type = 'text/css', status = 200, url = '', length, chunks } = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const headers = new Headers();
  if (type) headers.set('content-type', type);
  if (length !== undefined) headers.set('content-length', String(length));
  let cancelled = false;
  const size = (chunks ?? bytes.length) || 1;
  let at = 0;
  const stream = new ReadableStream({
    // One chunk per pull, so a reader that stops early leaves the stream open and its cancel() is called.
    pull(c) {
      if (at >= bytes.length) c.close();
      else {
        c.enqueue(bytes.slice(at, at + size));
        at += size;
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return { ok: status >= 200 && status < 300, status, url, headers, body: stream, get cancelled() { return cancelled; } };
}

function make({ responses = [], used = true, now = () => 1000 } = {}) {
  const calls = [];
  const queue = [...responses];
  const net = createNet({ publicSpace: true, 
    now,
    verifyUsed: async () => used,
    fetchImpl: async (href, init) => {
      calls.push({ href, init });
      const next = queue.length ? queue.shift() : res({ url: href });
      if (typeof next === 'function') return next(href, init);
      return { ...next, url: next.url || href };
    },
  });
  return { net, calls };
}

/* ---------- where a request may go ---------- */

test('private and local host names are recognized', () => {
  for (const h of ['localhost', 'LOCALHOST', 'app.localhost', 'printer.local', 'host.internal', 'intranet', 'a', '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.0.8', '198.18.0.1', '[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[ff02::1]', '[::ffff:7f00:1]', '[::ffff:c0a8:101]', '[::ffff:a00:1]', '', 'a.local.', '999.1.1.1']) {
    assert.equal(isPrivateHost(h), true, h);
  }
});

test('public host names are not private', () => {
  for (const h of ['example.com', 'cdn.example.co.uk', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.63.0.1', '100.128.0.1', '169.253.0.1', '203.0.113.5', '[2001:db8::1]', '[2606:4700::1111]', '[::ffff:808:808]', 'xn--mgbaam7a8h.example']) {
    assert.equal(isPrivateHost(h), false, h);
  }
});

test('the address parser gives the forms that the checks expect', () => {
  // Numbers in odd forms become dotted quads before the check.
  assert.equal(isPrivateHost(new URL('http://2130706433/').hostname), true);
  assert.equal(isPrivateHost(new URL('http://0x7f.1/').hostname), true);
  assert.equal(isPrivateHost(new URL('http://017700000001/').hostname), true);
  assert.equal(isPrivateHost(new URL('http://[::ffff:127.0.0.1]/').hostname), true);
  assert.equal(isPrivateHost(new URL('http://user@127.0.0.1/').hostname), true);
});

test('targets: only http and https, no credentials, no private network from a public page', () => {
  const ok = (t, p = PUBLIC_PAGE) => checkTarget(t, p);
  assert.equal(ok('https://cdn.example/a.css').ok, true);
  assert.equal(ok('http://cdn.example/a.css').ok, true);
  const refused = { 'data:text/css,a{}': 'scheme', 'file:///etc/passwd': 'scheme', 'ftp://a.example/x': 'scheme', 'javascript:1': 'scheme', 'blob:https://a.example/x': 'scheme', 'chrome://version': 'scheme', 'https://u:p@a.example/x': 'credentials', 'https://u@a.example/x': 'credentials', 'http://127.0.0.1/a.css': 'private', 'http://localhost:8080/a.css': 'private', 'http://192.168.0.1/admin': 'private', 'http://[::1]/a': 'private', 'http://metadata.internal/x': 'private', '': 'invalid', 'not a url': 'invalid', '//a.example/x': 'invalid' };
  for (const [target, code] of Object.entries(refused)) assert.deepEqual(ok(target), { ok: false, code }, target);
  for (const junk of [undefined, null, 5, {}, [], true]) assert.deepEqual(ok(junk), { ok: false, code: 'invalid' });
  assert.deepEqual(ok(`https://a.example/${'x'.repeat(3000)}`), { ok: false, code: 'invalid' });
});

test('a page on a private network may ask for private targets, a page with no usable address may not', () => {
  assert.equal(checkTarget('http://127.0.0.1:8000/a.css', 'http://127.0.0.1:9000/').ok, true);
  assert.equal(checkTarget('http://192.168.1.5/a.css', 'http://localhost:3000/').ok, true);
  assert.equal(checkTarget('http://127.0.0.1:8000/a.css', 'https://site.example/').ok, false);
  assert.deepEqual(checkTarget('http://127.0.0.1/a.css', 'about:blank'), { ok: false, code: 'private' });
  assert.deepEqual(checkTarget('http://127.0.0.1/a.css', 'garbage'), { ok: false, code: 'page' });
  assert.deepEqual(checkTarget('http://127.0.0.1/a.css', undefined), { ok: false, code: 'page' });
});

/* ---------- the fetch itself ---------- */

test('a stylesheet is fetched without credentials and without a referrer', async () => {
  const { net, calls } = make({ responses: [res({ body: 'p{color:#123}' })] });
  const r = await net.text('https://cdn.example/a.css', who());
  assert.deepEqual(r, { ok: true, text: 'p{color:#123}', url: 'https://cdn.example/a.css' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.ok(calls[0].init.signal);
});

test('text must be CSS, with or without parameters', async () => {
  const good = make({ responses: [res({ type: 'text/css; charset=utf-8' }), res({ type: 'TEXT/CSS' })] });
  assert.equal((await good.net.text('https://a.example/1.css', who())).ok, true);
  assert.equal((await good.net.text('https://a.example/2.css', who())).ok, true);
  for (const type of ['text/html', 'text/plain', 'application/javascript', 'image/png', '', 'text/css-ish']) {
    const m = make({ responses: [res({ type })] });
    assert.deepEqual(await m.net.text('https://a.example/x.css', who()), { ok: false, code: 'type' }, type || '(none)');
  }
});

test('an image must be one of the known image types, and comes back as base64', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 0, 255, 128, 7]);
  const m = make({ responses: [res({ body: bytes, type: 'image/png' })] });
  const r = await m.net.image('https://a.example/x.png', who());
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/png');
  assert.deepEqual([...Buffer.from(r.base64, 'base64')], [...bytes]);
  for (const type of ['image/svg+xml', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif']) {
    assert.equal((await make({ responses: [res({ type, body: '<svg/>' })] }).net.image('https://a.example/i', who())).ok, true, type);
  }
  for (const type of ['text/html', 'application/octet-stream', 'image/tiff', 'video/mp4', '']) {
    assert.deepEqual(await make({ responses: [res({ type })] }).net.image('https://a.example/i', who()), { ok: false, code: 'type' }, type || '(none)');
  }
});

test('a large file is refused by its declared size and by what really arrives', async () => {
  const big = new Uint8Array(LIMITS.TEXT_BYTES + 5 * 65536).fill(97);
  const declared = make({ responses: [res({ body: 'x', length: LIMITS.TEXT_BYTES + 1 })] });
  assert.deepEqual(await declared.net.text('https://a.example/a.css', who()), { ok: false, code: 'too-large' });
  const lied = res({ body: big, chunks: 65536 });
  const streamed = make({ responses: [lied] });
  assert.deepEqual(await streamed.net.text('https://a.example/b.css', who()), { ok: false, code: 'too-large' });
  assert.equal(lied.cancelled, true, 'the download must be cancelled');
  const exact = make({ responses: [res({ body: new Uint8Array(LIMITS.TEXT_BYTES).fill(97), chunks: 65536 })] });
  assert.equal((await exact.net.text('https://a.example/c.css', who())).ok, true);
  const imageBig = make({ responses: [res({ body: new Uint8Array(LIMITS.IMAGE_BYTES + 1), type: 'image/png', chunks: 65536 })] });
  assert.deepEqual(await imageBig.net.image('https://a.example/i.png', who()), { ok: false, code: 'too-large' });
});

test('a request that takes too long is stopped', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const net = createNet({ publicSpace: true, 
      verifyUsed: async () => true,
      fetchImpl: (href, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    });
    const pending = net.text('https://slow.example/a.css', who());
    const image = net.image('https://slow.example/a.png', who());
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(LIMITS.TIMEOUT_MS);
    assert.deepEqual(await image, { ok: false, code: 'timeout' });
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'a style sheet is waited for longer than a picture');
    mock.timers.tick(LIMITS.TEXT_TIMEOUT_MS - LIMITS.TIMEOUT_MS);
    assert.deepEqual(await pending, { ok: false, code: 'timeout' });
  } finally {
    mock.timers.reset();
  }
});

test('a network failure and an error status give codes, not exceptions', async () => {
  const failing = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: async () => { throw new TypeError('failed to fetch'); } });
  // A failed public-only fetch cannot be told from a refusal: the page is asked to read it, and without a reader it is refused.
  assert.deepEqual(await failing.text('https://a.example/a.css', who()), { ok: false, code: 'unused' });
  assert.deepEqual(await failing.text('http://127.0.0.1:8/a.css', who({ pageUrl: 'http://127.0.0.1:7/' })), { ok: false, code: 'network' }, 'no option: the error itself');
  const notFound = make({ responses: [res({ status: 404 })] });
  assert.deepEqual(await notFound.net.text('https://a.example/a.css', who()), { ok: false, code: 'status' });
  const noBody = make({ responses: [{ ok: true, status: 200, url: '', headers: new Headers({ 'content-type': 'text/css' }), body: null }] });
  assert.deepEqual(await noBody.net.text('https://a.example/empty.css', who()), { ok: true, text: '', url: 'https://a.example/empty.css' });
});

test('the final address is still checked, as a second line behind the refusal of redirects', async () => {
  const m = make({ responses: [res({ url: 'http://127.0.0.1:9/secret.css' })] });
  assert.deepEqual(await m.net.text('https://cdn.example/a.css', who()), { ok: false, code: 'redirect' });
  const fine = make({ responses: [res({ url: 'https://other.example/final.css' })] });
  assert.equal((await fine.net.text('https://cdn.example/a.css', who())).url, 'https://other.example/final.css');
  const fromPrivate = make({ responses: [res({ url: 'http://127.0.0.1:9/ok.css' })] });
  assert.equal((await fromPrivate.net.text('http://127.0.0.1:8/a.css', who({ pageUrl: 'http://127.0.0.1:7/' }))).ok, true);
});

test('an address the frame does not use is not fetched', async () => {
  const m = make({ used: false });
  assert.deepEqual(await m.net.text('https://a.example/a.css', who()), { ok: false, code: 'unused' });
  assert.deepEqual(await m.net.image('https://a.example/i.png', who()), { ok: false, code: 'unused' });
  assert.equal(m.calls.length, 0);
});

test('the verifier is asked with the sender and the exact address', async () => {
  const asked = [];
  const net = createNet({ publicSpace: true, verifyUsed: async (w, url) => (asked.push([w, url]), true), fetchImpl: async (href) => ({ ...res(), url: href }) });
  await net.text('https://a.example/a.css#frag', who({ tabId: 5, frameId: 3 }));
  assert.equal(asked[0][0].tabId, 5);
  assert.equal(asked[0][0].frameId, 3);
  assert.equal(asked[0][1], 'https://a.example/a.css#frag');
});

test('bad addresses never reach the verifier or the network', async () => {
  const { net, calls } = make();
  for (const t of ['file:///x', 'http://127.0.0.1/a', 'data:text/css,a{}', '', undefined, 5, 'https://u:p@a.example/x']) {
    assert.equal((await net.text(t, who())).ok, false);
    assert.equal((await net.image(t, who())).ok, false);
  }
  assert.equal(calls.length, 0);
});

test('a tab may ask only so often, and a quiet time makes room again', async () => {
  let t = 1000;
  const { net, calls } = make({ now: () => t });
  for (let i = 0; i < LIMITS.RATE_COUNT; i++) assert.equal((await net.text(`https://a.example/${i}.css`, who())).ok, true);
  assert.deepEqual(await net.text('https://a.example/extra.css', who()), { ok: false, code: 'rate' });
  assert.equal((await net.text('https://a.example/other-tab.css', who({ tabId: 2 }))).ok, true);
  t += LIMITS.RATE_WINDOW_MS + 1;
  assert.equal((await net.text('https://a.example/later.css', who())).ok, true);
  assert.equal(calls.length, LIMITS.RATE_COUNT + 2);
});

test('a repeated request is answered from the cache until it is old', async () => {
  let t = 1000;
  const { net, calls } = make({ now: () => t });
  await net.text('https://a.example/a.css', who());
  await net.text('https://a.example/a.css', who({ tabId: 2 }));
  assert.equal(calls.length, 1);
  t += LIMITS.CACHE_TTL_MS + 1;
  await net.text('https://a.example/a.css', who());
  assert.equal(calls.length, 2);
  // Text and image of one address are cached apart.
  await net.image('https://a.example/a.css', who());
});

test('the cache holds at most 50 entries and drops the oldest', async () => {
  const { net, calls } = make();
  for (let i = 0; i < 70; i++) await net.text(`https://a.example/${i}.css`, who({ tabId: i + 100 }));
  assert.equal(net.cacheSize, LIMITS.CACHE_ENTRIES);
  const before = calls.length;
  await net.text('https://a.example/69.css', who());
  assert.equal(calls.length, before, 'the newest is still cached');
  await net.text('https://a.example/0.css', who());
  assert.equal(calls.length, before + 1, 'the oldest was dropped');
});

test('the cache is also bounded in bytes', async () => {
  const body = new Uint8Array(1024 * 1024).fill(97);
  const responses = Array.from({ length: 30 }, () => res({ body, chunks: 262144 }));
  const { net } = make({ responses });
  for (let i = 0; i < 30; i++) await net.text(`https://a.example/${i}.css`, who({ tabId: i + 1 }));
  assert.ok(net.cacheSize <= 20, `${net.cacheSize} entries of 1 MB`);
});

test('a failed request is not cached', async () => {
  const { net, calls } = make({ responses: [res({ status: 500 }), res()] });
  assert.equal((await net.text('https://a.example/a.css', who())).ok, false);
  assert.equal((await net.text('https://a.example/a.css', who())).ok, true);
  assert.equal(calls.length, 2);
});
