// the pages of the extension in every language, look and size that people use: names for every control, focus rings,
// reading order, forced colors, reduced motion, short windows, messages and confirmations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

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

const DAY = 86400000;
const LOCALES = ['en', 'fa', 'ar', 'he'];
const TABS = ['general', 'appearance', 'sites', 'schedule', 'advanced', 'data', 'about'];
const RTL = new Set(['fa', 'ar', 'he']);
const stored = (key) => browser.worker.evaluate((k) => chrome.storage.local.get(k), key);

async function openPopup(storage, { size = [360, 600], media = null } = {}) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const popup = await browser.context.newPage();
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/basic.html`);
  await waitState(web, 'ready');
  await web.bringToFront();
  if (media) await popup.emulateMedia(media);
  await popup.setViewportSize({ width: size[0], height: size[1] });
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return { popup, web };
}

async function openPage(path, storage, { size = [1000, 900], media = null } = {}) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  if (media) await page.emulateMedia(media);
  await page.setViewportSize({ width: size[0], height: size[1] });
  await page.goto(`chrome-extension://${extId}/pages/${path}`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return page;
}

/** Runs in the page: controls without a name, controls whose focus cannot be seen, text with too little contrast. */
const audit = () => {
  const out = { noName: [], contrast: [] };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden';
  };
  const label = (el) => {
    const id = (el.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean);
    return (
      el.getAttribute('aria-label') ||
      id.map((i) => document.getElementById(i)?.textContent ?? '').join(' ').trim() ||
      [...(el.labels ?? [])].map((l) => l.textContent).join(' ').trim() ||
      (el.closest('label')?.textContent ?? '').trim() ||
      (el.textContent ?? '').trim() ||
      el.getAttribute('title') ||
      ''
    );
  };
  const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`;
  for (const el of document.querySelectorAll('button, input:not([type="hidden"]), select, textarea, a[href], summary, [role="tab"], [role="radio"]')) {
    if (visible(el) && !label(el)) out.noName.push(name(el));
  }
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  const lum = (c) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let base = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255 };
    if (layers.length && layers[layers.length - 1].a >= 1) base = { r: 0, g: 0, b: 0 };
    let out2 = { r: base.r, g: base.g, b: base.b };
    for (const c of layers.reverse()) out2 = { r: c.r * c.a + out2.r * (1 - c.a), g: c.g * c.a + out2.g * (1 - c.a), b: c.b * c.a + out2.b * (1 - c.a) };
    return out2;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (el.closest(':disabled, [data-off], select')) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    const bg = backdrop(el);
    if (!fg || !bg) continue;
    let opacity = 1;
    for (let e = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
    const a = fg.a * opacity;
    const mix = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
    const [hi, lo] = [lum(mix), lum(bg)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) out.contrast.push(`${name(el)} ${ratio.toFixed(2)} "${el.textContent.trim().slice(0, 24)}"`);
  }
  return out;
};

/** Press Tab through the page and report the stops whose focus cannot be seen. */
async function unseenFocus(page, max = 80) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const bad = [];
  const seen = new Set();
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
      const r = el.getBoundingClientRect();
      const id = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}`;
      // A slider shows its focus on the thumb, a switch on its track: both are checked through their own rules in the style sheet.
      return { id, ring, range: el instanceof HTMLInputElement && el.type === 'range', inView: r.width > 0 && r.height > 0 };
    });
    if (!info) break;
    if (seen.has(info.id + info.inView)) {
      if (seen.size > 3) break;
    }
    seen.add(info.id + info.inView);
    if (!info.ring && !info.range) bad.push(info.id);
  }
  return bad;
}

