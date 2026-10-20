// The worker's fetch and the browser's local network rule: where the browser knows the option, the worker names
// the address spaces the page may reach and the browser checks the real connection. Where it cannot judge (a proxy, Firefox), the
// page reads the file itself with CORS. No check comes before a separate fetch, and no count can turn a check off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { createNet, publicSpaceKnown } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'net.js')).href);

const who = (extra = {}) => ({ tabId: 1, frameId: 0, pageUrl: 'https://site.example/page', ...extra });
const intranet = (extra = {}) => who({ pageUrl: 'http://10.0.0.5/admin', ...extra });
const isImage = (u) => /\.(png|ico)(\?|$)/.test(u);
const answer = (url) =>
  isImage(url)
    ? { ok: true, status: 200, url, headers: new Headers({ 'content-type': 'image/png' }), body: new Blob([new Uint8Array([137, 80, 78, 71])]).stream() }
    : { ok: true, status: 200, url, headers: new Headers({ 'content-type': 'text/css' }), body: new Blob(['a{color:red}']).stream() };
const b64 = (text) => Buffer.from(text).toString('base64');

/** A browser: the option is an exact check of the address the name points to. Behind a proxy every value fails. */
function browserLike({ space = (u) => (u.includes('inner.') ? 'local' : u.includes('loop.') ? 'loopback' : 'public'), proxy = false } = {}) {
  const sent = [];
  const tried = [];
  const fetchImpl = async (href, init) => {
    if (init.targetAddressSpace) {
      tried.push(`${init.targetAddressSpace} ${href}`);
      if (proxy || space(href) !== init.targetAddressSpace) throw new TypeError('Failed to fetch');
    }
    sent.push(href);
    return answer(href);
  };
  return { sent, tried, fetchImpl };
}

/** @param {(url: string) => any} [page] what the page's own CORS read gives */
function make(opts = {}, { page = () => null, publicSpace = true } = {}) {
  const b = browserLike(opts);
  const read = [];
  const verifyUsed = Object.assign(async () => true, {
    read: async (_who, url, accept, max, ms) => (read.push({ url, accept, max, ms }), page(url)),
  });
  const net = createNet({ fetchImpl: b.fetchImpl, verifyUsed, publicSpace, now: () => 0 });
  return { ...b, read, net };
}

const cors = (url) => ({ status: 200, url, type: isImage(url) ? 'image/png' : 'text/css', b64: isImage(url) ? Buffer.from([137, 80, 78, 71]).toString('base64') : b64('.page-read{}') });

test('a public address is fetched at once, public-only, and the page is not asked', async () => {
  const s = make();
  const r = await s.net.text('https://cdn.example/a.css', who());
  assert.equal(r.ok, true);
  assert.deepEqual(s.tried, ['public https://cdn.example/a.css']);
  assert.deepEqual(s.read, []);
});

test('a public page: a public name on a private address is refused before it is sent, and the page cannot read it either', async () => {
  const s = make();
  assert.deepEqual(await s.net.text('https://inner.example/a.css', who()), { ok: false, code: 'unused' });
  assert.deepEqual(await s.net.image('https://loop.example/a.png', who()), { ok: false, code: 'unused' });
  assert.deepEqual(s.sent, [], 'nothing reached the private servers');
  assert.deepEqual(s.tried, ['public https://inner.example/a.css', 'public https://loop.example/a.png'], 'no other space for a public page');
  assert.deepEqual(s.read.map((r) => r.url), ['https://inner.example/a.css', 'https://loop.example/a.png']);
});

test('what the page reads with CORS is used as it is, and the worker sends nothing itself', async () => {
  const s = make({}, { page: cors });
  const r = await s.net.text('https://inner.example/a.css', who());
  assert.deepEqual(r, { ok: true, text: '.page-read{}', url: 'https://inner.example/a.css' });
  const img = await s.net.image('https://inner.example/a.png', who());
  assert.equal(img.ok, true);
  assert.equal(img.mime, 'image/png');
  assert.deepEqual(s.sent, []);
  assert.deepEqual(
    s.read.map((x) => [x.accept.split(',')[0], x.max, x.ms]),
    [
      ['text/css', 2 * 1024 * 1024, 25_000],
      ['image/*', 1024 * 1024, 10_000],
    ],
  );
});

