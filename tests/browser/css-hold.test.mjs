import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const MARK = 'html{border-left:7px solid rgb(1, 2, 3)}';
const MARK_SITE = 'body{border-top:9px solid rgb(4, 5, 6)}';
const MARK_FIX = 'body{border-bottom:11px solid rgb(7, 8, 9)}';

async function openOptions(storage = { settings: { enabled: true } }) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/options/options.html`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  return page;
}

async function openWeb() {
  const web = await browser.context.newPage();
  await web.goto(`${servers.origin}/basic.html`);
  await waitState(web, 'ready');
  return web;
}

/** What the page shows of the three marks: [global, site rule, site fix]. */
const marks = (web) =>
  web.evaluate(() => [getComputedStyle(document.documentElement).borderLeftWidth, getComputedStyle(document.body).borderTopWidth, getComputedStyle(document.body).borderBottomWidth]);

const heldStorage = () => ({
  settings: { enabled: true, cssHeld: true, theme: { css: MARK } },
  siteRules: { [host]: { css: MARK_SITE, cssHeld: true } },
  userFixes: { [host]: { dynamic: { css: MARK_FIX }, cssHeld: true } },
});

test('CSS typed on this device before the hold existed stays on', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({
    settings: { enabled: true, theme: { css: MARK } },
    siteRules: { [host]: { css: MARK_SITE } },
    userFixes: { [host]: { dynamic: { css: MARK_FIX } } },
  });
  const web = await openWeb();
  assert.deepEqual(await marks(web), ['7px', '9px', '11px']);
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/options/options.html`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  assert.equal(await page.isHidden('#css-hold'), true);
  await page.close();
  await web.close();
});

