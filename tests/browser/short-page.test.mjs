// A page shorter than the window must not leave a light canvas under it in any engine or mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, pixelsOf, SLOW } from './harness.mjs';

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

const lightness = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

async function shoot(engine, theme, variant) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, engine, theme } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/short-page.html#${variant}`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForTimeout(200 * SLOW);
  const box = await page.evaluate(() => {
    const r = document.getElementById('box').getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  });
  const [below, corner, inBox] = await pixelsOf(page, helper, [[500, 600], [980, 790], box]);
  await page.close();
  return { below, corner, inBox };
}

const gap = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const MODES = {
  dark: { mode: 'dark' },
  light: { mode: 'light' },
  eink: { mode: 'eink', einkPreset: 'eink' },
  paper: { mode: 'eink', einkPreset: 'paper' },
};

// A white box and the canvas around it must look the same: the page was white there, so the filter must treat both alike.
for (const engine of ['filter', 'filterPlus']) {
  for (const [name, theme] of Object.entries(MODES)) {
    for (const variant of ['none', 'body', 'root', 'gray']) {
      test(`${engine}, ${name} mode, short page (${variant}): the canvas under the content matches the page`, { timeout: 90000 * SLOW }, async () => {
        const r = await shoot(engine, theme, variant);
        if (name === 'dark') {
          assert.ok(lightness(r.below) < 0.3, `below ${r.below}`);
          assert.ok(lightness(r.corner) < 0.3, `corner ${r.corner}`);
        }
        if (name === 'light') assert.ok(lightness(r.below) > 0.85, `below ${r.below}`);
        // The gray canvas is a different color from the white box on purpose; it may differ by the step between them.
        assert.ok(gap(r.below, r.inBox) <= (variant === 'gray' ? 40 : 6), `canvas ${r.below}, box ${r.inBox}`);
      });
    }
  }
}

// A page that gives its canvas a color after the engine's first reads: the layer follows (a class or style change of the root or the body).
for (const engine of ['filter', 'filterPlus']) {
  for (const target of ['root', 'body']) {
    test(`${engine}: a canvas color that the ${target} gets later is copied by the layer`, { timeout: 90000 * SLOW }, async () => {
      await browser.clearStorage();
      await browser.setStorage({ settings: { enabled: true, engine, theme: { mode: 'dark' } } });
      const page = await browser.context.newPage();
      await page.goto(`${servers.origin}/short-page.html#none`);
      await waitState(page, 'ready', 30000 * SLOW);
      await page.waitForTimeout(300 * SLOW);
      await page.evaluate((t) => {
        const el = t === 'root' ? document.documentElement : document.body;
        el.setAttribute('style', 'background:#808080');
        document.getElementById('box').style.background = '#808080';
      }, target);
      await page.waitForTimeout(300 * SLOW);
      const box = await page.evaluate(() => {
        const r = document.getElementById('box').getBoundingClientRect();
        return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
      });
      const [below, inBox] = await pixelsOf(page, helper, [[500, 600], box]);
      await page.close();
      assert.ok(gap(below, inBox) <= 6, `canvas ${below}, box ${inBox}`);
    });
  }
}

async function judged(url) {
  return browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => globalThis.__dk?.filter?.stats()?.canvasJudged ?? -1 });
    return r.result;
  }, `${servers.origin}/short-page.html*`);
}

test('stylesheets that load together cost one read of the page styles, not one each', { timeout: 90000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, engine: 'filterPlus', theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/short-page.html#none`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForTimeout(500 * SLOW);
  const before = await judged();
  assert.ok(before >= 0, "the engine reports its reads");
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let left = 30;
        for (let i = 0; i < 30; i++) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = `data:text/css,.x${i}{color:red}`;
          link.onload = link.onerror = () => --left === 0 && resolve();
          document.head.append(link);
        }
      }),
  );
  await page.waitForTimeout(500 * SLOW);
  const reads = (await judged()) - before;
  await page.close();
  assert.ok(reads <= 3, `${reads} reads for 30 sheets`);
});

test('a page that changes a class of the body every frame costs a capped number of reads', { timeout: 90000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, engine: 'filterPlus', theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/short-page.html#none`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForTimeout(500 * SLOW);
  const before = await judged();
  assert.ok(before >= 0, "the engine reports its reads");
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const tick = () => {
          document.body.classList.toggle('flip');
          document.documentElement.classList.toggle('flip');
          if (++n < 120) requestAnimationFrame(tick);
          else resolve();
        };
        tick();
      }),
  );
  await page.waitForTimeout(500 * SLOW);
  const reads = (await judged()) - before;
  await page.close();
  assert.ok(reads >= 1 && reads <= 25, `${reads} reads for 120 changes`);
});
