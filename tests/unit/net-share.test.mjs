import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { createNet, decodeText, LIMITS } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'net.js')).href);

const PUBLIC_PAGE = 'https://site.example/page';
const PRIVATE_PAGE = 'http://192.168.1.5/admin';
const who = (extra = {}) => ({ tabId: 1, frameId: 0, pageUrl: PUBLIC_PAGE, ...extra });
const tick = () => new Promise((r) => setImmediate(r));

function reply({ body = 'a{color:red}', type = 'text/css', status = 200, url, length } = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const headers = new Headers();
  if (type) headers.set('content-type', type);
  if (length !== undefined) headers.set('content-length', String(length));
  return { ok: status >= 200 && status < 300, status, url, headers, body: new Blob([bytes]).stream() };
}

/** A fetch whose answers are given by hand, one at a time. */
function manual() {
  const calls = [];
  const fetchImpl = (href, init) =>
    new Promise((resolve, reject) => {
      calls.push({ href, init, resolve: (r) => resolve({ ...r, url: r.url || href }), reject });
    });
  return { calls, fetchImpl };
}

test('twelve requests for one address at the same time make one fetch', async () => {
  const m = manual();
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: m.fetchImpl });
  const all = Array.from({ length: 12 }, (_, i) => net.text('https://cdn.example/a.css', who({ tabId: i + 1 })));
  await tick();
  assert.equal(m.calls.length, 1);
  m.calls[0].resolve(reply({}));
  const results = await Promise.all(all);
  assert.equal(m.calls.length, 1);
  for (const r of results) assert.deepEqual(r, { ok: true, text: 'a{color:red}', url: 'https://cdn.example/a.css' });
  // Text and image of one address are separate work.
  const image = net.image('https://cdn.example/a.css', who());
  await tick();
  assert.equal(m.calls.length, 2);
  m.calls[1].resolve(reply({ type: 'text/html' }));
  assert.deepEqual(await image, { ok: false, code: 'type' });
});

test('a failure is not kept: the next request fetches again', async () => {
  const m = manual();
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: m.fetchImpl });
  const first = net.text('https://cdn.example/a.css', who());
  await tick();
  m.calls[0].resolve(reply({ status: 503 }));
  assert.deepEqual(await first, { ok: false, code: 'status' });
  const second = net.text('https://cdn.example/a.css', who());
  await tick();
  assert.equal(m.calls.length, 2);
  m.calls[1].resolve(reply({}));
  assert.equal((await second).ok, true);
});

test('askers that joined a transient failure try again together, once', async () => {
  const m = manual();
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: m.fetchImpl });
  const all = Array.from({ length: 5 }, (_, i) => net.text('https://cdn.example/a.css', who({ tabId: i + 1 })));
  await tick();
  m.calls[0].reject(new TypeError('failed to fetch'));
  await tick();
  assert.equal(m.calls.length, 2, 'one retry for all who joined');
  m.calls[1].resolve(reply({}));
  const results = await Promise.all(all);
  assert.deepEqual(results[0], { ok: false, code: 'unused' });
  for (const r of results.slice(1)) assert.equal(r.ok, true);
});

test('a timeout of the shared fetch is not handed on to the ones who joined', async () => {
  const m = manual();
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: m.fetchImpl });
  const a = net.image('https://cdn.example/a.png', who());
  const b = net.image('https://cdn.example/a.png', who({ tabId: 2 }));
  await tick();
  m.calls[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await tick();
  assert.equal(m.calls.length, 2);
  m.calls[1].resolve(reply({ type: 'image/png', body: Uint8Array.from([1, 2, 3]) }));
  assert.deepEqual(await a, { ok: false, code: 'timeout' });
  assert.equal((await b).ok, true);
});

