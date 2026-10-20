import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { encodePng } from '../helpers/png.mjs';

const { createNet, pixelSize, sampleImage, LIMITS } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'net.js')).href);

const pad = (bytes, n = 40) => Uint8Array.from([...bytes, ...new Array(Math.max(0, n - bytes.length)).fill(0)]);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const le16 = (v) => [v & 255, v >> 8];
const le24 = (v) => [v & 255, (v >> 8) & 255, v >> 16];
const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

test('the header gives the size of each format the worker samples', () => {
  const png = new Uint8Array(encodePng(300, 120, new Uint8ClampedArray(300 * 120 * 4)));
  assert.deepEqual(pixelSize(png), [300, 120]);
  assert.deepEqual(pixelSize(pad([...ascii('GIF89a'), ...le16(64), ...le16(32)])), [64, 32]);
  assert.deepEqual(pixelSize(pad([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(799), ...le24(449)])), [800, 450]);
  const lossy = [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8 '), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480)];
  assert.deepEqual(pixelSize(pad(lossy)), [640, 480]);
  const bits = (333 - 1) | ((222 - 1) << 14);
  const lossless = [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8L'), 0, 0, 0, 0, 0x2f, ...le32(bits)];
  assert.deepEqual(pixelSize(pad(lossless)), [333, 222]);
  assert.deepEqual(pixelSize(pad([...ascii('BM'), ...new Array(16).fill(0), ...le32(50), ...le32(-20 >>> 0)])), [50, 20]);
  assert.deepEqual(pixelSize(pad([0, 0, 1, 0, 1, 0, 0, 16])), [256, 16]);
  // A JPEG: an application segment first, the frame header after it.
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 6, 1, 2, 3, 4, 0xff, 0xc2, 0, 17, 8, ...[1000 >> 8, 1000 & 255], ...[700 >> 8, 700 & 255]];
  assert.deepEqual(pixelSize(pad(jpeg)), [700, 1000]);
});

test('a header that is not known or is cut short gives no size', () => {
  assert.equal(pixelSize(new Uint8Array(10)), null);
  assert.equal(pixelSize(pad(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))), null);
  assert.equal(pixelSize(pad([0xff, 0xd8, 0x00, 0x01, 0x02])), null);
  // A segment that points past the end of the file does not loop.
  assert.equal(pixelSize(pad([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff])), null);
  assert.equal(pixelSize(pad([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPJUNK')])), null);
});

test('no sample without a canvas, for a vector file, a size over the cap or an unknown format', async () => {
  const png = new Uint8Array(encodePng(40, 40, new Uint8ClampedArray(40 * 40 * 4)));
  // This process has neither createImageBitmap nor OffscreenCanvas.
  assert.equal(await sampleImage(png, 'image/png'), null);
  const saved = { c: globalThis.createImageBitmap, o: globalThis.OffscreenCanvas };
  let decoded = 0;
  globalThis.createImageBitmap = async () => {
    decoded += 1;
    throw new Error('should not run');
  };
  globalThis.OffscreenCanvas = class {};
  try {
    assert.equal(await sampleImage(png, 'image/svg+xml'), null);
    assert.equal(await sampleImage(pad(ascii('not a picture')), 'image/png'), null);
    const huge = new Uint8Array(encodePng(40, 40, new Uint8ClampedArray(40 * 40 * 4)));
    new DataView(huge.buffer).setUint32(16, 5000);
    new DataView(huge.buffer).setUint32(20, 5000);
    assert.ok(5000 * 5000 > LIMITS.SAMPLE_PIXELS);
    assert.equal(await sampleImage(huge, 'image/png'), null);
    assert.equal(decoded, 0);
  } finally {
    globalThis.createImageBitmap = saved.c;
    globalThis.OffscreenCanvas = saved.o;
    if (saved.c === undefined) delete globalThis.createImageBitmap;
    if (saved.o === undefined) delete globalThis.OffscreenCanvas;
  }
});

test('a sample is the 32 by 32 RGBA of the decoder, a failed or a slow decode gives none and the bitmap is closed', async () => {
  const png = new Uint8Array(encodePng(40, 40, new Uint8ClampedArray(40 * 40 * 4)));
  const saved = { c: globalThis.createImageBitmap, o: globalThis.OffscreenCanvas };
  const closed = [];
  const asked = [];
  let mode = 'ok';
  let release;
  globalThis.createImageBitmap = async (blob, options) => {
    asked.push(options);
    if (mode === 'fail') throw new Error('The source image could not be decoded');
    if (mode === 'slow') await new Promise((r) => { release = r; });
    const bitmap = { close: () => closed.push(bitmap) };
    return bitmap;
  };
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        drawImage() {},
        getImageData: () => ({ data: Uint8ClampedArray.from({ length: 32 * 32 * 4 }, (_, i) => i % 251) }),
      };
    }
  };
  try {
    const sample = await sampleImage(png, 'image/png');
    assert.equal(Buffer.from(sample, 'base64').length, 4096);
    assert.equal(Buffer.from(sample, 'base64')[7], 7);
    assert.deepEqual(asked[0], { resizeWidth: 32, resizeHeight: 32 });
    assert.equal(closed.length, 1);
    mode = 'fail';
    assert.equal(await sampleImage(png, 'image/png'), null);
    // A decode over the limit gives none, and the bitmap that arrives later is closed.
    mode = 'slow';
    assert.equal(await sampleImage(png, 'image/png', 10), null);
    assert.equal(closed.length, 1);
    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closed.length, 2);
  } finally {
    globalThis.createImageBitmap = saved.c;
    globalThis.OffscreenCanvas = saved.o;
    if (saved.c === undefined) delete globalThis.createImageBitmap;
    if (saved.o === undefined) delete globalThis.OffscreenCanvas;
  }
});

