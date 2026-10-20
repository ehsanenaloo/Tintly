// The performance harness. It measures the rows of performance-budget.md that can be measured here, prints a table and
// writes a JSON file with the browser, the machine and every value. It exits with an error when a row is over its limit.
//
// A row can have a `ceiling` above its budget. That is a known miss: the budget is not met, the cause is recorded in
// the issues file, and the ceiling stops it from getting worse. The table says MISS for those rows, not PASS.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release } from 'node:os';
import { join } from 'node:path';
import { startServers, launch, launchPlain, waitState } from '../browser/harness.mjs';
import { loadContent } from '../helpers/content.mjs';
import { loadTraced } from './trace.mjs';
import { codeBytes } from './strip.mjs';
import { REPO } from '../helpers/tree.mjs';

const RUNS = Number(process.env.DK_PERF_RUNS || 3);
const NOISE = 1.1;
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const ON = { settings: { enabled: true } };

const rows = [];
/** @param {{ id: string, name: string, value: number, budget: number, unit: string, ceiling?: number, note?: string, detail?: string[] }} row */
function record(row) {
  rows.push(row);
}

/* ----- static rows ----- */

function sizes() {
  const ext = join(REPO, 'extension');
  // Bytes with LF line ends: a checkout with CRLF line ends must not change the number (the shipped file is the LF one).
  const size = (file) => readFileSync(join(ext, file)).filter((b) => b !== 13).length;
  // The always-loaded rows count code without comments (`strip.mjs`): what the browser scans and compiles, not the notes next to it.
  const code = (file) => codeBytes(readFileSync(join(ext, file)));
  // P-02a: what every page loads from the manifest (both worlds).
  // The worker registers the files (background/modules/register.js) for the pages where the extension can be on; the manifest lists none.
  const loaded = [...readFileSync(join(ext, 'background', 'modules', 'register.js'), 'utf8').matchAll(/'(content\/[a-z-]+\/[a-z-]+\.js)'/g)].map((m) => m[1]);
  const total = loaded.reduce((n, f) => n + code(f), 0);
  const gate = ['namespace.js', 'prefetch.js', 'boot.js'].reduce((n, f) => n + code(`content/core/${f}`), 0);
  const raw = loaded.reduce((n, f) => n + size(f), 0);
  const breakdown = (files) => files.map((f) => `${(code(f) / 1024).toFixed(1).padStart(6)} KB  ${f} (${(size(f) / 1024).toFixed(1)} with comments)`).sort((a, b) => parseFloat(b) - parseFloat(a));
  record({ id: 'P-02a', name: 'content scripts loaded on a page where the extension is on (registered list, both worlds, without comments)', value: total / 1024, budget: 305, unit: 'KB', ceiling: 315, note: `a guard on growth; the cost is in P-02t; ${(raw / 1024).toFixed(1)} KB with comments`, detail: breakdown(loaded) });
  record({ id: 'P-02b', name: 'gate and namespace files (without comments)', value: gate / 1024, budget: 34, unit: 'KB', ceiling: 35, detail: breakdown(['namespace.js', 'prefetch.js', 'boot.js'].map((f) => `content/core/${f}`)) });
  // The modules that are injected on request, each with its own budget.
  const optional = { schedule: ['core', 8], leftovers: ['core', 2.5], filter: ['engine', 19, 22], static: ['engine', 4.5], images: ['engine', 19.5, 20.5], imagebg: ['engine', 31, 32], backdrop: ['engine', 14.5], calm: ['engine', 18.5, 19.5], extras: ['engine', 5], readability: ['engine', 30], einkpalette: ['engine', 13.5], cvd: ['engine', 22], sitetheme: ['engine', 27.5], shadowroots: ['engine', 15] };
  for (const [name, [dir, budget, ceiling]] of Object.entries(optional)) {
    record({ id: `P-02-${name}`, name: `on-demand module ${name}`, value: size(`content/${dir}/${name}.js`) / 1024, budget, unit: 'KB', ...(ceiling ? { ceiling, note: '' } : { note: '' }) });
  }
}

