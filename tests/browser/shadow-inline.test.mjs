// Inline styles inside shadow roots, open and closed, are themed like those of the document.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, paintedLightness } from './harness.mjs';

let servers;
let browser;
let helper;

before(async () => {
  servers = await startServers();
  browser = await launch();
  helper = await browser.context.newPage();
  await helper.goto('about:blank');
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const ON = { settings: { enabled: true } };
const lum = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};
/** A computed style inside a root: `which` is `__root` (closed) or `__open`. */
const inRoot = (page, which, id, prop) => page.evaluate(([w, i, p]) => getComputedStyle(window[w].getElementById(i))[p], [which, id, prop]);

async function open() {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  const url = `${servers.origin}/shadow-inline.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000);
  return { page, url };
}

for (const which of ['__open', '__root']) {
  test(`inline colors inside a ${which === '__root' ? 'closed' : 'open'} root are themed: the first pass, a later change, an added element, a rebuilt tree`, { timeout: 60000 }, async () => {
    const { page } = await open();
    // The rule-based background was themed before; the inline ones are new.
    assert.ok(lum(await inRoot(page, which, 'a', 'backgroundColor')) < 0.25, 'rule background');
    const a = await inRoot(page, which, 'a', 'color');
    assert.ok(lum(a) > 0.5, `inline color stayed dark: ${a}`);
    assert.ok(lum(await inRoot(page, which, 'b', 'backgroundColor')) < 0.25, 'inline background');
    assert.ok(lum(await inRoot(page, which, 'b', 'color')) > 0.5, 'inline color 2');
    // An SVG attribute.
    assert.ok(lum(await page.evaluate((w) => getComputedStyle(window[w].getElementById('shape')).fill, which)) < 0.5, 'svg fill');
    // A native control follows the scheme hint of the host.
    assert.equal(await inRoot(page, which, 'sel', 'colorScheme'), 'dark');
    // A change made later, in the same task as the check: never drawn in the page value.
    const changed = await page.evaluate(async (w) => {
      window.changeLater(window[w]);
      // A callback of the observer has run before the next microtask checkpoint of a task that yielded; wait one frame.
      await new Promise((r) => requestAnimationFrame(() => r(0)));
      const s = getComputedStyle(window[w].getElementById('b'));
      return [s.backgroundColor, s.color];
    }, which);
    assert.ok(lum(changed[0]) < 0.25, `changed background ${changed[0]}`);
    assert.ok(lum(changed[1]) > 0.5, `changed color ${changed[1]}`);
    // An element added later.
    const added = await page.evaluate(async (w) => {
      window.addLater(window[w]);
      await new Promise((r) => requestAnimationFrame(() => r(0)));
      const s = getComputedStyle(window[w].getElementById('late'));
      return [s.backgroundColor, s.color];
    }, which);
    assert.ok(lum(added[0]) < 0.25, `added background ${added[0]}`);
    assert.ok(lum(added[1]) > 0.5, `added color ${added[1]}`);
    // The page replaces the whole tree, our style element with it: it comes back and the new elements are themed.
    await page.evaluate((w) => window.rebuild(window[w]), which);
    await page.waitForFunction(([w]) => {
      const m = /\d+/g;
      const c = getComputedStyle(window[w].getElementById('b')).backgroundColor.match(m).map(Number);
      return c[0] < 90;
    }, [which], { timeout: 5000 });
    await page.close();
  });
}

test('the engine ending leaves nothing in the roots', { timeout: 60000 }, async () => {
  const { page } = await open();
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 10000 });
  const left = await page.evaluate(() => [window.__root, window.__open].map((r) => r.querySelectorAll('style[data-dk], [data-dk-i], [data-dk-j]').length));
  assert.deepEqual(left, [0, 0]);
  assert.equal(await inRoot(page, '__root', 'b', 'backgroundColor'), 'rgb(255, 255, 255)');
  await page.close();
});

test('no light frame while a page with inline colors in roots loads', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/dark.html`);
  const lightness = await paintedLightness(page, helper, async () => {
    await page.goto(`${servers.origin}/shadow-inline.html`);
    await waitState(page, 'ready', 30000);
    await page.evaluate(() => {
      window.changeLater(window.__root);
      window.addLater(window.__root);
    });
  });
  console.log(`# shadow inline: ${lightness.length} frames, ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
  assert.deepEqual(lightness.filter((v) => v > 0.5), []);
  await page.close();
});
