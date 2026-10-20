// The page's own dark theme: found in the sheets, switched on without touching the page, kept only when it reads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, paintedLightness } from './harness.mjs';

let servers;
let browser;
let helper;

before(async () => {
  servers = await startServers();
  browser = await launch();
  helper = await browser.context.newPage();
  await helper.goto('about:blank');
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const ON = { settings: { enabled: true } };

const rgb = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return p.slice(0, 3);
};
const lum = (css) => {
  const [r, g, b] = rgb(css).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const style = (page, selector, prop) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [selector, prop]);

async function open(path, storage = ON) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  const url = `${servers.origin}${path}`;
  await page.goto(url);
  await waitState(page, 'ready', 30000);
  return { page, url };
}

test('rules inside the dark media query are switched on: the site colors show, not ours', { timeout: 60000 }, async () => {
  const { page, url } = await open('/site-dark-media.html');
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  assert.equal(s.siteDark.reason, 'ok');
  assert.ok(s.siteDark.media >= 1);
  assert.ok(s.siteDark.contrast >= 4.5);
  // The check with the site's rules and the check without them share one switch of the engine styles (one page restyle less).
  const assessments = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => globalThis.__dk?.sitetheme?.stats().assessments ?? -1 });
    return r.result;
  }, url);
  assert.equal(assessments, 1);
  // The page's own values, exactly, and the later light block of the original sheet does not win.
  assert.equal(await style(page, 'body', 'backgroundColor'), 'rgb(16, 20, 24)');
  assert.equal(await style(page, 'body', 'color'), 'rgb(232, 234, 237)');
  assert.equal(await style(page, '#card', 'backgroundColor'), 'rgb(27, 33, 40)');
  assert.equal(await style(page, '#link', 'color'), 'rgb(138, 180, 248)');
  // Only the scheme hint and the copy of the dark rules are ours; the themed copies and the inline work are gone.
  const counts = await page.evaluate(() => ({
    themed: document.querySelectorAll('style[data-dk="sheet"]').length,
    site: document.querySelectorAll('style[data-dk="site"]').length,
    inline: document.querySelectorAll('style[data-dk="inline"]').length,
    early: document.querySelectorAll('style[data-dk="early"]').length,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    attrs: document.documentElement.getAttributeNames().filter((n) => !n.startsWith('data-dk')),
    classes: document.documentElement.className,
  }));
  assert.deepEqual({ themed: counts.themed, site: counts.site, inline: counts.inline, early: counts.early }, { themed: 0, site: 1, inline: 0, early: 0 });
  assert.equal(counts.scheme, 'dark');
  assert.deepEqual(counts.attrs, ['lang']);
  assert.equal(counts.classes, '');
  await page.close();
});

test('rules that depend on a state of the root apply without the state, in a linked sheet, on the first load and from the cache', { timeout: 90000 }, async () => {
  const { page, url } = await open('/site-dark-state.html');
  for (const load of ['first', 'cached']) {
    if (load === 'cached') {
      await page.reload();
      await waitState(page, 'ready', 30000);
    }
    const s = await browser.stats(url);
    assert.equal(s.siteDark.state, 'on', `${load}: ${JSON.stringify(s.siteDark)}`);
    assert.ok(s.siteDark.selectors >= 3);
    assert.equal(await style(page, 'body', 'backgroundColor'), 'rgb(16, 20, 24)', load);
    assert.equal(await style(page, '#card', 'backgroundColor'), 'rgb(27, 33, 40)', load);
    assert.equal(await style(page, '#link', 'color'), 'rgb(138, 180, 248)', load);
    // The light state of the page is not on, and the page has no attribute added.
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-theme')), false);
    assert.notEqual(await style(page, '#card', 'outlineStyle'), 'solid');
    if (load === 'cached') assert.equal(s.textSheets >= 1, true, JSON.stringify({ text: s.textSheets, cssom: s.cssomSheets }));
  }
  await page.close();
});

test('a linked sheet that arrives after the page was parsed still gives the page its own dark theme', { timeout: 90000 }, async () => {
  const { page, url } = await open('/site-dark-slow.html');
  // The verdict waits for the sheet; it is not "none" because the sheet was not there yet.
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(16, 20, 24)', undefined, { timeout: 20000 });
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  assert.equal(await style(page, '#card', 'backgroundColor'), 'rgb(27, 33, 40)');
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-theme')), false);
  await page.close();
});

