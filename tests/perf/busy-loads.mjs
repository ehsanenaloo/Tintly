// Page loads on a machine whose cores are all busy. Starts N processes that do nothing but compute, then loads a page with
// a dark theme of its own again and again, and reports for each load whether the page ends with its own theme and how long that takes.
// A load is right when the page's own background shows, the status is a site-theme status and both are still so a few seconds later.
// Usage: node tests/perf/busy-loads.mjs [--busy=8] [--loads=10] [--wait=120] [--page=/site-dark-media.html] [--theirs=rgb(16, 20, 24)]
// DK_EXTENSION names another unpacked copy (to compare two builds).
import { spawn } from 'node:child_process';
import { startServers, launch } from '../browser/harness.mjs';

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const BUSY = Number(arg('busy', 8));
const LOADS = Number(arg('loads', 10));
const WAIT_MS = Number(arg('wait', 120)) * 1000;
const PAGE = arg('page', '/site-dark-media.html');
const THEIRS = arg('theirs', 'rgb(16, 20, 24)');
const SITE = ['site-theme', 'site-theme-repaired'];

const burners = [];
const stopBurners = () => {
  for (const p of burners.splice(0)) p.kill();
};
process.on('exit', stopBurners);
process.on('SIGINT', () => process.exit(130));

const servers = await startServers();
const browser = await launch();
await browser.clearStorage();
await browser.setStorage({ settings: { enabled: true } });
for (let i = 0; i < BUSY; i++) burners.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
// Let the load settle before the first page.
await new Promise((r) => setTimeout(r, 1500));

const url = `${servers.origin}${PAGE}`;
const status = (tabUrl) =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    if (tab?.id === undefined) return null;
    const key = `tab:${tab.id}`;
    return (await chrome.storage.session.get(key))[key]?.status ?? null;
  }, tabUrl);

const results = [];
for (let i = 0; i < LOADS; i++) {
  await browser.worker.evaluate(() => chrome.storage.session.clear());
  const page = await browser.context.newPage();
  const began = Date.now();
  await page.goto(url, { timeout: 120000 });
  const seen = [];
  let rightAt = null;
  let last = '';
  while (Date.now() - began < WAIT_MS) {
    const [st, bg] = await Promise.all([status(url).catch(() => null), page.evaluate(() => getComputedStyle(document.body).backgroundColor).catch(() => '')]);
    if (st && seen.at(-1) !== st) seen.push(st);
    last = `${st} ${bg}`;
    if (bg === THEIRS && SITE.includes(st ?? '')) {
      rightAt = Date.now() - began;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  let stayed = false;
  if (rightAt !== null) {
    await new Promise((r) => setTimeout(r, 3000));
    const [st, bg] = await Promise.all([status(url).catch(() => null), page.evaluate(() => getComputedStyle(document.body).backgroundColor).catch(() => '')]);
    stayed = bg === THEIRS && SITE.includes(st ?? '');
    if (!stayed) last = `${st} ${bg}`;
  }
  const modules = await browser.worker
    .evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify(globalThis.__dk?.optional?.stats() ?? null) });
      return JSON.parse(r.result);
    }, url)
    .catch(() => null);
  results.push({ right: rightAt !== null && stayed, rightAt, seen, last: rightAt !== null && stayed ? '' : last, late: modules?.late ?? null });
  console.log(`load ${i + 1}: ${results[i].right ? `right after ${rightAt} ms` : `WRONG (${results[i].last})`}; statuses ${seen.join(' > ')}${modules ? `; late ${modules.late}, failed ${modules.failed}` : ''}`);
  await page.close();
}

stopBurners();
const times = results.filter((r) => r.right).map((r) => r.rightAt).sort((a, b) => a - b);
const wrong = results.filter((r) => !r.right).length;
console.log(`${BUSY} busy processes, ${LOADS} loads: ${wrong} wrong final states; time to the right state median ${times[Math.floor(times.length / 2)] ?? '-'} ms, slowest ${times.at(-1) ?? '-'} ms`);
await browser.close();
await servers.close();
process.exit(wrong === 0 ? 0 : 1);
