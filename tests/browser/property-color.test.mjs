// the initial value of a registered <color> property is themed, in both paths, and a property that does not inherit
// keeps not inheriting its themed value.
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

const MODES = { dark: { mode: 'dark' }, light: { mode: 'light' } };

/** Lightness 0..1 of a computed color through a canvas. */
const lightnessOf = (page, ids, key) =>
  page.evaluate(
    ({ ids, key }) => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      return Object.fromEntries(
        ids.map((id) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = '#000';
          ctx.fillStyle = getComputedStyle(document.getElementById(id))[key];
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          return [id, (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255];
        }),
      );
    },
    { ids, key },
  );

for (const [name, theme] of Object.entries(MODES)) {
  for (const textPath of [true, false]) {
    test(`${name}, ${textPath ? 'text' : 'CSSOM'} path: registered colors are themed`, { timeout: 90000 }, async () => {
      await browser.clearStorage();
      await browser.setStorage({ settings: { enabled: true, theme } });
      const page = await browser.context.newPage();
      const url = `${servers.origin}/property-color.html`;
      await page.goto(url);
      await waitState(page, 'ready');
      await browser.restartEngine(url, textPath ? { early: false, hold: false } : { early: false, hold: false, textPath: false }, theme);
      const bg = await lightnessOf(page, ['a', 'g', 'a2'], 'backgroundColor');
      const fg = await lightnessOf(page, ['a', 'g', 'a2'], 'color');
      const dark = name === 'dark';
      for (const id of ['a', 'a2']) {
        assert.ok(dark ? bg[id] < 0.35 : bg[id] > 0.6, `${id} background ${bg[id]}`);
        assert.ok(dark ? fg[id] > 0.6 : fg[id] < 0.35, `${id} text ${fg[id]}`);
      }
      // The card sets other values, but a property that does not inherit leaves the box inside it on the initial values.
      assert.ok(Math.abs(bg.a2 - bg.a) < 0.02, `the initial value again: ${bg.a2} against ${bg.a}`);
      const edge = await lightnessOf(page, ['a', 'e'], 'borderTopColor');
      assert.notEqual(edge.a.toFixed(2), edge.e.toFixed(2), 'an inherited edge color follows the scope that sets it');
      assert.ok(dark ? edge.a < 0.6 : edge.a > 0.3);
      await page.close();
    });
  }
}