test('a page on a private network: public first, then the private space, both judged by the browser; loopback stays shut', async () => {
  const s = make();
  assert.equal((await s.net.text('https://inner.example/a.css', intranet())).ok, true);
  assert.deepEqual(s.tried, ['public https://inner.example/a.css', 'local https://inner.example/a.css']);
  assert.deepEqual(s.sent, ['https://inner.example/a.css']);
  assert.deepEqual(await s.net.text('https://loop.example/a.css', intranet()), { ok: false, code: 'unused' });
  assert.equal(s.sent.length, 1, 'the loopback server got nothing');
  assert.deepEqual(s.read.map((r) => r.url), ['https://loop.example/a.css']);
});

test('a page on this machine may reach every network: no option', async () => {
  const s = make();
  assert.equal((await s.net.text('https://loop.example/a.css', who({ pageUrl: 'http://localhost:8080/' }))).ok, true);
  assert.deepEqual(s.tried, []);
  assert.deepEqual(s.sent, ['https://loop.example/a.css']);
});

test('behind a proxy every address is read by the page; nothing switches the browser check off for later addresses', async () => {
  const s = make({ proxy: true }, { page: cors });
  for (let i = 0; i < 5; i++) assert.equal((await s.net.text(`https://cdn.example/${i}.css`, who())).ok, true);
  assert.equal(s.tried.length, 5, 'the browser is asked every time');
  assert.equal(s.read.length, 5);
  assert.deepEqual(s.sent, [], 'the worker never fetches without the check');
});

test('a page that makes the public-only fetch fail many times gains nothing: an address the page cannot read stays refused', async () => {
  const s = make({ space: (u) => (u.includes('flaky') ? 'none' : u.includes('inner.') ? 'local' : 'public') }, { page: (u) => (u.includes('flaky') ? cors(u) : null) });
  for (let i = 0; i < 10; i++) await s.net.text(`https://flaky.example/${i}.css`, who());
  assert.deepEqual(await s.net.text('https://inner.example/secret.css', who()), { ok: false, code: 'unused' });
  assert.equal(s.sent.length, 0);
});

test('without the option (Firefox) the page reads every public name; a name that says it is private is judged by its network', async () => {
  const s = make({}, { publicSpace: false, page: cors });
  assert.equal((await s.net.text('https://cdn.example/a.css', who())).ok, true);
  assert.deepEqual(s.tried, []);
  assert.deepEqual(s.sent, []);
  assert.deepEqual(s.read.map((r) => r.url), ['https://cdn.example/a.css']);
  const local = await s.net.text('http://192.168.1.9/a.css', who({ pageUrl: 'http://192.168.1.5/admin' }));
  assert.equal(local.ok, true);
  assert.deepEqual(s.sent, ['http://192.168.1.9/a.css'], 'judged by its network, as before');
});

test('a page read keeps every other rule: status, type, size, time, and the address it ended at', async () => {
  const replies = {
    'https://cdn.example/gone.css': { status: 404, url: 'https://cdn.example/gone.css' },
    'https://cdn.example/html.css': { status: 200, url: 'https://cdn.example/html.css', type: 'text/html', b64: b64('<p>') },
    'https://cdn.example/big.css': { code: 'too-large' },
    'https://cdn.example/slow.css': { code: 'timeout' },
    'https://cdn.example/moved.css': { status: 200, url: 'http://10.0.0.9/moved.css', type: 'text/css', b64: b64('a{}') },
    'https://cdn.example/bad.css': { status: 200, url: 'https://cdn.example/bad.css', type: 'text/css', b64: '%%%' },
    'https://cdn.example/odd.css': { status: 'x' },
  };
  const s = make({}, { publicSpace: false, page: (u) => replies[u] });
  const code = async (u) => (await s.net.text(u, who())).code;
  assert.equal(await code('https://cdn.example/gone.css'), 'status');
  assert.equal(await code('https://cdn.example/gone.css'), 'status', 'remembered');
  assert.equal(s.read.filter((r) => r.url.endsWith('gone.css')).length, 1);
  assert.equal(await code('https://cdn.example/html.css'), 'type');
  assert.equal(await code('https://cdn.example/big.css'), 'too-large');
  assert.equal(await code('https://cdn.example/slow.css'), 'timeout');
  assert.equal(await code('https://cdn.example/moved.css'), 'redirect', 'a public page may not end on a private address');
  assert.equal(await code('https://cdn.example/bad.css'), 'unused');
  assert.equal(await code('https://cdn.example/odd.css'), 'unused');
});

