// The optional engine modules are not in the manifest list. The page script asks the worker for the ones it needs
// (`dk.inject`). A page that is off loads none; a refused request leaves the page usable; the worker checks every request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

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

const OPTIONAL = ['images', 'backdrop', 'calm', 'extras', 'readability', 'filter', 'staticEngine', 'detect'];

/** The names in the namespace and the loader's counters, for every frame of the tab that shows `url`. */
const frames = (url) =>
  browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'ISOLATED',
      func: () => JSON.stringify({ keys: Object.keys(globalThis.__dk ?? {}), stats: globalThis.__dk?.optional?.stats() ?? null }),
    });
    return out.map((r) => JSON.parse(r.result));
  }, url);

async function open(path, settings) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, ...settings } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  return { page, url: `${servers.origin}${path}` };
}

const until = async (check, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('a page where the extension is off has no script of ours at all, so it loads no optional module and asks for none', { timeout: 60000 }, async () => {
  const { page, url } = await open('/dynamic.html', { enabled: false });
  await page.waitForTimeout(800);
  const [top] = await frames(url);
  for (const name of OPTIONAL) assert.ok(!top.keys.includes(name), name);
  assert.deepEqual(top.keys, [], 'the engine files are registered only for the pages that can be on');
  assert.equal(top.stats, null);
  await page.close();
});

test('a dark theme on a page loads the pictures, the net and the probe, and not the other engines or the E-ink rules', { timeout: 60000 }, async () => {
  const { page, url } = await open('/dynamic.html', {});
  await waitState(page, 'ready', 30000);
  const top = await until(async () => {
    const [f] = await frames(url);
    return f.keys.includes('images') && f.keys.includes('readability') && f.keys.includes('detect') ? f : null;
  });
  for (const name of ['filter', 'staticEngine', 'calm', 'extras']) assert.ok(!top.keys.includes(name), name);
  assert.equal(top.stats.failed, 0);
  await page.close();
});

test('the Filter engine loads its own module and no picture module', { timeout: 60000 }, async () => {
  const { page, url } = await open('/filter-base.html', { engine: 'filter' });
  await waitState(page, 'ready', 30000);
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="filter"]'), null, { timeout: 10000 });
  const [top] = await frames(url);
  assert.ok(top.keys.includes('filter'));
  for (const name of ['images', 'staticEngine', 'calm']) assert.ok(!top.keys.includes(name), name);
  await page.close();
});

test('the E-ink and Paper mode loads the calm rules before the page is ready, and the extras only when a setting needs them', { timeout: 60000 }, async () => {
  const { page, url } = await open('/eink-book.html', { theme: { mode: 'eink', einkPreset: 'paper' } });
  await waitState(page, 'ready', 30000);
  assert.equal(await page.evaluate(() => !!document.querySelector('style[data-dk="calm"]')), true, 'the rules are there when the page is ready');
  const [top] = await frames(url);
  assert.ok(top.keys.includes('calm'));
  assert.ok(!top.keys.includes('extras'));
  await page.close();
  const font = await open('/extras.html', { theme: { fontEnabled: true, fontFamily: 'Verdana' } });
  await waitState(font.page, 'ready', 30000);
  assert.equal(await font.page.evaluate(() => !!document.querySelector('style[data-dk="extras"]')), true, 'the extras are there when the page is ready');
  const [t2] = await frames(font.url);
  assert.ok(t2.keys.includes('extras') && t2.keys.includes('calm'));
  await font.page.close();
});

test('a frame loads its own modules', { timeout: 60000 }, async () => {
  const { page, url } = await open('/frame.html', {});
  await waitState(page, 'ready', 30000);
  await until(async () => (await frames(url)).filter((f) => f.keys.includes('images')).length >= 2);
  await page.close();
});

