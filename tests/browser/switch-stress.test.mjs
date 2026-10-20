// Random switching between the four modes over every engine. After the last change the page must show the last mode and nothing
// may be left over (no staged piece, no quick or hold style, no frozen transitions). The Filter engines have no colors in the
// computed style, so a state of the root, the filter and the engine's own style elements stand for them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

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

const MODES = {
  dark: { mode: 'dark' },
  light: { mode: 'light' },
  paper: { mode: 'eink', einkPreset: 'paper' },
  eink: { mode: 'eink', einkPreset: 'eink' },
};
const NAMES = Object.keys(MODES);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small deterministic random generator, so a failure can be run again from its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function storage(engine, mode, host) {
  const base = { settings: { enabled: true, engine, theme: { ...MODES[mode] } } };
  if (engine === 'static') base.userFixes = { [host]: { static: { bg: ['body', '.card', 'footer'], fg: ['body', 'footer'], border: ['.card'] } } };
  return base;
}

/** What the page shows, in a form that is the same for every engine. */
const signature = (page, probes, colors = true) =>
  page.evaluate(([list, withColors]) => {
    const style = (el) => (el ? getComputedStyle(el) : null);
    const root = document.documentElement;
    const own = [...document.querySelectorAll('style[data-dk], svg[data-dk]')];
    const kinds = {};
    for (const el of own) {
      const k = el.getAttribute('data-dk');
      // The readability net and the pictures come when they are ready, so they are not part of the look.
      if (!['sheet', 'site', 'inert', 'read', 'images'].includes(k)) kinds[k] = (kinds[k] ?? 0) + 1;
    }
    return {
      html: [style(root).backgroundColor, style(root).filter, style(root).colorScheme],
      probes: list.map((s) => {
        const c = style(document.querySelector(s));
        return c ? [c.backgroundColor, withColors ? c.color : null] : null;
      }),
      kinds: Object.fromEntries(Object.entries(kinds).sort()),
      // Leftovers: a switched-off piece, a style that only belongs to a build or a hold.
      staged: document.querySelectorAll('style[data-dk][media="not all"]').length,
      transient: ['quick', 'early', 'freeze'].reduce((n, k) => n + document.querySelectorAll(`style[data-dk="${k}"]`).length, 0),
      bothInline: document.querySelectorAll('[data-dk-i]').length > 0 && document.querySelectorAll('[data-dk-j]').length > 0,
      filterText: [...document.querySelectorAll('style[data-dk="filter"], style[data-dk="static"], style[data-dk="calm"], svg[data-dk]')].map((e) => (e.nodeName === 'svg' ? e.outerHTML : e.textContent)).join('|'),
    };
  }, [probes, colors]);

const clean = (sig) => sig.staged === 0 && sig.transient === 0 && !sig.bothInline;
const same = (a, b) => JSON.stringify({ html: a.html, probes: a.probes, kinds: a.kinds, filterText: a.filterText }) === JSON.stringify({ html: b.html, probes: b.probes, kinds: b.kinds, filterText: b.filterText });

/** Wait until the signature stops changing and is clean; resolves to it or to the last one seen. */
async function settled(page, probes, want, colors, timeout = 25000) {
  const t = Date.now();
  let last = null;
  let steady = 0;
  while (Date.now() - t < timeout) {
    const sig = await signature(page, probes, colors);
    if (want && same(sig, want) && clean(sig)) {
      if (++steady >= 3) return { sig, ok: true };
    } else steady = 0;
    last = sig;
    await sleep(120);
  }
  return { sig: last, ok: false };
}

async function openPage(url, st) {
  await browser.clearStorage();
  await browser.setStorage(st);
  const page = await browser.context.newPage();
  await page.bringToFront();
  await page.goto(url);
  await waitState(page, 'ready', 30000).catch(() => {});
  return page;
}

/** What each mode looks like on its own, from a clean load. */
async function calibrate(url, engine, probes, host, colors) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const mode of NAMES) {
    const page = await openPage(url, storage(engine, mode, host));
    // A page that is still loading its late sheets is not steady yet.
    // The E-ink rules come from a module that is injected after the page is ready, and a busy machine takes long to inject it,
    // so the reference needs the E-ink rules (when the mode has them) and a longer quiet time.
    let previous = null;
    let sig = null;
    let steady = 0;
    for (let i = 0; i < 100; i++) {
      sig = await signature(page, probes, colors);
      const complete = mode !== 'eink' || engine === 'static' || !!sig.kinds.calm || /grayscale/.test(sig.html[1]);
      steady = previous && same(sig, previous) && clean(sig) && complete ? steady + 1 : 0;
      if (steady >= 4) break;
      previous = sig;
      await sleep(150);
    }
    out[mode] = sig;
    await page.close();
  }
  // The four modes must look different from each other, or the test could not tell them apart.
  for (let i = 0; i < NAMES.length; i++) {
    for (let j = i + 1; j < NAMES.length; j++) {
      assert.equal(same(out[NAMES[i]], out[NAMES[j]]), false, `${engine}: ${NAMES[i]} and ${NAMES[j]} look the same`);
    }
  }
  return out;
}

const DELAYS = [0, 0, 10, 40, 90, 160, 280, 340, 420, 700];

