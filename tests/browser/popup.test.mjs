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

const stored = (key) => browser.worker.evaluate((k) => chrome.storage.local.get(k), key);

/** Open a web page, then the popup as the toolbar would show it for that page (the page is the active tab). */
async function openPopup(storage, path = '/basic.html') {
  await browser.clearStorage();
  await browser.setStorage(storage);
  let web = null;
  // The popup page is loaded once, after the web page is the active tab. A second load runs the reminder
  // logic twice, and the first run records the reminder as shown before the second one reads it.
  const popup = await browser.context.newPage();
  if (path) {
    web = await browser.context.newPage();
    await web.goto(`${servers.origin}${path}`);
    if (storage.settings?.enabled !== false) await waitState(web, 'ready');
    await web.bringToFront();
  }
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return { popup, web };
}

const ON = { settings: { enabled: true } };

test('the popup shows the state of the page it was opened for', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  assert.equal(await popup.inputValue('#brightness'), '100');
  assert.equal(await popup.isChecked('#master'), true);
  assert.equal(await popup.isChecked('#site'), true);
  assert.equal(await popup.textContent('#host'), new URL(servers.origin).host);
  await popup.waitForFunction(() => document.getElementById('status').textContent.trim() !== '');
  console.log(`# popup status text: ${await popup.textContent('#status')}`);
  await popup.close();
  await web.close();
});

test('on a page the extension cannot change, the site switch is off and a message says so', { timeout: 60000 }, async () => {
  const { popup } = await openPopup(ON, null);
  assert.equal(await popup.isDisabled('#site'), true);
  assert.equal(await popup.textContent('#status'), 'Tintly cannot change this page.');
  await popup.close();
});

test('the switches, the mode, the engine and the sliders are saved and the page follows', { timeout: 90000 }, async () => {
  const { popup, web } = await openPopup(ON);
  const bg = () => web.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = await bg();

  await popup.fill('#brightness', '70');
  await popup.waitForFunction(() => document.getElementById('brightness-out').textContent !== '');
  await popup.waitForTimeout(400);
  assert.equal((await stored('settings')).settings.theme.brightness, 70);
  await web.waitForFunction((b) => getComputedStyle(document.body).backgroundColor !== b, before, { timeout: 15000 });

  await popup.click('#mode-light');
  await popup.selectOption('#engine', 'filter');
  // Each save waits for the one before it; a cold worker can take a few hundred milliseconds.
  for (let i = 0; i < 120; i++) {
    const s = (await stored('settings')).settings;
    if (s.theme.mode === 'light' && s.engine === 'filter') break;
    await popup.waitForTimeout(50);
  }
  const settings = (await stored('settings')).settings;
  assert.equal(settings.theme.mode, 'light');
  assert.equal(settings.engine, 'filter');

  await popup.selectOption('#engine', 'dynamic');
  await popup.click('#mode-dark');
  assert.equal(await popup.getAttribute('#mode-dark', 'aria-checked'), 'true');
  await popup.uncheck('#site');
  await waitState(web, null);
  assert.equal((await stored('siteRules')).siteRules[new URL(servers.origin).host].enabled, false);
  await popup.check('#site');
  await waitState(web, 'ready');

  await popup.uncheck('#master');
  await waitState(web, null);
  assert.equal((await stored('settings')).settings.enabled, false);
  assert.equal(await popup.evaluate(() => document.getElementById('controls').hasAttribute('data-off')), true);
  await popup.check('#master');
  await waitState(web, 'ready');
  await popup.close();
  await web.close();
});

test('a change made just before the window closes is not lost', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  await popup.fill('#contrast', '120');
  await popup.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await stored('settings')).settings.theme.contrast, 120);
  await web.close();
});

test('a field the worker does not know says that the extension needs a reload; other refusals keep the generic text', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  // Play the part of a worker from an older version.
  await popup.evaluate(() => {
    window.__reply = { ok: false, code: 'unknown-field' };
    window.__patches = 0;
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => {
      if (message && message.type === 'dk.settings.patch') {
        window.__patches += 1;
        return Promise.resolve(window.__reply);
      }
      return real(message, ...rest);
    };
  });
  await popup.click('#mode-light');
  await popup.waitForSelector('#notice:not([hidden])');
  assert.equal(await popup.textContent('#notice'), "Could not save. Reload the extension in the browser's extensions page.");
  assert.equal(await popup.evaluate(() => window.__patches), 1, 'a refusal for the content is not tried again');

  await popup.evaluate(() => {
    window.__reply = { ok: false, code: 'invalid' };
  });
  await popup.click('#mode-dark');
  await popup.waitForFunction(() => document.getElementById('notice').textContent === 'Could not save the change.');

  await popup.evaluate(() => {
    window.__reply = { ok: true };
  });
  await popup.click('#mode-light');
  await popup.waitForSelector('#notice', { state: 'hidden' });
  await popup.close();
  await web.close();
});

