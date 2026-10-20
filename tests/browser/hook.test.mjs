import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js');
const C = dk.color;
const lightnessOf = (css) => {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  const [r, g, b] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return C.toOklch({ r: r / 255, g: g / 255, b: b / 255, a: 1 })[0];
};

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

async function open(path, storage) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`${servers.origin}${path}`);
  if (storage.settings.enabled) await waitState(page, 'ready');
  else await page.waitForLoadState('load');
  return { page, problems, url: `${servers.origin}${path}` };
}

const ON = { settings: { enabled: true } };
const OFF = { settings: { enabled: false } };

/** Wait until the element found by `finder` (a function in the page) has a dark background and a light text. */
async function expectThemed(page, finder, label) {
  await page.waitForFunction(
    ({ src }) => {
      const el = new Function(`return (${src})()`)();
      if (!el) return false;
      const s = getComputedStyle(el);
      const parts = (css) => {
        const m = /rgba?\(([^)]+)\)/.exec(css);
        return m ? m[1].split(/[,\s/]+/).filter(Boolean).map(Number) : [0, 0, 0, 0];
      };
      // Rough lightness, enough to tell a dark background from a light one.
      const l = (css) => {
        const [r, g, b] = parts(css);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      };
      // The element must have a background of its own, so a transparent one inherited from a themed page does not count.
      const alpha = parts(s.backgroundColor)[3] ?? 1;
      return alpha > 0.5 && l(s.backgroundColor) < 0.25 && l(s.color) > 0.4;
    },
    { src: finder.toString() },
    { timeout: 8000 },
  ).catch(async () => {
    const now = await page.evaluate((src) => {
      const el = new Function(`return (${src})()`)();
      const s = el && getComputedStyle(el);
      return s ? `${s.color} on ${s.backgroundColor}` : 'no element';
    }, finder.toString());
    assert.fail(`${label} was not themed: ${now}`);
  });
}

const FINDERS = {
  open: () => document.getElementById('open').shadowRoot.querySelector('.t'),
  closed: () => window.__closed.querySelector('.t'),
  adopted: () => document.getElementById('adopted').shadowRoot.querySelector('.t'),
  outer: () => window.__outer.querySelector('.o'),
  inner: () => window.__outer.querySelector('inner-card').shadowRoot.querySelector('.t'),
  declarative: () => document.getElementById('decl').shadowRoot.querySelector('.d'),
  docad: () => document.querySelector('.docad'),
  cij: () => document.querySelector('.cij'),
  media: () => document.querySelector('.media-rule'),
};

test('open, closed, adopted, nested and declarative shadow roots are themed', { timeout: 60000 }, async () => {
  const { page, problems } = await open('/shadow.html', ON);
  for (const [name, finder] of Object.entries(FINDERS)) await expectThemed(page, finder, name);
  assert.deepEqual(problems, []);
  const stats = await browser.stats(`${servers.origin}/shadow.html`);
  console.log(`# shadow: roots=${stats.roots} adoptedSheets=${stats.adoptedSheets} hookEvents=${stats.hookEvents} faults=${stats.faults}`);
  assert.ok(stats.roots >= 5, JSON.stringify(stats));
  assert.equal(stats.faults, 0);
  assert.equal(stats.adoptFailed, 0);
  await page.close();
});

test('a shadow root with no theme leaves the page alone when the site is off', { timeout: 60000 }, async () => {
  const { page } = await open('/shadow.html', OFF);
  const r = await page.evaluate(() => ({
    adopted: document.getElementById('adopted').shadowRoot.adoptedStyleSheets.length,
    doc: document.adoptedStyleSheets.length,
    marked: document.getElementById('open').shadowRoot.querySelectorAll('[data-dk]').length,
  }));
  assert.deepEqual(r, { adopted: 1, doc: 1, marked: 0 });
  await page.close();
});

test('a change to a constructed sheet is followed, for replaceSync and for replace', { timeout: 60000 }, async () => {
  const { page } = await open('/shadow.html', ON);
  await expectThemed(page, FINDERS.adopted, 'adopted');
  const before = await page.evaluate(() => getComputedStyle(window.__adoptedSheet && document.getElementById('adopted').shadowRoot.querySelector('.t')).color);
  await page.evaluate(() => window.replaceAdopted());
  await page.waitForFunction((was) => getComputedStyle(document.getElementById('adopted').shadowRoot.querySelector('.t')).color !== was, before);
  await expectThemed(page, FINDERS.adopted, 'adopted after replaceSync');
  // The original teal text would be rgb(0, 77, 64). It must not show through.
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById('adopted').shadowRoot.querySelector('.t')).color), 'rgb(0, 77, 64)');

  const docBefore = await page.evaluate(() => getComputedStyle(document.querySelector('.docad')).color);
  await page.evaluate(() => window.replaceDocAsync());
  await page.waitForFunction((was) => getComputedStyle(document.querySelector('.docad')).color !== was, docBefore);
  await expectThemed(page, FINDERS.docad, 'document sheet after replace');
  await page.close();
});