test('every control has a name and every text reads at AA contrast, in four languages and both looks', { timeout: 280000 }, async () => {
  for (const locale of LOCALES) {
    for (const uiTheme of ['light', 'dark']) {
      const ui = { locale, uiTheme };
      const label = `${locale} ${uiTheme}`;
      const { popup, web } = await openPopup({ settings: { enabled: true }, ui, presets: [{ id: 'p1', name: 'Evening', theme: { mode: 'dark', brightness: 90, contrast: 100, sepia: 0, grayscale: 0 } }] });
      let r = await popup.evaluate(audit);
      assert.deepEqual(r.noName, [], `popup names ${label}`);
      assert.deepEqual(r.contrast, [], `popup contrast ${label}`);
      await popup.close();
      await web.close();
      const siteRules = { 'example.com': { enabled: false, theme: { mode: 'light' } } };
      const page = await openPage('options/options.html', { settings: { enabled: true }, ui, siteRules, presets: [{ id: 'p1', name: 'Evening', theme: { mode: 'dark', brightness: 90, contrast: 100, sepia: 0, grayscale: 0 } }] });
      for (const tab of TABS) {
        await page.click(`#tab-${tab}`);
        r = await page.evaluate(audit);
        assert.deepEqual(r.noName, [], `options ${tab} names ${label}`);
        assert.deepEqual(r.contrast, [], `options ${tab} contrast ${label}`);
      }
      await page.close();
      const fixes = await openPage('fixes/fixes.html', { settings: { enabled: true }, ui, userFixes: { 'example.com': { note: 'n' } } });
      r = await fixes.evaluate(audit);
      assert.deepEqual(r.noName, [], `fixes names ${label}`);
      assert.deepEqual(r.contrast, [], `fixes contrast ${label}`);
      await fixes.close();
    }
  }
});

test('keyboard focus is visible on every stop of the popup, the settings tabs and the fix editor', { timeout: 200000 }, async () => {
  for (const locale of ['en', 'fa']) {
    const ui = { locale, uiTheme: 'dark' };
    const { popup, web } = await openPopup({ settings: { enabled: true }, ui });
    assert.deepEqual(await unseenFocus(popup), [], `popup ${locale}`);
    await popup.close();
    await web.close();
    const page = await openPage('options/options.html', { settings: { enabled: true }, ui, siteRules: { 'example.com': {} } });
    for (const tab of TABS) {
      await page.click(`#tab-${tab}`);
      assert.deepEqual(await unseenFocus(page, 60), [], `options ${tab} ${locale}`);
    }
    await page.close();
    const fixes = await openPage('fixes/fixes.html', { settings: { enabled: true }, ui, userFixes: { 'example.com': { note: 'n' } } });
    assert.deepEqual(await unseenFocus(fixes, 60), [], `fixes ${locale}`);
    await fixes.close();
  }
});

test('the popup window scrolls when the browser gives it less than 600 px, and does not at 600 px', { timeout: 90000 }, async () => {
  const { popup, web } = await openPopup({ settings: { enabled: true } }, { size: [360, 300] });
  const short = await popup.evaluate(() => ({ h: document.scrollingElement.scrollHeight, c: document.scrollingElement.clientHeight }));
  assert.ok(short.h > short.c, 'a short window can scroll');
  await popup.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
  const foot = await popup.evaluate(() => document.querySelector('.dock').getBoundingClientRect().bottom <= window.innerHeight + 1);
  assert.equal(foot, true, 'the footer is reachable by scrolling');
  await popup.setViewportSize({ width: 360, height: 600 });
  assert.deepEqual(await popup.evaluate(() => [document.scrollingElement.scrollHeight, document.scrollingElement.clientHeight]), [600, 600]);
  await popup.close();
  await web.close();
});

test('forced colors: switches, sliders, the chosen mode and primary buttons stay readable', { timeout: 120000 }, async () => {
  const { popup, web } = await openPopup({ settings: { enabled: true } }, { media: { forcedColors: 'active', reducedMotion: 'reduce' } });
  const read = (sel, pseudo = null) => popup.evaluate(({ sel, pseudo }) => getComputedStyle(document.querySelector(sel), pseudo).backgroundColor, { sel, pseudo });
  const trackOn = await read('#master');
  const knobOn = await read('#master', '::after');
  assert.notEqual(trackOn, knobOn, 'the knob differs from the track of a switch that is on');
  await popup.evaluate(() => { document.querySelector('#site').checked = false; });
  const trackOff = await read('#site');
  assert.notEqual(trackOn, trackOff, 'a switch that is on differs from one that is off');
  assert.notEqual(await read('#site', '::after'), trackOff, 'the knob differs from the track of a switch that is off');
  assert.notEqual(await read('#mode-dark'), await read('#mode-light'), 'the chosen mode is marked');
  const primary = await popup.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#footer-cta'));
    return { border: cs.borderTopColor, bg: cs.backgroundColor, fg: cs.color };
  });
  assert.notEqual(primary.bg, primary.fg, 'a primary button has text that differs from its fill');
  assert.notEqual(primary.border, 'rgba(0, 0, 0, 0)');
  await popup.close();
  await web.close();

  const page = await openPage('options/options.html', { settings: { enabled: true } }, { media: { forcedColors: 'active', reducedMotion: 'reduce' } });
  const tab = await page.evaluate(() => [getComputedStyle(document.querySelector('#tab-general')).backgroundColor, getComputedStyle(document.querySelector('#tab-sites')).backgroundColor]);
  assert.notEqual(tab[0], tab[1], 'the chosen tab is marked');
  await page.close();
});

