// A page that declares one scheme only (`color-scheme: only light` or `only dark`, in CSS or in the meta tag) is left alone
// when the choice would fight it, unless the person turned the site on by hand or switched the respect off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, cpuThrottle, paintedLightness, SLOW } from './harness.mjs';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODES = {
  dark: { mode: 'dark' },
  light: { mode: 'light' },
  paper: { mode: 'eink', einkPreset: 'paper' },
  eink: { mode: 'eink', einkPreset: 'eink' },
};
const WHITE = 'rgb(255, 255, 255)';
const bgOf = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const hasEngine = (page) => page.evaluate(() => document.querySelectorAll('style[data-dk]').length + (document.documentElement.hasAttribute('data-dk-state') ? 1 : 0));

/** Open a fixture. A page the engine leaves alone never says `ready`, so the wait is for the load and a short quiet time. */
async function open(path, mode = 'dark', extra = {}, rules = undefined) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { ...MODES[mode] }, ...extra }, ...(rules ? { siteRules: rules } : {}) });
  const page = await browser.context.newPage();
  await page.bringToFront();
  // Count the frames the page asks for. Whether a dark frame was painted is told by the frame captures below: a script that reads the
  // styles in a callback also sees frames that the browser never paints (it paints nothing while the page is held back or has no body).
  await page.addInitScript(() => {
    window.__frames = { n: 0 };
    const tick = () => {
      window.__frames.n++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(`${servers.origin}${path}`);
  await page.waitForLoadState('load');
  await sleep(900);
  return page;
}

const PLAIN_LIGHT = ['/scheme-only-light-css.html', '/scheme-only-light-meta.html', '/scheme-only-light-body.html', '/scheme-only-light-linked.html'];

for (const path of PLAIN_LIGHT) {
  test(`${path}: a page that says only light is left as the page wrote it in the dark mode`, { timeout: 60000 }, async () => {
    const page = await open(path);
    assert.equal(await bgOf(page), WHITE);
    assert.equal(await hasEngine(page), 0, 'no engine element and no state on the root');
    const frames = await page.evaluate(() => window.__frames);
    assert.ok(frames.n > 3, `only ${frames.n} frames watched`);
    await page.close();
  });
}

// The frames the screen gets, not the styles a script can read. The frames that come before the first frame of the page's main
// thread show only the canvas color of the first-paint style; they are left out, found by the time of the first animation
// frame of the page.
const FRAME_PATHS = PLAIN_LIGHT.slice(0, 2);
async function paintedFrames(settings, rules, rate, path) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' }, ...settings }, ...(rules ? { siteRules: rules } : {}) });
  // The worker registers the first-paint styles after the change; the page must load after that.
  const wantMarker = settings.respectOnlyLight !== false;
  for (let i = 0; i < 100; i++) {
    const ids = await browser.worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
    if (ids.includes('dk-early') && ids.includes('dk-early-respect') === wantMarker) break;
    await sleep(100);
  }
  const helper = await browser.context.newPage();
  await helper.goto(`${servers.origin}/gen/blank.html`);
  const page = await browser.context.newPage();
  await cpuThrottle(page, rate);
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      window.__firstFrameAt = performance.timeOrigin + performance.now();
    });
  });
  const times = [];
  const frames = await paintedLightness(
    page,
    helper,
    async () => {
      await page.goto(`${servers.origin}${path}`);
      await page.waitForLoadState('load');
    },
    { times },
  );
  const firstFrameAt = await page.evaluate(() => window.__firstFrameAt);
  assert.ok(Number.isFinite(firstFrameAt), `${path}: the page had no animation frame`);
  const painted = frames.filter((_, i) => times[i] >= firstFrameAt - 5);
  assert.ok(painted.length > 0, `${path}: no frame was painted by the page`);
  const note = frames.map((f, i) => `${f.toFixed(2)}@${Math.round(times[i] - firstFrameAt)}`).join(' ');
  await page.close();
  await helper.close();
  return { painted, note };
}

for (const rate of [1, 4, 6]) {
  test(`a page that says only light is never painted dark after the page's first frame, main thread ${rate} times slower`, { timeout: 180000 }, async () => {
    for (const path of PLAIN_LIGHT) {
      const { painted, note } = await paintedFrames({}, null, rate, path);
      assert.ok(Math.min(...painted) > 0.5, `${path}: a dark frame was painted: ${note}`);
    }
  });
}