test('rules added to a sheet with insertRule are followed, also inside a grouping rule', { timeout: 60000 }, async () => {
  const { page } = await open('/shadow.html', ON);
  await expectThemed(page, FINDERS.cij, 'insertRule');
  await expectThemed(page, FINDERS.media, 'insertRule of a media rule');
  await page.evaluate(() => window.insertInMedia());
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.media-rule')).borderTopStyle === 'solid');
  // The border color was set to a light gray. It is a border color, so the theme changes it.
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.media-rule')).borderTopColor !== 'rgb(224, 224, 224)');
  await page.close();
});

test('when the page drops an adopted sheet, our copy goes with it, and it comes back with the sheet', { timeout: 60000 }, async () => {
  const { page } = await open('/shadow.html', ON);
  await expectThemed(page, FINDERS.adopted, 'adopted');
  const length = () => page.evaluate(() => document.getElementById('adopted').shadowRoot.adoptedStyleSheets.length);
  assert.equal(await length(), 2);
  await page.evaluate(() => window.dropAdopted());
  await page.waitForFunction(() => document.getElementById('adopted').shadowRoot.adoptedStyleSheets.length === 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await length(), 0);
  await page.evaluate(() => window.readoptAdopted());
  await page.waitForFunction(() => document.getElementById('adopted').shadowRoot.adoptedStyleSheets.length === 2);
  await expectThemed(page, FINDERS.adopted, 'adopted again');
  await page.close();
});

test('a component added after load is themed', { timeout: 60000 }, async () => {
  const { page } = await open('/shadow.html', ON);
  await page.evaluate(() => window.addLate());
  await expectThemed(page, () => window.__late.querySelector('.t'), 'late closed root');
  await page.close();
});

test('turning the site off leaves only the page\'s own sheets in every root', { timeout: 60000 }, async () => {
  const { page } = await open('/shadow.html', ON);
  await expectThemed(page, FINDERS.adopted, 'adopted');
  await expectThemed(page, FINDERS.docad, 'docad');
  await browser.setStorage({ settings: { enabled: false } });
  await waitState(page, null);
  const r = await page.evaluate(() => ({
    adopted: document.getElementById('adopted').shadowRoot.adoptedStyleSheets.length,
    doc: document.adoptedStyleSheets.length,
    marked: [document.getElementById('open').shadowRoot, window.__closed, window.__outer].reduce((n, root) => n + root.querySelectorAll('[data-dk]').length, 0),
    docMarked: document.querySelectorAll('[data-dk]').length,
  }));
  assert.deepEqual(r, { adopted: 1, doc: 1, marked: 0, docMarked: 0 });
  await page.close();
});

