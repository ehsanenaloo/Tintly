// The verdict for each picture address and the elements that carry a CSS background picture are kept when the picture module
// restarts for another mode, so a switch away from Dark and back sorts nothing again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, waitState } from './harness.mjs';
import { startShop } from './shop-page.mjs';

let shop;
let browser;
before(async () => {
  shop = await startShop({ rules: 400, carousels: 4, cards: 10, depth: 3 });
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await shop?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODES = { dark: { mode: 'dark' }, paper: { mode: 'eink', einkPreset: 'paper' } };
const set = (name) => browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme: MODES[name] } });
const imageStats = (url) =>
  browser.worker.evaluate(
    async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => globalThis.__dk?.images?.stats?.() ?? null });
      return r.result;
    },
    `${url}/*`,
  );

/** Wait until the picture module has sorted pictures and nothing new is being sorted. */
async function settled(url) {
  let last = '';
  let same = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const s = await imageStats(url);
    const now = s ? JSON.stringify([s.invert, s.dim, s.keep, s.plate, s.flip, s.analyzed, s.bgFound]) : '';
    same = now === last ? same + 1 : 0;
    last = now;
    if (s && same >= 4 && s.keep + s.dim + s.invert + s.plate + s.flip > 0) return s;
  }
  throw new Error('the picture module did not settle');
}

test('a return to Dark sorts no picture again and finds the backgrounds without a new look at every selector', { timeout: 180000 }, async () => {
  await browser.clearStorage();
  await set('dark');
  const page = await browser.context.newPage();
  await page.goto(shop.origin);
  await waitState(page, 'ready', 60000);
  const first = await settled(shop.origin);
  assert.ok(first.analyzed > 0, 'the first run reads the pictures');
  await set('paper');
  await sleep(4000);
  await set('dark');
  await waitState(page, 'ready', 60000);
  const again = await settled(shop.origin);
  console.log('# first', JSON.stringify(first), 'again', JSON.stringify(again));
  assert.equal(again.analyzed, 0, `${again.analyzed} pictures were sorted again`);
  assert.ok(again.cached >= first.cached, 'the verdicts are kept');
  assert.ok(again.keep + again.dim + again.invert + again.plate + again.flip > 0, 'the pictures are sorted from the kept verdicts');
  assert.ok(again.bgFound > 0, 'the elements with a background picture are known at once');
  await page.close();
});