test('a refused injection is counted and the page is left usable, not hidden', { timeout: 60000 }, async () => {
  const worked = await browser.worker.evaluate(() => {
    try {
      globalThis.__saved = chrome.scripting.executeScript;
      chrome.scripting.executeScript = async () => {
        throw new Error('refused');
      };
      return chrome.scripting.executeScript !== globalThis.__saved;
    } catch {
      return false;
    }
  });
  if (!worked) return;
  try {
    const { page, url } = await open('/filter-base.html', { engine: 'filter' });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-dk-go'), null, { timeout: 10000 });
    await page.waitForTimeout(500);
  } finally {
    await browser.worker.evaluate(() => {
      chrome.scripting.executeScript = globalThis.__saved;
    });
  }
  {
    // Back to normal: the counters of the page say the request failed, and the engine is not there.
    const url = `${servers.origin}/filter-base.html`;
    const page = browser.context.pages().find((p) => p.url() === url);
    assert.ok(page);
    const [top] = await frames(url);
    assert.ok(top.stats.failed >= 1, JSON.stringify(top.stats));
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-dk-go')), true);
    assert.ok(!top.keys.includes('filter'));
    assert.ok(top.keys.includes('dynamic'));
    await page.close();
  }
});

test('the worker refuses names that are not on its list and limits the requests of a frame', { timeout: 60000 }, async () => {
  const { page, url } = await open('/dynamic.html', { enabled: false });
  await page.waitForTimeout(500);
  const replies = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: async () => {
        const out = [];
        for (const module of ['nope', 'content/engine/images.js', '../x', '', 'constructor']) out.push((await chrome.runtime.sendMessage({ type: 'dk.inject', module })).code);
        const codes = [];
        for (let i = 0; i < 40; i++) codes.push((await chrome.runtime.sendMessage({ type: 'dk.inject', module: 'readability' })).code ?? 'ok');
        out.push(codes);
        return JSON.stringify(out);
      },
    });
    return JSON.parse(r.result);
  }, url);
  assert.deepEqual(replies.slice(0, 5), ['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
  const codes = replies[5];
  assert.equal(codes.filter((c) => c === 'ok').length, 24);
  assert.equal(codes.filter((c) => c === 'rate').length, 16);
  await page.close();
});

test('late module replies after the site went off leave the page clean', { timeout: 90000 }, async () => {
  const slowed = await browser.worker.evaluate(() => {
    globalThis.__saved = chrome.scripting.executeScript;
    const real = globalThis.__saved.bind(chrome.scripting);
    chrome.scripting.executeScript = async (...a) => {
      await new Promise((r) => setTimeout(r, 1500));
      return real(...a);
    };
    return chrome.scripting.executeScript !== globalThis.__saved;
  });
  assert.ok(slowed);
  try {
    const residue = () => document.querySelectorAll('style[data-dk], [data-dk-bd], [data-dk-bg]').length + [...document.documentElement.attributes].filter((a) => a.name.startsWith('data-dk') && a.name !== 'data-dk-go').length;
    const { page } = await open('/extras.html', { theme: { fontEnabled: true, fontFamily: 'Verdana', mode: 'eink' } });
    await page.waitForTimeout(300);
    await browser.setStorage({ settings: { enabled: false } });
    await page.waitForTimeout(5000);
    assert.equal(await page.evaluate(residue), 0);
    await page.close();
  } finally {
    await browser.worker.evaluate(() => {
      chrome.scripting.executeScript = globalThis.__saved;
    });
  }
});

test('a module that failed to load is tried again by the next decision', { timeout: 60000 }, async () => {
  await browser.worker.evaluate(() => {
    globalThis.__saved = chrome.scripting.executeScript;
    chrome.scripting.executeScript = async () => {
      throw new Error('refused');
    };
  });
  let url;
  let page;
  try {
    ({ page, url } = await open('/filter-base.html', { engine: 'filter' }));
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-dk-go'), null, { timeout: 10000 });
    await page.waitForTimeout(500);
  } finally {
    await browser.worker.evaluate(() => {
      chrome.scripting.executeScript = globalThis.__saved;
    });
  }
  assert.ok(!(await frames(url))[0].keys.includes('filter'));
  await browser.setStorage({ settings: { enabled: true, engine: 'filter', theme: { brightness: 95 } } });
  await until(async () => (await frames(url))[0].keys.includes('filter'));
  await waitState(page, 'ready');
  await page.close();
});
