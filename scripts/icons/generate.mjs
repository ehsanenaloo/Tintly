// Draws the toolbar and store icons from the SVG files in this folder with the browser's own renderer.
// The small drawing (no text lines, no star) is used at 16 and 32 px; the full drawing at 48 and 128 px.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'extension', 'icons');
const JOBS = [
  ['icon.svg', 48, 'icon-48.png'],
  ['icon.svg', 128, 'icon-128.png'],
  ['icon-small.svg', 16, 'icon-16.png'],
  ['icon-small.svg', 32, 'icon-32.png'],
  ['icon-off.svg', 16, 'icon-off-16.png'],
  ['icon-off.svg', 32, 'icon-off-32.png'],
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [file, size, out] of JOBS) {
    const svg = readFileSync(join(HERE, file), 'utf8').replace(/width="128" height="128"/, `width="${size}" height="${size}"`);
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
    writeFileSync(join(OUT, out), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  }
} finally {
  await browser.close();
}