test('cacheBytes equals the sum of the kept entries after eviction, expiry and a new fetch', async () => {
  let t = 1000;
  const sizes = new Map();
  const net = createNet({ publicSpace: true, 
    now: () => t,
    verifyUsed: async () => true,
    fetchImpl: async (href) => ({ ...reply({ body: new Uint8Array(sizes.get(href)).fill(97) }), url: href }),
  });
  const url = (i) => `https://a.example/${i}.css`;
  for (let i = 0; i < 60; i++) {
    sizes.set(url(i), i + 1);
    await net.text(url(i), who({ tabId: 100 + i }));
  }
  const kept = (from, to) => Array.from({ length: to - from }, (_, k) => from + k + 1).reduce((a, b) => a + b, 0);
  assert.equal(net.cacheSize, LIMITS.CACHE_ENTRIES);
  assert.equal(net.cacheBytes, kept(10, 60), 'the oldest ten were dropped');
  t += LIMITS.CACHE_TTL_MS + 1;
  sizes.set(url(59), 500);
  await net.text(url(59), who());
  assert.equal(net.cacheBytes, kept(10, 59) + 500, 'the expired entry was replaced, not added');
  assert.equal(net.cacheSize, LIMITS.CACHE_ENTRIES);
});

test('an answer from the cache or from a shared fetch is checked again for each asker', async () => {
  const publicUrl = 'https://cdn.example/a.css';
  const makeNet = () => {
    const m = manual();
    return { m, net: createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: m.fetchImpl }) };
  };
  // Two askers of one partition (net-partition.test.mjs); the second has no rights to the private network.
  const onPrivate = who({ pageUrl: PRIVATE_PAGE });
  const onPublic = who({ tabId: 2, pageUrl: PRIVATE_PAGE, top: 'http://192.168.1.5/', rights: 'https://site.example/page' });
  const secret = { url: 'http://192.168.1.9/secret.css', body: 'secret{}' };

  const cached = makeNet();
  const first = cached.net.text(publicUrl, onPrivate);
  await tick();
  cached.m.calls[0].resolve(reply(secret));
  assert.equal((await first).ok, true, 'a page on that network may read it');
  assert.deepEqual(await cached.net.text(publicUrl, onPublic), { ok: false, code: 'redirect' });
  assert.equal(cached.m.calls.length, 1);

  const shared = makeNet();
  const a = shared.net.text(publicUrl, onPrivate);
  const b = shared.net.text(publicUrl, onPublic);
  await tick();
  shared.m.calls[0].resolve(reply(secret));
  assert.equal((await a).ok, true);
  assert.deepEqual(await b, { ok: false, code: 'redirect' });

  // The other way round: the public page asks first and the redirect is refused for it; the private page then asks for itself.
  const reverse = makeNet();
  const p = reverse.net.text(publicUrl, onPublic);
  const q = reverse.net.text(publicUrl, onPrivate);
  await tick();
  reverse.m.calls[0].resolve(reply(secret));
  assert.deepEqual(await p, { ok: false, code: 'redirect' });
  await tick();
  assert.equal(reverse.m.calls.length, 2);
  reverse.m.calls[1].resolve(reply(secret));
  assert.equal((await q).ok, true);
});

test('every refused reply is cancelled, and a good one is read in full', async () => {
  const cases = {
    redirect: reply({ url: 'http://127.0.0.1:9/x.css' }),
    status: reply({ status: 404 }),
    type: reply({ type: 'text/html' }),
    'too-large': reply({ length: LIMITS.TEXT_BYTES + 1 }),
  };
  for (const [code, response] of Object.entries(cases)) {
    let signal;
    const net = createNet({ publicSpace: true, 
      verifyUsed: async () => true,
      fetchImpl: async (href, init) => ((signal = init.signal), { ...response, url: response.url || href }),
    });
    assert.deepEqual(await net.text('https://cdn.example/a.css', who()), { ok: false, code }, code);
    assert.equal(signal.aborted, true, `${code}: the request is ended`);
  }
  let signal;
  const net = createNet({ publicSpace: true, 
    verifyUsed: async () => true,
    fetchImpl: async (href, init) => ((signal = init.signal), { ...reply({ body: 'p{color:#123}' }), url: href }),
  });
  assert.deepEqual(await net.text('https://cdn.example/b.css', who()), { ok: true, text: 'p{color:#123}', url: 'https://cdn.example/b.css' });
  assert.equal(signal.aborted, true);
});

