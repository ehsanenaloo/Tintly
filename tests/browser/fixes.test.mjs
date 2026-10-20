import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

let servers;
let browser;
let extId;
let host;

before(async () => {
  servers = await startServers();
  browser = await launch();
  extId = new URL(browser.worker.url()).host;
  host = new URL(servers.origin).host;
});

after(async () => {
  await browser?.close();
  await servers?.close();
});

const stored = (key) => browser.worker.evaluate((k) => chrome.storage.local.get(k), key);
const ON = { settings: { enabled: true } };

async function openWeb(storage, path = '/basic.html') {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}${path}`);
  if (storage.settings?.enabled !== false) await waitState(web, 'ready');
  return web;
}

const color = (web, selector) => web.evaluate((s) => getComputedStyle(document.querySelector(s)).color, selector);

test('custom CSS from the settings and from a site rule is applied last, and removed with the theme', { timeout: 60000 }, async () => {
  const web = await openWeb({ settings: { enabled: true, theme: { css: 'h1 { outline: 3px solid rgb(1, 2, 3) !important; }' } } });
  const outline = () => web.evaluate(() => getComputedStyle(document.querySelector('h1')).outlineColor);
  assert.equal(await outline(), 'rgb(1, 2, 3)');
  assert.equal(await web.evaluate(() => document.querySelectorAll('style[data-dk="css"]').length), 1);

  await web.evaluate(() => chrome?.runtime);
  await browser.setStorage({ siteRules: { [host]: { css: 'h1 { outline: 3px solid rgb(4, 5, 6) !important; }' } } });
  await web.waitForFunction(() => getComputedStyle(document.querySelector('h1')).outlineColor === 'rgb(4, 5, 6)');

  await browser.setStorage({ siteRules: { [host]: { enabled: false } } });
  await waitState(web, null);
  assert.equal(await web.evaluate(() => document.querySelectorAll('style[data-dk]').length), 0);
  await web.close();
});

test('a fix applies its CSS, theme and inversion, and leaves the inline colors it names alone', { timeout: 90000 }, async () => {
  const web = await openWeb(ON);
  await web.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'inl';
    p.style.cssText = 'color:#000;background:#fff';
    p.textContent = 'inline';
    const q = document.createElement('p');
    q.id = 'keep';
    q.className = 'keep';
    q.style.cssText = 'color:#000;background:#fff';
    q.textContent = 'kept';
    const logo = document.createElement('div');
    logo.id = 'logo';
    logo.textContent = 'logo';
    document.body.append(p, q, logo);
  });
  await web.waitForFunction(() => getComputedStyle(document.getElementById('inl')).color !== 'rgb(0, 0, 0)');
  assert.equal(await color(web, '#keep'), await color(web, '#inl'));

  await browser.setStorage({
    userFixes: {
      [host]: { note: 'test', dynamic: { css: '#logo { margin-top: 7px; }', invert: ['#logo'], ignoreInline: ['.keep'] } },
    },
  });
  await web.waitForFunction(() => getComputedStyle(document.getElementById('keep')).color === 'rgb(0, 0, 0)', undefined, { timeout: 15000 });
  assert.notEqual(await color(web, '#inl'), 'rgb(0, 0, 0)');
  assert.equal(await web.evaluate(() => getComputedStyle(document.getElementById('logo')).marginTop), '7px');
  assert.match(await web.evaluate(() => getComputedStyle(document.getElementById('logo')).filter), /invert/);

  await browser.setStorage({ userFixes: { [host]: { engine: 'filter', dynamic: { theme: { mode: 'light' } } } } });
  // The fix names the Filter engine, so the Dynamic engine's sheet copies go away.
  await web.waitForFunction(() => document.querySelectorAll('style[data-dk="sheet"]').length === 0, undefined, { timeout: 15000 });
  assert.ok(await browser.stats(`${servers.origin}/basic.html`), 'an engine is running');
  await web.close();
});

async function openEditor(storage, query = '') {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/fixes/fixes.html${query}`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return page;
}

const settle = (page) => page.waitForTimeout(800);