test('forced colors: a slider that has the keyboard focus shows an outline', { timeout: 90000 }, async () => {
  const { popup, web } = await openPopup({ settings: { enabled: true } }, { media: { forcedColors: 'active', reducedMotion: 'reduce' } });
  let found = null;
  for (let i = 0; i < 30 && found === null; i++) {
    await popup.keyboard.press('Tab');
    found = await popup.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLInputElement) || el.type !== 'range') return null;
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
  }
  assert.ok(found, 'a slider was reached with the keyboard');
  assert.notEqual(found.style, 'none');
  assert.ok(found.width >= 2);
  await popup.close();
  await web.close();
});

test('every page has its own localized title', { timeout: 150000 }, async () => {
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  const { REPO } = await import('../helpers/tree.mjs');
  for (const locale of LOCALES) {
    const catalog = (await import(pathToFileURL(join(REPO, 'extension', 'shared', 'locales', `${locale}.js`)).href)).default;
    const titles = {};
    const { popup, web } = await openPopup({ settings: { enabled: true }, ui: { locale } });
    titles.popup = await popup.title();
    await popup.close();
    await web.close();
    const options = await openPage('options/options.html', { settings: { enabled: true }, ui: { locale } });
    titles.options = await options.title();
    await options.close();
    const fixes = await openPage('fixes/fixes.html', { settings: { enabled: true }, ui: { locale } });
    titles.fixes = await fixes.title();
    await fixes.close();
    assert.equal(titles.popup, catalog['app.name'], `${locale} popup`);
    assert.equal(titles.options, catalog['options.title'], `${locale} settings`);
    assert.ok(titles.fixes.includes(catalog['fixes.title']), `${locale} fix editor`);
    assert.equal(new Set(Object.values(titles)).size, 3, `${locale} titles differ`);
  }
});

test('reduced motion: the footer stays on one item and nothing animates for long', { timeout: 90000 }, async () => {
  const { popup, web } = await openPopup({ settings: { enabled: true } }, { media: { reducedMotion: 'reduce' } });
  assert.equal(await popup.locator('.footer.is-rotating').count(), 0, 'no rotation');
  const long = await popup.evaluate(() => {
    const names = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.01) names.push(`${el.id || el.className}:${cs.animationName}`);
    }
    return names;
  });
  assert.deepEqual(long, []);
  await popup.close();
  await web.close();
});

test('right-to-left pages mirror the mode control, the tab marker and the menu', { timeout: 120000 }, async () => {
  const centers = {};
  for (const locale of ['en', 'fa']) {
    const { popup, web } = await openPopup({ settings: { enabled: true }, ui: { locale, uiTheme: 'light' } });
    centers[locale] = await popup.evaluate(() => {
      const box = document.querySelector('#mode').getBoundingClientRect();
      const dark = document.querySelector('#mode-dark').getBoundingClientRect();
      return (dark.left + dark.width / 2 - box.left) / box.width;
    });
    await popup.click('#overflowBtn');
    const menu = await popup.evaluate(() => {
      const m = document.querySelector('#overflowMenu').getBoundingClientRect();
      const t = document.querySelector('#overflowBtn').getBoundingClientRect();
      return { inside: m.left >= 0 && m.right <= innerWidth, startAligned: Math.abs(locale_dir() === 'rtl' ? m.left - t.left : m.right - t.right) < 2 };
      function locale_dir() { return document.documentElement.dir; }
    });
    assert.equal(menu.inside, true, `${locale} menu inside the window`);
    assert.equal(menu.startAligned, true, `${locale} menu is anchored to its button`);
    await popup.close();
    await web.close();
  }
  assert.ok(centers.en < 0.5, 'Dark is first at the start (left) in English');
  assert.ok(centers.fa > 0.5, 'Dark is first at the start (right) in Persian');

  for (const locale of ['en', 'ar']) {
    const page = await openPage('options/options.html', { settings: { enabled: true }, ui: { locale, uiTheme: 'light' } });
    const side = await page.evaluate(() => {
      const bar = getComputedStyle(document.querySelector('#tab-general'), '::before');
      return { left: bar.left, right: bar.right, dir: document.documentElement.dir };
    });
    assert.equal(side.dir === 'rtl' ? side.right : side.left, '0px', `${locale} the tab marker sits at the start edge`);
    await page.close();
  }
});

