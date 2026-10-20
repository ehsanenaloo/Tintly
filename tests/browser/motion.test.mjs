// The reduced motion hint also makes the page's own `prefers-reduced-motion: reduce` rules apply.
import { test, before, after, afterEach } from 'node:test';
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
afterEach(async () => {
  for (const page of browser.context.pages()) await page.close().catch(() => {});
});

const URL_PATH = '/reduced-motion.html';
const lum = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};

async function open(theme) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${URL_PATH}`);
  await waitState(page, 'ready', 30000);
  return page;
}
const read = (page) =>
  page.evaluate(() => {
    const get = (id, prop) => getComputedStyle(document.getElementById(id))[prop];
    return {
      spin: get('spin', 'animationName'),
      both: get('both', 'animationName'),
      calm: get('calm', 'animationName'),
      chipBg: get('chip', 'backgroundColor'),
      chipTransition: get('chip', 'transitionProperty'),
      queried: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  });

const PAPER = { mode: 'eink', einkPreset: 'paper' };

test('with the reduced motion hint on, the page\'s own reduced-motion rules apply and keep the theme', { timeout: 60000 }, async () => {
  const page = await open({ ...PAPER, reducedMotionHint: true });
  const got = await read(page);
  assert.equal(got.queried, true);
  assert.equal(got.spin, 'none');
  // The same rule that also sets a background is themed: not the page's white.
  assert.notEqual(got.chipBg, 'rgb(255, 255, 255)');
  // A query with another condition keeps it (the window is wider than 400 px), and the no-preference query is not touched.
  assert.equal(got.both, 'none');
  assert.equal(got.calm, 'spin');
});

test('with the hint off the page keeps its animation', { timeout: 60000 }, async () => {
  const page = await open({ ...PAPER, reducedMotionHint: false, noAnimation: false });
  const got = await read(page);
  assert.equal(got.queried, false);
  assert.equal(got.spin, 'spin');
  assert.equal(got.both, 'spin');
});

test('in the dark mode the rules are not unwrapped', { timeout: 60000 }, async () => {
  const page = await open({ mode: 'dark' });
  assert.equal((await read(page)).spin, 'spin');
});

test('the CSSOM path writes the same: rules unwrapped and themed', { timeout: 90000 }, async () => {
  const page = await open({ mode: 'dark' });
  const url = page.url();
  for (const options of [{ early: false, hold: false, motion: true }, { early: false, hold: false, motion: true, textPath: false }]) {
    await browser.restartEngine(url, options, { mode: 'dark' });
    const got = await read(page);
    assert.equal(got.spin, 'none', JSON.stringify(options));
    assert.equal(got.both, 'none');
    assert.equal(got.calm, 'spin');
    assert.ok(lum(got.chipBg) < 0.3, `chip background ${got.chipBg} ${JSON.stringify(options)}`);
  }
});

test('the helper reads only the plain reduce query and keeps other conditions', async () => {
  const { loadContent } = await import('../helpers/content.mjs');
  const dk = await loadContent('engine/sitedark.js');
  const R = dk.sitedark.reducedMedia;
  assert.equal(R('(prefers-reduced-motion: reduce)'), '');
  assert.equal(R('(min-width: 400px) and (prefers-reduced-motion: reduce)'), '(min-width: 400px)');
  assert.equal(R('screen and (prefers-reduced-motion:reduce)'), 'screen');
  assert.equal(R('(prefers-reduced-motion: no-preference)'), null);
  assert.equal(R('not (prefers-reduced-motion: reduce)'), null);
  assert.equal(R('(prefers-reduced-motion: reduce), print'), null);
  assert.equal(R('(prefers-color-scheme: dark)'), null);
});