async function colorSpeed() {
  const dk = await loadContent('engine/color.js');
  const theme = dk.color.createTheme({});
  const make = () => dk.color.createTransformer(theme);
  const colors = Array.from({ length: 4000 }, (_, i) => `#${((i * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}`);
  const run = (t, list) => {
    const start = performance.now();
    for (const c of list) t.transform(c, 'background');
    return performance.now() - start;
  };
  const cold = [];
  const warm = [];
  for (let i = 0; i < RUNS; i++) {
    const t = make();
    cold.push((run(t, colors) / colors.length) * 1000);
    const hot = [];
    for (let k = 0; k < 20; k++) hot.push(...colors);
    warm.push((run(t, hot) / hot.length) * 1000);
  }
  record({ id: 'P-18', name: 'color transform, uncached', value: median(cold), budget: 20, unit: 'µs' });
  record({ id: 'P-19', name: 'color transform, cached', value: median(warm), budget: 2, unit: 'µs' });
}

/* ----- browser rows ----- */

/** P-11 and P-11a: the popup page. `DK_PERF_ONLY=popup` runs these rows alone. */
async function popupRows(browser, servers) {
  // P-11: the popup, from navigation to interactive.
  {
    await browser.clearStorage();
    await browser.setStorage(ON);
    const id = new URL(browser.worker.url()).host;
    const times = [];
    for (let i = 0; i < 9; i++) {
      const page = await browser.context.newPage();
      await page.addInitScript(() => {
        new MutationObserver((_, o) => {
          if (document.body && !document.body.hasAttribute('data-loading')) {
            window.__interactive = performance.now();
            o.disconnect();
          }
        }).observe(document, { subtree: true, attributes: true, childList: true });
      });
      await page.goto(`chrome-extension://${id}/pages/popup/popup.html`);
      await page.waitForFunction(() => window.__interactive !== undefined);
      times.push(await page.evaluate(() => window.__interactive));
      await page.close();
    }
    record({ id: 'P-11', name: 'popup, navigation start to interactive (median of 9)', value: median(times), budget: 80, unit: 'ms', ceiling: 250, note: 'measured from navigation, not from a toolbar click' });
  }

  // P-11a: the popup with a stopped service worker, from navigation to the first paint of the stored state.
  {
    const id = new URL(browser.worker.url()).host;
    const web = await browser.context.newPage();
    await web.goto(`${servers.origin}/basic.html`);
    await waitState(web, 'ready');
    const times = [];
    const loaded = [];
    for (let i = 0; i < 7; i++) {
      const probe = await browser.context.newPage();
      const cdp = await browser.context.newCDPSession(probe);
      const status = new Map();
      cdp.on('ServiceWorker.workerVersionUpdated', (e) => e.versions.forEach((v) => status.set(v.versionId, v.runningStatus)));
      await cdp.send('ServiceWorker.enable');
      await new Promise((r) => setTimeout(r, 100));
      await cdp.send('ServiceWorker.stopAllWorkers');
      for (let k = 0; k < 200 && !(status.size > 0 && [...status.values()].every((v) => v === 'stopped')); k++) await new Promise((r) => setTimeout(r, 25));
      await cdp.detach();
      await probe.close();
      const page = await browser.context.newPage();
      await page.addInitScript(() => {
        new MutationObserver((_, o) => {
          const b = document.body;
          if (b && b.hasAttribute('data-painted') && window.__painted === undefined) window.__painted = performance.now();
          if (b && !b.hasAttribute('data-loading')) {
            window.__interactive = performance.now();
            o.disconnect();
          }
        }).observe(document, { subtree: true, attributes: true, childList: true });
      });
      await web.bringToFront();
      await page.goto(`chrome-extension://${id}/pages/popup/popup.html`);
      await page.waitForFunction(() => window.__interactive !== undefined);
      const m = await page.evaluate(() => ({ painted: window.__painted ?? window.__interactive, interactive: window.__interactive }));
      times.push(m.painted);
      loaded.push(m.interactive);
      await page.close();
    }
    await web.close();
    record({ id: 'P-11a', name: 'popup, stopped worker, navigation start to first paint (median of 7)', value: median(times), budget: 150, unit: 'ms', ceiling: 300, note: `the state of the worker arrives later (median ${Math.round(median(loaded))} ms)` });
  }
}

