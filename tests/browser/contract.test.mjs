import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';
import { frameProbed, pageStatus } from '../helpers/gate.mjs';

let servers;
let browser;
let host;
let otherHost;

before(async () => {
  servers = await startServers();
  browser = await launch();
  host = new URL(servers.origin).host;
  otherHost = new URL(servers.other).host;
});

after(async () => {
  await browser?.close();
  await servers?.close();
});

const ON = { settings: { enabled: true } };

const luminance = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};

async function open(path, storage = ON, state = 'ready') {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  if (state) await waitState(page, state, 30000);
  return page;
}

const read = (page, id, prop) => page.evaluate(([i, p]) => getComputedStyle(document.getElementById(i)).getPropertyValue(p), [id, prop]);
const nodes = (page) => page.evaluate(() => document.querySelectorAll('[data-dk], [data-dk-state]').length);

/* ---------- editors and the clipboard ---------- */

test('no marker is written inside an editable area; elsewhere inline colors are still themed', { timeout: 60000 }, async () => {
  const page = await open('/editable.html');
  // The inline pass has run when the themed elements carry their marker; only then is "no marker" a claim about the editors.
  await page.waitForFunction(() => ['s4', 'out'].every((id) => document.getElementById(id).hasAttribute('data-dk-i')), undefined, { timeout: 15000 });
  const marker = (id) => page.evaluate((i) => document.getElementById(i).hasAttribute('data-dk-i'), id);
  assert.equal(await marker('s1'), false, 'a span in a contenteditable');
  assert.equal(await marker('s2'), false, 'a nested element in a contenteditable');
  assert.equal(await marker('s3'), false, 'a span in a rich text editor');
  assert.equal(await marker('s4'), true, 'contenteditable=false is not an editor');
  assert.equal(await marker('out'), true, 'text outside any editor');
  // What an editor would save holds nothing of ours.
  const saved = await page.evaluate(() => document.getElementById('ed').innerHTML + document.getElementById('pm').innerHTML);
  assert.doesNotMatch(saved, /data-dk/);
  assert.equal((await browser.stats(page.url())).skippedEditable >= 3, true);
  // A marker made before the area became editable is taken off.
  await page.evaluate(() => {
    const el = document.getElementById('s4');
    el.parentElement.setAttribute('contenteditable', 'true');
    el.setAttribute('style', 'color:#339');
  });
  await page.waitForFunction(() => !document.getElementById('s4').hasAttribute('data-dk-i'), undefined, { timeout: 5000 });
  await page.close();
});

test('copied text carries the colors of the page, not the theme, and the theme is back at once', { timeout: 60000 }, async () => {
  const page = await open('/copy.html');
  await page.waitForTimeout(500);
  assert.ok(luminance(await read(page, 'para', 'background-color')) < 0.3, 'the theme is on');
  await page.bringToFront();
  await page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('para'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.keyboard.press('Control+c');
  await page.waitForFunction(() => window.copied.length >= 1, undefined, { timeout: 5000 });
  const seen = await page.evaluate(() => window.copied[0]);
  assert.equal(seen.para[0], 'rgb(255, 255, 255)', 'background of the selected text while it is copied');
  assert.equal(seen.para[1], 'rgb(17, 17, 17)');
  assert.equal(seen.inl[0], 'rgb(255, 255, 255)', 'an inline style too');
  // The next task: dark again, with every sheet switched on.
  await page.waitForTimeout(200);
  assert.ok(luminance(await read(page, 'para', 'background-color')) < 0.3);
  assert.ok(luminance(await read(page, 'inl', 'background-color')) < 0.3);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('style[data-dk]')].filter((s) => s.disabled).length), 0);
  await page.close();
});

/* ---------- the author's opt-out ---------- */

test('a meta tag or a root attribute turns the theme off for that page', { timeout: 60000 }, async () => {
  for (const path of ['/opt-out-meta.html', '/opt-out-attr.html']) {
    const page = await open(path, ON, null);
    await page.waitForLoadState('load');
    assert.equal(await pageStatus(browser, page.url(), { want: ['site-off'] }), 'site-off', `${path}: the gate saw the opt-out`);
    assert.equal(await nodes(page), 0, path);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.ok(luminance(bg) > 0.9, `${path}: ${bg}`);
    await page.close();
  }
});

test('the opt-out can come after the load, can be taken back, and is overruled by a site the person turned on', { timeout: 90000 }, async () => {
  const page = await open('/opt-out-late.html');
  await page.evaluate(() => window.optOut());
  await waitState(page, null, 10000);
  assert.equal(await nodes(page), 0);
  await page.evaluate(() => window.optIn());
  await waitState(page, 'ready', 15000);
  await page.close();

  const forced = await open('/opt-out-meta.html', { settings: { enabled: true }, siteRules: { [host]: { enabled: true } } });
  assert.ok(luminance(await forced.evaluate(() => getComputedStyle(document.body).backgroundColor)) < 0.3);
  await forced.close();
});