test('a save that fails once, as when the worker restarts, is tried again before an error shows', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  await popup.evaluate(() => {
    window.__tries = 0;
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => {
      if (message && message.type === 'dk.settings.patch') {
        window.__tries += 1;
        if (window.__tries === 1) return Promise.reject(new Error('The message port closed'));
      }
      return real(message, ...rest);
    };
  });
  await popup.click('#mode-light');
  await popup.waitForFunction(() => window.__tries >= 2, null, { timeout: 5000 });
  await popup.waitForTimeout(300);
  assert.equal(await popup.isHidden('#notice'), true, 'no error after a retry that worked');
  assert.equal((await stored('settings')).settings.theme.mode, 'light');

  // Two failures in a row show the error.
  await popup.evaluate(() => {
    window.__tries = 0;
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => {
      if (message && message.type === 'dk.settings.patch') {
        window.__tries += 1;
        return Promise.reject(new Error('gone'));
      }
      return real(message, ...rest);
    };
  });
  await popup.click('#mode-dark');
  await popup.waitForSelector('#notice:not([hidden])', { timeout: 5000 });
  assert.equal(await popup.evaluate(() => window.__tries), 2);
  assert.equal(await popup.textContent('#notice'), 'Could not save the change.');
  await popup.close();
  await web.close();
});

test('a preset can be applied from the popup', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'dk.preset.save', preset: { name: 'Soft', theme: { brightness: 80, sepia: 20 } } }));
  await popup.reload();
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  await popup.click('#presets button');
  await popup.waitForTimeout(400);
  const theme = (await stored('settings')).settings.theme;
  assert.deepEqual([theme.brightness, theme.sepia], [80, 20]);
  assert.equal(await popup.inputValue('#sepia'), '20');
  await popup.close();
  await web.close();
});

test('every control can be reached and used with the keyboard', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  const seen = [];
  await popup.evaluate(() => document.body.focus());
  for (let i = 0; i < 20; i++) {
    await popup.keyboard.press('Tab');
    const id = await popup.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute('href') || '');
    if (seen.includes(id)) break;
    seen.push(id);
  }
  for (const id of ['master', 'site', 'mode-dark', 'engine', 'brightness', 'contrast', 'sepia', 'grayscale']) assert.ok(seen.includes(id), `${id} not reached: ${seen}`);
  assert.ok(seen.some((s) => s.includes('options.html')) && seen.some((s) => s.includes('fixes.html')), String(seen));

  // Operate a switch and a slider by key.
  await popup.focus('#master');
  await popup.keyboard.press('Space');
  await waitState(web, null);
  await popup.keyboard.press('Space');
  await waitState(web, 'ready');
  await popup.focus('#sepia');
  await popup.keyboard.press('ArrowRight');
  // The popup saves a moment after the last change; on a busy machine the write takes longer than a fixed wait.
  for (let i = 0; i < 50 && (await stored('settings')).settings.theme.sepia !== 1; i++) await popup.waitForTimeout(100);
  assert.equal((await stored('settings')).settings.theme.sepia, 1);

  // Every control has a name.
  const unnamed = await popup.evaluate(() =>
    [...document.querySelectorAll('input, select, button')].filter((el) => !(el.labels?.length || el.getAttribute('aria-label') || el.textContent.trim())).map((el) => el.id),
  );
  assert.deepEqual(unnamed, []);
  await popup.close();
  await web.close();
});

