// A page whose colors fade (a transition on the body or on everything) must be judged by its own colors, not by the first
// step of a fade from the themed look: the page stays themed, the kept color of a text on a picture is the page's own, and
// no fade starts back after a look.
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

const LOADS = 10;

for (const name of ['light-transition', 'light-transition-all']) {
  test(`a light page with faded colors stays themed in ${LOADS} loads (${name})`, { timeout: 240000 * SLOW }, async () => {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true } });
    const off = [];
    for (let i = 0; i < LOADS; i++) {
      const page = await browser.context.newPage();
      await page.goto(`${servers.origin}/detect/${name}.html`);
      await waitState(page, 'ready', 30000 * SLOW);
      // The verdict comes at load and again once the page is quiet; give both time.
      await page.waitForTimeout(1600);
      const state = await page.evaluate(() => ({ state: document.documentElement.getAttribute('data-dk-state'), styles: document.querySelectorAll('style[data-dk]').length, dark: document.documentElement.hasAttribute('data-dk-dark') }));
      if (state.state !== 'ready' || state.styles === 0) off.push(`load ${i}: ${JSON.stringify(state)}`);
      await page.close();
    }
    assert.deepEqual(off, []);
  });
}

test('a look at the page leaves no fade, no sheet and no disabled element behind', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/detect/light-transition.html`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForTimeout(3500 * SLOW);
  const url = `${servers.origin}/detect/light-transition.html`;
  const after = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: async () => {
        const dk = globalThis.__dk;
        const sheets = document.adoptedStyleSheets.length;
        const before = getComputedStyle(document.body).backgroundColor;
        for (let i = 0; i < 3; i++) dk.detect.probe();
        const running = document.getAnimations().length;
        await new Promise((x) => setTimeout(x, 100));
        return JSON.stringify({
          sheetsBefore: sheets,
          sheetsAfter: document.adoptedStyleSheets.length,
          running,
          before,
          after: getComputedStyle(document.body).backgroundColor,
          disabled: [...document.querySelectorAll('style[data-dk]')].filter((s) => s.disabled).length,
        });
      },
    });
    return JSON.parse(r.result);
  }, url);
  assert.equal(after.sheetsAfter, after.sheetsBefore);
  assert.equal(after.running, 0, 'a fade started after the look');
  assert.equal(after.after, after.before, 'the themed color changed');
  assert.equal(after.disabled, 0);
  await page.close();
});

test('the color kept for a text on a picture is the page\'s own, also when it fades', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/photo-text-fade.html`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForFunction(() => document.querySelector('style[data-dk="keep"]')?.textContent.includes('color:'), undefined, { timeout: 20000 * SLOW });
  const kept = await page.evaluate(() => document.querySelector('style[data-dk="keep"]').textContent);
  assert.match(kept, /color:rgb\(17, 17, 17\)!important/);
  await page.close();
});

test('a kept color follows the page when the page gives the text another color', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/photo-text-fade.html`);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForFunction(() => document.querySelector('style[data-dk="keep"]')?.textContent.includes('color:'), undefined, { timeout: 20000 * SLOW });
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('style[data-dk="keep"]').textContent.includes('rgb(170, 0, 0)'), undefined, { timeout: 8000 * SLOW });
  await page.close();
});

test('a look at the page leaves the transitions and animations of the page running', { timeout: 120000 * SLOW }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/detect/light-motion.html`;
  await page.goto(url);
  await waitState(page, 'ready', 30000 * SLOW);
  await page.waitForTimeout(1600 * SLOW);
  await page.evaluate(() => document.getElementById('slide').classList.add('wide'));
  await page.waitForTimeout(300);
  const seen = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => {
        const dk = globalThis.__dk;
        const before = document.getAnimations();
        const start = before.map((a) => Number(a.currentTime));
        for (let i = 0; i < 3; i++) dk.detect.probe();
        const after = new Set(document.getAnimations());
        return JSON.stringify({
          count: before.length,
          kinds: before.map((a) => a.constructor.name).sort(),
          lost: before.filter((a) => !after.has(a)).length,
          rewound: before.filter((a, i) => Number(a.currentTime) < start[i]).length,
          extra: [...after].filter((a) => !before.includes(a)).length,
        });
      },
    });
    return JSON.parse(r.result);
  }, url);
  assert.ok(seen.kinds.includes('CSSTransition') && seen.kinds.includes('CSSAnimation'), `nothing was running: ${seen.kinds}`);
  assert.equal(seen.lost, 0, 'a running transition or animation was cut by the look');
  assert.equal(seen.rewound, 0, 'an animation started again');
  assert.equal(seen.extra, 0, 'a fade started');
  await page.close();
});
