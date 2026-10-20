// Repair of the page's own dark theme: a variable that holds a plain light color on the root and that the dark theme does not set.
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

const lumaOf = ([r, g, b]) => {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

test('a light variable that the dark theme leaves alone is dark where it is used; the variables of the theme are exact', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/site-repair-var.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000 * SLOW);
  for (let i = 0; i < 200; i++) {
    const s = await browser.stats(url);
    if (s && s.siteDark.state === 'on' && s.siteDark.repair.state === 'done') break;
    await page.waitForTimeout(50);
  }
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  const read = (id, prop) => page.evaluate(([i, p]) => getComputedStyle(document.getElementById(i))[p], [id, prop]);
  // A computed color can be in any syntax (oklch, for one); the canvas gives it back as pixels.
  const rgb = (id, prop) =>
    page.evaluate(([i, p]) => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = getComputedStyle(document.getElementById(i))[p];
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    }, [id, prop]);
  for (const id of ['a', 'b', 'd', 'f']) {
    const bg = await rgb(id, 'backgroundColor');
    assert.ok(lumaOf(bg) < 0.08, `${id} background ${bg}`);
  }
  for (const id of ['a', 'b', 'd']) {
    const fg = await rgb(id, 'color');
    assert.ok(lumaOf(fg) > 0.4, `${id} text ${fg}`);
  }
  // The dark value of the theme and the value of a deeper scope are kept as they are.
  assert.deepEqual(await rgb('c', 'backgroundColor'), [35, 40, 46]);
  assert.deepEqual(await rgb('g', 'backgroundColor'), [32, 36, 40]);
  assert.deepEqual(await rgb('g', 'color'), [232, 234, 237]);
  // A gradient in a variable is not touched by this rule.
  assert.ok((await read('e', 'backgroundImage')).includes('gradient'));
  await page.close();
});