test('the popup fits and reads correctly in each language and both color schemes', { timeout: 120000 }, async () => {
  const dirs = { fa: 'rtl', ar: 'rtl', he: 'rtl', en: 'ltr' };
  for (const [locale, dir] of Object.entries(dirs)) {
    for (const scheme of ['light', 'dark']) {
      const { popup, web } = await openPopup({ settings: { enabled: true }, ui: { locale } });
      await popup.emulateMedia({ colorScheme: scheme });
      assert.equal(await popup.evaluate(() => document.documentElement.dir), dir, locale);
      assert.equal(await popup.evaluate(() => document.documentElement.lang), locale);
      const text = await popup.evaluate(() => document.body.innerText);
      assert.doesNotMatch(text, /\b(popup|status|theme|mode|engine)\.[a-zA-Z]+/, `${locale}: a key shows`);
      const fit = await popup.evaluate(() => ({ w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
      assert.ok(fit.w <= fit.c, `${locale} ${scheme}: sideways scroll ${JSON.stringify(fit)}`);
      const contrast = await popup.evaluate(() => {
        const lum = (s) => {
          const [r, g, b] = s.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => {
            const c = Number(v) / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const cs = getComputedStyle(document.body);
        const a = lum(cs.color) + 0.05;
        const b = lum(cs.backgroundColor) + 0.05;
        return Math.max(a, b) / Math.min(a, b);
      });
      assert.ok(contrast >= 4.5, `${locale} ${scheme}: contrast ${contrast}`);
      await popup.close();
      await web.close();
    }
  }
});

test('opening is quick and nothing moves after the first paint', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  await popup.reload();
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  const m = await popup.evaluate(
    () =>
      new Promise((resolve) => {
        let shift = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) if (!e.hadRecentInput) shift += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve({ ready: Math.round(performance.now()), shift }), 300);
      }),
  );
  console.log(`# popup: interactive about ${m.ready} ms after navigation start (headless), layout shift ${m.shift}`);
  assert.ok(m.shift < 0.01, `layout shift ${m.shift}`);
  await popup.close();
  await web.close();
});

const DAY = 86400000;
const support = (over) => ({ installedAt: 0, lastShownAt: 0, shownCount: 0, optOut: false, ...over });

test('a new install is only marked, and the reminder waits for the grace period', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  await popup.waitForFunction(() => document.getElementById('nudgeMount') !== null);
  await popup.waitForTimeout(500);
  const ui = (await stored('ui')).ui;
  assert.ok(ui.support.installedAt > 0);
  assert.equal(await popup.locator('#nudge').count(), 0);
  await popup.close();
  await web.close();

  const fresh = await openPopup({ ...ON, ui: { support: support({ installedAt: Date.now() - 3 * DAY }) } });
  await fresh.popup.waitForTimeout(500);
  assert.equal(await fresh.popup.locator('#nudge').count(), 0);
  await fresh.popup.close();
  await fresh.web.close();
});

test('the reminder shows after the grace period, records it, and is dismissed with Not now', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup({ ...ON, ui: { support: support({ installedAt: Date.now() - 20 * DAY }) } });
  await popup.waitForSelector('#nudge');
  await popup.waitForTimeout(300);
  const saved = (await stored('ui')).ui.support;
  assert.equal(saved.shownCount, 1);
  assert.ok(saved.lastShownAt > Date.now() - 60000);
  await popup.click('#nudge-later');
  assert.equal(await popup.locator('#nudge').count(), 0);
  await popup.close();

  // Opened again at once: not due for a month.
  const again = await browser.context.newPage();
  await again.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await again.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  await again.waitForTimeout(500);
  assert.equal(await again.locator('#nudge').count(), 0);
  assert.equal((await stored('ui')).ui.support.shownCount, 1);
  await again.close();
  await web.close();
});

test('the reminder comes back a month after it was shown, and never after Do not show again', { timeout: 60000 }, async () => {
  const a = await openPopup({ ...ON, ui: { support: support({ installedAt: Date.now() - 90 * DAY, lastShownAt: Date.now() - 31 * DAY, shownCount: 1 }) } });
  await a.popup.waitForSelector('#nudge');
  await a.popup.click('#nudge-never');
  await a.popup.waitForTimeout(400);
  assert.equal((await stored('ui')).ui.support.optOut, true);
  await a.popup.close();
  await a.web.close();

  const b = await openPopup({ ...ON, ui: { support: support({ installedAt: Date.now() - 90 * DAY, lastShownAt: Date.now() - 31 * DAY, optOut: true }) } });
  await b.popup.waitForTimeout(500);
  assert.equal(await b.popup.locator('#nudge').count(), 0);
  await b.popup.close();
  await b.web.close();

  const c = await openPopup({ ...ON, ui: { support: support({ installedAt: Date.now() - 90 * DAY, lastShownAt: Date.now() - 5 * DAY }) } });
  await c.popup.waitForTimeout(500);
  assert.equal(await c.popup.locator('#nudge').count(), 0);
  await c.popup.close();
  await c.web.close();
});