test('the editor adds a fix for a site, saves edits, and the open page follows', { timeout: 90000 }, async () => {
  const web = await openWeb(ON);
  await web.waitForTimeout(100);
  const page = await openEditor(ON, `?site=${encodeURIComponent(host)}`);
  assert.equal(await page.isVisible('#editor'), true);
  assert.equal((await stored('userFixes')).userFixes, undefined, 'nothing is stored before the first edit');
  assert.equal(await page.textContent('#editor-title'), host);

  await page.fill('#note', 'dark logo');
  await page.fill('#css', 'h1 { outline: 3px solid rgb(9, 8, 7) !important; }');
  await page.fill('#invert', '.logo\n#brand');
  await page.fill('#brightness', '85');
  await page.selectOption('#mode', 'dark');
  await settle(page);
  const fix = (await stored('userFixes')).userFixes[host];
  assert.equal(fix.note, 'dark logo');
  assert.deepEqual(fix.dynamic.invert, ['.logo', '#brand']);
  assert.equal(fix.dynamic.theme.brightness, 85);
  await web.waitForFunction(() => getComputedStyle(document.querySelector('h1')).outlineColor === 'rgb(9, 8, 7)', undefined, { timeout: 15000 });

  // Invalid input is shown and never stored.
  await page.fill('#invert', '.logo\n:::bad((');
  await settle(page);
  assert.equal(await page.isVisible('#invert-error'), true);
  assert.deepEqual((await stored('userFixes')).userFixes[host].dynamic.invert, ['.logo', '#brand']);
  await page.fill('#invert', '.logo');
  await page.fill('#css', 'h1 { color: red; ');
  await settle(page);
  assert.equal(await page.isVisible('#css-error'), true);
  assert.match((await stored('userFixes')).userFixes[host].dynamic.css, /9, 8, 7/);

  // The fix survives a reload of the editor.
  await page.fill('#css', 'h1 { outline: 3px solid rgb(9, 8, 7) !important; }');
  await settle(page);
  await page.reload();
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  assert.equal(await page.inputValue('#note'), 'dark logo');
  assert.equal(await page.inputValue('#invert'), '.logo');

  await page.click('#delete');
  await page.click('#delete');
  await settle(page);
  assert.deepEqual(Object.keys((await stored('userFixes')).userFixes), []);
  assert.equal(await page.isHidden('#editor'), true);
  await page.close();
  await web.close();
});

test('the editor saves the style sheet addresses and the not-dark switch, and refuses a bad address', { timeout: 90000 }, async () => {
  const page = await openEditor(ON, `?site=${encodeURIComponent(host)}`);
  await page.fill('#ignoreCssUrl', '//fonts.example/\ncdn.example/*/icons.css');
  await page.check('#notDark');
  await settle(page);
  const fix = (await stored('userFixes')).userFixes[host];
  assert.deepEqual(fix.dynamic.ignoreCssUrl, ['//fonts.example/', 'cdn.example/*/icons.css']);
  assert.equal(fix.notDark, true);

  // An address with a space is shown as an error and never stored.
  await page.fill('#ignoreCssUrl', 'a bad address');
  await settle(page);
  assert.equal(await page.isVisible('#ignoreCssUrl-error'), true);
  assert.deepEqual((await stored('userFixes')).userFixes[host].dynamic.ignoreCssUrl, ['//fonts.example/', 'cdn.example/*/icons.css']);

  // Both come back after a reload, and the other ids of the page are the same as before.
  await page.fill('#ignoreCssUrl', '//fonts.example/');
  await settle(page);
  await page.reload();
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  assert.equal(await page.inputValue('#ignoreCssUrl'), '//fonts.example/');
  assert.equal(await page.isChecked('#notDark'), true);
  for (const id of ['note', 'engine', 'mode', 'css', 'invert', 'ignoreInline', 'ignoreImage', 'sBg', 'sFg', 'sBorder', 'sSkip']) assert.equal(await page.locator(`#${id}`).count(), 1, id);

  await page.uncheck('#notDark');
  await page.fill('#ignoreCssUrl', '');
  await settle(page);
  const cleared = (await stored('userFixes')).userFixes[host];
  assert.equal(cleared.notDark, undefined);
  assert.equal(cleared.dynamic?.ignoreCssUrl, undefined);
  await page.close();
});