/**
 * P-24 to P-26: the first use of a part that is loaded on demand. The time from the request of the module to its arrival in the page
 * (the loader's own count), at the normal speed and with the CPU slowed 4 times, median of 7 loads. The page needs the part, so this
 * time is on the way to its first themed frame. `DK_PERF_ONLY=parts` runs these rows alone.
 */
async function firstUse(browser, servers) {
  const moduleMs = (url) =>
    browser.worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => JSON.stringify(globalThis.__dk?.optional?.stats().ms ?? null) });
      return JSON.parse(r.result);
    }, url);
  const parts = [
    { id: 'P-24', module: 'sitetheme', what: "the page's own dark theme", path: '/site-dark-media.html', settings: { enabled: true, theme: { mode: 'dark' } } },
    { id: 'P-25', module: 'shadowroots', what: 'shadow roots and adopted sheets', path: '/shadow.html', settings: { enabled: true, theme: { mode: 'dark' } } },
    { id: 'P-28', module: 'imagebg', what: 'CSS pictures (imagebg)', path: '/bg-images.html', settings: { enabled: true, theme: { mode: 'dark' } } },
    { id: 'P-26', module: 'einkpalette', what: 'the E-ink palette', path: '/eink-book.html', settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'eink' } } },
  ];
  for (const part of parts) {
    for (const rate of [1, 4]) {
      const times = [];
      for (let i = 0; i < 7; i++) {
        await browser.clearStorage();
        await browser.setStorage({ settings: part.settings });
        const page = await browser.context.newPage();
        const cdp = await browser.context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate });
        await page.goto(`${servers.origin}${part.path}`);
        await waitState(page, 'ready', 60000);
        const ms = (await moduleMs(page.url()))?.[part.module];
        if (typeof ms === 'number') times.push(ms);
        await page.close();
      }
      // The time is mostly the injection by the browser (file read, compile) and the wait for a busy main thread; the older modules take as long. The hold of the quick version, which is what a person sees, is held to the copy with the modules in the manifest.
      const budget = rate === 1 ? 100 : 450;
      if (times.length) record({ id: `${part.id}-${rate}x`, name: `first use of ${part.what}: request to arrival (${rate}x CPU, median of 7)`, value: median(times), budget, unit: 'ms', ceiling: Math.round(budget * 1.6) });
      else record({ id: `${part.id}-${rate}x`, name: `first use of ${part.what}: the page did not ask for the module`, value: 1e6, budget, unit: 'ms', note: '' });
    }
  }
}


/** P-02t: compile and run time of everything that an empty page where the extension is on loads before it is ready (browser trace, median of 7 after 3 warm-up loads). */
async function scriptTime(browser, servers) {
  for (const rate of [1, 4]) {
    await browser.clearStorage();
    await browser.setStorage(ON);
    const url = `${servers.origin}/gen/blank.html`;
    for (let i = 0; i < 3; i++) await loadTraced(browser, url, rate);
    const times = [];
    for (let i = 0; i < 7; i++) times.push((await loadTraced(browser, url, rate)).scripts);
    const budget = rate === 1 ? 40 : 190;
    record({ id: `P-02t-${rate}x`, name: `script time of an empty page that is on (${rate}x CPU, median of 7)`, value: median(times), budget, unit: 'ms', ceiling: Math.round(budget * 1.6) });
  }
}

/**
 * P-29: the picture filter of the color vision correction. A page of 200 pictures is scrolled one step a frame, and the
 * time of each frame is taken, with the CPU slowed 4 times: the correction of pictures on against the correction without it,
 * median of 5 pairs. `DK_PERF_ONLY=pictures` runs this row alone.
 */