test('the menu opens with the keyboard, has Settings, Help, About and Support, and About is a dialog', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  await popup.focus('#overflowBtn');
  await popup.keyboard.press('Enter');
  assert.equal(await popup.getAttribute('#overflowBtn', 'aria-expanded'), 'true');
  const ids = await popup.evaluate(() => [...document.querySelectorAll('#overflowMenu [role="menuitem"]')].map((e) => e.id));
  assert.deepEqual(ids, ['menu-settings', 'menu-help', 'menu-about', 'menu-support']);
  assert.equal(await popup.evaluate(() => document.activeElement.id), 'menu-settings');
  await popup.keyboard.press('ArrowDown');
  assert.equal(await popup.evaluate(() => document.activeElement.id), 'menu-help');
  await popup.keyboard.press('Escape');
  assert.equal(await popup.isHidden('#overflowMenu'), true);
  assert.equal(await popup.evaluate(() => document.activeElement.id), 'overflowBtn');

  await popup.click('#overflowBtn');
  await popup.click('#menu-about');
  await popup.waitForSelector('#about[open]');
  assert.match(await popup.textContent('#about'), /Version \d/);
  assert.match(await popup.textContent('#about'), /does not collect data/);
  await popup.keyboard.press('Escape');
  assert.equal(await popup.locator('#about[open]').count(), 0);
  await popup.close();
  await web.close();
});

test('the look of the pages is chosen on the main view of the popup, kept, and followed by an open settings page', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  const options = await browser.context.newPage();
  await options.goto(`chrome-extension://${extId}/pages/options/options.html`);
  await options.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  assert.equal(await popup.isVisible('#theme-dark'), true);
  assert.equal(await popup.getAttribute('#theme-system', 'aria-checked'), 'true');
  await popup.click('#theme-dark');
  await popup.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await options.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await popup.waitForTimeout(400);
  assert.equal((await stored('ui')).ui.uiTheme, 'dark');
  assert.equal(await popup.getAttribute('#theme-dark', 'aria-checked'), 'true');
  await popup.click('#theme-light');
  await popup.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await options.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await popup.click('#theme-system');
  await popup.waitForFunction(() => document.documentElement.dataset.theme === undefined);
  await popup.waitForTimeout(400);
  assert.equal((await stored('ui')).ui.uiTheme, 'system');
  // Keyboard: arrow keys move through the three choices.
  await popup.focus('#theme-system');
  await popup.keyboard.press('ArrowRight');
  await popup.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await options.close();
  await popup.close();
  await web.close();
});

test('the popup shows the schedule state', { timeout: 60000 }, async () => {
  const { popup } = await openPopup({ settings: { enabled: true, automation: { mode: 'time', behavior: 'onOff', time: { from: '19:30', to: '06:15' }, location: { lat: null, lon: null } } } }, null);
  assert.match(await popup.textContent('#schedule-text'), /19:30 to 06:15/);
  await popup.close();
});

test('the footer rotates by itself, stops when a tab is chosen, and always shows the Rate item', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  const first = await popup.getAttribute('#footer-tab-about', 'aria-selected');
  assert.equal(first, 'true');
  assert.equal(await popup.locator('#footer-tab-rate').count(), 1);
  await popup.waitForFunction(() => document.getElementById('footer-tab-support')?.getAttribute('aria-selected') === 'true' || document.getElementById('footer-tab-github')?.getAttribute('aria-selected') === 'true', undefined, { timeout: 15000 });
  await popup.click('#footer-tab-about');
  assert.equal(await popup.evaluate(() => document.querySelector('.footer').classList.contains('is-rotating')), false);
  await popup.close();
  await web.close();
});

test('the site card shows the icon of the page, and the globe when the page has none', { timeout: 60000 }, async () => {
  const withIcon = await openPopup(ON, '/with-icon.html');
  await withIcon.popup.waitForSelector('#siteTile img.site-icon', { timeout: 10000 });
  assert.equal(await withIcon.popup.evaluate(() => document.querySelector('#siteTile img').src.startsWith('data:image/png;base64,')), true);
  await withIcon.popup.close();
  await withIcon.web?.close();
  const without = await openPopup(ON, '/basic.html');
  await without.popup.waitForTimeout(800);
  assert.equal(await without.popup.evaluate(() => !!document.querySelector('#siteTile img') && document.querySelector('#siteTile img').complete && document.querySelector('#siteTile svg') === null), false);
  assert.equal(await without.popup.evaluate(() => document.querySelector('#siteTile svg') !== null), true);
  await without.popup.close();
  await without.web?.close();
});

