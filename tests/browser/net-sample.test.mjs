// Pictures of another origin: the worker makes the small copy and sends 4 KB, not the file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { startServers, launch, waitState, imageStore, SLOW } from './harness.mjs';
import { encodePng, rng } from '../helpers/png.mjs';

let servers;
let browser;

before(async () => {
  servers = await startServers();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

/** A PNG with a text chunk of `extra` bytes after the header, so the file is big and the picture is whatever the pixels say. */
function padded(png, extra, seed) {
  const next = rng(seed);
  const data = Buffer.alloc(extra);
  for (let i = 0; i < extra; i++) data[i] = 65 + Math.floor(next() * 58);
  const body = Buffer.concat([Buffer.from('tEXt'), Buffer.from('note\0'), data]);
  const chunk = Buffer.alloc(12 + body.length - 4);
  chunk.writeUInt32BE(body.length - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), chunk.length - 4);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

function noise(side, seed) {
  const next = rng(seed);
  const px = new Uint8ClampedArray(side * side * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = next() * 256;
    px[i + 1] = next() * 256;
    px[i + 2] = next() * 256;
    px[i + 3] = 255;
  }
  return encodePng(side, side, px);
}

function icon(side) {
  const px = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const inside = (x - side / 2) ** 2 + (y - side / 2) ** 2 < (side * 0.36) ** 2;
      px.set(inside ? [20, 24, 30, 255] : [0, 0, 0, 0], (y * side + x) * 4);
    }
  }
  return encodePng(side, side, px);
}

const COUNT = 40;
const ICONS = new Set([3, 17, 30]);

function fill() {
  imageStore.clear();
  for (let i = 0; i < COUNT; i++) imageStore.set(`s${i}`, ICONS.has(i) ? padded(icon(48), 60_000, i + 1) : padded(noise(60, i + 1), 0, i + 1));
}

const fromContent = (url, message) =>
  browser.worker.evaluate(
    async ({ u, m }) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (msg) => chrome.runtime.sendMessage(msg), args: [m] });
      return r.result;
    },
    { u: url, m: message },
  );

const imageStats = (page) =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify(globalThis.__dk.images.stats()) });
    return JSON.parse(r.result);
  }, page.url());

async function open(path) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready');
  return page;
}

test('the worker answers with the 32 by 32 copy for a raster picture and with the file for a vector picture', { timeout: 60000 }, async () => {
  fill();
  const page = await open(`/gen/images.html?names=s0,s3&base=${servers.other}`);
  const url = page.url();
  const sample = await fromContent(url, { type: 'dk.net.image', url: `${servers.other}/gen/img/s3.png`, sample: true });
  assert.equal(sample.ok, true, JSON.stringify(sample));
  assert.equal(sample.base64, undefined);
  const px = Buffer.from(sample.sample, 'base64');
  assert.equal(px.length, 32 * 32 * 4);
  // The middle of the disc is dark and opaque, the corner is clear.
  const at = (x, y) => [...px.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
  assert.ok(at(16, 16)[3] > 200 && at(16, 16)[0] < 60, JSON.stringify(at(16, 16)));
  assert.ok(at(0, 0)[3] < 30, JSON.stringify(at(0, 0)));
  // Without the field the answer is the file, as it was.
  const file = await fromContent(url, { type: 'dk.net.image', url: `${servers.other}/gen/img/s3.png` });
  assert.equal(file.ok, true);
  assert.equal(file.sample, undefined);
  assert.equal(Buffer.from(file.base64, 'base64').subarray(1, 4).toString(), 'PNG');
  // A field of the wrong type is refused like any other.
  assert.equal((await fromContent(url, { type: 'dk.net.image', url: `${servers.other}/gen/img/s3.png`, sample: 'yes' })).ok, false);
  assert.equal((await fromContent(url, { type: 'dk.net.image', url: `${servers.other}/gen/img/s3.png`, sample: true, extra: 1 })).ok, false);
  // The picture is not one the frame uses: the same refusal as for a file.
  assert.equal((await fromContent(url, { type: 'dk.net.image', url: `${servers.other}/gen/img/s9.png`, sample: true })).ok, false);
  await page.close();
});

test('40 pictures of another origin, 60 KB each: sorted from the worker copies, with a short main thread', { timeout: 120000 * SLOW }, async () => {
  fill();
  await browser.worker.evaluate(() => {
    globalThis.__asked = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.type === 'dk.net.image') globalThis.__asked.push(m.sample === true);
    });
  });
  const names = Array.from({ length: COUNT }, (_, i) => `s${i}`).join(',');
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((list) => window.__long.push(...list.getEntries().map((e) => e.duration))).observe({ entryTypes: ['longtask'] });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async (name) => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === name).value;
  await page.goto(`${servers.origin}/gen/images.html?names=${names}&base=${servers.other}`);
  await waitState(page, 'ready');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 30000 * SLOW });
  const began = await metric('TaskDuration');
  const deadline = Date.now() + 40000 * SLOW;
  let stats;
  do {
    await page.waitForTimeout(200);
    stats = await imageStats(page);
  } while (stats.fetched + stats.failed < COUNT && Date.now() < deadline);
  await page.waitForTimeout(500);
  const spent = ((await metric('TaskDuration')) - began) * 1000;
  const long = await page.evaluate(() => window.__long);
  const marks = await page.evaluate(() => Object.fromEntries([...document.images].map((i) => [i.id, i.getAttribute('data-dk-img') ?? 'none'])));
  const asked = await browser.worker.evaluate(() => globalThis.__asked);
  console.log(`# ${COUNT} pictures: ${JSON.stringify(stats)}; main thread after load ${spent.toFixed(0)} ms; long tasks ${JSON.stringify(long.map(Math.round))}`);
  assert.equal(stats.fetched, COUNT);
  assert.equal(stats.failed, 0);
  assert.equal(asked.length, COUNT);
  assert.ok(asked.every((v) => v === true), 'every request asks for the copy');
  for (let i = 0; i < COUNT; i++) assert.equal(marks[`s${i}`], ICONS.has(i) ? 'invert' : 'none', `s${i}`);
  // Before the copy was made in the worker: 240 ms at normal speed, 1 200 ms at 4 times slower (the file was decoded in the page).
  assert.ok(spent < 160 * SLOW, `${spent.toFixed(0)} ms of main thread`);
  assert.ok(Math.max(0, ...long) < 80 * SLOW, `a task of ${Math.max(0, ...long)} ms`);
  await page.close();
});