test('a copied fix can be added again from text, and a bad text is refused', { timeout: 60000 }, async () => {
  const page = await openEditor(ON);
  assert.equal(await page.isHidden('#editor'), true);
  await page.fill('#pasted', JSON.stringify({ host: 'example.org', fix: { note: 'pasted', dynamic: { css: 'a { color: red; }' } } }));
  await page.click('#paste-apply');
  await page.waitForSelector('#editor:not([hidden])');
  assert.equal((await stored('userFixes')).userFixes['example.org'].note, 'pasted');
  assert.equal(await page.inputValue('#css'), 'a { color: red; }');

  await page.fill('#pasted', '{"host":"example.org","fix":{"unknown":1}}');
  await page.click('#paste-apply');
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('not a valid fix'));
  await page.fill('#pasted', 'nonsense');
  await page.click('#paste-apply');
  await page.waitForFunction(() => document.getElementById('message').textContent.includes('not a valid fix'));
  await page.close();
});

test('the popup opens the editor for its site', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/basic.html`);
  await waitState(web, 'ready');
  const popup = await browser.context.newPage();
  await popup.goto(`chrome-extension://${extId}/pages/popup/popup.html`);
  await web.bringToFront();
  await popup.reload();
  await popup.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  assert.match(await popup.getAttribute('a[href*="fixes.html"]', 'href'), new RegExp(`\\?site=${encodeURIComponent(host).replace('.', '\\.')}`));
  await popup.close();
  await web.close();
});

test('the editor fits and reads correctly in each language and both color schemes', { timeout: 180000 }, async () => {
  for (const locale of ['en', 'fa', 'ar', 'he']) {
    for (const scheme of ['light', 'dark']) {
      const page = await openEditor({ settings: { enabled: true }, ui: { locale } }, `?site=${host}`);
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [1000, 360]) {
        await page.setViewportSize({ width, height: 800 });
        const fit = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
        assert.ok(fit.w <= fit.c, `${locale} ${scheme} ${width}: sideways scroll ${JSON.stringify(fit)}`);
      }
      assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /\b(fx|opt|popup|fixes)\.[a-zA-Z]+/, `${locale}: a key shows`);
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll('input, select, textarea, button')].filter((el) => !(el.labels?.length || el.getAttribute('aria-label') || el.textContent.trim())).map((el) => el.id),
      );
      assert.deepEqual(unnamed, [], locale);
      await page.close();
    }
  }
});

const TWO = { settings: { enabled: true }, userFixes: { 'a.example.com': { note: 'A' }, 'b.example.com': { note: 'B' } } };
const noteOf = async (name) => (await stored('userFixes')).userFixes[name]?.note;

test('switching records inside the save delay saves the draft to its own record', { timeout: 60000 }, async () => {
  const page = await openEditor(TWO, '?site=a.example.com');
  assert.equal(await page.inputValue('#note'), 'A');
  await page.fill('#note', 'A edited');
  await page.selectOption('#fix-site', 'b.example.com');
  await page.waitForFunction(() => document.getElementById('editor-title').textContent === 'b.example.com');
  assert.equal(await page.inputValue('#note'), 'B');
  await settle(page);
  assert.equal(await noteOf('a.example.com'), 'A edited');
  assert.equal(await noteOf('b.example.com'), 'B');
  await page.close();
});

test('an invalid draft keeps the editor on its record and stores nothing', { timeout: 60000 }, async () => {
  const page = await openEditor(TWO, '?site=a.example.com');
  await page.fill('#invert', ':::bad((');
  await page.selectOption('#fix-site', 'b.example.com');
  await settle(page);
  assert.equal(await page.inputValue('#fix-site'), 'a.example.com');
  assert.equal(await page.textContent('#editor-title'), 'a.example.com');
  assert.equal(await page.isVisible('#invert-error'), true);
  assert.equal(await page.inputValue('#invert'), ':::bad((');
  assert.deepEqual((await stored('userFixes')).userFixes, TWO.userFixes);
  await page.fill('#invert', '.logo');
  await page.selectOption('#fix-site', 'b.example.com');
  await page.waitForFunction(() => document.getElementById('editor-title').textContent === 'b.example.com');
  assert.deepEqual((await stored('userFixes')).userFixes['a.example.com'].dynamic.invert, ['.logo']);
  await page.close();
});

