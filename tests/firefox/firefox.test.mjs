import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, imageStore } from '../browser/harness.mjs';
import { corpus, encodePng } from '../helpers/png.mjs';
import { startFirefox, firefoxSkip } from './driver.mjs';

const skip = firefoxSkip();
let servers;
let ff;
let ext; // the options page in a frame: a place to run extension code

before(async () => {
  if (skip) return;
  for (const i of corpus()) imageStore.set(i.name, encodePng(i.w, i.h, i.px));
  servers = await startServers();
  ff = await startFirefox();
  console.log(`# Firefox ${ff.version}`);
  ext = (await ff.extensionPage(servers.origin, '/pages/options/options.html')).frame;
});

after(async () => {
  await ff?.close();
  await servers?.close();
});

const host = () => new URL(servers.origin).host;
// The content scripts are registered by the background page; a write returns when the registration matches it.
const setStorage = (items) => ff.run(ext, async (o) => (await browser.storage.local.set(o), await browser.runtime.sendMessage({ type: 'dk.register.sync' })), items);
const clearStorage = () => ff.run(ext, async () => (await browser.storage.local.clear(), await browser.runtime.sendMessage({ type: 'dk.register.sync' })));
const send = (message) => ff.run(ext, (m) => browser.runtime.sendMessage(m), message);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(tab, fn, ...args) {
  for (let i = 0; i < 100; i++) {
    if (await ff.run(tab, fn, ...args)) return true;
    await sleep(100);
  }
  return false;
}
const state = (tab) => ff.run(tab, () => document.documentElement.getAttribute('data-dk-state'));
const count = (tab, selector) => ff.run(tab, (s) => document.querySelectorAll(s).length, selector);
const ready = (tab) => waitFor(tab, () => document.documentElement.getAttribute('data-dk-state') === 'ready');

async function open(path, storage) {
  await clearStorage();
  await setStorage(storage);
  return ff.newTab(`${servers.origin}${path}`);
}
const ON = { settings: { enabled: true } };
// Wait for the color: a read right after `ready` can come before the first dark frame.
const bodyDark = (tab) =>
  waitFor(tab, () => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.35;
  });

test('the add-on installs, the worker writes the defaults, and the pages load', { skip, timeout: 60000 }, async () => {
  const stored = await ff.run(ext, () => browser.storage.local.get(null));
  assert.ok(stored.schemaVersion >= 1, JSON.stringify(Object.keys(stored)));
  assert.ok(await waitFor(ext, () => !document.body.hasAttribute('data-loading')));
  assert.equal(await ff.run(ext, () => document.getElementById('brightness').value), '100');
  const popup = await ff.extensionPage(servers.origin, '/pages/popup/popup.html');
  assert.ok(await waitFor(popup.frame, () => !document.body.hasAttribute('data-loading')));
  const fixes = await ff.extensionPage(servers.origin, '/pages/fixes/fixes.html');
  assert.ok(await waitFor(fixes.frame, () => !document.body.hasAttribute('data-loading')));
});

test('the Dynamic engine themes a page and leaves with the switch', { skip, timeout: 60000 }, async () => {
  const tab = await open('/basic.html', ON);
  assert.ok(await ready(tab), `state ${await state(tab)}`);
  assert.ok(await bodyDark(tab), 'the body is dark');
  assert.ok((await count(tab, 'style[data-dk="sheet"]')) > 0);
  await setStorage({ settings: { enabled: false } });
  assert.ok(await waitFor(tab, () => !document.documentElement.hasAttribute('data-dk-state')));
  assert.equal(await count(tab, '[data-dk]'), 0);
  const plain = await open('/basic.html', { settings: { enabled: false } });
  await sleep(500);
  assert.equal(await count(plain, '[data-dk]'), 0);
});

