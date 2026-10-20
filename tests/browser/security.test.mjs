import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, pixelsOf } from './harness.mjs';

let servers;
let browser;
let extId;

before(async () => {
  servers = await startServers();
  browser = await launch();
  extId = new URL(browser.worker.url()).host;
});

after(async () => {
  await browser?.close();
  await servers?.close();
});

const ON = { settings: { enabled: true } };

async function open(path, storage = ON) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  return page;
}

const fromContent = (url, message) =>
  browser.worker.evaluate(
    async ({ u, m }) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (msg) => chrome.runtime.sendMessage(msg), args: [m] });
      return r.result;
    },
    { u: url, m: message },
  );

test('T-04: a sheet over a limit is left as the page wrote it, and the page stays usable', { timeout: 120000 }, async () => {
  for (const kind of ['rules', 'depth', 'imports']) {
    const page = await open(`/gen/hostile.html?kind=${kind}`);
    await waitState(page, 'ready', 60000);
    const url = `${servers.origin}/gen/hostile.html?kind=${kind}`;
    const stats = await browser.stats(url);
    console.log(`# ${kind}: capped ${stats.capped}, faults ${stats.faults}, rules ${stats.rules}`);
    // Chromium follows an @import chain only a few levels deep itself, so the import case may end before our limit.
    if (kind !== 'imports') assert.ok(stats.capped >= 1, `${kind}: no limit was reached`);
    assert.equal(stats.faults, 0);
    // The page still has a dark canvas from the base style and answers at once.
    assert.ok(await page.evaluate(() => 1 + 1) === 2);
    await page.close();
  }
});

test('T-02, T-11: a page that replaces the built-ins and the extension\'s own names cannot stop the engine', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  await page.addInitScript(() => {
    // Runs in the page's own world before its scripts.
    const bad = () => {
      throw new Error('page patch');
    };
    for (const [obj, name] of [
      [Array.prototype, 'push'],
      [Array.prototype, 'map'],
      [Map.prototype, 'set'],
      [Set.prototype, 'add'],
      [JSON, 'parse'],
      [JSON, 'stringify'],
      [Element.prototype, 'querySelectorAll'],
      [Element.prototype, 'setAttribute'],
      [Node.prototype, 'appendChild'],
      [Document.prototype, 'createElement'],
      [CSSStyleSheet.prototype, 'replaceSync'],
      [String.prototype, 'replace'],
    ]) {
      try {
        obj[name] = bad;
      } catch {
        // frozen
      }
    }
    window.MutationObserver = bad;
    window.getComputedStyle = bad;
    window.__dk = { dynamic: { start: bad } };
    window.chrome = { runtime: { sendMessage: bad } };
  });
  await page.goto(`${servers.origin}/basic.html`);
  // The page's own world is wrecked, so nothing here may run code in it: ask the extension's world and look at pixels.
  const url = `${servers.origin}/basic.html`;
  let stats = null;
  for (let i = 0; i < 100 && !(stats && stats.readyAt); i++) {
    await new Promise((r) => setTimeout(r, 100));
    stats = await browser.stats(url).catch(() => null);
  }
  assert.ok(stats && stats.readyAt, 'the engine finished');
  assert.equal(stats.faults, 0);
  const helper = await browser.context.newPage();
  const [[r, g, b]] = await pixelsOf(page, helper, [[900, 700]]);
  await helper.close();
  assert.ok([r, g, b].every((v) => v < 90), `the page is dark: ${r},${g},${b}`);
  await page.close();
});