test('a shared fetch is ended once, when the shared work ends', async () => {
  const m = manual();
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: m.fetchImpl });
  const a = net.text('https://cdn.example/a.css', who());
  const b = net.text('https://cdn.example/a.css', who({ tabId: 2 }));
  await tick();
  assert.equal(m.calls[0].init.signal.aborted, false, 'a second asker does not end it');
  m.calls[0].resolve(reply({ status: 404 }));
  await Promise.all([a, b]);
  assert.equal(m.calls[0].init.signal.aborted, true);
});

test('at most 16 fetches run at once, over all tabs', async () => {
  const m = manual();
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: m.fetchImpl });
  const url = (i) => `https://cdn.example/${i}.css`;
  const running = Array.from({ length: LIMITS.INFLIGHT }, (_, i) => net.text(url(i), who({ tabId: i + 1 })));
  await tick();
  assert.equal(m.calls.length, LIMITS.INFLIGHT);
  assert.deepEqual(await net.text(url(99), who({ tabId: 50 })), { ok: false, code: 'rate' });
  assert.equal(m.calls.length, LIMITS.INFLIGHT, 'no fetch was made');
  const joiner = net.text(url(0), who({ tabId: 51 }));
  await tick();
  assert.equal(m.calls.length, LIMITS.INFLIGHT, 'joining a running fetch costs no slot');
  m.calls[0].resolve(reply({}));
  assert.equal((await joiner).ok, true);
  const next = net.text(url(99), who({ tabId: 50 }));
  await tick();
  assert.equal(m.calls.length, LIMITS.INFLIGHT + 1, 'a slot is free again');
  for (const c of m.calls.slice(1)) c.resolve(reply({}));
  await Promise.all([...running, next]);
});

/* ---------- the charset of a sheet ---------- */

const bytesOf = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const utf16 = (s, big) => [...s].flatMap((c) => (big ? [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255] : [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]));
const CSS = 'text/css';

test('a sheet is decoded by its byte order mark, its header, its @charset, then UTF-8', () => {
  const css = '.café{color:red}';
  assert.equal(decodeText(new TextEncoder().encode(css), CSS), css, 'utf-8');
  assert.equal(decodeText(bytesOf([0xef, 0xbb, 0xbf], new TextEncoder().encode(css)), CSS), css, 'the utf-8 mark is dropped');
  const latin = bytesOf(ascii('.caf'), [0xe9], ascii('{color:red}'));
  assert.equal(decodeText(latin, 'text/css; charset=windows-1252'), css, 'header');
  assert.equal(decodeText(latin, 'text/css; charset="ISO-8859-1"'), css, 'quoted label');
  assert.equal(decodeText(bytesOf(ascii('@charset "windows-1252";.caf'), [0xe9], ascii('{}')), CSS), '@charset "windows-1252";.café{}', '@charset');
  assert.equal(decodeText(bytesOf([0xff, 0xfe], utf16(css, false)), CSS), css, 'utf-16le mark');
  assert.equal(decodeText(bytesOf([0xfe, 0xff], utf16(css, true)), CSS), css, 'utf-16be mark');
});

test('an unknown label falls back to the next signal and then to UTF-8', () => {
  const css = '.café{}';
  assert.equal(decodeText(new TextEncoder().encode(css), 'text/css; charset=nonsense-9'), css);
  const latin = bytesOf(ascii('@charset "windows-1252";.caf'), [0xe9]);
  assert.equal(decodeText(latin, 'text/css; charset=nonsense-9'), '@charset "windows-1252";.café', 'the @charset is next');
  assert.equal(decodeText(new TextEncoder().encode(`@charset "bogus";${css}`), CSS), `@charset "bogus";${css}`);
  assert.equal(decodeText(new TextEncoder().encode(`@charset "utf-16";${css}`), CSS), `@charset "utf-16";${css}`, 'ASCII text is never UTF-16');
});