test('a sheet from another origin is fetched through the worker and themed', { skip, timeout: 60000 }, async () => {
  const tab = await open('/dynamic.html', ON);
  assert.ok(await ready(tab));
  const before = await count(tab, 'style[data-dk="sheet"]');
  await ff.run(
    tab,
    (u) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = `${u}/css/linked.css`;
      document.head.append(l);
    },
    servers.other,
  );
  assert.ok(await waitFor(tab, (n) => document.querySelectorAll('style[data-dk="sheet"]').length > n, before), 'a copy of the other-origin sheet was made');
  assert.equal(await count(tab, 'style[data-dk="inert"]'), 0);
});

test('a large linked sheet of this origin is themed, whichever way the engine reads it', { skip, timeout: 60000 }, async () => {
  const tab = await open('/gen/large.html?rules=800&palette=40&linked=1', ON);
  assert.ok(await ready(tab), `state ${await state(tab)}`);
  assert.ok(await bodyDark(tab), 'the body is dark');
  assert.ok(await waitFor(tab, () => document.querySelectorAll('style[data-dk="sheet"]').length > 0), 'a copy of the sheet was made');
  // The text of the sheet is asked from the cache only; a miss falls back to the CSSOM and the result is the same.
  assert.equal(await count(tab, 'style[data-dk="inert"]'), 0);
});

test('pictures of another origin are sorted through the worker, and an extension page can make the 32 by 32 copy', { skip, timeout: 60000 }, async () => {
  const tab = await open(`/gen/images.html?names=dark-logo-0,photo-0&base=${servers.other}`, ON);
  assert.ok(await ready(tab), `state ${await state(tab)}`);
  assert.ok(await waitFor(tab, () => document.getElementById('dark-logo-0').getAttribute('data-dk-img') === 'invert'), 'the dark logo was inverted');
  assert.equal(await ff.run(tab, () => document.getElementById('photo-0').getAttribute('data-dk-img')), null);
  // The steps the worker takes for a copy, run in the extension page of this Firefox: a clear disc with a dark middle.
  const copy = await ff.run(ext, async (u) => {
    const bytes = new Uint8Array(await (await fetch(u)).arrayBuffer());
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { resizeWidth: 32, resizeHeight: 32 });
    const ctx = new OffscreenCanvas(32, 32).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    return { length: data.length, base64: typeof Uint8Array.fromBase64, middleAlpha: data[(16 * 32 + 16) * 4 + 3] };
  }, `${servers.other}/gen/img/dark-logo-0.png`);
  assert.equal(copy.length, 4096);
  assert.ok(copy.middleAlpha > 0, JSON.stringify(copy));
});

test('dark icons set as CSS backgrounds are inverted, photos are not', { skip, timeout: 60000 }, async () => {
  const tab = await open('/bg-images.html', ON);
  assert.ok(await ready(tab), `state ${await state(tab)}`);
  assert.ok(await waitFor(tab, () => document.querySelectorAll('[data-dk-bg]').length >= 5), 'icons were marked');
  const got = await ff.run(tab, () => ({ logo: document.getElementById('logo').getAttribute('data-dk-bg'), photo: document.getElementById('photo').getAttribute('data-dk-bg'), svg: document.getElementById('svg').getAttribute('data-dk-bg') }));
  assert.deepEqual(got, { logo: 'invert', photo: null, svg: 'invert' });
});

test('the Filter and Filter+ engines run', { skip, timeout: 60000 }, async () => {
  for (const engine of ['filter', 'filterPlus']) {
    const tab = await open('/basic.html', { settings: { enabled: true, engine } });
    assert.ok(await ready(tab), engine);
    assert.equal(await count(tab, 'style[data-dk="filter"]'), 1, engine);
    assert.equal(await count(tab, 'style[data-dk="sheet"]'), 0, engine);
    if (engine === 'filterPlus') assert.equal(await count(tab, 'svg[data-dk="filter-defs"]'), 1);
  }
});