test('held CSS is not applied, shows in the notice, and one click after the review turns it on', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(heldStorage());
  const web = await openWeb();
  assert.deepEqual(await marks(web), ['0px', '0px', '0px'], 'held CSS is off');
  assert.equal(await web.evaluate(() => document.querySelector('style[data-dk="css"]') !== null), false);

  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/options/options.html`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  assert.equal(await page.isVisible('#css-hold'), true);
  assert.equal(await page.locator('#hold-list > li').count(), 3);
  assert.equal(await page.isVisible('#css-held'), false, 'the hint under the field is on the Advanced tab');
  await page.click('#tab-advanced');
  assert.equal(await page.isVisible('#css-held'), true);

  const first = page.locator('#hold-list > li').first();
  assert.equal(await first.locator('button.btn-primary').isHidden(), true, 'nothing to turn on before the CSS is shown');
  assert.equal(await first.locator('pre').isHidden(), true);
  await first.locator('button').first().click();
  assert.equal(await first.locator('pre').textContent(), MARK);
  assert.equal(await first.locator('pre').getAttribute('dir'), 'ltr');
  await first.locator('button.btn-primary').click();
  await page.waitForFunction(() => document.querySelectorAll('#hold-list > li').length === 2);
  await web.waitForFunction(() => getComputedStyle(document.documentElement).borderLeftWidth === '7px');
  assert.deepEqual(await marks(web), ['7px', '0px', '0px'], 'only the reviewed CSS is on');
  assert.equal((await stored('settings')).settings.cssHeld, false);
  assert.equal((await stored('siteRules')).siteRules[host].cssHeld, true);

  for (let left = 1; left >= 0; left--) {
    const row = page.locator('#hold-list > li').first();
    await row.locator('button').first().click();
    await row.locator('button.btn-primary').click();
    await page.waitForFunction((n) => document.querySelectorAll('#hold-list > li').length === n, left);
  }
  assert.equal(await page.isHidden('#css-hold'), true);
  await web.waitForFunction(() => getComputedStyle(document.body).borderBottomWidth === '11px');
  assert.deepEqual(await marks(web), ['7px', '9px', '11px']);
  const after = await stored(['siteRules', 'userFixes']);
  assert.equal(after.siteRules[host].css, MARK_SITE);
  assert.equal(after.siteRules[host].cssHeld, undefined);
  assert.equal(after.userFixes[host].cssHeld, undefined);
  await page.close();
  await web.close();
});

test('a file imported in the settings page arrives off, says so, and the CSS comes on after the review', { timeout: 90000 }, async () => {
  const page = await openOptions();
  const dir = mkdtempSync(join(tmpdir(), 'dk-hold-'));
  const file = join(dir, 'in.json');
  writeFileSync(
    file,
    JSON.stringify({
      app: 'tintly',
      schemaVersion: 1,
      settings: { theme: { css: MARK } },
      siteRules: { [host]: { css: MARK_SITE } },
      userFixes: { [host]: { dynamic: { css: MARK_FIX } } },
    }),
  );
  await page.click('#tab-data');
  await page.setInputFiles('#import', file);
  await page.waitForSelector('#import-box:not([hidden])');
  assert.match(await page.textContent('#import-summary'), /stay off until you turn it on/);
  assert.equal(await page.isHidden('#css-hold'), true, 'a preview changes nothing');
  await page.click('#import-apply');
  await page.waitForFunction(() => !document.getElementById('css-hold').hidden);
  assert.equal(await page.locator('#hold-list > li').count(), 3);
  assert.match(await page.textContent('#message'), /off until you turn it on/);
  const s = await stored(['settings', 'siteRules', 'userFixes']);
  assert.equal(s.settings.theme.css, MARK, 'the text is kept');
  assert.deepEqual([s.settings.cssHeld, s.siteRules[host].cssHeld, s.userFixes[host].cssHeld], [true, true, true]);
  const web = await openWeb();
  assert.deepEqual(await marks(web), ['0px', '0px', '0px']);
  await web.close();
  await page.close();
});

test('a row stays open while other settings change, and shows the new CSS when the held CSS changes', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, cssHeld: true, theme: { css: MARK } } });
  const row = page.locator('#hold-list > li').first();
  await row.locator('button').first().click();
  await browser.setStorage({ settings: { enabled: true, cssHeld: true, theme: { css: MARK, brightness: 90 } } });
  await page.waitForFunction(() => document.getElementById('brightness').value === '90');
  assert.equal(await row.locator('pre').isVisible(), true, 'an unrelated change does not close the review');
  const changed = 'html{border-left:1px solid red}';
  await browser.setStorage({ settings: { enabled: true, cssHeld: true, theme: { css: changed } } });
  await page.waitForFunction((text) => document.querySelector('#hold-list pre')?.textContent === text, changed);
  assert.equal(await page.locator('#hold-list > li').first().locator('pre').isHidden(), true, 'a changed CSS has to be read again');
  assert.equal((await stored('settings')).settings.cssHeld, true);
  await page.close();
});

test('turning on CSS that is not the CSS that was shown is refused by the worker', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, cssHeld: true, theme: { css: MARK } } });
  const reply = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'dk.css.enable', scope: 'settings', css: 'html{}' }));
  assert.deepEqual(reply, { ok: false, code: 'changed' });
  assert.equal((await stored('settings')).settings.cssHeld, true);
  await page.close();
});

test('editing a held field keeps it held; emptying it ends the hold', { timeout: 60000 }, async () => {
  const page = await openOptions({ settings: { enabled: true, cssHeld: true, theme: { css: MARK } } });
  await page.click('#tab-advanced');
  await page.fill('#css', 'html{border-left:2px solid rgb(1, 2, 3)}');
  await page.waitForTimeout(600);
  const kept = await stored('settings');
  assert.equal(kept.settings.cssHeld, true);
  assert.equal(kept.settings.theme.css, 'html{border-left:2px solid rgb(1, 2, 3)}');
  assert.equal(await page.locator('#hold-list > li').count(), 1);
  await page.fill('#css', '');
  await page.waitForFunction(() => document.getElementById('css-hold').hidden);
  assert.equal((await stored('settings')).settings.cssHeld, false);
  await page.fill('#css', MARK);
  await page.waitForTimeout(600);
  assert.equal((await stored('settings')).settings.cssHeld, false, 'CSS typed by the person is on at once');
  assert.equal(await page.isHidden('#css-hold'), true);
  await page.close();
});

test('a held site card says so, and saving the card keeps the hold', { timeout: 60000 }, async () => {
  const page = await openOptions(heldStorage());
  await page.click('#tab-sites');
  const card = page.locator('#site-list > li').first();
  await card.locator('.site-toggle').click();
  assert.equal(await card.locator('.held').isVisible(), true);
  await card.locator('select[data-f="enabled"]').selectOption('on');
  await page.waitForTimeout(600);
  const rule = (await stored('siteRules')).siteRules[host];
  assert.equal(rule.enabled, true);
  assert.equal(rule.cssHeld, true);
  assert.equal(await card.locator('.held').isVisible(), true);
  await page.close();
});

test('the notice fits in every language, both color schemes and a narrow window', { timeout: 240000 }, async () => {
  for (const locale of ['en', 'fa', 'ar', 'he']) {
    for (const scheme of ['light', 'dark']) {
      const page = await openOptions({ ...heldStorage(), ui: { locale } });
      await page.emulateMedia({ colorScheme: scheme });
      for (const row of await page.locator('#hold-list > li').all()) await row.locator('button').first().click();
      for (const width of [1000, 360]) {
        await page.setViewportSize({ width, height: 800 });
        const fit = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
        assert.ok(fit.w <= fit.c, `${locale} ${scheme} ${width}: sideways scroll ${JSON.stringify(fit)}`);
        const box = await page.evaluate(() => {
          const card = document.getElementById('css-hold').getBoundingClientRect();
          return [...document.querySelectorAll('#css-hold button, #css-hold pre')].every((el) => {
            const r = el.getBoundingClientRect();
            return r.left >= card.left - 1 && r.right <= card.right + 1;
          });
        });
        assert.equal(box, true, `${locale} ${scheme} ${width}: a control leaves the notice`);
      }
      const text = await page.evaluate(() => document.getElementById('css-hold').innerText);
      assert.doesNotMatch(text, /\bopt\.[a-zA-Z]+/, `${locale}: a key shows`);
      assert.equal(await page.evaluate(() => document.documentElement.dir), locale === 'en' ? 'ltr' : 'rtl');
      const names = await page.evaluate(() => [...document.querySelectorAll('#css-hold button')].every((b) => b.textContent.trim() !== ''));
      assert.equal(names, true);
      await page.close();
    }
  }
});
