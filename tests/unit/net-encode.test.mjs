import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { createNet, encodeBase64, LIMITS } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'net.js')).href);

const random = (n) => {
  const b = new Uint8Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
};

test('the fallback encoder gives the standard base64 for every length and byte value', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = random(n);
    assert.equal(encodeBase64(bytes, false), Buffer.from(bytes).toString('base64'), `length ${n}`);
  }
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(encodeBase64(all, false), Buffer.from(all).toString('base64'));
  const big = random(1024 * 1024);
  assert.equal(encodeBase64(big, false), Buffer.from(big).toString('base64'));
});

test('the fallback encoder is not slow: 1 MB in well under 60 ms', () => {
  const big = random(1024 * 1024);
  encodeBase64(big, false);
  const t = performance.now();
  encodeBase64(big, false);
  const ms = performance.now() - t;
  assert.ok(ms < 60, `${ms.toFixed(1)} ms`);
});

test('the built-in encoder is used when the engine has one', () => {
  const bytes = random(100);
  let used = 0;
  bytes.toBase64 = function () {
    used++;
    return 'native';
  };
  assert.equal(encodeBase64(bytes), 'native');
  assert.equal(used, 1);
  assert.equal(encodeBase64(bytes, false), Buffer.from(bytes.subarray(0)).toString('base64'));
});

test('an image answer carries standard base64 and the cache counts what it holds', async () => {
  const png = random(70_000);
  const net = createNet({ publicSpace: true, 
    now: () => 0,
    verifyUsed: async () => true,
    fetchImpl: async (href) => ({ ok: true, status: 200, url: href, headers: new Headers({ 'content-type': 'image/png' }), body: new Blob([png]).stream() }),
  });
  const who = { tabId: 1, frameId: 0, pageUrl: 'https://site.example/' };
  const r = await net.image('https://cdn.example/a.png', who);
  assert.equal(r.ok, true);
  assert.equal(r.base64, Buffer.from(png).toString('base64'));
  assert.equal(net.cacheBytes, r.base64.length);
  assert.equal(net.cacheSize, 1);
});

test('the cache stays inside its entry and byte limits with many images', async () => {
  const pics = new Map();
  const net = createNet({ publicSpace: true, 
    now: () => 0,
    verifyUsed: async () => true,
    fetchImpl: async (href) => {
      if (!pics.has(href)) pics.set(href, random(900_000 + pics.size));
      return { ok: true, status: 200, url: href, headers: new Headers({ 'content-type': 'image/jpeg' }), body: new Blob([pics.get(href)]).stream() };
    },
  });
  for (let i = 0; i < 40; i++) {
    const who = { tabId: 100 + i, frameId: 0, pageUrl: 'https://site.example/' };
    const r = await net.image(`https://cdn.example/${i}.jpg`, who);
    assert.equal(r.ok, true);
    assert.ok(net.cacheBytes <= LIMITS.CACHE_BYTES, `${net.cacheBytes} bytes`);
    assert.ok(net.cacheSize <= LIMITS.CACHE_ENTRIES);
  }
  assert.ok(net.cacheSize >= 10, 'many fit under the limit');
  assert.ok(net.cacheBytes > 0);
});