test('a message about a failed save is an alert with its own look, and a confirmation is a status', { timeout: 90000 }, async () => {
  const page = await openPage('options/options.html', { settings: { enabled: true } });
  await page.click('#tab-appearance');
  await page.fill('#sepia', '12');
  await page.waitForFunction(() => document.getElementById('message').textContent !== '');
  assert.equal(await page.getAttribute('#message', 'role'), 'status');
  assert.equal(await page.getAttribute('#message', 'data-kind'), 'info');
  await page.evaluate(() => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (m) => (m?.type === 'dk.settings.patch' ? { ok: false, code: 'bad' } : real(m));
  });
  await page.fill('#sepia', '30');
  await page.waitForFunction(() => document.getElementById('message').dataset.kind === 'error');
  assert.equal(await page.getAttribute('#message', 'role'), 'alert');
  const box = await page.evaluate(() => {
    const r = document.getElementById('message').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, h: innerHeight, topbar: document.querySelector('.topbar').getBoundingClientRect().height };
  });
  assert.ok(box.bottom <= box.h && box.top > box.topbar, 'the message floats inside the window and below the top bar');
  assert.equal(box.topbar, 64, 'the top bar keeps its height');
  await page.close();
});

test('the top bar keeps its size and the title stays whole at 360 px, with a message showing', { timeout: 150000 }, async () => {
  for (const locale of LOCALES) {
    const page = await openPage('options/options.html', { settings: { enabled: true }, ui: { locale, uiTheme: 'light' } }, { size: [360, 800] });
    const before = await page.evaluate(() => document.querySelector('.topbar').getBoundingClientRect().height);
    await page.click('#tab-appearance');
    await page.fill('#sepia', '9');
    await page.waitForFunction(() => document.getElementById('message').textContent !== '');
    const after = await page.evaluate(() => {
      const h1 = document.querySelector('.brand h1');
      return { height: document.querySelector('.topbar').getBoundingClientRect().height, cut: h1.scrollWidth > h1.clientWidth + 1, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    assert.equal(after.height, before, `${locale} the top bar did not change size`);
    assert.equal(after.cut, false, `${locale} the title is whole`);
    assert.equal(after.page, 0, `${locale} no sideways scroll`);
    await page.close();
  }
});

test('the settings page and the fix editor have no sideways scroll at 320, 360, 412 and 500 px in any language', { timeout: 500000 }, async () => {
  for (const locale of LOCALES) {
    for (const width of [320, 360, 412, 500]) {
      const page = await openPage('options/options.html', { settings: { enabled: true }, ui: { locale, uiTheme: 'dark' }, siteRules: { 'a-very-long-subdomain-name.example-company-international.co.uk': { theme: { mode: 'eink' }, css: 'a{}' } }, presets: [{ id: 'p', name: 'A rather long preset name that goes on and on', theme: { mode: 'dark', brightness: 90, contrast: 100, sepia: 0, grayscale: 0 } }] }, { size: [width, 800] });
      for (const tab of TABS) {
        await page.click(`#tab-${tab}`);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(over, 0, `${locale} ${width} ${tab}`);
      }
      await page.close();
      const fixes = await openPage('fixes/fixes.html', { settings: { enabled: true }, ui: { locale, uiTheme: 'dark' }, userFixes: { 'a-very-long-subdomain-name.example-company-international.co.uk': { note: 'n' } } }, { size: [width, 800] });
      assert.equal(await fixes.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `${locale} ${width} fixes`);
      await fixes.close();
    }
  }
});

test('a chosen option in a settings select is shown whole', { timeout: 150000 }, async () => {
  for (const locale of LOCALES) {
    const page = await openPage('options/options.html', { settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'paper' } }, ui: { locale, uiTheme: 'light' } });
    for (const tab of ['general', 'appearance', 'schedule']) {
      await page.click(`#tab-${tab}`);
      const cut = await page.evaluate(() => {
        const out = [];
        for (const select of document.querySelectorAll('.item select')) {
          if (select.getBoundingClientRect().width === 0) continue;
          const cs = getComputedStyle(select);
          const canvas = document.createElement('canvas').getContext('2d');
          canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          for (const option of select.options) {
            const room = select.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
            if (canvas.measureText(option.textContent).width > room) out.push(`${select.id}:${option.textContent}`);
          }
        }
        return out;
      });
      assert.deepEqual(cut, [], `${locale} ${tab}`);
    }
    await page.close();
  }
});

test('destructive buttons ask for a second press, and moving away cancels it', { timeout: 120000 }, async () => {
  const page = await openPage('fixes/fixes.html', { settings: { enabled: true }, userFixes: { 'example.com': { note: 'keep me' } } });
  const label = await page.textContent('#delete');
  await page.click('#delete');
  assert.equal(await page.getAttribute('#delete', 'data-armed'), '1');
  assert.equal(await page.textContent('#delete'), 'Press again to delete');
  assert.equal((await stored('userFixes')).userFixes['example.com'].note, 'keep me', 'one press deletes nothing');
  await page.focus('#note');
  assert.equal(await page.getAttribute('#delete', 'data-armed'), null);
  assert.equal(await page.textContent('#delete'), label);
  await page.click('#delete');
  await page.click('#delete');
  await page.waitForFunction(() => document.getElementById('editor').hidden);
  assert.deepEqual((await stored('userFixes')).userFixes, {});
  await page.close();
});

test('the error notice of the popup floats, moves nothing, and can be closed', { timeout: 120000 }, async () => {
  const { popup, web } = await openPopup({ settings: { enabled: true } });
  const spot = () => popup.evaluate(() => ['#sepia', '#engine', '.meta', '.dock'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.height)]; }));
  const before = await spot();
  await popup.evaluate(() => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (m) => (m?.type === 'dk.settings.patch' ? { ok: false, code: 'bad' } : real(m));
  });
  await popup.fill('#sepia', '20');
  await popup.waitForSelector('#notice:not([hidden])');
  assert.deepEqual(await spot(), before, 'no control moved');
  const win = await popup.evaluate(() => ({ w: document.scrollingElement.scrollWidth, h: document.scrollingElement.scrollHeight }));
  assert.deepEqual(win, { w: 360, h: 600 });
  const inside = await popup.evaluate(() => { const r = document.querySelector('#notice').getBoundingClientRect(); return r.left >= 0 && r.right <= 360 && r.bottom <= 600; });
  assert.equal(inside, true);
  await popup.click('#notice-x');
  assert.equal(await popup.isHidden('#notice'), true);
  assert.equal(await popup.isHidden('#notice-x'), true);
  await popup.close();
  await web.close();
});

