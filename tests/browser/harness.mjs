import { chromium } from 'playwright';
import http from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const FIXTURES = join(REPO, 'tests', 'browser', 'fixtures');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.js': 'text/javascript' };

/** The sheet of `largePage`: `rules` small rules. */
export function largeCss(rules, palette = 0) {
  // With a palette, the colors repeat the way they do on a real site; without one, nearly every color is new.
  const hex = (n) => `#${((((palette ? n % palette : n) * 2654435761) >>> 8) & 0xffffff).toString(16).padStart(6, '0')}`;
  let css = 'body{margin:0;background:#fff;color:#222;font:14px system-ui}\n';
  for (let i = 0; i < rules; i++) {
    css += `.c${i}{color:${hex(i)};background:${hex(i + 7)};border:1px solid ${hex(i + 13)}}\n`;
  }
  return css;
}

/** A page with `rules` small rules and a few hundred elements that use them. With `linked`, the rules come from a file. */
export function largePage(rules, palette = 0, elements = 600, linked = false) {
  let body = '';
  for (let i = 0; i < elements; i++) body += `<div class="c${(i * 37) % Math.max(rules, 1)}">Item ${i}</div>`;
  const sheet = linked ? `<link rel="stylesheet" href="/gen/large.css?rules=${rules}&palette=${palette}">` : `<style>${largeCss(rules, palette)}</style>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Large</title>${sheet}</head><body>${body}</body></html>`;
}

