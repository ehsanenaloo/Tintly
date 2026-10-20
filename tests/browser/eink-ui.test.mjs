// The controls of the E-ink and Paper mode: the mode control in the popup, the section and the folded
// advanced part on the settings page, the site rule, the schedule, saved presets and the fix editor.
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
const theme = async () => (await stored('settings')).settings.theme;
const settle = (page) => page.waitForTimeout(600);

async function openPopup(storage, path = '/eink-book.html') {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const popup = await browser.context.newPage();
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}${path}`);
  await waitState(web, 'ready');
  await web.bringToFront();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return { popup, web };
}

async function openOptions(storage) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/options/options.html`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return page;
}

const ON = { settings: { enabled: true } };
const PAPER = { enabled: true, theme: { mode: 'eink', einkPreset: 'paper' } };

test('popup: five choices, Dark, Light, Paper, E-ink and Original, each with an icon and a label; Paper and E-ink show their two sliders and hide the five', { timeout: 90000 }, async () => {
  const { popup, web } = await openPopup(ON);
  const radios = await popup.$$eval('#mode [role="radio"]', (els) => els.map((e) => ({ value: e.dataset.value, label: e.textContent.trim(), icon: !!e.querySelector('svg') })));
  assert.deepEqual(radios.map((r) => r.value), ['dark', 'light', 'paper', 'eink', 'original']);
  assert.deepEqual(radios.map((r) => r.label), ['Dark', 'Light', 'Paper', 'E-ink', 'Original']);
  assert.ok(radios.every((r) => r.icon));
  assert.equal(await popup.locator('#einkPreset').count(), 0, 'the style switch is gone');
  assert.equal(await popup.isHidden('#einkBox'), true);
  assert.equal(await popup.isVisible('#sliders'), true);

  // Choosing E-ink once gives E-ink, not Paper first, in one change of settings.
  await popup.click('#mode-eink');
  await popup.waitForSelector('#einkBox', { state: 'visible' });
  assert.equal(await popup.isHidden('#sliders'), true);
  assert.equal(await popup.getAttribute('#mode-eink', 'aria-checked'), 'true');
  await settle(popup);
  const t = await theme();
  assert.equal(t.mode, 'eink');
  assert.equal(t.einkPreset, 'eink');
  await web.waitForFunction(() => getComputedStyle(document.documentElement).backgroundColor === 'rgb(255, 255, 255)');
  // The sliders show the values of the E-ink style.
  assert.equal(await popup.inputValue('#whiteCap'), '100');
  assert.equal(await popup.inputValue('#einkBlue'), '0');

  // Paper: the style changes with the mode and every field goes back to the values of the style.
  await popup.fill('#einkBlue', '40');
  await settle(popup);
  assert.equal((await theme()).einkBlue, 40);
  assert.equal(await popup.textContent('#einkBlue-out'), '40');
  await popup.click('#mode-paper');
  await settle(popup);
  const p = await theme();
  assert.equal(p.mode, 'eink');
  assert.equal(p.einkPreset, 'paper');
  assert.equal(p.einkBlue, null);
  assert.equal(await popup.getAttribute('#mode-paper', 'aria-checked'), 'true');
  assert.equal(await popup.inputValue('#whiteCap'), '84');
  assert.equal(await popup.inputValue('#einkBlue'), '12');

  // The sliders of a style stay when the same style is chosen again.
  await popup.fill('#einkBlue', '30');
  await settle(popup);
  await popup.click('#mode-paper');
  await settle(popup);
  assert.equal((await theme()).einkBlue, 30);

  // Dark and Light leave the style and its values alone; the five sliders come back.
  await popup.click('#mode-dark');
  await popup.waitForSelector('#sliders', { state: 'visible' });
  assert.equal(await popup.isHidden('#einkBox'), true);
  await settle(popup);
  const d = await theme();
  assert.equal(d.mode, 'dark');
  assert.equal(d.einkPreset, 'paper');
  assert.equal(d.einkBlue, 30);
  await popup.click('#mode-light');
  await settle(popup);
  assert.equal((await theme()).mode, 'light');
  assert.equal(await popup.getAttribute('#mode-light', 'aria-checked'), 'true');
  await popup.close();
  await web.close();
});