/* ---------- every engine puts its own nodes back ---------- */

const owned = (page, selector) => page.waitForFunction((s) => document.querySelector(s) !== null, selector, { timeout: 8000 });

test('the Filter engines put their style and their filter definitions back', { timeout: 90000 }, async () => {
  const filter = await open('/basic.html', { settings: { enabled: true, engine: 'filter' } });
  await filter.evaluate(() => document.head.replaceChildren());
  await owned(filter, 'style[data-dk="filter"]');
  assert.match(await filter.evaluate(() => getComputedStyle(document.documentElement).filter), /invert/);
  await filter.close();

  const plus = await open('/basic.html', { settings: { enabled: true, engine: 'filterPlus' } });
  await plus.evaluate(() => {
    document.querySelector('svg[data-dk="filter-defs"]')?.remove();
    document.querySelector('style[data-dk="filter"]')?.remove();
  });
  await owned(plus, 'svg[data-dk="filter-defs"]');
  await owned(plus, 'style[data-dk="filter"]');
  assert.ok((await browser.stats(plus.url())).restored >= 2);
  await plus.close();
});

test('the Static engine, the image rules and the custom CSS come back too', { timeout: 90000 }, async () => {
  const stat = await open('/basic.html', { settings: { enabled: true }, userFixes: { [host]: { engine: 'static', static: { bg: ['main'] } } } });
  await stat.evaluate(() => document.querySelector('style[data-dk="static"]').remove());
  await owned(stat, 'style[data-dk="static"]');
  await stat.close();

  const page = await open('/basic.html', { settings: { enabled: true, theme: { css: 'h1 { margin-top: 13px; }' } } });
  await owned(page, 'style[data-dk="images"]');
  await page.evaluate(() => {
    document.querySelector('style[data-dk="images"]').remove();
    document.querySelector('style[data-dk="css"]').remove();
  });
  await owned(page, 'style[data-dk="images"]');
  await owned(page, 'style[data-dk="css"]');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).marginTop), '13px');
  await page.close();
});

test('a page that keeps removing the Filter style is given up on, with no loop', { timeout: 60000 }, async () => {
  const page = await open('/basic.html', { settings: { enabled: true, engine: 'filter' } });
  await page.evaluate(() => {
    window.__fight = setInterval(() => document.querySelectorAll('style[data-dk]').forEach((n) => n.remove()), 40);
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => clearInterval(window.__fight));
  const fought = await browser.stats(page.url());
  assert.ok(fought.restored >= 1 && fought.restored <= 9, `restored ${fought.restored}`);
  // After the quiet window one removal is put back again.
  await page.waitForTimeout(2300);
  await page.evaluate(() => {
    // Any removal in the head makes the engine look again; the page is quiet now, so the style comes back.
    const probe = document.head.appendChild(document.createElement('meta'));
    probe.remove();
  });
  await owned(page, 'style[data-dk="filter"]');
  await page.close();
});

/* ---------- addresses of sheets to skip ---------- */

test('a fix can name style sheets to skip by address, and the common font hosts are skipped', { timeout: 90000 }, async () => {
  const hash = `#${servers.other}`;
  const base = await open(`/cross-sheets.html${hash}`);
  await base.waitForFunction(() => document.querySelectorAll('style[data-dk="sheet"]').length >= 2, undefined, { timeout: 15000 });
  const all = await browser.stats(base.url().split('#')[0]);
  assert.equal(all.skippedUrls, 0);
  assert.ok(all.fetched >= 2, JSON.stringify(all));
  await base.close();

  const skip = await open(`/cross-sheets.html${hash}`, { ...ON, userFixes: { [host]: { dynamic: { ignoreCssUrl: ['/css/imported.css', '*/nothing-here/*'] } } } });
  await skip.waitForTimeout(800);
  const some = await browser.stats(skip.url().split('#')[0]);
  assert.ok(some.skippedUrls >= 1, JSON.stringify(some));
  assert.equal(some.fetched, all.fetched - 1);
  // The other sheet is themed as before; the skipped one is left as the page wrote it.
  const themed = await skip.evaluate(() => getComputedStyle(document.querySelector('.linked-note')).backgroundColor);
  assert.ok(luminance(themed) < 0.3, themed);
  const left = await skip.evaluate(() => getComputedStyle(document.querySelector('.imported-note')).backgroundColor);
  assert.ok(luminance(left) > 0.6, left);
  await skip.close();

  // A font provider's sheet is never read or fetched. The network is blocked for the test.
  await browser.clearStorage();
  await browser.setStorage(ON);
  await browser.context.route('https://fonts.googleapis.com/**', (route) => route.abort());
  const fonts = await browser.context.newPage();
  await fonts.goto(`${servers.origin}/basic.html`);
  await waitState(fonts, 'ready');
  await fonts.evaluate(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Roboto';
    document.head.append(link);
  });
  await fonts.waitForTimeout(800);
  assert.equal((await browser.stats(fonts.url())).skippedUrls >= 1, true);
  await browser.context.unroute('https://fonts.googleapis.com/**');
  await fonts.close();
});