test('shadow roots and constructed sheets are themed through the main-world hook', { skip, timeout: 60000 }, async () => {
  const colorOf = (tab) =>
    ff.run(tab, () => {
      const hosts = [...document.querySelectorAll('*')].filter((e) => e.shadowRoot);
      return hosts.map((h) => [...h.shadowRoot.querySelectorAll('*')].map((e) => `${getComputedStyle(e).color}|${getComputedStyle(e).backgroundColor}`).join(';')).join('#');
    });
  const off = await open('/shadow.html', { settings: { enabled: false } });
  await sleep(500);
  const original = await colorOf(off);
  const tab = await open('/shadow.html', ON);
  assert.ok(await ready(tab));
  await sleep(1500);
  const themed = await colorOf(tab);
  assert.ok(original.length > 0, 'the fixture has shadow roots');
  assert.notEqual(themed, original, 'the colors inside the roots changed');
});

test('a static theme, a fix and custom CSS apply', { skip, timeout: 60000 }, async () => {
  const fix = { engine: 'static', static: { bg: ['.card'], fg: ['p'] }, dynamic: { css: 'h1 { outline: 3px solid rgb(1, 2, 3) !important; }' } };
  const tab = await open('/basic.html', { ...ON, userFixes: { [host()]: fix } });
  assert.ok(await ready(tab));
  assert.equal(await count(tab, 'style[data-dk="static"]'), 1);
  assert.equal(await count(tab, 'style[data-dk="sheet"]'), 0);
  assert.ok(await waitFor(tab, () => getComputedStyle(document.querySelector('h1')).outlineColor === 'rgb(1, 2, 3)'));
});

test('dark pages are left alone, light pages are themed, and images are sorted', { skip, timeout: 90000 }, async () => {
  const dark = await open('/detect/dark-css.html', ON);
  await sleep(1500);
  assert.equal(await count(dark, '[data-dk]'), 0);
  const light = await open('/detect/light-white.html', ON);
  assert.ok(await ready(light));
  const names = corpus().filter((i) => /^(dark-logo-0|chart-0|bright-photo-0|photo-0)$/.test(i.name)).map((i) => i.name);
  const page = await open(`/gen/images.html?names=${names.join(',')}`, ON);
  assert.ok(await waitFor(page, () => document.querySelectorAll('img[data-dk-img]').length >= 2), 'images were marked');
  const marks = await ff.run(page, () => Object.fromEntries([...document.images].map((i) => [i.id, i.getAttribute('data-dk-img') ?? 'keep'])));
  assert.deepEqual(marks, { 'dark-logo-0': 'invert', 'chart-0': 'dim', 'bright-photo-0': 'keep', 'photo-0': 'keep' });
});

test('messages: the pages talk to the worker, and the worker keeps writes in order', { skip, timeout: 60000 }, async () => {
  await clearStorage();
  const state0 = await send({ type: 'dk.state.get', url: `${servers.origin}/basic.html` });
  assert.equal(state0.ok, true);
  const replies = await ff.run(ext, () => Promise.all(Array.from({ length: 10 }, (_, i) => browser.runtime.sendMessage({ type: 'dk.settings.patch', patch: { theme: { brightness: 60 + i } } }))));
  assert.ok(replies.every((r) => r.ok));
  assert.equal((await ff.run(ext, () => browser.storage.local.get('settings'))).settings.theme.brightness, 69);
  assert.deepEqual(await send({ type: 'dk.nothing' }), { ok: false, code: 'unknown' });
  const exported = await send({ type: 'dk.export' });
  assert.equal(JSON.parse(exported.text).app, 'tintly');
});

test('a site switch from the popup reaches the open page', { skip, timeout: 60000 }, async () => {
  const tab = await open('/basic.html', ON);
  assert.ok(await ready(tab));
  assert.equal((await send({ type: 'dk.site.set', pattern: host(), rule: { enabled: false } })).ok, true);
  assert.ok(await waitFor(tab, () => !document.documentElement.hasAttribute('data-dk-state')));
  assert.equal((await send({ type: 'dk.site.set', pattern: host(), rule: null })).ok, true);
  assert.ok(await ready(tab));
});

