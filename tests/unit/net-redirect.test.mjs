import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { createNet, LIMITS } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'net.js')).href);

const PAGE = 'https://site.example/page';
const who = (extra = {}) => ({ tabId: 1, frameId: 0, pageUrl: PAGE, ...extra });

const css = (href, extra = {}) => ({
  ok: true,
  status: 200,
  url: href,
  type: 'basic',
  redirected: false,
  headers: new Headers({ 'content-type': 'text/css' }),
  body: new Response('a{color:red}').body,
  ...extra,
});
/** What a browser gives for `redirect: 'manual'`: no status, no headers, no body. */
const opaque = (href) => ({ ok: false, status: 0, url: href, type: 'opaqueredirect', redirected: false, headers: new Headers(), body: null });

/** A fetch that follows nothing: a table of address to reply, a log of the addresses asked. */
function web(table) {
  const asked = [];
  const fetchImpl = async (href, init) => {
    asked.push({ href, init });
    const reply = table[href];
    if (!reply) throw new TypeError('no route');
    return typeof reply === 'function' ? reply(href) : reply;
  };
  return { asked, net: createNet({ publicSpace: true, fetchImpl, verifyUsed: async () => true }) };
}

test('no request is made with redirects switched on', async () => {
  const { asked, net } = web({ 'https://cdn.example/a.css': css('https://cdn.example/a.css') });
  assert.equal((await net.text('https://cdn.example/a.css', who())).ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].init.redirect, 'manual');
  assert.equal(asked[0].init.credentials, 'omit');
});

test('an opaque redirect is refused for text and for images, and only the first address is asked', async () => {
  const { asked, net } = web({
    'https://cdn.example/a.css': opaque('https://cdn.example/a.css'),
    'https://cdn.example/i.png': opaque('https://cdn.example/i.png'),
  });
  assert.deepEqual(await net.text('https://cdn.example/a.css', who()), { ok: false, code: 'redirect' });
  assert.deepEqual(await net.image('https://cdn.example/i.png', who()), { ok: false, code: 'redirect' });
  assert.deepEqual(
    asked.map((a) => a.href),
    ['https://cdn.example/a.css', 'https://cdn.example/i.png'],
  );
});

test('a reply that shows a redirect status, or says it was redirected, is refused even when its address looks public', async () => {
  for (const extra of [{ status: 302, ok: false }, { redirected: true }, { type: 'opaqueredirect', status: 0, ok: false }]) {
    const { net } = web({ 'https://cdn.example/a.css': css('https://other.example/b.css', extra) });
    assert.deepEqual(await net.text('https://cdn.example/a.css', who()), { ok: false, code: 'redirect' }, JSON.stringify(extra));
  }
});

test('a redirect to a private address, a chain through one and a loop all end at the first hop', async () => {
  for (const name of ['private', 'chain', 'loop']) {
    const { asked, net } = web({ [`https://cdn.example/${name}.css`]: opaque(`https://cdn.example/${name}.css`) });
    const started = Date.now();
    assert.deepEqual(await net.text(`https://cdn.example/${name}.css`, who()), { ok: false, code: 'redirect' }, name);
    assert.equal(asked.length, 1, `${name}: one request`);
    assert.ok(Date.now() - started < 1000, `${name}: ends at once`);
  }
});

test('a moved http address is asked once more over https, and nothing else', async () => {
  const { asked, net } = web({
    'http://cdn.example/a.css': opaque('http://cdn.example/a.css'),
    'https://cdn.example/a.css': css('https://cdn.example/a.css'),
  });
  assert.deepEqual(await net.text('http://cdn.example/a.css', who({ pageUrl: 'http://site.example/' })), {
    ok: true,
    text: 'a{color:red}',
    url: 'https://cdn.example/a.css',
  });
  assert.deepEqual(
    asked.map((a) => a.href),
    ['http://cdn.example/a.css', 'https://cdn.example/a.css'],
  );
  assert.ok(asked.every((a) => a.init.redirect === 'manual' && a.init.credentials === 'omit'));
});

test('the https try is refused when it is a redirect again, an error, an explicit port, or when the first address was already https', async () => {
  const again = web({ 'http://cdn.example/a.css': opaque('http://cdn.example/a.css'), 'https://cdn.example/a.css': opaque('https://cdn.example/a.css') });
  assert.deepEqual(await again.net.text('http://cdn.example/a.css', who()), { ok: false, code: 'redirect' });
  assert.equal(again.asked.length, 2);
  const down = web({ 'http://cdn.example/a.css': opaque('http://cdn.example/a.css') });
  assert.deepEqual(await down.net.text('http://cdn.example/a.css', who()), { ok: false, code: 'redirect' });
  const port = web({ 'http://cdn.example:8080/a.css': opaque('http://cdn.example:8080/a.css'), 'https://cdn.example:8080/a.css': css('https://cdn.example:8080/a.css') });
  assert.deepEqual(await port.net.text('http://cdn.example:8080/a.css', who()), { ok: false, code: 'redirect' }, 'an explicit port is not a plain upgrade');
  assert.equal(port.asked.length, 1);
  const secure = web({ 'https://cdn.example/a.css': opaque('https://cdn.example/a.css') });
  assert.deepEqual(await secure.net.text('https://cdn.example/a.css', who()), { ok: false, code: 'redirect' });
  assert.equal(secure.asked.length, 1);
});

test('the https try keeps the private-network rule and never asks another host', async () => {
  const { asked, net } = web({ 'http://127.0.0.1:9/a.css': opaque('http://127.0.0.1:9/a.css'), 'https://127.0.0.1:9/a.css': css('https://127.0.0.1:9/a.css') });
  // A public page may not reach 127.0.0.1 at all: no request, with or without a redirect.
  assert.deepEqual(await net.text('http://127.0.0.1:9/a.css', who()), { ok: false, code: 'private' });
  assert.equal(asked.length, 0);
  assert.ok(LIMITS.INFLIGHT > 0);
});

test('a refused redirect is not remembered as an answer for the next asker', async () => {
  let moved = true;
  const asked = [];
  const net = createNet({ publicSpace: true, 
    verifyUsed: async () => true,
    fetchImpl: async (href) => (asked.push(href), moved ? opaque(href) : css(href)),
  });
  assert.deepEqual(await net.text('https://cdn.example/a.css', who()), { ok: false, code: 'redirect' });
  moved = false;
  assert.equal((await net.text('https://cdn.example/a.css', who())).ok, true);
  assert.equal(asked.length, 2);
});

test('every attempt counts for the rate limit, also the refused ones', async () => {
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: async (href) => opaque(href) });
  for (let i = 0; i < LIMITS.RATE_COUNT; i++) await net.text(`https://cdn.example/${i}.css`, who());
  assert.deepEqual(await net.text('https://cdn.example/over.css', who()), { ok: false, code: 'rate' });
});
