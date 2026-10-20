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
const support = (over) => ({ installedAt: 0, lastShownAt: 0, shownCount: 0, optOut: false, ...over });
const ON = { settings: { enabled: true } };

async function openPopup(storage, size = [360, 600], { touch = false } = {}) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const popup = await browser.context.newPage();
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/basic.html`);
  await waitState(web, 'ready');
  await web.bringToFront();
  await popup.setViewportSize({ width: size[0], height: size[1] });
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  // A phone: no hover, a coarse pointer. The emulation is set on the extension document, where it holds.
  if (touch) {
    await (await browser.context.newCDPSession(popup)).send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await popup.waitForFunction(() => matchMedia('(hover: none) and (pointer: coarse)').matches);
  }
  return { popup, web };
}

const PRESET = (n, name) => ({
  id: `p-t${n}`,
  name,
  theme: { mode: 'dark', brightness: 90, contrast: 100, sepia: 20, grayscale: 0, darkBackground: '#16181d', darkText: '#e6e8eb', lightBackground: '#eeece8', lightText: '#1a1c20', colorSchemeDark: 'Default', colorSchemeLight: 'Default', fontEnabled: false, fontFamily: 'system-ui', textStroke: 0, scrollbar: 'auto', selection: 'auto', systemControls: true, fade: true },
});

/** The sizes that must not change in the toolbar window, and the places where text could spill. */
const measure = (popup) =>
  popup.evaluate(() => {
    const box = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    };
    const over = (sel) => {
      const el = document.querySelector(sel);
      return { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight };
    };
    const root = document.documentElement;
    return {
      page: { w: root.scrollWidth, h: root.scrollHeight },
      app: box('.app'),
      dock: box('.dock'),
      footer: box('.footer'),
      panel: box('.footer-panel'),
      hero: box('.hero'),
      main: over('.main'),
      panelOver: over('.footer-panel'),
      textOver: over('.footer-text'),
    };
  });

test('the popup has one fixed width and height in every footer item, language, look and with the reminder shown', { timeout: 300000 }, async () => {
  const presets = Array.from({ length: 12 }, (_, i) => PRESET(i, `A rather long preset name number ${i}`));
  let base = null;
  const runs = [['en', 'light'], ['en', 'dark'], ['fa', 'light'], ['fa', 'dark'], ['ar', 'light'], ['he', 'dark']];
  for (const [locale, uiTheme] of runs) {
    for (const nudge of [false, true]) {
      const ui = { locale, uiTheme, ...(nudge ? { support: support({ installedAt: Date.now() - 40 * DAY }) } : {}) };
      const { popup, web } = await openPopup({ ...ON, ui, presets });
      if (nudge) await popup.waitForSelector('#nudge');
      const ids = await popup.evaluate(() => [...document.querySelectorAll('.footer-tab')].map((el) => el.id));
      assert.equal(ids.length, 4, String(ids));
      for (const id of ids) {
        await popup.click(`#${id}`, { force: true });
        const m = await measure(popup);
        const label = `${locale} ${uiTheme} nudge=${nudge} ${id}`;
        assert.deepEqual(m.page, { w: 360, h: 600 }, `${label} page ${JSON.stringify(m.page)}`);
        assert.deepEqual(m.app, { w: 360, h: 600 }, `${label} app`);
        assert.equal(m.main.y, 0, `${label} main scrolls by ${m.main.y}`);
        assert.equal(m.main.x, 0, `${label} main scrolls sideways`);
        assert.equal(m.panelOver.y, 0, `${label} footer panel text spills`);
        assert.equal(m.textOver.x, 0, `${label} footer text spills sideways`);
        base ??= m;
        for (const key of ['dock', 'footer', 'panel', 'hero']) assert.deepEqual(m[key], base[key], `${label} ${key} size differs from the first state`);
      }
      await popup.close();
      await web.close();
    }
  }
});

test('the About dialog fits inside the popup without a scrollbar in every language and look', { timeout: 180000 }, async () => {
  for (const [locale, uiTheme] of [['en', 'light'], ['fa', 'dark'], ['ar', 'light'], ['he', 'dark']]) {
    const { popup, web } = await openPopup({ ...ON, ui: { locale, uiTheme } });
    await popup.click('#overflowBtn');
    await popup.click('#menu-about');
    await popup.waitForSelector('#about[open]');
    await popup.waitForTimeout(450);
    const m = await popup.evaluate(() => {
      const d = document.getElementById('about');
      const r = d.getBoundingClientRect();
      return {
        y: d.scrollHeight - d.clientHeight,
        x: d.scrollWidth - d.clientWidth,
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        overflow: getComputedStyle(d).overflowY,
        support: !!document.getElementById('about-support'),
        links: d.querySelectorAll('.link-row').length,
        page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      };
    });
    assert.equal(m.y, 0, `${locale} about scrolls by ${m.y}`);
    assert.equal(m.x, 0, `${locale} about scrolls sideways`);
    assert.notEqual(m.overflow, 'auto');
    assert.notEqual(m.overflow, 'scroll');
    assert.ok(m.top >= 0 && m.bottom <= 600 && m.left >= 0 && m.right <= 360, `${locale} about outside the window ${JSON.stringify(m)}`);
    assert.deepEqual(m.page, [360, 600]);
    assert.equal(m.support, true);
    assert.equal(m.links, 6);
    await popup.close();
    await web.close();
  }
});