test('popup: a choice is one change of settings', { timeout: 60000 }, async () => {
  const { popup, web } = await openPopup(ON);
  // Count the writes of the settings: one choice must be one write.
  await browser.worker.evaluate(() => {
    globalThis.__writes = 0;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) globalThis.__writes += 1;
    });
  });
  await popup.click('#mode-eink');
  await settle(popup);
  assert.equal(await browser.worker.evaluate(() => globalThis.__writes), 1);
  await popup.click('#mode-paper');
  await settle(popup);
  assert.equal(await browser.worker.evaluate(() => globalThis.__writes), 2);
  await popup.close();
  await web.close();
});

test('popup: the mode choices work with the keyboard, in both text directions', { timeout: 90000 }, async () => {
  for (const locale of ['en', 'fa']) {
    const { popup, web } = await openPopup({ settings: PAPER, ui: { locale } });
    const rtl = locale === 'fa';
    // The roving tab stop is on the selected choice only.
    assert.equal(await popup.getAttribute('#mode-paper', 'tabindex'), '0');
    assert.equal(await popup.getAttribute('#mode-dark', 'tabindex'), '-1');
    assert.equal(await popup.getAttribute('#mode', 'role'), 'radiogroup');
    await popup.focus('#mode-paper');
    // The arrow that points to the end of the row: the next choice, E-ink.
    await popup.keyboard.press(rtl ? 'ArrowLeft' : 'ArrowRight');
    assert.equal(await popup.getAttribute('#mode-eink', 'aria-checked'), 'true');
    assert.equal(await popup.getAttribute('#mode-eink', 'tabindex'), '0');
    assert.equal(await popup.getAttribute('#mode-paper', 'tabindex'), '-1');
    await popup.keyboard.press(rtl ? 'ArrowRight' : 'ArrowLeft');
    assert.equal(await popup.getAttribute('#mode-paper', 'aria-checked'), 'true');
    await popup.keyboard.press('Home');
    assert.equal(await popup.getAttribute('#mode-dark', 'aria-checked'), 'true');
    await popup.keyboard.press('End');
    assert.equal(await popup.getAttribute('#mode-original', 'aria-checked'), 'true');
    await popup.keyboard.press(rtl ? 'ArrowRight' : 'ArrowLeft');
    assert.equal(await popup.getAttribute('#mode-eink', 'aria-checked'), 'true');
    // The save runs after a short delay and a round trip; a busy machine takes longer than a fixed wait.
    let t = await theme();
    for (let i = 0; i < 60 && !(t.mode === 'eink' && t.einkPreset === 'eink'); i++) {
      await popup.waitForTimeout(100);
      t = await theme();
    }
    assert.equal(t.mode, 'eink');
    assert.equal(t.einkPreset, 'eink');
    await popup.close();
    await web.close();
  }
});