async function pictureFilter(browser, servers) {
  const frames = async (settings) => {
    await browser.clearStorage();
    await browser.setStorage({ settings });
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/gen/pictures.html?count=200`);
    await waitState(page, 'ready', 60000);
    await page.waitForTimeout(500);
    const cdp = await browser.context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const ms = await page.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      await frame();
      const times = [];
      let last = performance.now();
      for (let i = 0; i < 80; i++) {
        scrollBy(0, 120);
        await frame();
        const now = performance.now();
        times.push(now - last);
        last = now;
      }
      times.sort((a, b) => a - b);
      return times[Math.floor(times.length / 2)];
    });
    await page.close();
    return ms;
  };
  const base = { enabled: true, theme: { mode: 'original', cvdType: 'deutan', cvdSeverity: 100 } };
  const off = [];
  const on = [];
  for (let r = 0; r < 5; r++) {
    off.push(await frames(base));
    on.push(await frames({ ...base, theme: { ...base.theme, cvdMedia: true } }));
  }
  record({ id: 'P-29', name: 'picture filter of the color vision correction: frame time while scrolling 200 pictures, on against off (4x slower CPU, median of 5 pairs)', value: median(on.map((v, i) => v / off[i])), budget: 1.25, unit: 'x', ceiling: 1.6, note: `median frame ${median(off).toFixed(1)} ms off, ${median(on).toFixed(1)} ms on` });
}

/** P-27: engine start of an empty page with 2 000 site rules and 2 000 fixes stored (the limits): the gate reads the slice of its host. */
async function bigData(browser, servers) {
  const siteRules = {};
  const userFixes = {};
  for (let i = 0; i < 2000; i++) siteRules[`site${i}.example.com`] = { enabled: i % 7 !== 0, theme: { mode: 'dark', brightness: 90 } };
  for (let i = 0; i < 2000; i++) userFixes[`fix${i}.example.org`] = { engine: 'dynamic', dynamic: { css: `.a${i}{color:red}`.repeat(100), invert: ['img.logo'] } };
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true }, siteRules, userFixes });
  await browser.worker.evaluate(() => globalThis.tintlyGate?.settled());
  const times = [];
  for (let i = 0; i < 8; i++) {
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/gen/blank.html`);
    await waitState(page, 'ready', 30000);
    if (i > 0) times.push((await browser.stats(page.url())).startedAt);
    await page.close();
  }
  record({ id: 'P-27', name: 'engine start with 2 000 rules and 2 000 fixes stored (median of 7, from navigation start)', value: median(times), budget: 90, unit: 'ms', ceiling: 140, note: '155 ms before' });
}