test('a linked sheet with no dark theme that arrives late ends the wait with "none" and the page is themed', { timeout: 90000 }, async () => {
  const { page, url } = await open('/site-dark-slow-plain.html');
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk="sheet"]').length > 0, undefined, { timeout: 20000 });
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)', undefined, { timeout: 20000 });
  let s = await browser.stats(url);
  const deadline = Date.now() + 15000;
  while (s.siteDark.state === 'pending' && Date.now() < deadline) {
    await page.waitForTimeout(100);
    s = await browser.stats(url);
  }
  assert.equal(s.siteDark.state, 'off', JSON.stringify(s.siteDark));
  assert.equal(s.siteDark.reason, 'none');
  assert.ok(lum(await style(page, 'body', 'backgroundColor')) < 0.12);
  await page.close();
});

test('a class on the root: the dark rules apply, a component variant and a light class do not', { timeout: 60000 }, async () => {
  const { page, url } = await open('/site-dark-class.html');
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  assert.ok(s.siteDark.selectors >= 3);
  assert.equal(await style(page, 'body', 'backgroundColor'), 'rgb(16, 20, 24)');
  // `.card.dark` is a variant of the card, not a state of the page: the card is not red.
  assert.equal(await style(page, '#card', 'backgroundColor'), 'rgb(27, 33, 40)');
  assert.equal(await style(page, '#link', 'color'), 'rgb(138, 180, 248)');
  assert.equal(await page.evaluate(() => document.documentElement.className), '');
  await page.close();
});

test('color-scheme and light-dark() are found, and the dark side shows', { timeout: 60000 }, async () => {
  const { page, url } = await open('/site-dark-scheme.html');
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  assert.ok(s.siteDark.scheme >= 1);
  assert.ok(s.siteDark.lightDark >= 4);
  assert.equal(await style(page, 'body', 'backgroundColor'), 'rgb(14, 17, 22)');
  assert.equal(await style(page, '#card', 'backgroundColor'), 'rgb(26, 32, 40)');
  await page.close();
});

test('a dark theme that does not read falls back to our theme, with every copy of the dark rules removed', { timeout: 60000 }, async () => {
  const { page, url } = await open('/site-dark-broken.html');
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'off', JSON.stringify(s.siteDark));
  assert.equal(s.siteDark.reason, 'gate');
  assert.ok(s.siteDark.media >= 1);
  assert.ok(s.siteDark.contrast < 4.5, `contrast ${s.siteDark.contrast}`);
  const bg = await style(page, 'body', 'backgroundColor');
  const fg = await style(page, '#text', 'color');
  assert.notEqual(bg, 'rgb(16, 20, 24)');
  assert.ok(lum(bg) < 0.12, bg);
  assert.ok(ratio(bg, fg) >= 4.5, `${fg} on ${bg}`);
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="site"]').length), 0);
  assert.ok((await page.evaluate(() => document.querySelectorAll('style[data-dk="sheet"]').length)) >= 1);
  await page.close();
});

test('a page whose elements all have transitions keeps its own dark theme: the reads see the page colors, not a fade', { timeout: 60000 }, async () => {
  const { page, url } = await open('/site-dark-transitions.html');
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  assert.equal(s.siteDark.reason, 'ok');
  // The page's own fade from the first look to its dark theme (0.4 s) is the page's and runs out.
  await page.waitForTimeout(1000);
  assert.equal(await style(page, 'body', 'backgroundColor'), 'rgb(16, 20, 24)');
  // No transition that a read started is left running.
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
  assert.equal(running, 0);
  await page.close();
});

test('a dark rule that does not make the page dark falls back to our theme', { timeout: 60000 }, async () => {
  const { page, url } = await open('/site-dark-partial.html');
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'off', JSON.stringify(s.siteDark));
  assert.ok(lum(await style(page, 'body', 'backgroundColor')) < 0.12);
  assert.ok(lum(await style(page, '#card', 'backgroundColor')) < 0.2);
  await page.close();
});

test('a page with no dark theme is themed as before', { timeout: 60000 }, async () => {
  const { page, url } = await open('/basic.html');
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'off');
  assert.equal(s.siteDark.reason, 'none');
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="site"]').length), 0);
  assert.ok(lum(await style(page, 'body', 'backgroundColor')) < 0.12);
  await page.close();
});

test('color-scheme only light keeps the page out of the switch', { timeout: 60000 }, async () => {
  // With the respect for `only light` off (it is on by default and leaves such a page alone), the page goes through the engine.
  const { page, url } = await open('/site-dark-onlylight.html', { settings: { enabled: true, respectOnlyLight: false } });
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'off');
  assert.equal(s.siteDark.reason, 'only-light');
  assert.notEqual(await style(page, 'body', 'backgroundColor'), 'rgb(16, 20, 24)');
  assert.ok(lum(await style(page, 'body', 'backgroundColor')) < 0.12);
  await page.close();
});

