// What the gate's read of the stored data costs on the page's main thread, with a small and a large set of site rules and fixes.
// `node tests/perf/gate-data.mjs [--rules=2000] [--fixes=2000] [--css=1500] [--runs=15]`; DK_EXTENSION names another build.
// The read is timed in the isolated world of a real page: `chrome.storage.local.get` of the four keys, and the same call for the keys
// of one host only (`gb:` keys, when the build has them). The numbers are milliseconds of the page's own main thread.
import { startServers, launch, waitState } from '../browser/harness.mjs';

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(name.length + 3);
const RULES = Number(arg('rules', 2000));
const FIXES = Number(arg('fixes', 2000));
const CSS = Number(arg('css', 1500));
const RUNS = Number(arg('runs', 15));
const median = (l) => [...l].sort((a, b) => a - b)[Math.floor(l.length / 2)];

const rules = {};
for (let i = 0; i < RULES; i++) rules[`site${i}.example.com`] = { enabled: i % 7 !== 0, theme: { mode: 'dark', brightness: 90 + (i % 10) }, engine: 'dynamic' };
const fixes = {};
for (let i = 0; i < FIXES; i++) fixes[`fix${i}.example.org`] = { engine: 'dynamic', dynamic: { css: `.a${i}{color:red}`.repeat(Math.max(1, Math.floor(CSS / 14))), invert: ['img.logo'], ignoreInline: [] } };

const servers = await startServers();
const browser = await launch();
await browser.clearStorage();
await browser.setStorage({ settings: { enabled: true }, siteRules: rules, userFixes: fixes });
const url = `${servers.origin}/basic.html`;
const page = await browser.context.newPage();
await page.goto(url);
await waitState(page, 'ready', 60000);
const bytes = JSON.stringify({ rules, fixes }).length;
const times = await browser.worker.evaluate(async ({ u, runs }) => {
  const [tab] = await chrome.tabs.query({ url: u });
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'ISOLATED',
    func: async (n) => {
      const out = { full: [], settingsOnly: [] };
      for (let i = 0; i < n; i++) {
        let t = performance.now();
        await chrome.storage.local.get(['settings', 'siteRules', 'userFixes', 'darkSites']);
        out.full.push(performance.now() - t);
        t = performance.now();
        await chrome.storage.local.get(['settings']);
        out.settingsOnly.push(performance.now() - t);
      }
      return JSON.stringify(out);
    },
    args: [runs],
  });
  return JSON.parse(r.result);
}, { u: url, runs: RUNS });
console.log(JSON.stringify({ rules: RULES, fixes: FIXES, bytes, fullReadMs: Math.round(median(times.full) * 10) / 10, settingsOnlyMs: Math.round(median(times.settingsOnly) * 10) / 10 }));
await browser.close();
await servers.close();