async function main() {
  sizes();
  // DK_PERF_ONLY=size: the size rows only, no browser and no timing rows.
  if (process.env.DK_PERF_ONLY === 'size') return { browser: 'none', os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), runs: 0, date: new Date().toISOString() };
  await colorSpeed();
  const servers = await startServers();
  const browser = await launch();
  const plain = await launchPlain();
  const meta = { browser: browser.browserVersion, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), runs: RUNS, date: new Date().toISOString() };

  const open = async (path, storage = ON) => {
    await browser.clearStorage();
    await browser.setStorage(storage);
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}${path}`);
    return page;
  };

  try {
    if (process.env.DK_PERF_ONLY === 'popup') {
      await popupRows(browser, servers);
      return meta;
    }
    if (process.env.DK_PERF_ONLY === 'parts') {
      await firstUse(browser, servers);
      return meta;
    }
    if (process.env.DK_PERF_ONLY === 'pictures') {
      await pictureFilter(browser, servers);
      return meta;
    }
    // P-01: what a page that is off pays, as the difference in script time against a browser without the extension. The
    // two browsers are asked in turn, in pairs, so that a busy machine slows both samples of a pair alike; the value is the
    // median of the differences of the pairs.
    const probeOnce = async (context) => {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      await page.goto(`${servers.origin}/dark.html`);
      await page.waitForLoadState('load');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const ms = (metrics.find((m) => m.name === 'ScriptDuration')?.value ?? 0) * 1000;
      await page.close();
      return ms;
    };
    // The scripts are registered for the pages that can be on, so a page that is off by the master switch or by a site rule gets none:
    // both are measured, and the value must stay near zero. The write returns when the registration matches it.
    for (const [id, name, storage] of [
      ['P-01', 'page that is off (extension off), extra script time (median of 25 pairs)', { settings: { enabled: false } }],
      ['P-01b', 'page of a site that is off by its rule, extra script time (median of 25 pairs)', { settings: { enabled: true }, siteRules: { '127.0.0.1': { enabled: false } } }],
    ]) {
      await browser.clearStorage();
      await browser.setStorage(storage);
      const diffs = [];
      for (let i = 0; i < 25; i++) {
        const order = i % 2 ? [plain.context, browser.context] : [browser.context, plain.context];
        const got = new Map();
        for (const context of order) got.set(context, await probeOnce(context));
        diffs.push(got.get(browser.context) - got.get(plain.context));
      }
      record({ id, name, value: Math.max(0, median(diffs)), budget: 2, unit: 'ms', ceiling: 6 });
    }

    // P-03: from the first content-script line to the engine start.
    const gates = [];
    for (let i = 0; i < 12; i++) {
      const page = await open('/dynamic.html');
      await waitState(page, 'ready');
      gates.push((await browser.stats(`${servers.origin}/dynamic.html`)).gateMs);
      await page.close();
    }
    record({ id: 'P-03', name: 'gate decision (median of 12)', value: median(gates), budget: 25, unit: 'ms', ceiling: 60 });

    // P-05, P-06, P-04: the full Dynamic pass on a typical and on a heavy page.
    const pass = async (rules, palette) => {
      const times = [];
      const slices = [];
      for (let i = 0; i < RUNS; i++) {
        const url = `${servers.origin}/gen/large.html?rules=${rules}&palette=${palette}`;
        const page = await open(`/gen/large.html?rules=${rules}&palette=${palette}`);
        await waitState(page, 'ready', 60000);
        const s = await browser.stats(url);
        times.push(s.readyAt - s.startedAt);
        slices.push(s.slices);
        await page.close();
      }
      return {
        time: median(times),
        // While the quick dark version is on, slices are long on purpose: nobody sees the page being worked on.
        quickMax: Math.max(...slices.map((s) => s.phases?.quick?.maxMs ?? 0)),
        overruns: slices.reduce((n, s) => n + s.overruns, 0),
        count: slices.reduce((n, s) => n + s.slices, 0),
      };
    };
    const typical = await pass(1500, 40);
    const heavy = await pass(30000, 40);
    record({ id: 'P-05', name: 'Dynamic pass, 1 500 rules (median)', value: typical.time, budget: 60, unit: 'ms', ceiling: 200 });
    record({ id: 'P-06', name: 'Dynamic pass, 30 000 rules, palette (median)', value: heavy.time, budget: 400, unit: 'ms', ceiling: 2500 });
    record({ id: 'P-04c', name: 'longest slice while the quick version is on, heavy page', value: heavy.quickMax, budget: 50, unit: 'ms', ceiling: 80, note: '' });
    record({ id: 'P-04b', name: 'slices over the hard limit, heavy page', value: heavy.overruns, budget: Math.ceil(heavy.count * 0.02), unit: 'slices' });

    // P-04a: a heavy sheet that the page adds after the engine is ready is worked on in short slices.
    {
      const url = `${servers.origin}/basic.html`;
      const page = await open('/basic.html');
      await waitState(page, 'ready');
      const worst = [];
      for (let i = 0; i < RUNS; i++) {
        const before = (await browser.stats(url)).sheets;
        await page.evaluate((n) => {
          const hex = (k) => `#${(((k % 40) * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}`;
          let css = '';
          for (let k = 0; k < n; k++) css += `.late${k}{color:${hex(k)};background:${hex(k + 7)};border:1px solid ${hex(k + 13)}}`;
          const style = document.createElement('style');
          style.textContent = css;
          document.head.append(style);
        }, 30000);
        let stats;
        for (let k = 0; k < 600; k++) {
          stats = await browser.stats(url);
          if (stats.sheets > before && !stats.waiting.pending && !stats.waiting.pumping) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        worst.push(stats.slices.phases?.live?.maxMs ?? 0);
      }
      record({ id: 'P-04a', name: 'longest slice after ready (a 30 000-rule sheet added late)', value: Math.max(...worst), budget: 12, unit: 'ms', ceiling: 20 });
      await page.close();
    }

    // P-07: a new style element added by the page.
    {
      const page = await open('/basic.html');
      await waitState(page, 'ready');
      const ms = await page.evaluate(
        () =>
          new Promise((resolve) => {
            let css = '';
            for (let i = 0; i < 500; i++) css += `.late${i}{color:#${((i * 40503) & 0xffffff).toString(16).padStart(6, '0')};background:#fff}`;
            const el = document.createElement('p');
            el.className = 'late0';
            el.textContent = 'late';
            document.body.append(el);
            const t0 = performance.now();
            const s = document.createElement('style');
            s.textContent = `${css}.late0{background:#ffffff}`;
            document.head.append(s);
            const poll = () => {
              if (getComputedStyle(el).backgroundColor !== 'rgb(255, 255, 255)') resolve(performance.now() - t0);
              else if (performance.now() - t0 > 2000) resolve(2000);
              else requestAnimationFrame(poll);
            };
            requestAnimationFrame(poll);
          }),
      );
      record({ id: 'P-07', name: 'new sheet of 500 rules themed, seen at the next frame', value: ms, budget: 20, unit: 'ms', ceiling: 300, note: ': one frame is 16.7 ms' });
      // The engine's own part: from the page adding the sheet to the copy being in the document.
      const inserted = [];
      for (let k = 0; k < 9; k++) {
        inserted.push(
          await page.evaluate(
            (n) =>
              new Promise((resolve) => {
                let css = '';
                for (let i = 0; i < 500; i++) css += `.copy${n}x${i}{color:#${((i * 40503) & 0xffffff).toString(16).padStart(6, '0')};background:#fff}`;
                const t0 = performance.now();
                const style = document.createElement('style');
                style.textContent = css;
                const mo = new MutationObserver((records) => {
                  for (const r of records) {
                    for (const node of r.addedNodes) {
                      if (node instanceof Element && node.getAttribute('data-dk') === 'sheet' && node.textContent.includes(`copy${n}x`)) {
                        mo.disconnect();
                        resolve(performance.now() - t0);
                        return;
                      }
                    }
                  }
                });
                mo.observe(document.head, { childList: true });
                document.head.append(style);
                setTimeout(() => resolve(2000), 2000);
              }),
            k,
          ),
        );
      }
      record({ id: 'P-07a', name: 'new sheet of 500 rules, copy in the document (median of 9)', value: median(inserted), budget: 5, unit: 'ms', ceiling: 30 });
      await page.close();
    }

    // P-08, P-09: JavaScript heap added by the extension, against the same page without it.
    const heap = async (context, path) => {
      const page = await context.newPage();
      await page.goto(`${servers.origin}${path}`);
      await page.waitForTimeout(1500);
      const cdp = await context.newCDPSession(page);
      await cdp.send('HeapProfiler.collectGarbage');
      const { usedSize } = await cdp.send('Runtime.getHeapUsage');
      await page.close();
      return usedSize / 2 ** 20;
    };
    await browser.clearStorage();
    await browser.setStorage(ON);
    const heapOn = await heap(browser.context, '/basic.html');
    await browser.setStorage({ settings: { enabled: false } });
    const heapOff = await heap(browser.context, '/basic.html');
    record({ id: 'P-08', name: 'JS heap added, typical page', value: Math.max(0, heapOn - heapOff), budget: 8, unit: 'MB'});
    {
      await browser.setStorage(ON);
      const heavyOn = await heap(browser.context, '/gen/large.html?rules=30000&palette=40');
      await browser.setStorage({ settings: { enabled: false } });
      const heavyOff = await heap(browser.context, '/gen/large.html?rules=30000&palette=40');
      record({ id: 'P-09', name: 'JS heap added, heavy page (30 000 rules)', value: Math.max(0, heavyOn - heavyOff), budget: 40, unit: 'MB', note: 'JS heap only, DOM memory not counted' });
    }

    await popupRows(browser, servers);

    // P-12: one round trip to the worker from an extension page.
    {
      const id = new URL(browser.worker.url()).host;
      const page = await browser.context.newPage();
      await page.goto(`chrome-extension://${id}/pages/popup/popup.html`);
      const times = await page.evaluate(async () => {
        const out = [];
        for (let i = 0; i < 30; i++) {
          const t0 = performance.now();
          await chrome.runtime.sendMessage({ type: 'dk.state.get' });
          out.push(performance.now() - t0);
        }
        return out;
      });
      record({ id: 'P-12', name: 'worker round trip, warm (median of 30)', value: median(times), budget: 15, unit: 'ms' });
      await page.close();
    }

    // P-13: a change of settings reaches an open tab.
    {
      const page = await open('/basic.html');
      await waitState(page, 'ready');
      const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const times = [];
      for (let i = 0; i < 7; i++) {
        const before = await bg();
        const t0 = Date.now();
        await browser.setStorage({ settings: { enabled: true, theme: { brightness: 70 + i * 4 } } });
        await page.waitForFunction((b) => getComputedStyle(document.body).backgroundColor !== b, before, { timeout: 5000 });
        times.push(Date.now() - t0);
      }
      record({ id: 'P-13', name: 'settings change to a themed page (median of 7)', value: median(times), budget: 250, unit: 'ms', note: 'includes the round trip of the test driver' });
      await page.close();
    }

    // P-20, P-21: what a style change costs in E-ink, against Dark and against off, with the CPU slowed 4 times.
    // Each frame, 20 elements get a new class (color, position and a cursor change) and the style is read at once. A
    // duration on every element made this 4 to 5 times as slow as off.
    {
      const churn = async () => {
        const styleEl = document.createElement('style');
        styleEl.textContent = '.hot{cursor:help;transform:translateX(2px);background-color:#fed}';
        document.head.append(styleEl);
        await new Promise((r) => setTimeout(r, 300));
        const els = [...document.querySelectorAll('.cell:not(.declared)')].slice(0, 20);
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const run = async () => {
          await frame();
          let busy = 0;
          for (let i = 0; i < 100; i++) {
            const t0 = performance.now();
            for (const el of els) el.classList.toggle('hot', i % 2 === 0);
            getComputedStyle(els[0]).cursor;
            busy += performance.now() - t0;
            await frame();
          }
          return (busy / 100) * 1000;
        };
        return Math.min(await run(), await run());
      };
      const modes = {
        off: { enabled: false },
        dark: { enabled: true, theme: { mode: 'dark' } },
        eink: { enabled: true, theme: { mode: 'eink', einkPreset: 'eink' } },
      };
      const cost = { off: [], dark: [], eink: [] };
      for (let r = 0; r < 7; r++) {
        for (const [name, settings] of Object.entries(modes)) {
          await browser.clearStorage();
          await browser.setStorage({ settings });
          const page = await browser.context.newPage();
          await page.goto(`${servers.origin}/eink-churn.html`);
          if (settings.enabled) await waitState(page, 'ready', 30000);
          if (name === 'eink') await page.waitForFunction(() => !!document.querySelector('style[data-dk="calm"]'), null, { timeout: 15000 });
          await page.evaluate(() => window.stopChurn());
          await page.waitForTimeout(600);
          const cdp = await browser.context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
          cost[name].push(await page.evaluate(churn));
          await page.close();
        }
      }
      const ratio = (a, b) => median(cost[a].map((v, i) => v / cost[b][i]));
      record({ id: 'P-20', name: 'E-ink style changes, cost against Dark (4x slower CPU, median of 7 pairs)', value: ratio('eink', 'dark'), budget: 1.5, unit: 'x', ceiling: 2, note: 'the transition rule made it 4 to 5' });
      record({ id: 'P-21', name: 'E-ink style changes, cost against off (4x slower CPU, median of 7 pairs)', value: ratio('eink', 'off'), budget: 2.5, unit: 'x', ceiling: 3.5 });
    }

    // P-22: a page that declares thousands of color tokens on its root and restyles the root on every frame. Every variant
    // of a token that nothing reads is a declaration the browser resolves again at each restyle of the root. Style time of the page
    // in a second, with the extension against off, the CPU slowed 4 times, median of 5 pairs.
    {
      const styleTime = async (settings) => {
        await browser.clearStorage();
        await browser.setStorage({ settings });
        const page = await browser.context.newPage();
        await page.goto(`${servers.origin}/gen/tokens.html?count=3000&used=60&churn=1`);
        if (settings.enabled) await waitState(page, 'ready', 30000);
        // The first pass of the readability net writes rules; the figure is for the steady state.
        await page.waitForTimeout(3000);
        const cdp = await browser.context.newCDPSession(page);
        await cdp.send('Performance.enable');
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        const read = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'RecalcStyleDuration')?.value ?? 0;
        const a = await read();
        const t0 = Date.now();
        await page.waitForTimeout(3000);
        const b = await read();
        await page.close();
        return ((b - a) * 1000) / ((Date.now() - t0) / 1000);
      };
      const ratios = [];
      for (let r = 0; r < 5; r++) {
        const off = await styleTime({ enabled: false });
        const on = await styleTime({ enabled: true, theme: { mode: 'dark' } });
        // The root alone is restyled, so the page itself costs next to nothing; one millisecond a second keeps the ratio finite.
        ratios.push((on + 1) / (off + 1));
      }
      record({ id: 'P-22', name: 'root restyle on a page with 3 000 color tokens, against off (4x slower CPU, median of 5 pairs)', value: median(ratios), budget: 1.5, unit: 'x', ceiling: 2.5, note: 'the variants of unread tokens made it 2.9 to 5.3' });
    }

    // P-23: the style attributes that a page writes on every frame (a player bar, an animation): time in the observer, in a second,
    // for 20 color writes a frame (about 1 200 changes a second, under the limit at which the observer pauses), the CPU slowed 4 times, median of 5.
    {
      const times = [];
      for (let r = 0; r < 5; r++) {
        await browser.clearStorage();
        await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
        const page = await browser.context.newPage();
        await page.goto(`${servers.origin}/inline-churn.html`);
        await waitState(page, 'ready', 30000);
        await page.waitForTimeout(2500);
        const cdp = await browser.context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        const before = await browser.stats(page.url());
        const t0 = Date.now();
        await page.waitForTimeout(3000);
        const after = await browser.stats(page.url());
        times.push(((after.inlineMs - before.inlineMs) * 1000) / (Date.now() - t0));
        await page.close();
      }
      record({ id: 'P-23', name: 'style attributes written every frame: time in the observer in a second (20 colors a frame, 4x slower CPU, median of 5)', value: median(times), budget: 100, unit: 'ms', ceiling: 190, note: '181 to 200 before the style attribute change' });
    }

    await scriptTime(browser, servers);
    await bigData(browser, servers);
    await firstUse(browser, servers);
    await pictureFilter(browser, servers);
  } finally {
    await plain.close();
    await browser.close();
    await servers.close();
  }
  return meta;
}