test('a page with a strict style policy is still themed', { skip, timeout: 60000 }, async () => {
  const tab = await open('/csp/basic.html', ON);
  assert.ok(await ready(tab));
  assert.ok(await bodyDark(tab), 'the body is dark under style-src self');
  assert.ok((await count(tab, 'style[data-dk]')) >= 2);
});

test('a constructed sheet adopted late by a shadow root is themed', { skip, timeout: 60000 }, async () => {
  const tab = await open('/edge-shadow.html', ON);
  assert.ok(await ready(tab));
  await ff.run(tab, () => {
    const host = document.createElement('div');
    host.id = 'late-host';
    document.getElementById('mount').append(host);
    host.attachShadow({ mode: 'open' }).append(Object.assign(document.createElement('div'), { id: 'late', className: 'b', textContent: 'late' }));
  });
  await sleep(600);
  await ff.run(tab, () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.b{background:#fff;color:#111;padding:8px}');
    document.getElementById('late-host').shadowRoot.adoptedStyleSheets = [sheet];
  });
  assert.ok(
    await waitFor(tab, () => {
      const [r, g, b] = getComputedStyle(document.getElementById('late-host').shadowRoot.getElementById('late')).backgroundColor.match(/\d+/g).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.35;
    }),
  );
});

test('the author opt-out, a route change and a removed style node are followed', { skip, timeout: 90000 }, async () => {
  const off = await open('/opt-out-meta.html', ON);
  await sleep(1500);
  assert.equal(await count(off, '[data-dk], [data-dk-state]'), 0);

  const tab = await open('/basic.html', { settings: { enabled: true }, siteRules: { [`${host()}/off`]: { enabled: false } } });
  assert.ok(await ready(tab));
  await ff.run(tab, () => history.pushState({}, '', '/off'));
  assert.ok(await waitFor(tab, () => !document.documentElement.hasAttribute('data-dk-state')));
  await ff.run(tab, () => history.pushState({}, '', '/basic.html'));
  assert.ok(await ready(tab));

  const filter = await open('/basic.html', { settings: { enabled: true, engine: 'filter' } });
  assert.ok(await ready(filter));
  await ff.run(filter, () => document.head.replaceChildren());
  assert.ok(await waitFor(filter, () => document.querySelector('style[data-dk="filter"]') !== null));
});

test('the E-ink and Paper mode: the mode switch themes the page with paper and ink, calm rules and the motion hint, and leaves with the mode', { skip, timeout: 90000 }, async () => {
  const real = await ff.run(await open('/eink-motion.html', { settings: { enabled: false } }), () => matchMedia('(prefers-color-scheme: dark)').matches);
  const tab = await open('/eink-motion.html', { settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'eink' } } });
  assert.ok(await ready(tab), `state ${await state(tab)}`);
  const paper = () => ff.run(tab, () => getComputedStyle(document.documentElement).backgroundColor);
  assert.ok(await waitFor(tab, () => getComputedStyle(document.documentElement).backgroundColor === 'rgb(255, 255, 255)'), await paper());
  assert.equal(await count(tab, 'style[data-dk="calm"]'), 1);
  assert.equal(await ff.run(tab, () => getComputedStyle(document.getElementById('spinner')).animationIterationCount), '1');
  assert.equal(await ff.run(tab, () => getComputedStyle(document.getElementById('card')).boxShadow), 'none');
  // The reduced motion query answers yes through the hook, the color scheme query is left alone.
  assert.ok(await waitFor(tab, () => matchMedia('(prefers-reduced-motion: reduce)').matches === true));
  assert.equal(await ff.run(tab, () => matchMedia('(prefers-color-scheme: dark)').matches), real);
  // Paper: a warm tone, and the motion stays.
  await setStorage({ settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'paper', einkBlue: 0, whiteCap: 100 } } });
  assert.ok(await waitFor(tab, () => getComputedStyle(document.documentElement).backgroundColor === 'rgb(244, 241, 234)'), await paper());
  assert.ok(await waitFor(tab, () => matchMedia('(prefers-reduced-motion: reduce)').matches === false));
  assert.equal(await ff.run(tab, () => getComputedStyle(document.getElementById('spinner')).animationIterationCount), 'infinite');
  // Dark and back leave nothing of the mode.
  await setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  assert.ok(await waitFor(tab, () => document.querySelector('style[data-dk="calm"]') === null && document.querySelector('style[data-dk="base"]') !== null));
  assert.ok(await bodyDark(tab), 'dark again');
});