test('copy saves a waiting draft first, and delete drops it for good', { timeout: 60000 }, async () => {
  const page = await openEditor(TWO, '?site=a.example.com');
  await page.fill('#note', 'A copied');
  await page.click('#copy');
  await page.waitForFunction(() => document.getElementById('message').textContent !== '');
  assert.equal(await noteOf('a.example.com'), 'A copied');
  await page.fill('#note', 'A gone');
  await page.click('#delete');
  await page.click('#delete');
  await settle(page);
  assert.equal((await stored('userFixes')).userFixes['a.example.com'], undefined);
  assert.equal(await noteOf('b.example.com'), 'B');
  await page.close();
});

test('adding a site that has a fix opens it and keeps every field', { timeout: 60000 }, async () => {
  const full = { note: 'keep', engine: 'filter', dynamic: { css: 'a { color: red; }', invert: ['.x'] } };
  const page = await openEditor({ settings: { enabled: true }, userFixes: { 'example.com': full } });
  await page.fill('#fix-pattern', 'EXAMPLE.COM');
  await page.click('#fix-add');
  await page.waitForFunction(() => document.getElementById('editor-title').textContent === 'example.com');
  assert.equal(await page.inputValue('#note'), 'keep');
  await settle(page);
  assert.deepEqual((await stored('userFixes')).userFixes, { 'example.com': full });
  await page.fill('#fix-pattern', 'New.Example.org');
  await page.click('#fix-add');
  await page.waitForFunction(() => document.getElementById('editor-title').textContent === 'new.example.org');
  assert.deepEqual((await stored('userFixes')).userFixes['new.example.org'], {});
  await page.close();
});

test('a deleted fix comes back with Undo, with the draft that was open, and a held-CSS fix has none', { timeout: 60000 }, async () => {
  const page = await openEditor(TWO, '?site=a.example.com');
  await page.fill('#note', 'A draft');
  await page.click('#delete');
  await page.click('#delete');
  await page.waitForSelector('#message .say-action');
  assert.equal((await stored('userFixes')).userFixes['a.example.com'], undefined);
  assert.ok((await page.textContent('#message')).includes('Fix for a.example.com deleted'));
  await page.click('#message .say-action');
  await page.waitForFunction(() => document.getElementById('editor-title').textContent === 'a.example.com');
  assert.equal(await noteOf('a.example.com'), 'A draft');
  assert.equal(await page.textContent('#message'), 'Restored.');
  await page.close();

  const held = await openEditor({ settings: { enabled: true }, userFixes: { 'h.example.com': { dynamic: { css: 'a { color: red; }' }, cssHeld: true } } }, '?site=h.example.com');
  await held.click('#delete');
  await held.click('#delete');
  await held.waitForFunction(() => /deleted/.test(document.getElementById('message').textContent));
  assert.equal(await held.locator('#message .say-action').count(), 0);
  await held.close();
});

test('every number field shows its allowed range from the limits', { timeout: 60000 }, async () => {
  const page = await openEditor(TWO, '?site=a.example.com');
  for (const [id, text] of [['brightness', '50 to 150'], ['contrast', '50 to 150'], ['sepia', '0 to 100'], ['grayscale', '0 to 100']]) {
    assert.equal(await page.textContent(`#${id}-range`), text, id);
    assert.equal(await page.getAttribute(`#${id}`, 'aria-describedby'), `${id}-range`);
  }
  await page.close();
});

test('no color transition is left running when the editor shows, in the dark look', { timeout: 60000 }, async () => {
  for (let i = 0; i < 4; i++) {
    const page = await openEditor({ settings: { enabled: true }, ui: { locale: 'en', uiTheme: 'dark' }, userFixes: { 'a.example.com': { note: 'A' } } }, '?site=a.example.com');
    assert.deepEqual(await page.evaluate(() => document.getAnimations().map((a) => a.transitionProperty)), []);
    await page.close();
  }
});