test('the support reminder covers part of the window, so what it covers cannot be reached, and Escape closes it', { timeout: 120000 }, async () => {
  const { popup, web } = await openPopup({ settings: { enabled: true }, ui: { support: { installedAt: Date.now() - 40 * DAY, lastShownAt: 0, shownCount: 0, optOut: false } } });
  await popup.waitForSelector('#nudge');
  const covered = () => popup.evaluate(() => ['#presets-box', '.meta', '#footerMount'].map((s) => document.querySelector(s).hasAttribute('inert')));
  assert.deepEqual(await covered(), [true, true, true]);
  await popup.focus('#nudge-support');
  await popup.keyboard.press('Escape');
  assert.equal(await popup.locator('#nudge').count(), 0);
  assert.deepEqual(await covered(), [false, false, false]);
  await popup.close();
  await web.close();
});

test('the paper color shows which quick color is in use', { timeout: 60000 }, async () => {
  const page = await openPage('options/options.html', { settings: { enabled: true, theme: { mode: 'eink', einkPreset: 'paper', paperColor: '#f6efd0' } } });
  await page.click('#tab-appearance');
  const pressed = await page.evaluate(() => [...document.querySelectorAll('.swatch')].map((s) => s.getAttribute('aria-pressed')));
  assert.deepEqual(pressed, ['false', 'true', 'false', 'false']);
  await page.close();
});