// The settings are not read yet when the page says its scheme: the page is held until they are, not released as if they said "respect".
for (const rate of [1, 4]) {
  test(`with the respect turned off an only light page is never painted light after the page's first frame, main thread ${rate} times slower`, { timeout: 180000 }, async () => {
    for (const path of FRAME_PATHS) {
      const { painted, note } = await paintedFrames({ respectOnlyLight: false }, null, rate, path);
      assert.ok(Math.max(...painted) < 0.5, `${path}: a light frame was painted: ${note}`);
    }
  });
  test(`a site turned on by hand is never painted light on an only light page after the page's first frame, main thread ${rate} times slower`, { timeout: 180000 }, async () => {
    const host = new URL(servers.origin).host;
    for (const path of FRAME_PATHS) {
      const { painted, note } = await paintedFrames({}, { [host]: { enabled: true } }, rate, path);
      assert.ok(Math.max(...painted) < 0.5, `${path}: a light frame was painted: ${note}`);
    }
  });
}

test('light dark without only is themed as every page', { timeout: 60000 }, async () => {
  const page = await open('/scheme-light-dark.html');
  await waitState(page, 'ready');
  assert.notEqual(await bgOf(page), WHITE);
  await page.close();
});

test('only light on a widget does not make the page keep its colors', { timeout: 60000 }, async () => {
  const page = await open('/scheme-only-light-widget.html');
  await waitState(page, 'ready');
  assert.notEqual(await bgOf(page), WHITE);
  await page.close();
});

test('the other modes theme an only light page, because the page is light anyway', { timeout: 120000 }, async () => {
  for (const mode of ['light', 'paper', 'eink']) {
    for (const path of ['/scheme-only-light-css.html', '/scheme-only-light-meta.html']) {
      const page = await open(path, mode);
      await waitState(page, 'ready');
      const bg = await bgOf(page);
      assert.notEqual(bg, 'rgb(0, 0, 0)');
      if (mode === 'light') assert.notEqual(bg, WHITE, `${mode} ${path} must show the light page color`);
      await page.close();
    }
  }
});

test('an only dark page is left alone in every mode', { timeout: 120000 }, async () => {
  for (const mode of ['dark', 'light', 'paper', 'eink']) {
    const meta = await open('/scheme-only-dark-meta.html', mode);
    assert.equal(await bgOf(meta), WHITE, `${mode}: meta`);
    assert.equal(await hasEngine(meta), 0, `${mode}: meta, engine`);
    await meta.close();
    const css = await open('/scheme-only-dark-css.html', mode);
    assert.equal(await bgOf(css), 'rgb(16, 20, 24)', `${mode}: css`);
    assert.equal(await hasEngine(css), 0, `${mode}: css, engine`);
    await css.close();
  }
});

test('a site the person turned on by hand is themed whatever the page says', { timeout: 60000 }, async () => {
  const host = new URL(servers.origin).host;
  for (const path of ['/scheme-only-light-css.html', '/scheme-only-light-meta.html']) {
    const page = await open(path, 'dark', {}, { [host]: { enabled: true } });
    await waitState(page, 'ready');
    assert.notEqual(await bgOf(page), WHITE, path);
    await page.close();
  }
  const dark = await open('/scheme-only-dark-meta.html', 'light', {}, { [host]: { enabled: true } });
  await waitState(dark, 'ready');
  assert.notEqual(await bgOf(dark), WHITE);
  await dark.close();
});

test('with the respect turned off in the settings the page is themed', { timeout: 60000 }, async () => {
  for (const path of ['/scheme-only-light-css.html', '/scheme-only-light-meta.html']) {
    const page = await open(path, 'dark', { respectOnlyLight: false });
    await waitState(page, 'ready');
    assert.notEqual(await bgOf(page), WHITE, path);
    await page.close();
  }
});

test('the setting and the mode are followed while the page is open', { timeout: 90000 }, async () => {
  const page = await open('/scheme-only-light-css.html');
  assert.equal(await bgOf(page), WHITE);
  await browser.setStorage({ settings: { enabled: true, respectOnlyLight: false, theme: { mode: 'dark' } } });
  await waitState(page, 'ready');
  assert.notEqual(await bgOf(page), WHITE);
  await browser.setStorage({ settings: { enabled: true, respectOnlyLight: true, theme: { mode: 'dark' } } });
  await waitState(page, null);
  assert.equal(await bgOf(page), WHITE);
  // The light mode themes it (the page is light anyway), and the dark mode leaves it alone again.
  await sleep(500);
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'light' } } });
  await waitState(page, 'ready');
  assert.notEqual(await bgOf(page), WHITE);
  await sleep(500);
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  await waitState(page, null);
  assert.equal(await bgOf(page), WHITE);
  await page.close();
});