test('the switch in the settings turns the whole thing off, and the light mode does not use a dark theme', { timeout: 90000 }, async () => {
  const off = await open('/site-dark-media.html', { settings: { enabled: true, theme: { useSiteDark: false } } });
  let s = await browser.stats(off.url);
  assert.equal(s.siteDark.state, 'off');
  assert.equal(s.siteDark.reason, 'disabled');
  assert.notEqual(await style(off.page, 'body', 'backgroundColor'), 'rgb(16, 20, 24)');
  assert.ok(lum(await style(off.page, 'body', 'backgroundColor')) < 0.12);
  // Turned on again while the page is open: the engine is rebuilt and the page's own colors come back.
  await browser.setStorage({ settings: { enabled: true, theme: { useSiteDark: true } } });
  await off.page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(16, 20, 24)', undefined, { timeout: 15000 });
  s = await browser.stats(off.url);
  assert.equal(s.siteDark.state, 'on');
  await off.page.close();

  const light = await open('/site-dark-media.html', { settings: { enabled: true, theme: { mode: 'light' } } });
  s = await browser.stats(light.url);
  assert.equal(s.siteDark.state, 'off');
  assert.equal(s.siteDark.reason, 'disabled');
  await light.page.close();
});

test('the CSSOM path writes the same result as the text path', { timeout: 120000 }, async () => {
  for (const path of ['/site-dark-media.html', '/site-dark-class.html', '/site-dark-scheme.html', '/site-dark-state.html']) {
    const { page, url } = await open(path);
    const text = await browser.stats(url);
    const colors = (p) => p.evaluate(() => ['body', '#card'].map((s) => getComputedStyle(document.querySelector(s)).backgroundColor).join('|'));
    const viaText = await colors(page);
    const cssom = await browser.restartEngine(url, { textPath: false });
    assert.equal(cssom.siteDark.state, 'on', `${path}: ${JSON.stringify(cssom.siteDark)}`);
    assert.equal(cssom.textSheets, 0);
    assert.ok(cssom.cssomSheets >= 1);
    assert.equal(await colors(page), viaText, path);
    for (const key of ['media', 'selectors', 'scheme', 'lightDark']) assert.equal(cssom.siteDark[key], text.siteDark[key], `${path} ${key}`);
    await page.close();
  }
});

test('the choice is made before the first frame of the page is drawn: no light frame, with the switch or after the fallback', { timeout: 120000 }, async () => {
  for (const path of ['/site-dark-media.html', '/site-dark-state.html', '/site-dark-broken.html', '/site-dark-class.html']) {
    await browser.clearStorage();
    await browser.setStorage(ON);
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/dark.html`);
    const lightness = await paintedLightness(page, helper, async () => {
      await page.goto(`${servers.origin}${path}`);
      await waitState(page, 'ready', 30000);
    });
    console.log(`# ${path}: ${lightness.length} frames, ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
    assert.ok(lightness.length >= 1);
    assert.deepEqual(lightness.filter((v) => v > 0.5), [], `${path} showed a light frame`);
    await page.close();
  }
});

test('the dark scheme query answers yes while the page may use its own dark theme, and nothing else is touched', { timeout: 90000 }, async () => {
  const { page } = await open('/site-dark-js.html');
  const read = () => page.evaluate(() => ({ dark: window.dark.matches, light: window.light.matches, wide: window.wide.matches, motion: window.motion.matches, events: window.events.slice() }));
  const on = await read();
  assert.equal(on.dark, true);
  assert.equal(on.light, false);
  assert.equal(on.wide, true);
  assert.equal(on.motion, false);
  assert.deepEqual(on.events, [['dark', true, true], ['light', false, false]]);
  // A query written another way is not ours.
  assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark) and (min-width: 1px)').matches), false);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-contrast: more)').matches), false);
  // The system turning dark changes nothing for the page while the hint is on: no event, the same answer.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  assert.equal((await read()).events.length, 2);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  assert.equal((await read()).events.length, 2);
  // The switch turned off: the browser's answer comes back and the listeners are told once.
  await browser.setStorage({ settings: { enabled: true, theme: { useSiteDark: false } } });
  await page.waitForFunction(() => window.dark.matches === false, undefined, { timeout: 15000 });
  const off = await read();
  assert.equal(off.light, true);
  assert.deepEqual(off.events.slice(2), [['dark', false, false], ['light', true, true]]);
  // The page got no class or attribute for this.
  assert.equal(await page.evaluate(() => document.documentElement.className + document.body.className), '');
  await page.close();
});
