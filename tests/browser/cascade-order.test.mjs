// The copies keep the cascade of the page: presentation attributes stay the weakest, anonymous layers keep their place,
// keyframes keep their variables, a text color keeps its contrast to the background of its rule, the Filter layer leaves
// the page's html::before alone, and a busy shadow component does not keep the engine busy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

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

const nums = (css) => css.match(/[\d.]+/g).map(Number);
const lum = (css) => {
  const [r, g, b] = nums(css).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

async function open(file, settings = {}) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, ...settings } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/${file}`);
  await waitState(page, 'ready', 30000 * SLOW);
  return page;
}

const styleOf = (page, id, props, pseudo = null) =>
  page.evaluate(([i, p, ps]) => {
    const el = document.getElementById(i) ?? document.documentElement;
    const cs = getComputedStyle(el, ps);
    return Object.fromEntries(p.map((name) => [name, cs.getPropertyValue(name)]));
  }, [id, props, pseudo]);

test('a themed SVG fill attribute loses to the page rules, layered or not, as the attribute does', { timeout: 60000 }, async () => {
  const page = await open('cascade-order.html');
  const p1 = await styleOf(page, 'p1', ['fill', 'color']);
  assert.equal(p1.fill, p1.color, 'fill: currentColor of the page must win over the fill attribute');
  const p2 = await styleOf(page, 'p2', ['fill', 'color']);
  assert.equal(p2.fill, p2.color, 'a layered fill: currentColor must win over the fill attribute');
  // With no page rule the attribute itself is themed: dark gray becomes a light text color.
  const p3 = await styleOf(page, 'p3', ['fill']);
  assert.ok(lum(p3.fill) > 0.3, `plain icon fill stayed dark: ${p3.fill}`);
  // A hover rule of the page wins too.
  await page.hover('#p1');
  const hot = await styleOf(page, 'p1', ['fill']);
  assert.notEqual(hot.fill, p1.fill, 'the hover rule did not change the fill');
  const [r, g, b] = nums(hot.fill);
  assert.ok(r > g + 40 && r > b + 40, `hover fill is not the red of the page rule: ${hot.fill}`);
  await page.close();
});

test('a copied anonymous layer keeps its place: a layer declared after it still wins, in the text and the CSSOM paths', { timeout: 60000 }, async () => {
  const page = await open('cascade-order.html');
  const props = ['color', 'background-color'];
  const ref = await styleOf(page, 'ref', props);
  assert.ok(lum(ref['background-color']) < 0.2, `the reference is not themed: ${ref['background-color']}`);
  for (const id of ['x', 'z', 'q', 'v']) {
    const got = await styleOf(page, id, id === 'v' ? ['background-color'] : props);
    for (const [name, value] of Object.entries(got)) assert.equal(value, ref[name], `#${id} ${name}`);
  }
  await page.close();
});

test('a keyframe that sets a shorthand with a variable keeps it in its copy', { timeout: 60000 }, async () => {
  const page = await open('cascade-order.html');
  const k = await styleOf(page, 'k', ['background-color']);
  const r = await styleOf(page, 'r', ['background-color']);
  assert.ok(lum(r['background-color']) < 0.2, `the variable is not themed: ${r['background-color']}`);
  assert.equal(k['background-color'], r['background-color']);
  await page.close();
});

test('a text color and a background in one rule keep their contrast in the dark and the light mode', { timeout: 60000 }, async () => {
  for (const theme of [{ mode: 'dark' }, { mode: 'light' }]) {
    const page = await open('cascade-order.html', { theme });
    const w = await styleOf(page, 'warn', ['color', 'background-color']);
    assert.ok(ratio(w.color, w['background-color']) >= 4.5, `${theme.mode}: ${w.color} on ${w['background-color']}`);
    await page.close();
  }
});

test('the Filter engines leave the html::before of the page as it is', { timeout: 60000 }, async () => {
  for (const engine of ['filter', 'filterPlus']) {
    const page = await open('page-before.html', { engine });
    const before = await styleOf(page, null, ['content', 'display'], '::before');
    assert.equal(before.content, '"wide"', engine);
    assert.equal(before.display, 'none', engine);
    await page.close();
  }
});

test('a shadow component whose text changes all the time does not keep the look at switched sheets running', { timeout: 60000 }, async () => {
  const url = `${servers.origin}/shadow-text-churn.html`;
  const page = await open('shadow-text-churn.html');
  const card = await page.evaluate(() => window.cardBackground());
  assert.ok(lum(card) < 0.2, `the card in the root is not themed: ${card}`);
  await page.waitForTimeout(500 * SLOW);
  const start = (await browser.stats(url)).switchChecks;
  await page.evaluate(() => window.tick(true));
  await page.waitForTimeout(1500 * SLOW);
  await page.evaluate(() => window.tick(false));
  const end = (await browser.stats(url)).switchChecks;
  assert.ok(end - start <= 1, `the pass ran ${end - start} times for text changes`);
  // A change of the text of a style in the root is still seen.
  await page.evaluate(() => window.editStyleText());
  await page.waitForFunction(() => {
    const m = window.spanColor().match(/[\d.]+/g).map(Number);
    return m[2] > m[0] + 40;
  }, undefined, { timeout: 10000 * SLOW });
  const span = await page.evaluate(() => window.spanColor());
  assert.ok(lum(span) > 0.1, `the new text color in the root is not themed: ${span}`);
  await page.close();
});
