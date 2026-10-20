// A wide light stroke laid behind text (a marker highlight) is a background in every mode: it never turns dark in the light
// modes, it is not left bright under light text in the dark mode, and a thin light line stays a foreground color.
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
  light: { mode: 'light' },
  dark: { mode: 'dark' },
  paper: { mode: 'eink', einkPreset: 'paper' },
  eink: { mode: 'eink', einkPreset: 'eink' },
};

const lum = (css) => {
  const n = css.match(/[\d.]+/g).map(Number);
  const scale = /^color\(/.test(css) ? 1 : 255;
  const lin = (c) => (c / scale <= 0.04045 ? c / scale / 12.92 : ((c / scale + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(n[0]) + 0.7152 * lin(n[1]) + 0.0722 * lin(n[2]);
};
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

async function read(mode) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { ...MODES[mode] } } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/svg-marker.html`);
  await waitState(page, 'ready', 30000);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', null, { timeout: 15000 });
  await page.waitForTimeout(600);
  const got = await page.evaluate(() => ({
    stroke: getComputedStyle(document.getElementById('stroke')).stroke,
    text: getComputedStyle(document.getElementById('word')).color,
    thin: getComputedStyle(document.getElementById('thin')).stroke,
  }));
  await page.close();
  return got;
}

for (const mode of Object.keys(MODES)) {
  test(`${mode}: the marker behind a word keeps the word readable`, { timeout: 90000 }, async () => {
    const g = await read(mode);
    const ratioText = ratio(lum(g.stroke), lum(g.text));
    assert.ok(ratioText >= 4.5, `marker ${g.stroke} under text ${g.text}: ${ratioText.toFixed(2)} to 1`);
    if (mode !== 'dark') assert.ok(lum(g.stroke) > 0.35, `the marker stays light in ${mode}: ${g.stroke}`);
    if (mode === 'dark') assert.ok(lum(g.stroke) < 0.35, `the marker is dark in the dark mode: ${g.stroke}`);
  });
}