test('a meta tag added by script after the load makes the page keep its colors', { timeout: 60000 }, async () => {
  const page = await open('/scheme-light-dark.html');
  await waitState(page, 'ready');
  await page.evaluate(() => {
    document.querySelector('meta[name="color-scheme"]').setAttribute('content', 'only light');
    document.documentElement.style.setProperty('color-scheme', 'only light');
  });
  await waitState(page, null);
  assert.equal(await bgOf(page), WHITE);
  await page.close();
});

test('the popup says the page keeps its own colors', { timeout: 60000 }, async () => {
  const web = await open('/scheme-only-light-meta.html');
  const popup = await browser.context.newPage();
  await web.bringToFront();
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  await popup.waitForFunction(() => document.getElementById('status').textContent.includes('keep its own colors'), null, { timeout: 8000 });
  assert.equal(await popup.getAttribute('#status-dot', 'data-state'), 'info');
  await popup.close();
  await web.close();
});

test('the settings page has the switch, on by default, and it is saved', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/options/options.html`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  const box = page.locator('[data-setting="respectOnlyLight"]');
  assert.equal(await box.isChecked(), true);
  await box.uncheck();
  await page.waitForTimeout(700);
  const stored = (await browser.worker.evaluate(() => chrome.storage.local.get('settings'))).settings;
  assert.equal(stored.respectOnlyLight, false);
  await page.close();
});

// A script of the page can watch the root. The release of the first-paint hold is one attribute that is added once. The reads of
// the page's own styles during the hold switch the hold sheet off and on again, which leaves no record in the document.
test('a script of the page that watches every attribute sees the release once and nothing else', { timeout: 90000 }, async () => {
  for (const path of ['/scheme-light-dark.html', '/scheme-only-light-css.html', '/scheme-only-light-linked.html']) {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
    const page = await browser.context.newPage();
    await page.addInitScript(() => {
      window.__rootFlips = [];
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.attributeName === 'data-dk-go') window.__rootFlips.push(r.oldValue === null ? 'add' : r.target.hasAttribute('data-dk-go') ? 'set' : 'drop');
          else if (r.target === document.documentElement && r.attributeName !== 'data-dk-state') window.__rootFlips.push('other:' + r.attributeName);
        }
      }).observe(document, { attributes: true, subtree: true, attributeOldValue: true });
    });
    await page.goto(`${servers.origin}${path}`);
    await page.waitForLoadState('load');
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-dk-go'), null, { timeout: 15000 * SLOW });
    await sleep(900);
    await page.evaluate(() => {
      document.body.style.margin = '1px';
    });
    await sleep(300);
    const flips = await page.evaluate(() => window.__rootFlips);
    await page.close();
    assert.deepEqual(flips, ['add'], path);
  }
});

test('the hold leaves nothing in the document after the release, and a page that replaces its adopted sheets does not break it', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const plain = await browser.context.newPage();
  await plain.goto(`${servers.origin}/scheme-light-dark.html`);
  await waitState(plain, 'ready');
  assert.equal(await plain.evaluate(() => document.adoptedStyleSheets.length), 0, 'the hold sheet is taken out at the release');
  await plain.close();

  const page = await browser.context.newPage();
  await page.addInitScript(() => {
    // A page that owns the list: it replaces whatever is in it, once the document is there, and adopts a sheet of its own.
    document.addEventListener('DOMContentLoaded', () => {
      const mine = new CSSStyleSheet();
      mine.replaceSync('p{outline:2px solid rgb(1, 2, 3)}');
      window.__mine = mine;
      document.adoptedStyleSheets = [mine];
    });
  });
  await page.goto(`${servers.origin}/scheme-light-dark.html`);
  await waitState(page, 'ready');
  const seen = await page.evaluate(() => ({
    own: document.adoptedStyleSheets.includes(window.__mine),
    outline: getComputedStyle(document.querySelector('p') ?? document.body).outlineWidth,
    go: document.documentElement.hasAttribute('data-dk-go'),
    body: getComputedStyle(document.body).backgroundColor,
  }));
  await page.close();
  assert.equal(seen.own, true, 'the sheet of the page stays');
  assert.equal(seen.go, true);
  assert.notEqual(seen.body, 'rgb(255, 255, 255)', 'the page is themed');
});
