// a shorthand that holds var() must not reset widths, styles, sizes or positions of the page. Every property that is not a
// color has the same computed value with the extension on (text path and CSSOM path) as with the extension off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, launchPlain, waitState } from './harness.mjs';

let servers;
let browser;
let plain;
before(async () => {
  servers = await startServers();
  browser = await launch();
  plain = await launchPlain();
});
after(async () => {
  await plain?.close();
  await browser?.close();
  await servers?.close();
});

const PROPS = [
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-inline-start-width', 'border-inline-end-width',
  'background-size', 'background-repeat', 'background-position', 'background-attachment',
  'outline-width', 'outline-style', 'outline-offset',
  'text-decoration-line', 'text-decoration-style', 'text-decoration-thickness',
  '-webkit-text-stroke-width', 'text-emphasis-style', 'text-emphasis-position',
  'column-rule-width', 'column-rule-style', 'width', 'height',
];

/** The computed value of every property that is not a color, by element. */
const read = (page) =>
  page.evaluate((props) => {
    const out = {};
    for (const el of document.querySelectorAll('.box')) {
      const cs = getComputedStyle(el);
      out[el.id] = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
    }
    return out;
  }, PROPS);

const colors = (page) =>
  page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('.box')) {
      const cs = getComputedStyle(el);
      out[el.id] = [cs.borderTopColor, cs.borderBottomColor, cs.backgroundColor, cs.outlineColor, cs.textDecorationColor, cs.columnRuleColor].join('|');
    }
    return out;
  });

test('layout never changes: the sizes and styles are those of the page, in both paths', { timeout: 120000 }, async () => {
  const off = await plain.context.newPage();
  await off.goto(`${servers.origin}/shorthand-var.html`);
  const expected = await read(off);
  const offColors = await colors(off);
  await off.close();

  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/shorthand-var.html`;
  await page.goto(url);
  await waitState(page, 'ready');
  for (const [name, options] of [['text path', { early: false, hold: false }], ['CSSOM path', { early: false, hold: false, textPath: false }]]) {
    const stats = await browser.restartEngine(url, options, { mode: 'dark' });
    assert.ok(name === 'text path' ? stats.textSheets >= 1 : stats.cssomSheets >= 1, `${name}: ${JSON.stringify({ t: stats.textSheets, c: stats.cssomSheets })}`);
    const got = await read(page);
    const differences = [];
    for (const id of Object.keys(expected)) {
      for (const p of PROPS) if (got[id][p] !== expected[id][p]) differences.push(`${id} ${p}: ${expected[id][p]} off, ${got[id][p]} on`);
    }
    assert.deepEqual(differences, [], `${name}: ${differences.join('\n')}`);
    // The colors are themed, not left as written.
    const now = await colors(page);
    for (const id of ['c1', 'c2', 'c4', 'c9', 'c11']) assert.notEqual(now[id], offColors[id], `${name}: ${id} keeps its colors`);
  }
  await page.close();
});