/* ---------- a page that claims to be dark but is not ---------- */

test('a fix can say a page is not dark: it is themed although its colors say dark; the person\'s own dark list still wins', { timeout: 90000 }, async () => {
  const plain = await open('/detect/dark-css.html', ON, null);
  await plain.waitForLoadState('load');
  await pageStatus(browser, plain.url(), { want: ['dark-detected'] });
  assert.equal(await nodes(plain), 0, 'a dark page is left alone');
  await plain.close();

  const fixed = await open('/detect/dark-css.html', { ...ON, userFixes: { [host]: { notDark: true } } }, null);
  await fixed.waitForLoadState('load');
  await waitState(fixed, 'ready', 15000);
  await fixed.close();

  const listed = await open('/detect/light-white.html', { ...ON, userFixes: { [host]: { notDark: true } }, darkSites: { add: [host], remove: [] } }, null);
  await listed.waitForLoadState('load');
  await pageStatus(browser, listed.url(), { want: ['dark-detected'] });
  assert.equal(await nodes(listed), 0, 'the person said this site is dark');
  await listed.close();
});

test('detection and the fix of a frame follow the address of the frame, not of the page around it', { timeout: 90000 }, async () => {
  const frameOf = async (page) => (await page.$('#inner')).contentFrame();
  const left = await open(`/frame-dark.html#${servers.other}`, ON);
  const inner = await frameOf(left);
  await inner.waitForLoadState('load');
  // Only the top frame reports a status; the signal for the frame is that detection ran there. The verdict then removes the first themed look.
  await frameProbed(browser, left.url(), '/detect/dark-css.html');
  await inner.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 15000 });
  assert.equal(await inner.evaluate(() => document.documentElement.hasAttribute('data-dk-state')), false, 'a dark frame is left alone');
  await left.close();

  const fixed = await open(`/frame-dark.html#${servers.other}`, { ...ON, userFixes: { [otherHost]: { notDark: true } } });
  const frame = await frameOf(fixed);
  await frame.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', undefined, { timeout: 15000 });
  await fixed.close();
});

/* ---------- no decision on every tab show ---------- */

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const plus = (minutes) => new Date(Date.now() + minutes * 60000);

test('showing the tab again reads nothing, unless the schedule has passed its next change', { timeout: 90000 }, async () => {
  const page = await open('/basic.html', {
    settings: { enabled: true, automation: { mode: 'time', behavior: 'scheme', time: { from: hhmm(plus(-120)), to: hhmm(plus(120)) }, location: { lat: null, lon: null } } },
  });
  const spy = () =>
    browser.worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          const g = /** @type {any} */ (globalThis);
          g.__reads = 0;
          if (!g.__spied) {
            g.__spied = true;
            const area = chrome.storage.local;
            const original = area.get.bind(area);
            area.get = (...args) => {
              g.__reads += 1;
              return original(...args);
            };
          }
        },
      });
    }, `${servers.origin}/basic.html`);
  const reads = () =>
    browser.worker.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => /** @type {any} */ (globalThis).__reads });
      return r.result;
    }, `${servers.origin}/basic.html`);
  const lightness = () =>
    page.evaluate(() => {
      const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    });
  const shift = (hours) =>
    browser.worker.evaluate(async ([u, h]) => {
      const [tab] = await chrome.tabs.query({ url: u });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: (hh) => {
          const g = /** @type {any} */ (globalThis);
          const Real = (g.__RealDate ??= Date);
          const offset = hh * 3_600_000;
          // The page asks the clock through Date.now and through new Date().
          g.Date = class extends Real {
            constructor(...args) {
              if (args.length === 0) super(Real.now() + offset);
              else super(...args);
            }
            static now() {
              return Real.now() + offset;
            }
          };
        },
        args: [h],
      });
    }, [`${servers.origin}/basic.html`, hours]);

  await spy();
  for (let i = 0; i < 5; i++) await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(500);
  assert.equal(await reads(), 0, 'five tab shows read the storage 0 times');
  assert.ok((await lightness()) < 0.4, 'inside the window the page stays dark');
  // The clock moves past the next change of the schedule: the next show decides again.
  await shift(6);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // The decision runs from the data the page holds, so the proof is the new look.
  await page.waitForFunction(
    () => {
      const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6;
    },
    null,
    { timeout: 10000 },
  );
  await page.close();
});