const tapSends = (popup) =>
  popup.evaluate(() => {
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__log = [];
    window.__fail = 0;
    chrome.runtime.sendMessage = async (msg) => {
      window.__log.push({ type: msg.type, at: performance.now() });
      if (msg.type === 'dk.settings.patch' && window.__fail > 0) {
        window.__fail -= 1;
        throw new Error('worker is starting');
      }
      return orig(msg);
    };
  });

const moveSlider = (popup) =>
  popup.evaluate(() => {
    const el = document.getElementById('brightness');
    el.value = '77';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

test('hiding the popup saves a waiting change at once', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  await tapSends(popup);
  await moveSlider(popup);
  const waited = await popup.evaluate(async () => {
    const t0 = performance.now();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const sent = window.__log.find((m) => m.type === 'dk.settings.patch');
    return sent ? sent.at - t0 : null;
  });
  assert.ok(waited !== null && waited < 100, `the save waited ${waited} ms`);
  await popup.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings?.theme?.brightness === 77);
  await popup.close();
  await web?.close();
});

test('closing the popup retries a failed save without the pause', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  await tapSends(popup);
  await popup.evaluate(() => (window.__fail = 1));
  await moveSlider(popup);
  const gap = await popup.evaluate(async () => {
    dispatchEvent(new Event('pagehide'));
    await new Promise((resolve) => setTimeout(resolve, 900));
    const sends = window.__log.filter((m) => m.type === 'dk.settings.patch');
    return sends.length === 2 ? sends[1].at - sends[0].at : sends.length;
  });
  assert.ok(gap < 200, `the retry came after ${gap}`);
  await popup.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.theme.brightness === 77);
  await popup.close();
  await web?.close();
});

test('the title of the main switch says the state it shows now, in each language', { timeout: 120000 }, async () => {
  const titles = { en: ['Tintly is on', 'Tintly is off'], fa: ['Tintly روشن است', 'Tintly خاموش است'], ar: ['Tintly يعمل', 'Tintly متوقف'], he: ['Tintly פועל', 'Tintly כבוי'] };
  for (const [locale, [on, off]] of Object.entries(titles)) {
    const { popup, web } = await openPopup({ settings: { enabled: true }, ui: { locale } });
    assert.equal(await popup.textContent('#master-label'), on, locale);
    await popup.click('#master');
    assert.equal(await popup.textContent('#master-label'), off, locale);
    await popup.click('#master');
    assert.equal(await popup.textContent('#master-label'), on, locale);
    await popup.close();
    await web.close();
  }
  const { popup, web } = await openPopup({ settings: { enabled: false } });
  assert.equal(await popup.textContent('#master-label'), 'Tintly is off');
  await popup.close();
  await web.close();
});

test('the footer has a pause button while it rotates: it stops the round, resumes it, and goes when nothing moves', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  const pause = popup.locator('.footer-pause');
  assert.equal(await pause.isVisible(), true);
  assert.equal(await pause.getAttribute('aria-pressed'), 'false');
  assert.ok((await pause.getAttribute('aria-label')).length > 0);
  const box = await pause.boundingBox();
  assert.ok(box.width >= 24 && box.height >= 24, `target ${box.width}x${box.height}`);
  assert.equal(await popup.evaluate(() => document.querySelector('.footer').classList.contains('is-rotating')), true);
  await pause.click();
  assert.equal(await pause.getAttribute('aria-pressed'), 'true');
  assert.equal(await popup.evaluate(() => document.querySelector('.footer').classList.contains('is-rotating')), false);
  const where = await popup.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]').id);
  await popup.mouse.move(5, 5);
  await popup.waitForTimeout(7500);
  assert.equal(await popup.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]').id), where, 'a paused footer stays');
  await pause.press('Enter');
  assert.equal(await pause.getAttribute('aria-pressed'), 'false');
  assert.equal(await popup.evaluate(() => document.querySelector('.footer').classList.contains('is-rotating')), true);
  // A chosen tab ends the rotation, and then nothing is left to pause.
  await popup.click('#footer-tab-about');
  assert.equal(await pause.isHidden(), true);
  await popup.close();
  await web.close();
});

test('with reduced motion the footer does not rotate and has no pause button', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const popup = await browser.context.newPage();
  await popup.emulateMedia({ reducedMotion: 'reduce' });
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  assert.equal(await popup.locator('.footer-pause').isHidden(), true);
  assert.equal(await popup.evaluate(() => document.querySelector('.footer').classList.contains('is-rotating')), false);
  await popup.close();
});