/** Generated test images, by name. A test fills it; the servers answer `/gen/img/<name>.png` from it. */
export const imageStore = new Map();

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fileHandler(extraHeaders = {}) {
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/gen/large.html') {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(largePage(Number(url.searchParams.get('rules') ?? 1000), Number(url.searchParams.get('palette') ?? 0), 600, url.searchParams.get('linked') === '1'));
      return;
    }
    if (url.pathname === '/gen/large.css') {
      // Served with a validator, so the browser keeps it in its cache the way it keeps a real site's sheets.
      res.writeHead(200, { 'content-type': TYPES['.css'], 'cache-control': 'max-age=300', etag: '"gen"' });
      res.end(largeCss(Number(url.searchParams.get('rules') ?? 1000), Number(url.searchParams.get('palette') ?? 0)));
      return;
    }
    if (url.pathname === '/gen/site-dark-large.html') {
      // A page with a complete dark theme in media rules (one dark rule for each of `rules` light rules) and `uncovered` rules the dark theme does not touch.
      const rules = Number(url.searchParams.get('rules') ?? 4000);
      const uncovered = Number(url.searchParams.get('uncovered') ?? 20);
      const hex = (n) => `#${(((n * 2654435761) >>> 8) & 0xffffff).toString(16).padStart(6, '0')}`;
      const light = (n) => `#${(0xe0 + (n % 24)).toString(16)}${(0xe0 + ((n * 7) % 24)).toString(16)}${(0xe0 + ((n * 13) % 24)).toString(16)}`;
      let css = 'body{margin:0;background:#fff;color:#222;font:14px system-ui}.promo{height:500px;background:linear-gradient(#fff,#fafafa)}\n';
      let dark = 'body{background:#101418;color:#e8eaed}\n';
      for (let i = 0; i < rules; i++) {
        css += `.c${i}{color:${hex(i)};background:${light(i)};border:1px solid ${light(i + 3)}}\n`;
        dark += `.c${i}{color:#e${(i % 10).toString(16)}e8ed;background:#1${(i % 10).toString(16)}2128;border:1px solid #3b4450}\n`;
      }
      for (let j = 0; j < uncovered; j++) css += `.u${j}{background:#ffffff;color:#101010}\n`;
      let body = '';
      for (let i = 0; i < 600; i++) body += `<div class="c${(i * 37) % Math.max(rules, 1)}">Item ${i}</div>`;
      for (let j = 0; j < uncovered; j++) body += `<p class="u${j}">Uncovered ${j}</p>`;
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Large site dark</title><style>${css}@media (prefers-color-scheme: dark){${dark}}</style></head><body>${body}<section class="promo" id="promo">Promo</section></body></html>`);
      return;
    }
    if (url.pathname === '/gen/big-light.html') {
      // A light page with `rules` rules whose colors are nearly all different (up to 32 768), and `elements` rows that fill the window and use them, so a
      // frame that is only partly themed is light in a large part of the window.
      const rules = Number(url.searchParams.get('rules') ?? 30000);
      const elements = Number(url.searchParams.get('elements') ?? 600);
      const light = (n) => `#${(0xe0 + (n % 32)).toString(16)}${(0xe0 + ((n >> 5) % 32)).toString(16)}${(0xe0 + ((n >> 10) % 32)).toString(16)}`;
      let css = 'body{margin:0;background:#fff;color:#222;font:14px system-ui}.row{height:24px;padding:2px 8px;box-sizing:border-box}\n';
      for (let i = 0; i < rules; i++) css += `.c${i}{background:${light(i)};color:#${(0x10 + (i % 40)).toString(16)}1010;border-bottom:1px solid ${light(i + 5)}}\n`;
      let body = '';
      for (let i = 0; i < elements; i++) body += `<div class="row c${(i * 997) % Math.max(rules, 1)}">Row ${i}</div>`;
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Big light</title><style>${css}</style></head><body>${body}</body></html>`);
      return;
    }
    if (url.pathname === '/gen/slow-cross.html') {
      // A page whose only style sheet comes from another origin after `ms` milliseconds, as a link in the head or in the body.
      const ms = Number(url.searchParams.get('ms') ?? 4000);
      const other = (url.searchParams.get('other') ?? '').replace(/[^\w:/.-]/g, '');
      const link = `<link rel="stylesheet" href="${other}/delay/${ms}/css/slow.css">`;
      const body = '<header class="top"><strong>Slow cross-origin sheet</strong></header><main><section class="card"><h2>One</h2><p>Text.</p></section><section class="card"><h2>Two</h2><p>More text.</p></section></main>';
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Slow cross</title>${url.searchParams.get('place') === 'body' ? '' : link}</head><body>${body}${url.searchParams.get('place') === 'body' ? link : ''}</body></html>`);
      return;
    }
    if (url.pathname === '/gen/blank.html') {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>Blank</title></head><body><p>blank</p></body></html>');
      return;
    }
    if (url.pathname.startsWith('/ext/')) {
      // The style sheets of the extension itself, as input of a realistic size.
      const file = normalize(join(REPO, 'extension', url.pathname.slice(5)));
      if (!file.startsWith(join(REPO, 'extension')) || !file.endsWith('.css') || !existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES['.css'], 'cache-control': 'max-age=300', etag: '"ext"' });
      createReadStream(file).pipe(res);
      return;
    }
    if (url.pathname === '/gen/code.html') {
      // About 72 000 elements: 300 code blocks of 40 lines, each line a box with 5 colored tokens.
      const blocks = Number(url.searchParams.get('blocks') ?? 300);
      const palette = ['#d73a49', '#6f42c1', '#005cc5', '#22863a', '#24292e'];
      let css = 'body{margin:0;background:#fff;color:#24292e;font:12px monospace}pre{margin:0 0 8px;padding:8px;background:#f6f8fa}.l{display:block}';
      palette.forEach((c, i) => (css += `.t${i}{color:${c}}`));
      let body = '';
      for (let b = 0; b < blocks; b++) {
        body += '<pre>';
        for (let l = 0; l < 40; l++) body += `<div class="l">${palette.map((_, i) => `<span class="t${i}">tok${i}</span>`).join(' ')}</div>`;
        body += '</pre>';
      }
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Code</title><style>${css}</style></head><body>${body}</body></html>`);
      return;
    }
    if (url.pathname === '/gen/pictures.html') {
      // A page of photos: `count` pictures with soft gradients in many hues, as a shop or a news front page has.
      const count = Number(url.searchParams.get('count') ?? 200);
      let body = '';
      for (let i = 0; i < count; i++) {
        const h = (i * 47) % 360;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 80% 45%)"/><stop offset="1" stop-color="hsl(${(h + 120) % 360} 70% 60%)"/></linearGradient></defs><rect width="240" height="160" fill="url(#g)"/><circle cx="${60 + (i % 5) * 30}" cy="80" r="40" fill="hsl(${(h + 200) % 360} 75% 50%)"/></svg>`;
        body += `<img width="240" height="160" alt="" src="data:image/svg+xml,${encodeURIComponent(svg)}">`;
      }
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Pictures</title><style>body{margin:8px;background:#fff;color:#222}img{margin:4px;vertical-align:top}</style></head><body>${body}</body></html>`);
      return;
    }
    if (url.pathname === '/gen/icons.html') {
      // Inline SVG icons that color themselves with attributes, as a shop result page does.
      const count = Number(url.searchParams.get('count') ?? 4000);
      const fills = ['#222', '#e33', '#0a6', '#06c', '#555', '#a0a', '#333', '#c60'];
      let body = '';
      for (let i = 0; i < count; i++) {
        const f = fills[i % fills.length];
        body += `<svg width="16" height="16" viewBox="0 0 16 16"><path fill="${f}" d="M2 2h12v12H2z"/><circle cx="8" cy="8" r="3" fill="${fills[(i + 3) % fills.length]}" stroke="${f}"/></svg>`;
      }
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Icons</title><style>body{margin:8px;background:#fff;color:#222}svg{margin:2px}</style></head><body>${body}</body></html>`);
      return;
    }
    if (url.pathname === '/gen/tokens.html') {
      // A design system: `count` color tokens on the root, the body and an application box, of which `used` are read by rules. With `churn`, the
      // page changes an attribute of the root on every frame (as a player or an animation does), so the root is restyled all the time.
      const count = Number(url.searchParams.get('count') ?? 3000);
      const used = Number(url.searchParams.get('used') ?? 60);
      const hex = (n) => `#${((n * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}`;
      let root = '';
      let body = '';
      let app = '';
      for (let i = 0; i < count; i++) {
        const decl = `--t${i}:${hex(i)};`;
        if (i % 3 === 0) root += decl;
        else if (i % 3 === 1) body += decl;
        else app += decl;
      }
      let rules = '';
      for (let i = 0; i < used; i++) rules += `.u${i}{background:var(--t${i});color:var(--t${i + used});border:1px solid var(--t${i + 2 * used})}`;
      // The state of the root changes its own style (a width that nothing draws), so the root is restyled with all its tokens and its children are not.
      for (let i = 0; i < 7; i++) rules += `html[data-t="${i}"]{outline-width:${i}px}`;
      let cells = '';
      for (let i = 0; i < 300; i++) cells += `<div class="u${i % Math.max(used, 1)}">Cell ${i}</div>`;
      const script = url.searchParams.get('churn') === '1' ? '<script>let n=0;let stop=false;window.stopChurn=()=>{stop=true};(function f(){if(stop)return;document.documentElement.setAttribute("data-t",String(++n%7));requestAnimationFrame(f)})()</script>' : '';
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Tokens</title><style>:root{${root}}body{margin:0;${body}background:#fff;color:#222;font:13px system-ui}#app{${app}}${rules}</style></head><body><div id="app">${cells}</div>${script}</body></html>`);
      return;
    }
    const image = /^\/gen\/img\/([\w-]+)\.png$/.exec(url.pathname);
    if (image) {
      const file = imageStore.get(image[1]);
      if (!file) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(file);
      return;
    }
    if (url.pathname === '/gen/hostile.html') {
      // Style sheets built to go over the engine's limits.
      const kind = url.searchParams.get('kind');
      let css = 'body{background:#fff;color:#222}.probe{color:#102030;background:#fafafa}';
      if (kind === 'rules') for (let i = 0; i < 65000; i++) css += `.r${i}{color:#${(i * 40503 & 0xffffff).toString(16).padStart(6, '0')}}`;
      if (kind === 'depth') css += '@media screen{'.repeat(40) + '.probe{color:#001122}' + '}'.repeat(40);
      const head = kind === 'imports' ? '<link rel="stylesheet" href="/gen/imp/0.css">' : '';
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Hostile</title><style>${css}</style>${head}</head><body><p class="probe">probe</p></body></html>`);
      return;
    }
    const imp = /^\/gen\/imp\/(\d+)\.css$/.exec(url.pathname);
    if (imp) {
      const k = Number(imp[1]);
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end(k < 12 ? `@import url(/gen/imp/${k + 1}.css);.probe{color:#10${k}0${k}0}` : '.probe{color:#123456}');
      return;
    }
    if (url.pathname === '/gen/big.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('a{color:red}'.concat(String.fromCharCode(10)).repeat(Number(url.searchParams.get('n') ?? 300000)));
      return;
    }
    if (url.pathname === '/gen/plain.css') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('a{color:red}');
      return;
    }
    if (url.pathname === '/gen/frame.html') {
      // A page that holds one frame, used by the Firefox driver to reach an extension page.
      const src = (url.searchParams.get('src') ?? '').replace(/"/g, '');
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Frame</title></head><body><iframe id="f" src="${src}" width="600" height="400"></iframe></body></html>`);
      return;
    }
    if (url.pathname === '/gen/images.html') {
      // A light page with the named images, from this server or from the one in `base`.
      const names = (url.searchParams.get('names') ?? '').split(',').filter(Boolean);
      const base = url.searchParams.get('base') ?? '';
      const tags = names.map((n) => `<img id="${n}" width="48" height="48" src="${base}/gen/img/${n}.png" alt="">`).join('');
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Images</title><style>body{background:#fff;color:#222;margin:8px}</style></head><body>${tags}</body></html>`);
      return;
    }
    if (url.pathname === '/gen/swatches.html') {
      // A grid of boxes in the given colors, 40 by 40 pixels, ten to a row, on a white page.
      const colors = (url.searchParams.get('c') ?? '').split(',').filter(Boolean);
      const boxes = colors.map((c, i) => `<div style="position:absolute;left:${(i % 10) * 40}px;top:${Math.floor(i / 10) * 40}px;width:40px;height:40px;background:#${c}"></div>`).join('');
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Swatches</title><style>html,body{margin:0;background:#fff}</style></head><body>${boxes}</body></html>`);
      return;
    }
    const delayed = /^\/delay\/(\d+)(\/.*)$/.exec(url.pathname);
    if (delayed) {
      // Serve the same file after a pause, so a test can make a stylesheet arrive late.
      const inner = new URL(delayed[2], 'http://x');
      setTimeout(() => handler(Object.assign(req, { url: inner.pathname + inner.search }), res), Number(delayed[1]));
      return;
    }
    const csp = url.pathname.startsWith('/csp/');
    const path = normalize(join(FIXTURES, csp ? url.pathname.slice(4) : url.pathname));
    if (!path.startsWith(FIXTURES) || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const headers = { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', ...extraHeaders };
    if (csp) headers['content-security-policy'] = "default-src 'self'; style-src 'self'; script-src 'self' 'unsafe-inline'";
    res.writeHead(200, headers);
    createReadStream(path).pipe(res);
  };
  return handler;
}

/** Two origins on different ports, so one is cross-origin for the other. */
export async function startServers() {
  const a = await serve(fileHandler());
  const b = await serve(fileHandler());
  const origin = (s) => `http://127.0.0.1:${s.address().port}`;
  return {
    origin: origin(a),
    other: origin(b),
    close: () => Promise.all([a, b].map((s) => new Promise((r) => s.close(r)))),
  };
}

/**
 * Launch Chromium with the unpacked extension. `extension` (or the variable DK_EXTENSION) names another unpacked copy, to
 * compare two builds.
 * @param {{ extension?: string, args?: string[] }} [options]  `args` adds browser flags
 */
export async function launch(options = {}) {
  const ext = options.extension ?? process.env.DK_EXTENSION ?? join(REPO, 'extension');
  const dir = mkdtempSync(join(tmpdir(), 'dk-chrome-'));
  const context = await chromium.launchPersistentContext(dir, {
    // DK_CHANNEL selects the browser: chromium (default), chrome or msedge.
    channel: process.env.DK_CHANNEL || 'chromium',
    headless: true,
    viewport: { width: 1000, height: 800 },
    // Branded builds switch off the command-line way of loading an unpacked extension unless this feature is turned off.
    // The welcome page of a fresh install must not reach the real site from a test.
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--host-resolver-rules=MAP enaloo.com ~NOTFOUND', ...(options.args ?? [])],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  // The worker writes the default data once on install. A test must not race that write.
  for (let i = 0; i < 100; i++) {
    if ((await worker.evaluate(() => chrome.storage.local.get('schemaVersion'))).schemaVersion !== undefined) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // The welcome tab is kept out of the way of the tests; its address is kept for the test of it.
  /** @type {string[]} */
  const welcome = [];
  for (let i = 0; i < 20 && welcome.length === 0; i++) {
    const tabs = await worker.evaluate(() => chrome.tabs.query({ url: 'https://enaloo.com/*' }).then((t) => t.map((x) => ({ id: x.id, url: x.url || x.pendingUrl, active: x.active }))));
    for (const tab of tabs) {
      welcome.push(JSON.stringify(tab));
      await worker.evaluate((id) => chrome.tabs.remove(id), tab.id).catch(() => {});
    }
    if (welcome.length === 0) await new Promise((r) => setTimeout(r, 100));
  }

  await worker.evaluate(() => globalThis.tintlyRegister?.sync());

  throttleContext(context);

  return {
    context,
    worker,
    /** The welcome tabs the install opened, as `{ id, url, active }`. */
    welcome: welcome.map((w) => JSON.parse(w)),
    browserVersion: context.browser()?.version(),
    /** Write to chrome.storage.local from the extension's worker. The content scripts are registered from the worker, so the call returns when the registration matches the new data (an older build has no handle and returns at once). */
    setStorage: (items) => worker.evaluate(async (v) => (await chrome.storage.local.set(v), await globalThis.tintlyRegister?.sync()), items),
    clearStorage: () => worker.evaluate(async () => (await chrome.storage.local.clear(), await globalThis.tintlyRegister?.sync())),
    /** Read engine stats from the isolated world of the tab that shows `url`. */
    stats: (url) =>
      worker.evaluate(async (u) => {
        const [tab] = await chrome.tabs.query({ url: u });
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: /** @type {number} */ (tab.id) },
          world: 'ISOLATED',
          func: () => JSON.stringify(globalThis.__dk?.dynamic?.stats() ?? globalThis.__dk?.filter?.stats() ?? null),
        });
        return JSON.parse(r.result);
      }, url),
    /**
     * Start the Dynamic engine again in the tab that shows `url`, with these engine options, and wait until it is ready.
     * Resolves to its stats.
     */
    restartEngine: (url, options, theme = {}) =>
      worker.evaluate(
        async ({ u, o, th }) => {
          const [tab] = await chrome.tabs.query({ url: u });
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: /** @type {number} */ (tab.id) },
            world: 'ISOLATED',
            func: async (opts, theme) => {
              const dk = globalThis.__dk;
              dk.dynamic.start(theme, opts);
              for (let i = 0; i < 400; i++) {
                const s = dk.dynamic.stats();
                if (s && s.ready && !s.waiting.fetching && !s.waiting.pending && !s.waiting.pumping) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              return JSON.stringify(dk.dynamic.stats());
            },
            args: [o, th],
          });
          return JSON.parse(r.result);
        },
        { u: url, o: options, th: theme },
      ),
    async close() {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** How many times slower the pages of this run are (DK_CPU_THROTTLE=4 node --test ...). Time budgets in a test scale with it. */
export const SLOW = Math.max(1, Number(process.env.DK_CPU_THROTTLE || 1));

/** With DK_CPU_THROTTLE set, every page the context opens runs with the main thread that many times slower. */
function throttleContext(context) {
  if (SLOW <= 1) return;
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await newPage();
    await cpuThrottle(page, SLOW);
    return page;
  };
}

/** Slow the main thread of `page` down `rate` times (CDP), to test a busy or slow machine. 1 switches it off. */
export async function cpuThrottle(page, rate) {
  await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate });
}

/** Wait until the engine says it finished its first pass (or is not running, when `off`). */
export async function waitState(page, state, timeout = 15000 * SLOW) {
  await page.waitForFunction(
    (s) => (s === null ? !document.documentElement.hasAttribute('data-dk-state') : document.documentElement.getAttribute('data-dk-state') === s),
    state,
    { timeout },
  );
}

/** Read what a person would see: text colors, effective backgrounds and boxes of every element with text. */
export function collect(page) {
  return page.evaluate(() => {
    const parse = (s) => {
      const m = /rgba?\(([^)]+)\)/.exec(s);
      if (!m) return null;
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    };
    const canvas = () => parse(getComputedStyle(document.documentElement).backgroundColor);
    const effective = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0.5) return c;
      }
      const c = canvas();
      return c && c.a > 0.5 ? c : { r: 255, g: 255, b: 255, a: 1 };
    };
    const rows = [];
    const all = [...document.body.querySelectorAll('*')];
    all.forEach((el, index) => {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      const rect = el.getBoundingClientRect();
      const row = { index, tag: el.tagName.toLowerCase(), cls: el.className?.baseVal ?? el.className, rect: [rect.x, rect.y, rect.width, rect.height].map((v) => Math.round(v * 100) / 100) };
      if (own) {
        row.color = parse(getComputedStyle(el).color);
        row.bg = effective(el);
      }
      rows.push(row);
    });
    return { rows, canvas: canvas(), html: document.documentElement.outerHTML };
  });
}