async function stress({ label, path, engine, probes, runs, seed, steps = 9, colors = true }) {
  const host = new URL(servers.origin).host;
  const url = `${servers.origin}${path}`;
  const want = await calibrate(url, engine, probes, host, colors);
  const random = rng(seed);
  for (let run = 0; run < runs; run++) {
    const start = NAMES[Math.floor(random() * NAMES.length)];
    const page = await openPage(url, storage(engine, start, host));
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const sequence = [];
    let current = start;
    for (let i = 0; i < steps; i++) {
      let next = NAMES[Math.floor(random() * NAMES.length)];
      if (next === current && random() < 0.7) next = NAMES[(NAMES.indexOf(next) + 1) % NAMES.length];
      const delay = DELAYS[Math.floor(random() * DELAYS.length)];
      sequence.push(`${next}+${delay}`);
      await browser.setStorage(storage(engine, next, host));
      current = next;
      await sleep(delay);
    }
    const result = await settled(page, probes, want[current], colors);
    const trail = `${label} seed ${seed} run ${run}: ${start} -> ${sequence.join(' ')}`;
    assert.ok(result.ok, `${trail}\nexpected ${JSON.stringify(want[current])}\nfound    ${JSON.stringify(result.sig)}`);
    assert.deepEqual(errors, [], `${trail}: page errors`);
    // The engine is still alive and answers a next change.
    const other = NAMES[(NAMES.indexOf(current) + 2) % NAMES.length];
    await browser.setStorage(storage(engine, other, host));
    const again = await settled(page, probes, want[other], colors);
    assert.ok(again.ok, `${trail}: then ${other}\nexpected ${JSON.stringify(want[other])}\nfound    ${JSON.stringify(again.sig)}`);
    await page.close();
  }
  console.log(`# ${label}: ${runs} random runs of ${steps} changes, seed ${seed}, all ended in the last mode`);
}

// The readability net repairs text colors a few seconds after the load, so a test that compares text colors on elements outside the
// lists of the Static engine cannot wait for a steady state; it compares the backgrounds there.
const BASIC = ['body', '.card', 'footer', 'header', 'p.muted', '.hero', 'th'];
const LARGE = ['body', '.c37', '.c74', '.c111'];

test('random switching over the Dynamic engine on a small page ends in the last mode with nothing left over', { timeout: 300000 }, async () => {
  await stress({ label: 'dynamic small', path: '/basic.html', engine: 'dynamic', probes: BASIC, runs: 14, seed: 20261016 });
});

test('random switching over the Dynamic engine on a page of 6 000 rules, where a build takes long enough to be overtaken', { timeout: 300000 }, async () => {
  await stress({ label: 'dynamic large', path: '/gen/large.html?rules=6000&palette=40', engine: 'dynamic', probes: LARGE, runs: 8, seed: 77031, colors: false });
});

test('random switching over Filter+ ends in the last mode', { timeout: 300000 }, async () => {
  await stress({ label: 'filterPlus', path: '/basic.html', engine: 'filterPlus', probes: BASIC, runs: 8, seed: 515 });
});

test('random switching over Filter ends in the last mode', { timeout: 300000 }, async () => {
  await stress({ label: 'filter', path: '/basic.html', engine: 'filter', probes: BASIC, runs: 8, seed: 909 });
});

test('random switching over the Static engine ends in the last mode', { timeout: 300000 }, async () => {
  await stress({ label: 'static', path: '/basic.html', engine: 'static', probes: BASIC, runs: 8, seed: 31337, colors: false });
});

test('a change that arrives while the page is still being themed for the first time wins', { timeout: 120000 }, async () => {
  const host = new URL(servers.origin).host;
  const url = `${servers.origin}/slow.html`;
  const probes = ['body', '.card'];
  const want = await calibrate(url, 'dynamic', probes, host, true);
  for (const [first, second] of [['dark', 'light'], ['light', 'eink'], ['paper', 'dark']]) {
    await browser.clearStorage();
    await browser.setStorage(storage('dynamic', first, host));
    const page = await browser.context.newPage();
    await page.bringToFront();
    const loading = page.goto(url);
    // The change comes while the late sheet is still on its way.
    await sleep(60);
    await browser.setStorage(storage('dynamic', second, host));
    await loading;
    const result = await settled(page, probes, want[second], true);
    assert.ok(result.ok, `${first} then ${second} while loading\nexpected ${JSON.stringify(want[second])}\nfound    ${JSON.stringify(result.sig)}`);
    await page.close();
  }
});

test('a change made at any moment while the page starts is not lost, also in the gap between the first read and the listener', { timeout: 240000 }, async () => {
  const host = new URL(servers.origin).host;
  const url = `${servers.origin}/basic.html`;
  const probes = ['body', '.card'];
  const want = await calibrate(url, 'dynamic', probes, host, true);
  const lost = [];
  // The change comes 0 to 100 ms after the navigation began, which covers the time the content script needs to start.
  for (let offset = 0; offset <= 100; offset += 5) {
    const [first, second] = offset % 10 === 0 ? ['dark', 'light'] : ['light', 'dark'];
    await browser.clearStorage();
    await browser.setStorage(storage('dynamic', first, host));
    const page = await browser.context.newPage();
    await page.bringToFront();
    const loading = page.goto(url);
    await sleep(offset);
    await browser.setStorage(storage('dynamic', second, host));
    await loading;
    const result = await settled(page, probes, want[second], true, 8000);
    if (!result.ok) lost.push(`${offset} ms: ${first} then ${second}`);
    await page.close();
  }
  assert.deepEqual(lost, [], 'these changes were lost');
});