test('a tab icon comes from the browser, so the use check is skipped; the address check is not', async () => {
  const s = make();
  assert.deepEqual(await s.net.favicon('https://inner.example/favicon.png', who()), { ok: false, code: 'unused' });
  assert.equal((await s.net.favicon('https://inner.example/favicon.png', intranet())).ok, true);
  assert.deepEqual(s.sent, ['https://inner.example/favicon.png']);
});

test('a refusal by the page is not handed to another asker that joined the fetch', async () => {
  // Frame 2 is a page that can read the address, frame 0 one that cannot.
  const b = browserLike();
  const verifyUsed = Object.assign(async () => true, { read: async (w, url) => (w.frameId === 2 ? cors(url) : null) });
  const net = createNet({ fetchImpl: b.fetchImpl, verifyUsed, publicSpace: false, now: () => 0 });
  const first = net.text('https://cdn.example/a.css', who({ frameId: 0 }));
  const second = net.text('https://cdn.example/a.css', who({ frameId: 2 }));
  assert.deepEqual(await first, { ok: false, code: 'unused' });
  assert.equal((await second).ok, true);
});

test('without a page reader an address the browser cannot judge is refused', async () => {
  const b = browserLike({ proxy: true });
  const net = createNet({ fetchImpl: b.fetchImpl, verifyUsed: async () => true, publicSpace: true, now: () => 0 });
  assert.deepEqual(await net.text('https://cdn.example/a.css', who()), { ok: false, code: 'unused' });
  assert.deepEqual(b.sent, []);
});

/** Timers that run only when the test moves the clock. */
function slowWorld() {
  const clock = { t: 0 };
  const timers = new Set();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => {
    const h = { at: clock.t + ms, fn };
    timers.add(h);
    return h;
  };
  globalThis.clearTimeout = (h) => timers.delete(h);
  const advance = async (ms) => {
    clock.t += ms;
    for (const h of [...timers]) if (h.at <= clock.t) (timers.delete(h), h.fn());
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const restore = () => ((globalThis.setTimeout = realSet), (globalThis.clearTimeout = realClear));
  return { clock, timers, advance, restore };
}

for (const [kind, limit] of [['text', 25_000], ['image', 10_000]]) {
  const url = kind === 'text' ? 'https://inner.example/a.css' : 'https://inner.example/a.png';

  test(`${kind}: the private space gets a fresh signal and its own full limit after a slow refusal of the public one`, async () => {
    const w = slowWorld();
    try {
      const signals = [];
      /** @type {() => void} */
      let refuse = () => {};
      const fetchImpl = (href, init) => {
        signals.push(init.signal);
        if (init.signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
        if (init.targetAddressSpace === 'public') return new Promise((_, reject) => (refuse = () => reject(new TypeError('Failed to fetch'))));
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      };
      const net = createNet({ fetchImpl, verifyUsed: async () => true, publicSpace: true, now: () => w.clock.t });
      const done = net[kind](url, intranet());
      await w.advance(0);
      // The refusal comes just before the first limit ends.
      await w.advance(limit - 1);
      refuse();
      await w.advance(0);
      assert.equal(signals.length, 2);
      assert.equal(signals[1].aborted, false, 'a new signal for the second fetch');
      let settled = false;
      void done.then(() => (settled = true));
      await w.advance(limit - 1);
      assert.equal(settled, false, 'still running just before its own limit');
      await w.advance(1);
      assert.deepEqual(await done, { ok: false, code: 'timeout' });
      assert.equal(w.timers.size, 0, 'no timer is left');
    } finally {
      w.restore();
    }
  });
}

test('Node does not know the option, so it is not used there', () => {
  assert.equal(publicSpaceKnown(), false);
});
