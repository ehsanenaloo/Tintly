// The proxy keeps what it fetched apart by site, and shares its fetches fairly between tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { createNet, partitionOf, LIMITS } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'net.js')).href);

const SHEET = 'https://cdn.example.com/site.css';
const tick = () => new Promise((r) => setImmediate(r));

function reply({ body = 'a{color:red}', status = 200, url } = {}) {
  const headers = new Headers({ 'content-type': 'text/css' });
  return { ok: status >= 200 && status < 300, status, url, headers, body: new Blob([new TextEncoder().encode(body)]).stream() };
}

/** A page of a site in a tab. */
const at = (top, tabId = 1, page = top) => ({ tabId, frameId: page === top ? 0 : 3, pageUrl: page, rights: page, top });

/** A fetch that answers after `ms`, and counts. */
function slow(ms) {
  const calls = [];
  const fetchImpl = (href, init) => {
    calls.push({ href, init });
    return new Promise((resolve) => setTimeout(() => resolve(reply({ url: href })), ms));
  };
  return { calls, fetchImpl };
}

/** A fetch whose answers are given by hand. */
function manual() {
  const calls = [];
  const fetchImpl = (href, init) => new Promise((resolve) => calls.push({ href, init, resolve: (r) => resolve({ ...r, url: r.url || href }) }));
  return { calls, fetchImpl };
}

test('the partition is the origin of the top page and of the asking frame', () => {
  assert.equal(partitionOf(at('https://a.example.org/x')), 'https://a.example.org|https://a.example.org');
  assert.equal(partitionOf(at('https://a.example.org/x', 1, 'https://ads.example.net/f')), 'https://a.example.org|https://ads.example.net');
  assert.equal(partitionOf({ tabId: 4, pageUrl: 'https://b.example.org/' }), 'https://b.example.org|https://b.example.org', 'no top known: the frame alone');
  assert.equal(partitionOf({ tabId: 4, pageUrl: 'about:blank' }), 'tab:4');
  assert.equal(partitionOf({ tabId: 4, pageUrl: 'https://b.example.org/', rights: '' }), 'tab:4', 'a frame of unknown origin does not share the top site');
});

test('a page cannot time what was fetched for another site: the second site fetches again, the same site does not', async () => {
  const s = slow(200);
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: s.fetchImpl });
  const time = async (who) => {
    const t = performance.now();
    const r = await net.text(SHEET, who);
    assert.equal(r.ok, true);
    return performance.now() - t;
  };
  const first = await time(at('https://victim.example.org/'));
  const again = await time(at('https://victim.example.org/other', 2));
  const other = await time(at('https://attacker.example.net/', 3));
  assert.equal(s.calls.length, 2, 'one fetch for each site');
  // Wide margins: the machine may be busy. The counts above are the proof; the times show what a page could measure.
  assert.ok(first >= 190 && other >= 190, `both sites wait for the server (${first.toFixed(1)} ms, ${other.toFixed(1)} ms)`);
  assert.ok(again < 100, `the same site is answered from the cache (${again.toFixed(1)} ms)`);
  // A frame of another site inside the victim's page has its own part too.
  await time(at('https://victim.example.org/', 1, 'https://attacker.example.net/frame'));
  assert.equal(s.calls.length, 3);
});

test('the browser cache of the worker is not used: every fetch asks the server', async () => {
  const s = slow(0);
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: s.fetchImpl });
  await net.text(SHEET, at('https://a.example.org/'));
  await net.image('https://cdn.example.com/p.png', at('https://a.example.org/'));
  assert.ok(s.calls.length >= 2);
  for (const c of s.calls) assert.equal(c.init.cache, 'no-store');
});

test('a missing file and a running fetch are kept apart by site too', async () => {
  const m = manual();
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: m.fetchImpl });
  const a = net.text(SHEET, at('https://a.example.org/'));
  const b = net.text(SHEET, at('https://b.example.org/', 2));
  const a2 = net.text(SHEET, at('https://a.example.org/', 3));
  await tick();
  assert.equal(m.calls.length, 2, 'a joins its own site only');
  m.calls[0].resolve(reply({ status: 404 }));
  m.calls[1].resolve(reply({ status: 404 }));
  assert.deepEqual(await Promise.all([a, b, a2]), [{ ok: false, code: 'status' }, { ok: false, code: 'status' }, { ok: false, code: 'status' }]);
  // The 404 is remembered for the site that saw it, not handed to a third site.
  assert.deepEqual(await net.text(SHEET, at('https://a.example.org/', 4)), { ok: false, code: 'status' });
  assert.equal(m.calls.length, 2);
  const c = net.text(SHEET, at('https://c.example.org/', 5));
  await tick();
  assert.equal(m.calls.length, 3);
  m.calls[2].resolve(reply({}));
  assert.equal((await c).ok, true);
});

test('a busy tab may use the pool up to the reserve, and the last slots stay for tabs that have none running', async () => {
  const m = manual();
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: m.fetchImpl });
  const url = (i) => `https://cdn.example.com/${i}.css`;
  const share = LIMITS.INFLIGHT - LIMITS.INFLIGHT_RESERVE;
  // One tab whose page and frame ask for many sheets at once (each frame of the engine runs up to 6).
  const top = at('https://busy.example.org/', 1);
  const frame = at('https://busy.example.org/', 1, 'https://media.example.net/embed');
  const running = Array.from({ length: share }, (_, i) => net.text(url(i), i % 2 ? frame : top));
  await tick();
  assert.equal(m.calls.length, share, 'the frames of one tab are not cut to the share of one frame');
  assert.deepEqual(await net.text(url(99), top), { ok: false, code: 'rate' }, 'the busy tab stops at the reserve');
  // Tabs with nothing running get the reserved slots, one each, until the pool is full.
  const fresh = Array.from({ length: LIMITS.INFLIGHT_RESERVE }, (_, i) => net.text(url(`f${i}`), at(`https://f${i}.example.org/`, 100 + i)));
  await tick();
  assert.equal(m.calls.length, LIMITS.INFLIGHT);
  assert.deepEqual(await net.text(url('late'), at('https://late.example.org/', 200)), { ok: false, code: 'rate' }, 'the pool is full');
  for (const c of m.calls) c.resolve(reply({}));
  await Promise.all([...running, ...fresh]);
  // Every slot comes back.
  const again = Array.from({ length: share }, (_, i) => net.text(url(`again${i}`), top));
  await tick();
  assert.equal(m.calls.length, LIMITS.INFLIGHT + share);
  for (const c of m.calls.slice(LIMITS.INFLIGHT)) c.resolve(reply({}));
  await Promise.all(again);
});