test('the Rate item always shows; an unpacked copy sends it to the public repository', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  await popup.click('#footer-tab-rate');
  assert.equal(await popup.getAttribute('#footer-tab-rate', 'aria-selected'), 'true');
  const opened = browser.context.waitForEvent('page', { timeout: 15000 });
  await popup.click('#footer-cta');
  const tab = await opened;
  assert.match(tab.url(), /^https:\/\/github\.com\/ehsanenaloo\/Tintly/);
  await tab.close();
  await popup.click('#overflowBtn');
  await popup.click('#menu-about');
  await popup.waitForSelector('#about[open]');
  assert.equal(await popup.locator('#about-rate').count(), 1);
  await popup.close();
  await web.close();
});

test('the main view has the look switch, status, empty preset state and no error by default', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup({ ...ON, ui: { locale: 'en' }, presets: [] });
  assert.equal(await popup.locator('#uiThemeSwitch [role="radio"]').count(), 3);
  assert.equal(await popup.isVisible('#presets-none'), true);
  assert.equal(await popup.isHidden('#notice'), true);
  assert.equal(await popup.getAttribute('#status-dot', 'data-state'), 'on');
  await popup.close();
  await web.close();
});

// Chrome lays the toolbar window out first in a viewport of a few pixels and sizes the window from that layout.
test('the toolbar window keeps its size when its first viewport is tiny', async () => {
  const { popup, web } = await openPopup(ON, [40, 40]);
  const size = await popup.evaluate(() => {
    const r = document.documentElement.getBoundingClientRect();
    return [r.width, r.height, document.body.getBoundingClientRect().width];
  });
  assert.deepEqual(size, [360, 600, 360]);
  await popup.close();
  await web.close();
});

// Firefox for Android opens the popup as a full-screen page of the phone's size.
test('the popup fits a phone screen: no sideways scroll, no control outside the screen, the footer reachable, the focus order follows the page', { timeout: 280000 }, async () => {
  const presets = Array.from({ length: 12 }, (_, i) => PRESET(i, `A rather long preset name number ${i}`));
  for (const [width, height] of [[360, 640], [412, 915], [320, 568], [360, 360]]) {
    for (const [locale, uiTheme] of [['en', 'light'], ['fa', 'dark']]) {
      const { popup, web } = await openPopup({ ...ON, ui: { locale, uiTheme }, presets }, [width, height], { touch: true });
      const label = `${width}x${height} ${locale}`;
      const m = await popup.evaluate(() => {
        const root = document.documentElement;
        const outside = [];
        for (const el of document.querySelectorAll('.app *')) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') continue;
          // What a scrolling strip holds beyond its edge is reached by scrolling it.
          let clipped = false;
          for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) if (getComputedStyle(up).overflowX !== 'visible') clipped = true;
          if (clipped) continue;
          if (r.left < -0.5 || r.right > window.innerWidth + 0.5) outside.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
        }
        return { over: root.scrollWidth - root.clientWidth, outside: outside.slice(0, 5), app: document.querySelector('.app').getBoundingClientRect().width };
      });
      assert.equal(m.over, 0, `${label} scrolls sideways`);
      assert.deepEqual(m.outside, [], `${label} controls outside the screen`);
      assert.ok(m.app <= width + 0.5, `${label} app is wider than the screen: ${m.app}`);
      // The footer can be reached: by sight when the screen is tall enough, by scrolling when it is not.
      await popup.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
      assert.equal(await popup.evaluate(() => document.querySelector('.dock').getBoundingClientRect().bottom <= window.innerHeight + 1), true, `${label} the footer is out of reach`);
      await popup.evaluate(() => window.scrollTo(0, 0));
      // Tab walks the controls in the order of the page, and every stop is on the screen.
      await popup.evaluate(() => document.body.focus());
      const stops = [];
      for (let i = 0; i < 12; i++) {
        await popup.keyboard.press('Tab');
        stops.push(await popup.evaluate(() => {
          const el = document.activeElement;
          const r = el.getBoundingClientRect();
          return { id: el.id || el.className, top: Math.round(r.top), visible: r.width > 0 && r.height > 0 && r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom > 0 && r.top < window.innerHeight };
        }));
      }
      assert.ok(stops.every((s) => s.visible), `${label} a focus stop is off the screen: ${JSON.stringify(stops.filter((s) => !s.visible))}`);
      assert.equal(new Set(stops.map((s) => s.id)).size > 6, true, `${label} the focus stays on few controls: ${JSON.stringify(stops)}`);
      await popup.close();
      await web.close();
    }
  }
});