const meta = await main();

let failed = 0;
const lines = [];
for (const r of rows) {
  // A size is a count of bytes and does not move between runs: no allowance. A time or a ratio moves, so it gets the noise band.
  const noise = r.unit === 'KB' ? 1 : NOISE;
  const limit = (r.ceiling ?? r.budget) * noise;
  const met = r.value <= r.budget * noise;
  const status = met ? 'PASS' : r.value <= limit ? 'MISS' : 'FAIL';
  if (status === 'FAIL') failed += 1;
  r.status = status;
  lines.push(`${status.padEnd(5)} ${r.id.padEnd(6)} ${r.name.padEnd(52)} ${r.value.toFixed(2).padStart(9)} ${r.unit.padEnd(6)} budget ${String(r.budget).padStart(5)}${r.ceiling ? `, ceiling ${r.ceiling}` : ''}${r.note ? `  (${r.note})` : ''}`);
  if (r.detail && status !== 'PASS') lines.push(...r.detail.map((d) => `        ${d}`));
}
console.log(`# ${meta.browser}, ${meta.cpu}, ${meta.cores} cores, ${meta.memoryGB} GB, ${meta.os}`);
console.log(lines.join('\n'));
const out = join(REPO, 'tests', 'perf', 'results');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'latest.json'), JSON.stringify({ meta, rows }, null, 2));
console.log(`# ${rows.filter((r) => r.status === 'PASS').length} pass, ${rows.filter((r) => r.status === 'MISS').length} known misses, ${failed} fail`);
process.exit(failed ? 1 : 0);