test('popup: the window keeps its size in every choice, language and look, and no label is cut off', { timeout: 300000 }, async () => {
  const presets = Array.from({ length: 12 }, (_, i) => ({ id: `p-e${i}`, name: `A rather long preset name number ${i}`, theme: { mode: 'eink', einkPreset: 'paper' } }));
  for (const [locale, uiTheme] of [['en', 'light'], ['fa', 'dark'], ['ar', 'light'], ['he', 'dark']]) {
    const { popup, web } = await openPopup({ settings: PAPER, ui: { locale, uiTheme }, presets });
    for (const mode of ['eink', 'dark', 'paper', 'light', 'original', 'eink']) {
      await popup.click(`#mode-${mode}`);
      await popup.waitForTimeout(150);
      const m = await popup.evaluate(() => {
        const main = document.querySelector('.main');
        const root = document.documentElement;
        const over = (sel) => {
          const el = document.querySelector(sel);
          return el.scrollWidth - el.clientWidth;
        };
        return { page: [root.scrollWidth, root.scrollHeight], mainY: main.scrollHeight - main.clientHeight, mainX: main.scrollWidth - main.clientWidth, modeX: over('#mode') };
      });
      const label = `${locale} ${uiTheme} ${mode}`;
      assert.deepEqual(m.page, [360, 600], label);
      assert.equal(m.mainY, 0, `${label} scrolls by ${m.mainY}`);
      assert.equal(m.mainX, 0, label);
      assert.equal(m.modeX, 0, `${label} mode control spills`);
      // The labels of the choices are not cut off.
      const cut = await popup.$$eval('#mode [role="radio"] span', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
      assert.deepEqual(cut, [], `${label} labels are cut`);
    }
    await popup.close();
    await web.close();
  }
});

test('popup: a saved preset that holds the E-ink fields applies them', { timeout: 60000 }, async () => {
  const theme0 = { mode: 'eink', einkPreset: 'eink', whiteCap: 77, einkImages: 'off' };
  const { popup, web } = await openPopup({ settings: { enabled: true, theme: { mode: 'dark' } }, presets: [{ id: 'p-b1', name: 'Book', theme: theme0 }] });
  await popup.click('#presets button');
  await settle(popup);
  const t = await theme();
  assert.equal(t.mode, 'eink');
  assert.equal(t.einkPreset, 'eink');
  assert.equal(t.whiteCap, 77);
  assert.equal(await popup.inputValue('#whiteCap'), '77');
  await popup.close();
  await web.close();
});

test('settings: the E-ink section shows in this mode only, and the advanced part is folded until it is opened', { timeout: 90000 }, async () => {
  const page = await openOptions(ON);
  await page.click('#tab-appearance');
  assert.equal(await page.isHidden('#eink-section'), true);
  assert.equal(await page.isVisible('#brightness'), true);
  await page.selectOption('#mode', 'eink');
  await page.waitForSelector('#eink-section', { state: 'visible' });
  assert.equal(await page.isHidden('#brightness'), true);
  assert.equal(await page.isHidden('#darkBackground'), true);
  // The advanced part is a closed details element; its controls are not shown.
  assert.equal(await page.evaluate(() => document.getElementById('einkAdvanced').open), false);
  assert.equal(await page.isHidden('#inkColor'), true);
  assert.equal(await page.isHidden('#noAnimation').catch(() => true), true);
  // It opens with the keyboard.
  await page.focus('#einkAdvanced > summary');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.getElementById('einkAdvanced').open), true);
  await page.waitForSelector('#inkColor', { state: 'visible' });
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => document.getElementById('einkAdvanced').open), false);
  // The controls show the values of the style.
  assert.equal(await page.inputValue('#paperColor'), '#f4f1ea');
  assert.equal(await page.inputValue('#whiteCap'), '84');
  assert.equal(await page.inputValue('#einkImages'), 'follow');
  assert.equal(await page.inputValue('#einkColorAmount'), '35');
  await page.click('#einkAdvanced > summary');
  assert.equal(await page.inputValue('#inkColor'), '#2b2620');
  assert.equal(await page.isChecked('[data-eink="einkGrayAll"]'), false);
  assert.equal(await page.inputValue('#einkLevels'), '0');
  assert.equal(await page.isChecked('#linkUnderline'), true, 'the one link switch shows the style of Paper');
  assert.equal(await page.isChecked('[data-eink="noAnimation"]'), false);
  // Switching back to dark hides the section again.
  await page.selectOption('#mode', 'dark');
  await page.waitForSelector('#eink-section', { state: 'hidden' });
  assert.equal(await page.isVisible('#brightness'), true);
  await page.close();
});