/** A browser without the extension, to measure what the extension costs. */
export async function launchPlain() {
  const dir = mkdtempSync(join(tmpdir(), 'dk-plain-'));
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, viewport: { width: 1000, height: 800 } });
  throttleContext(context);
  return {
    context,
    async close() {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Record every frame the page paints while `action` runs, as a list of mean lightness values (0 dark, 1 light).
 * Start from a dark page, so the first frame is not a blank white one that belongs to no page.
 * With `share` (a lightness between 0 and 1), each value is instead the share of the pixels lighter than that, so a page that is light in
 * a part of the window shows up although its mean lightness is low.
 */
export async function paintedLightness(page, helper, action, { share = null, times = null } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', (frame) => {
    frames.push(frame.data);
    // `times`, when given, is filled with the time of each frame in milliseconds since 1970.
    if (times) times.push((frame.metadata.timestamp ?? 0) * 1000);
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 160, maxHeight: 120, everyNthFrame: 1 });
  await action();
  await new Promise((r) => setTimeout(r, 500));
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  return helper.evaluate(async ({ list, share }) => {
    const out = [];
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 12;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (const data of list) {
      const blob = await (await fetch(`data:image/jpeg;base64,${data}`)).blob();
      const bmp = await createImageBitmap(blob);
      ctx.drawImage(bmp, 0, 0, 16, 12);
      const px = ctx.getImageData(0, 0, 16, 12).data;
      let sum = 0;
      let lighter = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
        sum += l;
        if (share !== null && l > share) lighter++;
      }
      out.push(share === null ? sum / (px.length / 4) : lighter / (px.length / 4));
    }
    return out;
  }, { list: frames, share });
}

/** The color at the middle of each element, read from a screenshot of the page. Scrolls to the top first. */
export async function colorsAt(page, helper, selectors) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const rects = await page.evaluate((list) => list.map((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  }), selectors);
  return pixelsOf(page, helper, rects);
}

/** The color at each point of a screenshot of the page (device pixels equal CSS pixels here). */
export async function pixelsOf(page, helper, points) {
  const png = await page.screenshot({ type: 'png' });
  return helper.evaluate(async ({ data, pts }) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return pts.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)));
  }, { data: png.toString('base64'), pts: points });
}