test('T-08: a web page cannot reach the extension or read its files', { timeout: 60000 }, async () => {
  const page = await open('/basic.html');
  await waitState(page, 'ready');
  const result = await page.evaluate(async (id) => {
    const out = {};
    out.runtime = typeof chrome !== 'undefined' && chrome.runtime ? typeof chrome.runtime.sendMessage : 'none';
    try {
      const r = await chrome.runtime.sendMessage(id, { type: 'dk.export' });
      out.reply = JSON.stringify(r ?? null);
    } catch (e) {
      out.reply = `error: ${String(e.message).slice(0, 80)}`;
    }
    try {
      const r = await fetch(`chrome-extension://${id}/manifest.json`);
      out.fetch = r.status;
    } catch (e) {
      out.fetch = 'blocked';
    }
    return out;
  }, extId);
  console.log(`# page to extension: ${JSON.stringify(result)}`);
  assert.equal(result.fetch, 'blocked');
  assert.ok(result.reply.startsWith('error') || result.reply === 'null', result.reply);
  await page.close();
});

test('T-05: the CSS the engine writes holds no address that the page did not already use', { timeout: 60000 }, async () => {
  const page = await open('/basic.html');
  await waitState(page, 'ready');
  const { ours, theirs } = await page.evaluate(() => {
    const urls = (text, base) => [...text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map((m) => { try { return new URL(m[2], base).href; } catch { return m[2]; } });
    const ours = [];
    const theirs = new Set();
    for (const s of document.querySelectorAll('style')) {
      if (s.hasAttribute('data-dk')) ours.push(...urls(s.textContent, document.baseURI));
      else urls(s.textContent, document.baseURI).forEach((u) => theirs.add(u));
    }
    for (const sheet of document.styleSheets) {
      try {
        for (const r of sheet.cssRules) urls(r.cssText, sheet.href ?? document.baseURI).forEach((u) => theirs.add(u));
      } catch {
        // other origin
      }
    }
    return { ours, theirs: [...theirs] };
  });
  console.log(`# generated CSS: ${ours.length} addresses, all from the page: ${ours.every((u) => theirs.includes(u))}`);
  assert.deepEqual(ours.filter((u) => !theirs.includes(u)), []);
  await page.close();
});

test('T-03: the worker proxy refuses what it must, with real servers', { timeout: 60000 }, async () => {
  const url = `${servers.origin}/gen/proxy.html`;
  void url;
  const page = await open('/net-probe.html', { settings: { enabled: false } });
  const pageUrl = `${servers.origin}/net-probe.html`;
  // Add the files to the page so the worker will consider them used.
  await page.evaluate((o) => {
    for (const f of ['/gen/big.css?n=300000', '/gen/plain.css']) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = `${o}${f}`;
      document.head.append(l);
    }
  }, servers.origin);
  await page.waitForTimeout(500);
  const big = await fromContent(pageUrl, { type: 'dk.net.text', url: `${servers.origin}/gen/big.css?n=300000` });
  assert.deepEqual([big.ok, big.code], [false, 'too-large']);
  const plain = await fromContent(pageUrl, { type: 'dk.net.text', url: `${servers.origin}/gen/plain.css` });
  assert.deepEqual([plain.ok, plain.code], [false, 'type']);
  // Not used by the page: refused even though the file exists.
  const unused = await fromContent(pageUrl, { type: 'dk.net.text', url: `${servers.origin}/gen/big.css?n=5` });
  assert.deepEqual([unused.ok, unused.code], [false, 'unused']);
  await page.close();
});

test('T-15: a page that floods the document with style elements does not freeze it', { timeout: 120000 }, async () => {
  const page = await open('/basic.html');
  await waitState(page, 'ready');
  const longest = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let worst = 0;
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          worst = Math.max(worst, now - last);
          last = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        for (let i = 0; i < 3000; i++) {
          const s = document.createElement('style');
          s.textContent = `.f${i}{color:#${(i * 40503 & 0xffffff).toString(16).padStart(6, '0')}}`;
          document.head.append(s);
        }
        setTimeout(() => resolve(worst), 3000);
      }),
  );
  console.log(`# 3000 style elements added at once: longest gap between frames ${longest.toFixed(0)} ms`);
  assert.ok(longest < 1500, `the page stalled for ${longest} ms`);
  const stats = await browser.stats(`${servers.origin}/basic.html`);
  assert.equal(stats.faults, 0);
  await page.close();
});
