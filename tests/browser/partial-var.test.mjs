// a color built from var() channels and literals is themed like the same color written out.
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

// The distance allowed in OKLab, by mode: the E-ink levels are steps that a smooth curve cannot follow.
const MODES = {
  dark: [{ mode: 'dark' }, 0.045],
  light: [{ mode: 'light' }, 0.045],
  paper: [{ mode: 'eink', einkPreset: 'paper' }, 0.06],
  eink: [{ mode: 'eink', einkPreset: 'eink' }, 0.16],
};

/** The color a computed value paints, as OKLab, read through a canvas. */
const readColors = (page) =>
  page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgb = (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const lab = ([r, g, b]) => {
      const f = (v) => ((v / 255) <= 0.04045 ? v / 255 / 12.92 : (((v / 255) + 0.055) / 1.055) ** 2.4);
      const [lr, lg, lb] = [f(r), f(g), f(b)];
      const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
      const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
      const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
      return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
    };
    const out = {};
    for (let i = 1; i <= 9; i++) {
      for (const kind of ['p', 'v']) {
        const cs = getComputedStyle(document.getElementById(`${kind}${i}`));
        out[`${kind}${i}`] = { bg: lab(rgb(cs.backgroundColor)), fg: lab(rgb(cs.color)), bd: lab(rgb(cs.borderTopColor)) };
      }
    }
    return out;
  });

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

for (const [name, [theme, limit]] of Object.entries(MODES)) {
  test(`${name}: colors from channels follow the same colors written out`, { timeout: 90000 }, async () => {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, theme } });
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/partial-var.html`);
    await waitState(page, 'ready');
    await page.waitForTimeout(500);
    const colors = await readColors(page);
    const pairs = [[1, 'bg'], [2, 'bg'], [3, 'bg'], [4, 'bg'], [5, 'bg'], [6, 'fg'], [7, 'fg'], [8, 'bd'], [9, 'bg']];
    const problems = [];
    for (const [i, key] of pairs) {
      const d = distance(colors[`p${i}`][key], colors[`v${i}`][key]);
      if (d > limit) problems.push(`${i} ${key}: ${d.toFixed(3)}`);
    }
    assert.deepEqual(problems, []);
    // The light box does not stay light in the dark mode.
    if (name === 'dark') assert.ok(colors.v1.bg[0] < 0.4, `v1 lightness ${colors.v1.bg[0]}`);
    if (name === 'light') assert.ok(colors.v1.bg[0] > 0.6);
    await page.close();
  });
}