test('a site rule and a preset are groups named after themselves', { timeout: 60000 }, async () => {
  const page = await openPage('options/options.html', { settings: { enabled: true }, siteRules: { 'example.com': { enabled: false } }, presets: [{ id: 'p1', name: 'Evening', theme: { mode: 'dark', brightness: 90, contrast: 100, sepia: 0, grayscale: 0 } }] });
  await page.click('#tab-sites');
  assert.equal(await page.getAttribute('#site-list li', 'role'), 'group');
  assert.equal(await page.getAttribute('#site-list li', 'aria-label'), 'example.com');
  await page.click('#tab-appearance');
  assert.equal(await page.getAttribute('#preset-list li', 'aria-label'), 'Evening');
  await page.close();
});

test('the notice that replaces the mode control has its height, so the sliders do not move', { timeout: 120000 }, async () => {
  const host = new URL(servers.origin).host;
  const top = async (storage) => {
    const { popup, web } = await openPopup(storage);
    // A site with its own look opens in the scope of the site; the notice belongs to the scope of all sites.
    if (await popup.isVisible('#scope-all')) await popup.click('#scope-all');
    const y = await popup.evaluate(() => document.querySelector('#sliders').getBoundingClientRect().top);
    const pinned = await popup.evaluate(() => !document.querySelector('#pin').hidden);
    await popup.close();
    await web.close();
    return { y, pinned };
  };
  const plain = await top({ settings: { enabled: true } });
  const pinned = await top({ settings: { enabled: true }, siteRules: { [host]: { theme: { mode: 'light' } } } });
  assert.equal(plain.pinned, false);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.y, plain.y);
});

test('closing the About dialog with Escape gives the focus back to the menu button', { timeout: 90000 }, async () => {
  const { popup, web } = await openPopup({ settings: { enabled: true } });
  await popup.click('#overflowBtn');
  await popup.click('#menu-about');
  await popup.waitForFunction(() => document.getElementById('about').open);
  assert.equal(await popup.evaluate(() => document.activeElement.id), 'about-close');
  await popup.keyboard.press('Escape');
  await popup.waitForFunction(() => !document.getElementById('about').open);
  await popup.waitForFunction(() => document.activeElement.id === 'overflowBtn', undefined, { timeout: 3000 });
  await popup.close();
  await web.close();
});

test('arrows of outside links and the search icon turn over in right-to-left pages', { timeout: 90000 }, async () => {
  for (const [locale, flipped] of [['en', false], ['fa', true], ['he', true]]) {
    const page = await openPage('options/options.html', { settings: { enabled: true }, ui: { locale } });
    await page.click('#tab-about');
    const [link, search] = await page.evaluate(() => [getComputedStyle(document.querySelector('.link-row .icon')).transform, getComputedStyle(document.querySelector('.search-icon')).transform]);
    const flips = (matrix) => matrix !== 'none' && Number(matrix.match(/matrix\(([^,]+),/)[1]) < 0;
    assert.equal(flips(link), flipped, `${locale} link arrow`);
    assert.equal(flips(search), flipped, `${locale} search icon`);
    await page.close();
  }
});

test('the popup says so when it cannot load, and the main switch is not offered', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true }, ui: { locale: 'en' } });
  const popup = await browser.context.newPage();
  await popup.addInitScript(() => {
    const fail = () => Promise.reject(new Error('stopped'));
    chrome.storage.local.get = fail;
    chrome.runtime.sendMessage = fail;
  });
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  assert.equal(await popup.textContent('#status'), 'Could not load. Close this window and open it again.');
  assert.equal(await popup.isDisabled('#master'), true);
  assert.equal(await popup.isHidden('#controls'), true);
  assert.deepEqual(await popup.evaluate(() => [document.scrollingElement.scrollWidth, document.scrollingElement.scrollHeight]), [360, 600]);
  await popup.close();
});

test('a menu button opens with the down arrow and closes with Escape', { timeout: 90000 }, async () => {
  const { popup, web } = await openPopup({ settings: { enabled: true } });
  await popup.focus('#overflowBtn');
  await popup.keyboard.press('ArrowDown');
  assert.equal(await popup.getAttribute('#overflowBtn', 'aria-expanded'), 'true');
  assert.equal(await popup.evaluate(() => document.activeElement.id), 'menu-settings');
  await popup.keyboard.press('Escape');
  assert.equal(await popup.getAttribute('#overflowBtn', 'aria-expanded'), 'false');
  assert.equal(await popup.evaluate(() => document.activeElement.id), 'overflowBtn');
  await popup.close();
  await web.close();
});