test('the readability net, the font, weight and selection settings, the legacy tile and the reduced motion rules', { skip, timeout: 120000 }, async () => {
  // A light tile, flat with a few other pixels.
  const tile = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < 256; i++) tile.set(i % 17 === 0 ? [236, 231, 217, 255] : [244, 240, 228, 255], i * 4);
  imageStore.set('legacy-light', encodePng(16, 16, tile));
  // Extras and the net. The dark text color is in a sheet that a fix tells the engine to skip, so the engine cannot theme it.
  const tab = await open('/readability-skip.html', {
    settings: { enabled: true, theme: { fontEnabled: true, fontFamily: 'Georgia', textStroke: 4, selection: '#ffcc00' } },
    userFixes: { [host()]: { dynamic: { ignoreCssUrl: ['*/readability-text.css'] } } },
  });
  assert.ok(await ready(tab), `state ${await state(tab)}`);
  assert.ok(await waitFor(tab, () => document.getElementById('bubble').hasAttribute('data-dk-r')), 'the net fixed the bubble');
  const got = await ff.run(tab, () => {
    const el = document.getElementById('bubble');
    const lum = (css) => {
      const p = css.match(/[\d.]+/g).map(Number).slice(0, 3).map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    };
    const s = getComputedStyle(el);
    const [a, b] = [lum(s.color), lum(s.backgroundColor)];
    return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), font: s.fontFamily, stroke: s.webkitTextStrokeWidth, selection: getComputedStyle(el, '::selection').backgroundColor };
  });
  assert.ok(got.ratio >= 4.5, `contrast ${got.ratio}`);
  assert.match(got.font, /^"?Georgia/);
  assert.equal(got.stroke, '0.4px');
  assert.equal(got.selection, 'rgb(255, 204, 0)');
  // The legacy tile.
  const legacy = await open('/legacy-bg.html', ON);
  assert.ok(await waitFor(legacy, () => document.body.getAttribute('data-dk-bg') === 'tile'), 'the tile was switched off');
  assert.equal(await ff.run(legacy, () => getComputedStyle(document.body).backgroundImage), 'none');
  // The page's reduced motion rules apply with the hint.
  const motion = await open('/reduced-motion.html', { settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'paper', reducedMotionHint: true } } });
  assert.ok(await ready(motion), `state ${await state(motion)}`);
  assert.ok(await waitFor(motion, () => getComputedStyle(document.getElementById('spin')).animationName === 'none'));
});