test('conflicting signals: the mark beats the header, the header beats @charset', () => {
  const css = '.café{}';
  assert.equal(decodeText(bytesOf([0xff, 0xfe], utf16(css, false)), 'text/css; charset=windows-1252'), css);
  assert.equal(decodeText(bytesOf([0xef, 0xbb, 0xbf], new TextEncoder().encode(css)), 'text/css; charset=utf-16le'), css);
  const utf8 = new TextEncoder().encode(`@charset "windows-1252";${css}`);
  assert.equal(decodeText(utf8, 'text/css; charset=utf-8'), `@charset "windows-1252";${css}`, 'the header wins over @charset');
});

test('the proxy returns text decoded by those signals', async () => {
  const latin = bytesOf(ascii('.caf'), [0xe9], ascii('{}'));
  const net = createNet({ publicSpace: true, 
    verifyUsed: async () => true,
    fetchImpl: async (href) => ({ ...reply({ body: latin, type: 'text/css; charset=windows-1252' }), url: href }),
  });
  assert.equal((await net.text('https://cdn.example/a.css', who())).text, '.café{}');
});

test('with no other signal the encoding of the asking document decodes the sheet; every other signal wins over it', () => {
  const css = '.café{}';
  const latin = bytesOf(ascii('.caf'), [0xe9], ascii('{}'));
  assert.equal(decodeText(latin, CSS), '.caf�{}', 'no signal: UTF-8');
  assert.equal(decodeText(latin, CSS, 'windows-1252'), css);
  assert.equal(decodeText(latin, 'text/css; charset=iso-8859-2', 'windows-1252'), '.café{}', 'the header comes first');
  const ruled = bytesOf(ascii('@charset "windows-1252";.caf'), [0xe9]);
  assert.equal(decodeText(ruled, CSS, 'shift_jis'), '@charset "windows-1252";.café', '@charset beats the document');
});

test('the proxy uses the document encoding of the asker, keeps answers apart by it, and ignores a bad value', async () => {
  const latin = bytesOf(ascii('.caf'), [0xe9], ascii('{}'));
  let fetches = 0;
  const net = createNet({ publicSpace: true, 
    verifyUsed: async () => true,
    fetchImpl: async (href) => {
      fetches += 1;
      return { ...reply({ body: latin, type: 'text/css' }), url: href };
    },
  });
  const url = 'https://cdn.example/legacy.css';
  assert.equal((await net.text(url, who(), 'windows-1252')).text, '.café{}');
  assert.equal((await net.text(url, who(), 'WINDOWS-1252')).text, '.café{}');
  assert.equal(fetches, 1, 'one name, one entry');
  assert.equal((await net.text(url, who(), 'UTF-8')).text, '.caf�{}', 'a UTF-8 document gets UTF-8');
  assert.equal(fetches, 2);
  for (const bad of ['nonsense-9', 'utf-16le', 7, null, 'x'.repeat(65)]) {
    assert.equal((await net.text(url, who(), bad)).text, '.caf�{}', String(bad));
  }
});

test('a 404 or 410 is remembered for a short time, for every asker whose rights allow the address', async () => {
  let t = 1000;
  let fetches = 0;
  let status = 404;
  const net = createNet({ publicSpace: true, 
    now: () => t,
    verifyUsed: async () => true,
    fetchImpl: async (href) => {
      fetches += 1;
      return { ...reply({ status }), url: href };
    },
  });
  const url = 'https://cdn.example/gone.css';
  assert.deepEqual(await net.text(url, who()), { ok: false, code: 'status' });
  assert.deepEqual(await net.text(url, who({ tabId: 2 })), { ok: false, code: 'status' });
  assert.equal(fetches, 1);
  assert.equal(net.cacheBytes, 0);
  assert.deepEqual(await net.image(url, who()), { ok: false, code: 'status' }, 'text and image are apart');
  assert.equal(fetches, 2);
  t += LIMITS.MISSING_TTL_MS + 1;
  status = 200;
  assert.equal((await net.text(url, who())).ok, true, 'after the time the file is asked for again');
  assert.equal(fetches, 3);
});

