// Open each page of a list with and without the extension, save what happened and run the checks.
//   node scripts/data/crawl.mjs <list.txt> [--local] [--out corpus] [--wait 4000]
// A line of the list is a host (`example.com`, opened as https://example.com/) or, with --local, a path of the test
// fixtures (`/basic.html`). Lines that start with # are ignored. The result is one JSON file and two screenshots per
// page in the output folder (default `corpus/`, which is never published), then run report.mjs.
// Pages are opened as an anonymous visitor. Nothing is typed into a page, and no page is opened that is not in the list.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, launchPlain, startServers } from '../../tests/browser/harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Read in the page: text elements whose color is too close to their background, and large areas that are still light. */
function inspect(viewport) {
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const effective = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id && /^[\w-]+$/.test(n.id)) {
        parts.unshift(`${s}#${n.id}`);
        break;
      }
      const cls = [...n.classList].filter((c) => /^[\w-]+$/.test(c)).slice(0, 2);
      if (cls.length) s += `.${cls.join('.')}`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const low = [];
  let texts = 0;
  const lightBoxes = [];
  const area = viewport.width * viewport.height;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > viewport.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    if (own && texts < 600) {
      texts += 1;
      const fg = parse(cs.color);
      const bg = effective(el);
      if (fg) {
        const a = lum(fg) + 0.05;
        const b = lum(bg) + 0.05;
        const ratio = Math.max(a, b) / Math.min(a, b);
        if (ratio < 3) low.push({ path: path(el), ratio: Math.round(ratio * 100) / 100 });
      }
    }
    const bgc = parse(cs.backgroundColor);
    if (bgc && bgc.a > 0.5 && lum(bgc) > 0.6 && (Math.min(rect.right, viewport.width) - Math.max(rect.left, 0)) * (Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0)) > area * 0.08) {
      lightBoxes.push(path(el));
    }
  }
  return { texts, low: low.slice(0, 20), lowCount: low.length, lightBoxes: lightBoxes.slice(0, 10) };
}

/** Share of the screenshot that is light (0 to 1). */
async function lightShare(helper, png) {
  return helper.evaluate(async (data) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, 64, 48);
    const px = ctx.getImageData(0, 0, 64, 48).data;
    let light = 0;
    for (let i = 0; i < px.length; i += 4) if ((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255 > 0.85) light += 1;
    return light / (px.length / 4);
  }, png.toString('base64'));
}

export async function crawl({ lines, local, out, wait }) {
  mkdirSync(out, { recursive: true });
  const servers = local ? await startServers() : null;
  const browser = await launch();
  const plain = await launchPlain();
  const helper = await browser.context.newPage();
  await helper.goto('about:blank');
  const results = [];
  try {
    for (const line of lines) {
      const url = local ? `${servers.origin}${line}` : line.includes('/') ? `https://${line}` : `https://${line}/`;
      const name = line.replace(/[^\w.-]+/g, '_').replace(/^_+/, '') || 'root';
      const record = { line, url: local ? `${line} (local)` : url, name, date: new Date().toISOString() };
      try {
        await browser.clearStorage();
        await browser.setStorage({ settings: { enabled: false } });
        const before = await plain.context.newPage();
        await before.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await before.waitForTimeout(Math.min(wait, 1500));
        const shotBefore = await before.screenshot({ type: 'png' });
        writeFileSync(join(out, `${name}.before.png`), shotBefore);
        record.lightBefore = await lightShare(helper, shotBefore);
        await before.close();

        await browser.setStorage({ settings: { enabled: true } });
        const page = await browser.context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120)));
        await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(wait);
        const shotAfter = await page.screenshot({ type: 'png' });
        writeFileSync(join(out, `${name}.after.png`), shotAfter);
        record.lightAfter = await lightShare(helper, shotAfter);
        record.state = await page.evaluate(() => document.documentElement.getAttribute('data-dk-state'));
        record.pageErrors = errors.length;
        record.checks = await page.evaluate(inspect, page.viewportSize() ?? { width: 1000, height: 800 });
        const stats = await browser.worker.evaluate(async (u) => {
          const [tab] = await chrome.tabs.query({});
          void u;
          const tabs = await chrome.tabs.query({ active: true });
          const id = (tabs.find((t) => t.url && !t.url.startsWith('about:')) ?? tab).id;
          const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, world: 'ISOLATED', func: () => JSON.stringify({ d: globalThis.__dk?.dynamic?.stats?.() ?? null, f: globalThis.__dk?.filter?.stats?.() ?? null }) });
          return JSON.parse(r.result);
        }, url).catch(() => null);
        record.engine = stats?.d ? 'dynamic' : stats?.f ? 'filter' : 'none';
        record.stats = stats?.d ? { sheets: stats.d.sheets, rules: stats.d.rules, faults: stats.d.faults, capped: stats.d.capped, unreadable: stats.d.unreadable, fetched: stats.d.fetched, gateMs: stats.d.gateMs, readyMs: stats.d.readyAt && stats.d.startedAt ? stats.d.readyAt - stats.d.startedAt : null } : null;
        await page.close();
      } catch (e) {
        record.error = String(e.message).slice(0, 200);
      }
      writeFileSync(join(out, `${name}.json`), JSON.stringify(record, null, 2));
      results.push(record);
      console.log(`${record.error ? 'ERROR' : 'ok   '} ${line} state=${record.state ?? '-'} light ${(record.lightBefore ?? 0).toFixed(2)} -> ${(record.lightAfter ?? 0).toFixed(2)} low-contrast ${record.checks?.lowCount ?? '-'}`);
    }
  } finally {
    await plain.close();
    await browser.close();
    await servers?.close();
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node scripts/data/crawl.mjs <list.txt> [--local] [--out corpus] [--wait 4000]');
    process.exit(2);
  }
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  await crawl({ lines, local: args.includes('--local'), out: join(ROOT, opt('--out', 'corpus')), wait: Number(opt('--wait', 4000)) });
}