test('the engine files are registered for the pages that can be on: an off page gets no script, a switch reaches an open tab', { skip, timeout: 120000 }, async () => {
  const plan = async () => (await send({ type: 'dk.register.sync' })).plan;
  const traces = (tab) => ff.run(tab, () => ({ hook: (() => { const w = globalThis.wrappedJSObject ?? globalThis; try { return Reflect.apply(w.Element.prototype.attachShadow, 'dk:hook?', []) === true; } catch { return false; } })(), attributes: [...document.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-dk')) }));
  // Off: nothing registered, nothing in the page.
  let tab = await open('/basic.html', { settings: { enabled: false } });
  assert.equal(await plan(), null);
  await sleep(1500);
  assert.deepEqual(await traces(tab), { hook: false, attributes: [] });
  // Switched on while the tab is open: the files are put into it.
  await setStorage({ settings: { enabled: true } });
  assert.ok(await ready(tab), `state ${await state(tab)}`);
  assert.equal((await traces(tab)).hook, true, 'the hook runs in the page world');
  assert.deepEqual(await plan(), { matches: ['<all_urls>'], excludeMatches: [] });
  // A new load of a themed site is themed at the first pass.
  tab = await ff.newTab(`${servers.origin}/basic.html`);
  assert.ok(await ready(tab));
  assert.ok(await bodyDark(tab));
  // A host that is off by its rule is left out of the set and gets nothing.
  await setStorage({ settings: { enabled: true }, siteRules: { [new URL(servers.origin).hostname]: { enabled: false } } });
  assert.deepEqual(await plan(), { matches: ['<all_urls>'], excludeMatches: ['*://*.127.0.0.1/*'] });
  tab = await ff.newTab(`${servers.origin}/basic.html`);
  await sleep(1500);
  assert.deepEqual(await traces(tab), { hook: false, attributes: [] });
});

const popupState = (context) =>
  ff.run(context, () => ({
    loading: document.body.hasAttribute('data-loading'),
    painted: document.body.hasAttribute('data-painted'),
    controls: !document.getElementById('controls').hidden,
    master: !document.getElementById('master').disabled,
    status: document.getElementById('status').textContent,
    label: document.getElementById('master-label').textContent,
  }));

test('the popup works in a frame, where `tabs` and `storage.session` do not exist, and in its own tab, where they do', { skip, timeout: 90000 }, async () => {
  await clearStorage();
  await setStorage(ON);
  const framed = (await ff.extensionPage(servers.origin, '/pages/popup/popup.html')).frame;
  assert.deepEqual(await ff.run(framed, () => [typeof chrome.tabs, typeof chrome.storage.session]), ['undefined', 'undefined']);
  assert.ok(await waitFor(framed, () => !document.body.hasAttribute('data-loading')));
  const a = await popupState(framed);
  assert.deepEqual([a.painted, a.controls, a.master], [true, true, true], JSON.stringify(a));
  assert.equal(a.label, 'Tintly is on');
  // The same page as a tab of its own, as the browser shows an extension page.
  const tab = await ff.extensionTab(servers.origin, '/pages/popup/popup.html');
  assert.deepEqual(await ff.run(tab, () => [typeof chrome.tabs?.query, typeof chrome.storage.session?.get]), ['function', 'function']);
  assert.ok(await waitFor(tab, () => !document.body.hasAttribute('data-loading')));
  const b = await popupState(tab);
  assert.deepEqual([b.painted, b.controls, b.master], [true, true, true], JSON.stringify(b));
  assert.ok(b.status.length > 0);
});

test('the settings page: a deleted site rule is brought back with Undo, and the font name follows its switch', { skip, timeout: 90000 }, async () => {
  const site = '127.0.0.1';
  await clearStorage();
  await setStorage({ settings: { enabled: true, theme: { fontEnabled: false, fontFamily: 'Georgia' } }, siteRules: { [site]: { enabled: false, theme: { brightness: 80 } } } });
  const page = (await ff.extensionPage(servers.origin, '/pages/options/options.html')).frame;
  assert.ok(await waitFor(page, () => !document.body.hasAttribute('data-loading')));
  assert.equal(await ff.run(page, () => document.getElementById('fontFamily').disabled), true);
  await ff.run(page, () => document.getElementById('tab-sites').click());
  // The delete button asks once more before it deletes.
  await ff.run(page, () => document.querySelector('#site-list .site-remove').click());
  await ff.run(page, () => document.querySelector('#site-list .site-remove').click());
  assert.ok(await waitFor(page, () => document.querySelector('#message .say-action') !== null));
  assert.deepEqual((await ff.run(ext, () => browser.storage.local.get('siteRules'))).siteRules, {});
  await ff.run(page, () => document.querySelector('#message .say-action').click());
  assert.ok(await waitFor(page, () => document.getElementById('message').textContent === 'Restored.'));
  assert.deepEqual((await ff.run(ext, () => browser.storage.local.get('siteRules'))).siteRules[site], { enabled: false, theme: { brightness: 80 } });
});

test('the footer pause button and the style of the swatches and sliders are present in Firefox', { skip, timeout: 60000 }, async () => {
  await clearStorage();
  await setStorage(ON);
  const popup = (await ff.extensionPage(servers.origin, '/pages/popup/popup.html')).frame;
  assert.ok(await waitFor(popup, () => !document.body.hasAttribute('data-loading')));
  assert.equal(await ff.run(popup, () => [document.querySelector('.footer-pause').hidden, document.querySelector('.footer-pause').getAttribute('aria-pressed')]).then((r) => r.join()), 'false,false');
  await ff.run(popup, () => document.querySelector('.footer-pause').click());
  assert.equal(await ff.run(popup, () => document.querySelector('.footer-pause').getAttribute('aria-pressed')), 'true');
  assert.equal(await ff.run(popup, () => document.querySelector('.footer').classList.contains('is-rotating')), false);
  // The slider thumb uses the Firefox pseudo-element rules (a 14 px thumb with a 2 px border), not the default look.
  const thumb = await ff.run(popup, () => getComputedStyle(document.getElementById('brightness'), '::-moz-range-thumb').width);
  assert.equal(thumb, '14px');
});

test('the schedule alarms: the permission is built in, a page that is off by the hours gets no script, the settings page shows it as allowed', { skip, timeout: 120000 }, async () => {
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const at = (ms) => hhmm(new Date(Date.now() + ms));
  const plan = async () => (await send({ type: 'dk.register.sync' })).plan;
  const until = async (read, want) => {
    for (let i = 0; i < 100; i++) {
      if (JSON.stringify(await read()) === JSON.stringify(want)) return true;
      await sleep(100);
    }
    return false;
  };
  const traces = (tab) => ff.run(tab, () => ({ hook: (() => { const w = globalThis.wrappedJSObject ?? globalThis; try { return Reflect.apply(w.Element.prototype.attachShadow, 'dk:hook?', []) === true; } catch { return false; } })(), attributes: [...document.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-dk')) }));
  // An extension page in a tab of its own has every API; the framed page used by the other tests lacks some.
  const page = await ff.extensionTab(servers.origin, '/pages/options/options.html');
  assert.equal(await ff.run(page, () => browser.permissions.contains({ permissions: ['alarms'] })), true);
  await clearStorage();
  await setStorage({ settings: { enabled: true, automation: { mode: 'time', behavior: 'onOff', time: { from: at(3600_000), to: at(7200_000) } } } });
  assert.ok(await until(plan, null), 'no script is registered outside the hours');
  const names = await ff.run(page, () => browser.alarms.getAll().then((list) => list.map((a) => a.name).sort()));
  assert.deepEqual(names, ['dk-schedule-check', 'dk-schedule-next']);
  const off = await ff.newTab(`${servers.origin}/basic.html`);
  await sleep(1500);
  assert.deepEqual(await traces(off), { hook: false, attributes: [] });
  // The settings page: allowed, and no button, because Firefox has no way to ask later.
  assert.ok(await waitFor(page, () => !document.body.hasAttribute('data-loading')));
  await ff.run(page, () => document.getElementById('tab-schedule').click());
  assert.ok(await waitFor(page, () => /^Allowed/.test(document.getElementById('alarm-status').textContent)));
  assert.deepEqual(await ff.run(page, () => ['alarm-box', 'alarm-allow', 'alarm-remove'].map((id) => document.getElementById(id).hidden)), [false, true, true]);
  // The hours are moved so that it is inside them now: the files come back and the page is themed.
  await setStorage({ settings: { enabled: true, automation: { mode: 'time', behavior: 'onOff', time: { from: at(-3600_000), to: at(3600_000) } } } });
  assert.deepEqual(await plan(), { matches: ['<all_urls>'], excludeMatches: [] });
  const on = await ff.newTab(`${servers.origin}/basic.html`);
  assert.ok(await ready(on));
  // Turning the schedule off removes the alarms.
  await setStorage({ settings: { enabled: true, automation: { mode: 'none' } } });
  assert.ok(await until(() => ff.run(page, () => browser.alarms.getAll().then((list) => list.length)), 0));
});
