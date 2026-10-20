// Main thread time that a settings change costs a tab nobody can see, on the shop page: the tab is hidden (the visibility is set
// in the isolated world, where the gate reads it), four changes of the look follow, and the thread time of the hidden tab is counted
// for the changes and the 2 s after, then for the moment it is shown. `--a=<dir> --b=<dir>` compare two builds; `--runs=N`.
import { launch, waitState } from '../browser/harness.mjs';
import { startShop } from '../browser/shop-page.mjs';

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const RUNS = Number(arg('runs', 3));
const builds = [['a', arg('a', '')], ['b', arg('b', '')]].filter(([, dir]) => dir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODES = [{ mode: 'light' }, { mode: 'dark', brightness: 85 }, { mode: 'eink', einkPreset: 'paper' }, { mode: 'light' }];
const median = (l) => [...l].sort((x, y) => x - y)[Math.floor(l.length / 2)];

const shop = await startShop({ rules: 5000, carousels: 14, cards: 30, depth: 12, imageDelay: 0 });
const results = {};
for (const [name, dir] of builds) {
  const browser = await launch({ extension: dir });
  const hidden = [];
  const shown = [];
  for (let run = 0; run < RUNS; run++) {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme: { mode: 'dark' } } });
    const page = await browser.context.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(shop.origin);
    await waitState(page, 'ready', 60000).catch(() => {});
    await sleep(1500);
    const inTab = (func) => browser.worker.evaluate(async ({ u, func }) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const fns = {
        hide: () => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); },
        show: () => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); },
      };
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: fns[func] });
    }, { u: `${shop.origin}/`, func });
    const busy = async () => (await cdp.send('Performance.getMetrics')).metrics.find((x) => x.name === 'TaskDuration').value * 1000;
    await inTab('hide');
    const t0 = await busy();
    for (const theme of MODES) {
      await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme } });
      await sleep(400);
    }
    await sleep(2000);
    const t1 = await busy();
    await inTab('show');
    await sleep(3500);
    const t2 = await busy();
    hidden.push(t1 - t0);
    shown.push(t2 - t1);
    await page.close();
  }
  results[name] = { hiddenMs: Math.round(median(hidden)), onShowMs: Math.round(median(shown)), runsHidden: hidden.map(Math.round), runsShow: shown.map(Math.round) };
  await browser.close();
}
console.log(JSON.stringify(results, null, 1));
await shop.close();