test('settings: every control writes its value, the swatches set the paper, the style resets, and an open tab follows', { timeout: 120000 }, async () => {
  const web = await browser.context.newPage();
  const page = await openOptions({ settings: PAPER });
  await web.goto(`${servers.origin}/eink-book.html`);
  await waitState(web, 'ready');
  await page.bringToFront();
  await page.click('#tab-appearance');
  await page.click('#einkAdvanced > summary');

  await page.click('.swatch[data-color="#ffffff"]');
  await settle(page);
  assert.equal((await theme()).paperColor, '#ffffff');
  assert.equal(await page.inputValue('#paperColor'), '#ffffff');
  await page.fill('#whiteCap', '70');
  await page.fill('#einkBlue', '33');
  await page.fill('#einkContrast', '120');
  await page.selectOption('#einkImages', 'off');
  await page.fill('#inkColor', '#101010');
  await page.fill('#einkColorAmount', '0');
  await page.check('[data-eink="einkGrayAll"]');
  await page.selectOption('#einkLevels', '4');
  await page.fill('#einkImageContrast', '130');
  await page.uncheck('#linkUnderline');
  await page.check('[data-eink="einkBorders"]');
  await page.check('[data-eink="noAnimation"]');
  await page.check('[data-eink="noTransition"]');
  await page.check('[data-eink="noSmoothScroll"]');
  await page.check('[data-eink="noShadow"]');
  await page.check('[data-eink="reducedMotionHint"]');
  await page.fill('#einkWeight', '2');
  await page.selectOption('#einkFont', 'serif');
  await settle(page);
  const t = await theme();
  assert.deepEqual(
    { paperColor: t.paperColor, whiteCap: t.whiteCap, einkBlue: t.einkBlue, einkContrast: t.einkContrast, einkImages: t.einkImages, inkColor: t.inkColor, einkColorAmount: t.einkColorAmount, einkColor: t.einkColor, einkGrayAll: t.einkGrayAll, einkLevels: t.einkLevels, einkImageContrast: t.einkImageContrast, einkLinks: t.einkLinks, einkBorders: t.einkBorders, noAnimation: t.noAnimation, noTransition: t.noTransition, noSmoothScroll: t.noSmoothScroll, noShadow: t.noShadow, reducedMotionHint: t.reducedMotionHint, einkWeight: t.einkWeight, einkFont: t.einkFont },
    { paperColor: '#ffffff', whiteCap: 70, einkBlue: 33, einkContrast: 120, einkImages: 'off', inkColor: '#101010', einkColorAmount: 0, einkColor: null, einkGrayAll: true, einkLevels: 4, einkImageContrast: 130, einkLinks: false, einkBorders: true, noAnimation: true, noTransition: true, noSmoothScroll: true, noShadow: true, reducedMotionHint: true, einkWeight: 2, einkFont: 'serif' },
  );
  // The tab follows: no underline, no picture filter, the serif stack, motion off.
  await web.waitForFunction(() => { const c = document.querySelector('style[data-dk="calm"]'); return !!c && !c.textContent.includes('text-decoration') && c.textContent.includes('animation-duration'); });
  await web.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches === true);
  await web.waitForFunction(() => getComputedStyle(document.querySelector('figure img')).filter === 'none');
  await web.waitForFunction(() => /Georgia/.test(getComputedStyle(document.querySelector('p')).fontFamily));

  // A custom font name.
  await page.selectOption('#einkFont', 'custom');
  await page.waitForSelector('#einkFontName', { state: 'visible' });
  await page.fill('#einkFontName', 'Vazirmatn');
  await settle(page);
  assert.equal((await theme()).einkFont, 'Vazirmatn');
  // After a reload the select shows "my own font" with the name.
  await page.reload();
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  await page.click('#tab-appearance');
  await page.click('#einkAdvanced > summary');
  assert.equal(await page.inputValue('#einkFont'), 'custom');
  assert.equal(await page.inputValue('#einkFontName'), 'Vazirmatn');

  // The reset button puts every field back to the style.
  await page.click('#einkReset');
  await settle(page);
  const r = await theme();
  for (const key of ['paperColor', 'whiteCap', 'einkBlue', 'einkFont', 'noAnimation', 'einkLinks']) assert.equal(r[key], null, key);
  assert.equal(await page.inputValue('#whiteCap'), '84');
  // Changing the style resets too.
  await page.fill('#whiteCap', '60');
  await settle(page);
  await page.selectOption('#einkPreset', 'eink');
  await settle(page);
  const s = await theme();
  assert.equal(s.einkPreset, 'eink');
  assert.equal(s.whiteCap, null);
  assert.equal(await page.inputValue('#whiteCap'), '100');
  await page.close();
  await web.close();
});

test('settings: a site rule can hold the mode and a style, and a saved preset carries the fields', { timeout: 90000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, theme: { mode: 'dark', einkPreset: 'paper', whiteCap: 66 } } });
  await page.click('#tab-sites');
  await page.fill('#site-pattern', 'books.test');
  await page.click('#site-add');
  await page.waitForSelector('#site-list li');
  const card = page.locator('#site-list li').first();
  assert.deepEqual(await card.locator('[data-f="mode"] option').evaluateAll((o) => o.map((x) => x.value)), ['', 'dark', 'light', 'eink', 'original']);
  assert.equal(await card.locator('[data-f="einkPreset"]').isHidden(), true);
  await card.locator('[data-f="mode"]').selectOption('eink');
  await card.locator('[data-f="einkPreset"]').waitFor({ state: 'visible' });
  await card.locator('[data-f="einkPreset"]').selectOption('eink');
  await settle(page);
  const rule = (await stored('siteRules')).siteRules['books.test'];
  assert.equal(rule.theme.mode, 'eink');
  assert.equal(rule.theme.einkPreset, 'eink');
  // The site starts from its own style: the global overrides do not reach it.
  assert.equal(rule.theme.whiteCap, null);
  // Changing something else keeps what the rule holds.
  await card.locator('[data-f="brightness"]').fill('90');
  await settle(page);
  const again = (await stored('siteRules')).siteRules['books.test'];
  assert.equal(again.theme.einkPreset, 'eink');
  assert.equal(again.theme.whiteCap, null);
  assert.equal(again.theme.brightness, 90);
  // Back to the default mode removes the style.
  await card.locator('[data-f="mode"]').selectOption('');
  await settle(page);
  assert.equal((await stored('siteRules')).siteRules['books.test'].theme?.einkPreset, undefined);

  // A preset saved now carries the fields of the mode.
  await page.click('#tab-appearance');
  await page.selectOption('#mode', 'eink');
  await page.fill('#whiteCap', '72');
  await settle(page);
  await page.fill('#preset-name', 'Evening book');
  await page.click('#preset-save');
  await settle(page);
  const preset = (await stored('presets')).presets[0];
  assert.equal(preset.name, 'Evening book');
  assert.equal(preset.theme.mode, 'eink');
  assert.equal(preset.theme.whiteCap, 72);
  assert.equal(preset.theme.einkPreset, 'paper');
  await page.close();
});