test('the hook changes nothing the page can observe about the functions it wraps', { timeout: 60000 }, async () => {
  const probe = () => {
    const out = {};
    const sheetProto = CSSStyleSheet.prototype;
    for (const name of ['insertRule', 'deleteRule', 'replace', 'replaceSync']) {
      const d = Object.getOwnPropertyDescriptor(sheetProto, name);
      out[name] = { name: sheetProto[name].name, length: sheetProto[name].length, enumerable: d.enumerable, configurable: d.configurable, writable: d.writable, isFunction: typeof sheetProto[name] === 'function', native: /\[native code\]/.test(Function.prototype.toString.call(sheetProto[name])) };
    }
    const attach = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow');
    out.attachShadow = { name: Element.prototype.attachShadow.name, length: Element.prototype.attachShadow.length, enumerable: attach.enumerable, configurable: attach.configurable, native: /\[native code\]/.test(Function.prototype.toString.call(Element.prototype.attachShadow)) };
    const ad = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
    out.adopted = { hasGet: typeof ad.get, hasSet: typeof ad.set, enumerable: ad.enumerable, configurable: ad.configurable };

    const style = document.createElement('style');
    document.head.append(style);
    const s = style.sheet;
    out.insertIndex = s.insertRule('.x { color: red }', 0);
    out.insertSecond = s.insertRule('.y { color: red }', 1);
    try { s.insertRule('.z { color: red }', 99); out.badIndex = 'no error'; } catch (e) { out.badIndex = e.name; }
    try { s.insertRule('this is not css', 0); out.badRule = 'no error'; } catch (e) { out.badRule = e.name; }
    out.deleteResult = s.deleteRule(0) === undefined;
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' });
    try { host.attachShadow({ mode: 'open' }); out.twice = 'no error'; } catch (e) { out.twice = e.name; }
    const c = new CSSStyleSheet();
    out.replaceSync = c.replaceSync('.a { color: red }') === undefined;
    out.replaceIsPromise = c.replace('.b { color: red }') instanceof Promise;
    try { c.replaceSync('@import url(x.css);'); out.importInConstructed = 'no error'; } catch (e) { out.importInConstructed = e.name; }
    style.remove();
    return out;
  };
  const results = {};
  for (const [label, storage] of [['off', OFF], ['on', ON]]) {
    const { page } = await open('/basic.html', storage);
    results[label] = await page.evaluate(`(${probe.toString()})()`);
    await page.close();
  }
  assert.deepEqual(results.on, results.off);
  assert.equal(results.on.badIndex, 'IndexSizeError');
  assert.equal(results.on.twice, 'NotSupportedError');
  assert.equal(results.on.insertIndex, 0);
});

test('a page that breaks the built-ins and fakes hints cannot break the engine or make it loop', { timeout: 90000 }, async () => {
  const { page, problems, url } = await open('/hostile.html', ON);
  await page.evaluate(() => window.sabotage());
  const started = Date.now();
  await page.evaluate(() => window.spam(20000));
  await page.evaluate(() => window.addRule());
  // Poll from here: the page's own promise machinery is broken on purpose.
  let color = '';
  for (let i = 0; i < 100; i++) {
    color = await page.evaluate(() => getComputedStyle(document.querySelector('.b')).color);
    if (color !== 'rgb(18, 52, 86)') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const took = Date.now() - started;
  assert.notEqual(color, 'rgb(18, 52, 86)', 'the rule added after the sabotage should be themed');
  const stats = await browser.stats(url);
  console.log(`# hostile: spam and rule in ${took} ms, hook events seen ${stats.hookEvents}, dropped ${stats.hookDropped}, faults ${stats.faults}, longest slice ${stats.slices.maxMs.toFixed(1)} ms`);
  assert.equal(stats.faults, 0);
  assert.ok(stats.slices.overruns <= 1, `overruns ${stats.slices.overruns}`);
  assert.ok(took < 20000);
  assert.deepEqual(problems, []);
  assert.ok(lightnessOf(await page.evaluate(() => getComputedStyle(document.querySelector('.a')).backgroundColor)) < 0.35);
  await page.close();
});

test('speed: insertRule with the hook', { timeout: 60000 }, async () => {
  const measure = async (storage) => {
    const { page } = await open('/basic.html', storage);
    const ms = await page.evaluate(() => {
      const style = document.createElement('style');
      document.head.append(style);
      const sheet = style.sheet;
      const t = performance.now();
      for (let i = 0; i < 3000; i++) sheet.insertRule(`.r${i} { margin: 0 }`, sheet.cssRules.length);
      const spent = performance.now() - t;
      style.remove();
      return spent;
    });
    await page.close();
    return ms;
  };
  const off = await measure(OFF);
  const on = await measure(ON);
  // Three thousand calls on one sheet must not send three thousand events.
  const { page, url } = await open('/basic.html', ON);
  await page.evaluate(() => {
    const style = document.createElement('style');
    document.head.append(style);
    for (let i = 0; i < 3000; i++) style.sheet.insertRule(`.q${i} { margin: 0 }`, style.sheet.cssRules.length);
  });
  await new Promise((r) => setTimeout(r, 300));
  const events = (await browser.stats(url)).hookEvents;
  console.log(`# hook events for 3000 insertRule calls: ${events}`);
  assert.ok(events <= 5, `${events} events`);
  await page.close();
  console.log(`# 3000 insertRule calls: ${off.toFixed(1)} ms without the extension, ${on.toFixed(1)} ms with it`);
  // The rules have no color, so the engine itself has nothing to do for them. The hook's share should be small.
  assert.ok(on < off + 60, `${on} against ${off}`);
});
