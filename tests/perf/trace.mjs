// Browser trace of one page load: the compile and run time of every content file of the extension.
import { waitState, cpuThrottle } from '../browser/harness.mjs';

export const median = (l) => (l.length ? [...l].sort((a, b) => a - b)[Math.floor(l.length / 2)] : null);
export const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Load `url` in a new tab of `browser`, with the trace on, and wait for the engine to be ready.
 * Resolves to the milliseconds per file (`files`), their sum (`scripts`) and the engine's own stats of the page.
 * @param {any} browser from `launch()`
 * @param {string} url
 * @param {number} rate CPU slowdown, 1 for none
 * @param {{ ready?: boolean }} [options] `ready: false` skips the wait for the engine (a page where the extension is off)
 */
export async function loadTraced(browser, url, rate = 1, options = {}) {
  const page = await browser.context.newPage();
  if (rate > 1) await cpuThrottle(page, rate);
  const cdp = await browser.context.browser().newBrowserCDPSession();
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.compile'], recordMode: 'recordAsMuchAsPossible' }, transferMode: 'ReportEvents' });
  await page.goto(url);
  if (options.ready !== false) await waitState(page, 'ready', 120000);
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  const files = {};
  for (const e of events) {
    const file = e.args?.fileName ?? e.args?.data?.url;
    if (typeof file !== 'string' || !file.includes('chrome-extension://') || e.ph !== 'X' || !file.includes('/content/')) continue;
    const name = file.slice(file.indexOf('/content/') + 9);
    const f = (files[name] ??= { compile: 0, run: 0, total: 0 });
    const ms = (e.dur ?? 0) / 1000;
    if (e.name === 'v8.compile') f.compile += ms;
    else if (e.name === 'v8.run') f.run += ms;
    else if (e.name === 'EvaluateScript') f.total += ms;
  }
  const stats = options.ready === false ? null : await browser.stats(url);
  await page.close();
  const scripts = Object.values(files).reduce((n, f) => n + f.total, 0);
  return { files, scripts, stats };
}