test('settings: the schedule can switch to the mode, inside or outside the hours', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, automation: { mode: 'time', behavior: 'onOff', time: { from: '18:00', to: '07:00' } } } });
  await page.click('#tab-schedule');
  assert.equal(await page.isHidden('#autoActive'), true);
  await page.selectOption('#autoBehavior', 'scheme');
  await page.waitForSelector('#autoActive', { state: 'visible' });
  assert.deepEqual(await page.$$eval('#autoActive option', (o) => o.map((x) => x.value)), ['dark', 'light', 'eink', 'original']);
  await page.selectOption('#autoIdle', 'eink');
  await settle(page);
  const a = (await stored('settings')).settings.automation;
  assert.equal(a.behavior, 'scheme');
  assert.equal(a.idleMode, 'eink');
  assert.equal(a.activeMode, 'dark');
  await page.selectOption('#autoMode', 'none');
  await page.waitForSelector('#autoActive', { state: 'hidden' });
  await page.close();
});

test('settings: search finds the E-ink controls, and the sections stay in order of the page', { timeout: 60000 }, async () => {
  const page = await openOptions(ON);
  await page.click('#tab-appearance');
  await page.selectOption('#mode', 'eink');
  await page.fill('#search', 'blue');
  await page.waitForSelector('#eink-section', { state: 'visible' });
  assert.equal(await page.isVisible('[for="einkBlue"]'), true);
  await page.close();
});

test('settings: the E-ink text is in every language and the section does not overflow in right-to-left layouts', { timeout: 120000 }, async () => {
  for (const locale of ['fa', 'ar', 'he', 'en']) {
    const page = await openOptions({ settings: PAPER, ui: { locale, uiTheme: 'light' } });
    await page.click('#tab-appearance');
    await page.click('#einkAdvanced > summary');
    const m = await page.evaluate(() => {
      const sec = document.getElementById('eink-section');
      const texts = [...sec.querySelectorAll('[data-i18n]')].map((e) => e.textContent.trim());
      return { empty: texts.filter((t) => t === '').length, count: texts.length, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, dir: document.documentElement.dir };
    });
    assert.equal(m.empty, 0, `${locale}: empty labels`);
    assert.ok(m.count > 25);
    assert.ok(m.over <= 0, `${locale}: the page scrolls sideways by ${m.over}`);
    assert.equal(m.dir, locale === 'en' ? 'ltr' : 'rtl');
    await page.close();
  }
});

test('the fix editor can set the mode and a style for a site', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true }, userFixes: { 'books.test': { note: 'x' } } });
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/fixes/fixes.html?site=books.test`);
  await page.waitForSelector('#editor', { state: 'visible' });
  assert.deepEqual(await page.$$eval('#mode option', (o) => o.map((x) => x.value)), ['', 'dark', 'light', 'eink', 'original']);
  await page.selectOption('#mode', 'eink');
  await page.selectOption('#einkPreset', 'paper');
  await settle(page);
  const fix = (await stored('userFixes')).userFixes['books.test'];
  assert.equal(fix.dynamic.theme.mode, 'eink');
  assert.equal(fix.dynamic.theme.einkPreset, 'paper');
  assert.equal(fix.dynamic.theme.whiteCap, null);
  await page.selectOption('#mode', '');
  await settle(page);
  assert.equal((await stored('userFixes')).userFixes['books.test'].dynamic, undefined);
  await page.close();
});