function make(sampler, body = new Uint8Array(70_000).fill(7)) {
  let fetches = 0;
  const net = createNet({ publicSpace: true, 
    now: () => 0,
    verifyUsed: async () => true,
    sampler,
    fetchImpl: async (href) => {
      fetches += 1;
      return { ok: true, status: 200, url: href, headers: new Headers({ 'content-type': href.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }), body: new Blob([body]).stream() };
    },
  });
  return { net, fetches: () => fetches };
}
const who = { tabId: 1, frameId: 0, pageUrl: 'https://site.example/' };

test('a page that asks for a sample gets 4 KB and no file; a page that does not gets the file', async () => {
  const calls = [];
  const { net } = make(async (bytes, mime) => {
    calls.push([bytes.length, mime]);
    return 'c2FtcGxl';
  });
  const small = await net.image('https://cdn.example/a.png', who, true);
  assert.deepEqual(small, { ok: true, mime: 'image/png', sample: 'c2FtcGxl', url: 'https://cdn.example/a.png' });
  assert.equal(small.base64, undefined);
  assert.deepEqual(calls, [[70_000, 'image/png']]);
  // The cache holds the small copy, not the file.
  assert.equal(net.cacheBytes, 'c2FtcGxl'.length);
  // The plain request is another entry and never gets a sample.
  const plain = await net.image('https://cdn.example/a.png', who);
  assert.equal(plain.sample, undefined);
  assert.equal(plain.base64.length, Buffer.from(new Uint8Array(70_000).fill(7)).toString('base64').length);
  assert.equal(calls.length, 1);
  assert.equal(net.cacheSize, 2);
  // The same small copy is served again without a fetch or a decode.
  assert.deepEqual(await net.image('https://cdn.example/a.png', who, true), small);
  assert.equal(calls.length, 1);
});

test('when no sample can be made the answer is the file, as before', async () => {
  const { net } = make(async () => null);
  const r = await net.image('https://cdn.example/b.svg', who, true);
  assert.equal(r.ok, true);
  assert.equal(r.sample, undefined);
  assert.equal(typeof r.base64, 'string');
  assert.equal(net.cacheBytes, r.base64.length);
});

test('a sample request keeps every limit of a file request', async () => {
  let ran = 0;
  const { net } = make(async () => {
    ran += 1;
    return 'x';
  });
  assert.deepEqual(await net.image('file:///etc/passwd', who, true), { ok: false, code: 'scheme' });
  assert.deepEqual(await net.image('http://192.168.1.2/a.png', who, true), { ok: false, code: 'private' });
  assert.equal(ran, 0);
  const big = make(async () => {
    ran += 1;
    return 'x';
  }, new Uint8Array(LIMITS.IMAGE_BYTES + 10));
  assert.deepEqual(await big.net.image('https://cdn.example/big.png', who, true), { ok: false, code: 'too-large' });
  assert.equal(ran, 0);
});

test('requests for the same address share one fetch and one decode', async () => {
  let ran = 0;
  const { net, fetches } = make(async () => {
    ran += 1;
    await new Promise((r) => setTimeout(r, 5));
    return 'c2FtcGxl';
  });
  const answers = await Promise.all([1, 2, 3].map((tabId) => net.image('https://cdn.example/c.png', { ...who, tabId }, true)));
  assert.ok(answers.every((a) => a.sample === 'c2FtcGxl'));
  assert.equal(fetches(), 1);
  assert.equal(ran, 1);
});