test('only 404 and 410 are remembered; a timeout, a network error and a 5xx fetch again', async () => {
  let fetches = 0;
  let mode = 503;
  const net = createNet({ publicSpace: true, 
    verifyUsed: async () => true,
    fetchImpl: async (href) => {
      fetches += 1;
      if (mode === 'net') throw new Error('down');
      return { ...reply({ status: mode }), url: href };
    },
  });
  for (const m of [503, 403, 401, 500, 'net']) {
    mode = m;
    const url = `https://cdn.example/${m}.css`;
    await net.text(url, who());
    const before = fetches;
    await net.text(url, who());
    assert.equal(fetches, before + 1, String(m));
  }
  mode = 410;
  await net.text('https://cdn.example/410.css', who());
  const before = fetches;
  await net.text('https://cdn.example/410.css', who());
  assert.equal(fetches, before, '410 is remembered');
});

test('a remembered 404 is not handed to an asker who may not reach its final address, nor to one the rate or the verifier refuses', async () => {
  let fetches = 0;
  let used = true;
  const net = createNet({ publicSpace: true, 
    verifyUsed: async () => used,
    fetchImpl: async (href) => {
      fetches += 1;
      return { ...reply({ status: 404 }), url: 'http://192.168.1.5/missing.css' };
    },
  });
  const url = 'https://cdn.example/moved.css';
  assert.deepEqual(await net.text(url, who({ pageUrl: PRIVATE_PAGE })), { ok: false, code: 'status' });
  assert.deepEqual(await net.text(url, who({ pageUrl: PRIVATE_PAGE, rights: 'https://site.example/page' })), { ok: false, code: 'redirect' }, 'an asker without rights may not learn about a private address');
  assert.equal(fetches, 1);
  used = false;
  assert.deepEqual(await net.text(url, who({ pageUrl: PRIVATE_PAGE })), { ok: false, code: 'unused' }, 'the check of use comes before the memory');
  used = true;
  for (let i = 0; i < LIMITS.RATE_COUNT; i++) await net.text(url, who({ tabId: 9, pageUrl: PRIVATE_PAGE }));
  assert.deepEqual(await net.text(url, who({ tabId: 9, pageUrl: PRIVATE_PAGE })), { ok: false, code: 'rate' });
});

test('the memory of missing files is bounded, and cacheBytes still equals the kept entries', async () => {
  let status = 404;
  let fetches = 0;
  const net = createNet({ publicSpace: true, 
    verifyUsed: async () => true,
    fetchImpl: async (href) => {
      fetches += 1;
      return { ...reply({ status, body: 'abc' }), url: href };
    },
  });
  const total = LIMITS.MISSING_ENTRIES + 20;
  for (let i = 0; i < total; i++) await net.text(`https://cdn.example/m${i}.css`, who({ tabId: 1000 + i }));
  await net.text('https://cdn.example/m0.css', who());
  assert.equal(fetches, total + 1, 'the oldest entry was dropped');
  await net.text(`https://cdn.example/m${total - 1}.css`, who());
  assert.equal(fetches, total + 1, 'the newest is kept');
  assert.equal(net.cacheBytes, 0);
  assert.equal(net.cacheSize, 0);
  status = 200;
  await net.text('https://cdn.example/ok1.css', who());
  await net.text('https://cdn.example/ok2.css', who());
  assert.equal(net.cacheBytes, 6);
  assert.equal(net.cacheSize, 2);
});
