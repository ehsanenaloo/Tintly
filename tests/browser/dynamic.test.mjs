import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, collect } from './harness.mjs';
import { loadContent } from '../helpers/content.mjs';

const dk = await loadContent('engine/color.js');
const C = dk.color;
const ratio = (a, b) => C.contrastRatio({ r: a.r / 255, g: a.g / 255, b: a.b / 255, a: 1 }, { r: b.r / 255, g: b.g / 255, b: b.b / 255, a: 1 });
const lightness = (c) => C.toOklch({ r: c.r / 255, g: c.g / 255, b: c.b / 255, a: 1 })[0];

let servers;
let browser;
const URL_BASIC = () => `${servers.origin}/basic.html`;

before(async () => {
  servers = await startServers();
  browser = await launch();
  console.log(`# browser ${browser.browserVersion}`);
});

after(async () => {
  await browser?.close();
  await servers?.close();
});

/** Open a page with these stored settings and wait for the engine (or for nothing, when it is off). */
async function open(url, storage, { expect = 'ready' } = {}) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(url);
  if (expect === 'ready') await waitState(page, 'ready');
  else await page.waitForLoadState('load');
  return { page, problems };
}

const ON = { settings: { enabled: true } };
const OFF = { settings: { enabled: false } };

test('the page gets a dark canvas and readable text', { timeout: 60000 }, async () => {
  const base = await open(URL_BASIC(), OFF, { expect: 'off' });
  const before = await collect(base.page);
  await base.page.close();
  const themed = await open(URL_BASIC(), ON);
  const after = await collect(themed.page);
  assert.deepEqual(themed.problems, []);

  assert.ok(lightness(after.canvas) < 0.35, `canvas lightness ${lightness(after.canvas)}`);

  let checked = 0;
  for (let i = 0; i < before.rows.length; i++) {
    const b = before.rows[i];
    const a = after.rows[i];
    if (!b.color || !a.color || !b.bg || !a.bg) continue;
    const was = ratio(b.color, b.bg);
    const now = ratio(a.color, a.bg);
    // Text that was readable stays readable; text that was weak does not get worse than it was.
    if (was >= 4.5) assert.ok(now >= 4.5, `${b.tag}.${b.cls} contrast ${was.toFixed(2)} became ${now.toFixed(2)}`);
    else assert.ok(now >= Math.min(was, 3) - 0.01, `${b.tag}.${b.cls} weak contrast ${was.toFixed(2)} became ${now.toFixed(2)}`);
    checked++;
  }
  assert.ok(checked > 20, `only ${checked} text elements were checked`);

  const text = after.rows.filter((r) => r.color);
  const light = text.filter((r) => lightness(r.color) > 0.5).length;
  assert.ok(light / text.length > 0.7, 'most text should be light on the dark page');
  await themed.page.close();
});

test('no box moves or changes size', { timeout: 60000 }, async () => {
  const base = await open(URL_BASIC(), OFF, { expect: 'off' });
  const before = await collect(base.page);
  await base.page.close();
  const themed = await open(URL_BASIC(), ON);
  const after = await collect(themed.page);
  assert.equal(after.rows.length, before.rows.length);
  const moved = [];
  before.rows.forEach((b, i) => {
    const a = after.rows[i];
    if (b.rect.some((v, k) => Math.abs(v - a.rect[k]) > 0.5)) moved.push(`${b.tag}.${b.cls} ${b.rect} -> ${a.rect}`);
  });
  assert.deepEqual(moved, []);
  await themed.page.close();
});

test('turning the site off removes everything and restores the original DOM', { timeout: 60000 }, async () => {
  const base = await open(URL_BASIC(), OFF, { expect: 'off' });
  const original = (await collect(base.page)).html;
  await base.page.close();

  const { page } = await open(URL_BASIC(), ON);
  assert.ok((await page.$$('style[data-dk]')).length >= 3);
  assert.ok((await page.$$('[data-dk-i], [data-dk-j]')).length >= 2);
  await browser.setStorage({ settings: { enabled: false } });
  await waitState(page, null);
  assert.equal((await page.$$('style[data-dk]')).length, 0);
  assert.equal((await page.$$('[data-dk-i], [data-dk-j]')).length, 0);
  assert.equal((await collect(page)).html, original);

  // And on again, without a reload.
  await browser.setStorage({ settings: { enabled: true } });
  await waitState(page, 'ready');
  assert.ok((await page.$$('style[data-dk]')).length >= 3);
  await page.close();
});

test('a switched-off site gets no marker, no element and no attribute', { timeout: 60000 }, async () => {
  const { page } = await open(URL_BASIC(), OFF, { expect: 'off' });
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk-state], [data-dk-i], style[data-dk]').length), 0);
  assert.equal(await browser.stats(URL_BASIC()), null);
  await page.close();
});

test('a rule for the site turns it off, and a rule for the site can turn the list mode around', { timeout: 60000 }, async () => {
  const host = new URL(servers.origin).host;
  const off = await open(URL_BASIC(), { settings: { enabled: true }, siteRules: { [host]: { enabled: false } } }, { expect: 'off' });
  assert.equal(await off.page.evaluate(() => document.querySelectorAll('[data-dk-state]').length), 0);
  await off.page.close();

  const only = await open(URL_BASIC(), { settings: { enabled: true, listMode: 'onlyListed' } }, { expect: 'off' });
  assert.equal(await only.page.evaluate(() => document.querySelectorAll('[data-dk-state]').length), 0);
  await only.page.close();

  const listed = await open(URL_BASIC(), { settings: { enabled: true, listMode: 'onlyListed' }, siteRules: { [host]: { enabled: true } } });
  assert.ok((await listed.page.$$('style[data-dk]')).length >= 3);
  await listed.page.close();
});

test('rules keep the cascade: a later inherit still wins, and relative URLs are resolved', { timeout: 60000 }, async () => {
  const { page } = await open(URL_BASIC(), ON);
  const r = await page.evaluate(() => {
    const later = getComputedStyle(document.querySelector('.later')).color;
    const body = getComputedStyle(document.body).color;
    const logo = document.createElement('div');
    logo.className = 'logo';
    document.body.append(logo);
    const image = getComputedStyle(logo).backgroundImage;
    logo.remove();
    return { later, body, image };
  });
  assert.equal(r.later, r.body);
  assert.match(r.image, /\/img\/dot\.svg/);
  await page.close();
});

test('print keeps the original colors', { timeout: 60000 }, async () => {
  const { page } = await open(URL_BASIC(), ON);
  await page.emulateMedia({ media: 'print' });
  const [bg, color] = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color]);
  assert.equal(bg, 'rgb(255, 255, 255)');
  assert.equal(color, 'rgb(0, 0, 0)');
  await page.close();
});

test('light mode makes dark pages light', { timeout: 60000 }, async () => {
  const { page } = await open(URL_BASIC(), { settings: { enabled: true, theme: { mode: 'light' } } });
  const after = await collect(page);
  assert.ok(lightness(after.canvas) > 0.8, `canvas lightness ${lightness(after.canvas)}`);
  await page.close();
});

test('a theme change reaches the open page without a reload', { timeout: 60000 }, async () => {
  const { page } = await open(URL_BASIC(), ON);
  const dark = lightness((await collect(page)).canvas);
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'light' } } });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready');
  await page.waitForFunction(() => getComputedStyle(document.documentElement).backgroundColor !== 'rgb(22, 24, 29)');
  assert.ok(lightness((await collect(page)).canvas) > dark + 0.4);
  await page.close();
});

test('styles added, edited and removed later are followed', { timeout: 60000 }, async () => {
  const { page } = await open(`${servers.origin}/dynamic.html`, ON);
  const colorOf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).color, sel);
  const bgOf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
  const copies = () => page.evaluate(() => document.querySelectorAll('style[data-dk="sheet"]').length);

  // Added after load: a style element, and a link.
  await page.waitForFunction(() => document.querySelector('link[href="/late.css"]')?.sheet);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.late-style')).color !== 'rgb(183, 28, 28)');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.late-link')).color !== 'rgb(13, 71, 161)');
  assert.notEqual(await bgOf('.late-style'), 'rgb(255, 235, 238)');

  // Edited text.
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.edited')).color !== 'rgb(17, 17, 17)');
  const before = await colorOf('.edited');
  await page.evaluate(() => window.editStyle());
  await page.waitForFunction((was) => getComputedStyle(document.querySelector('.edited')).color !== was, before);
  assert.notEqual(await colorOf('.edited'), 'rgb(0, 77, 64)');

  // Removed.
  const n = await copies();
  await page.evaluate(() => window.removeLate());
  await page.waitForFunction((count) => document.querySelectorAll('style[data-dk="sheet"]').length < count, n);

  // Inline style set later, and a style added inside the body.
  await page.evaluate(() => window.setInline());
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.inline-late')).color !== 'rgb(136, 14, 79)');
  await page.evaluate(() => window.addBodyStyle());
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.body-style')).color !== 'rgb(26, 35, 126)');
  await page.close();
});

test('a style-src policy on the page does not stop the override sheets', { timeout: 60000 }, async () => {
  const { page } = await open(`${servers.origin}/csp/basic.html`, ON);
  const blocked = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(blocked, 'rgb(255, 255, 255)');
  assert.ok((await page.$$('style[data-dk]')).length >= 2);
  await page.close();
});

test('a sheet from another origin does no harm, whether the browser lets the engine read it or not', { timeout: 60000 }, async () => {
  const { page, problems } = await open(`${servers.origin}/dynamic.html`, ON);
  await page.evaluate((u) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = `${u}/css/linked.css`;
    document.head.append(l);
  }, servers.other);
  await page.waitForFunction(() => document.querySelector('link[href$="linked.css"]')?.sheet);
  await new Promise((r) => setTimeout(r, 300));
  const stats = await browser.stats(`${servers.origin}/dynamic.html`);
  // Chromium lets the content script read the rules of a sheet from another origin. Firefox is expected to refuse; the worker then supplies the text.
  console.log(`# cross-origin sheet: unreadable=${stats.unreadable} fetched=${stats.fetched} sheets=${stats.sheets}`);
  assert.equal(stats.faults, 0);
  assert.ok(stats.fetched >= 1 || stats.sheets >= 5, JSON.stringify(stats));
  assert.deepEqual(problems, []);
  await page.close();
});

test('a large page is done in short slices', { timeout: 120000 }, async () => {
  const url = `${servers.origin}/gen/large.html?rules=30000`;
  const { page } = await open(url, ON);
  const stats = await browser.stats(url);
  const s = stats.slices;
  console.log(`# large page: ${stats.rules} rules, ${s.slices} slices, longest ${s.maxMs.toFixed(1)} ms, over 12 ms: ${s.overruns}, total ${s.totalMs.toFixed(0)} ms, ready after ${(stats.readyAt - stats.startedAt).toFixed(0)} ms`);
  assert.equal(stats.faults, 0);
  assert.ok(stats.rules >= 30000);
  assert.ok(s.slices > 10, 'work should be split into many slices');
  assert.ok(s.overruns <= Math.ceil(s.slices * 0.02), `${s.overruns} of ${s.slices} slices ran over 12 ms`);
  await page.close();
});

test('frames are themed on their own, including an empty one', { timeout: 60000 }, async () => {
  const { page } = await open(`${servers.origin}/frame.html`, ON);
  const frame = page.frames().find((f) => f.url().endsWith('/basic.html'));
  assert.ok(frame, 'the same-origin frame should exist');
  await frame.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready');
  const lightnessIn = async (f) => lightness((await collect(f)).canvas);
  assert.ok((await lightnessIn(frame)) < 0.35);
  const blank = page.frames().find((f) => f.url() === 'about:blank' && f !== page.mainFrame());
  assert.ok(blank, 'the empty frame should exist');
  await blank.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready');
  await page.close();
});

test('a sheet imported by @import that arrives late is themed when it arrives', { timeout: 60000 }, async () => {
  const { page } = await open(`${servers.origin}/slow-import.html`, ON);
  // The page loads first; the imported file comes 700 ms later.
  const original = 'rgb(74, 20, 140)';
  await page.waitForFunction((c) => getComputedStyle(document.querySelector('.imported-note')).color !== c && getComputedStyle(document.querySelector('.imported-note')).color !== 'rgb(34, 34, 34)', original, { timeout: 15000 });
  const color = await page.evaluate(() => getComputedStyle(document.querySelector('.imported-note')).color);
  const [r, g, b] = color.match(/\d+/g).map(Number);
  assert.ok((r + g + b) / 3 > 100, `the imported text color is light enough on a dark page: ${color}`);
  await page.close();
});

test('a shorthand with var() that a later longhand cuts short is themed, in a style element and in a linked sheet', { timeout: 60000 }, async () => {
  const end = (page, sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s), '::after').backgroundImage, sel);
  const dark = (css) => {
    const m = /rgb\((\d+), (\d+), (\d+)\)\)$/.exec(css);
    return !!m && [m[1], m[2], m[3]].every((v) => Number(v) < 90);
  };
  const a = await open(`${servers.origin}/grad.html`, ON);
  assert.ok(dark(await end(a.page, '.e')), `style element: ${await end(a.page, '.e')}`);
  await a.page.close();
  const b = await open(`${servers.origin}/grad-link.html`, ON);
  await b.page.waitForFunction(() => /rgb\((\d+), (\d+), (\d+)\)\)$/.test(getComputedStyle(document.querySelector('.g'), '::after').backgroundImage) && !/255, 255, 255\)\)$/.test(getComputedStyle(document.querySelector('.g'), '::after').backgroundImage), undefined, { timeout: 15000 });
  assert.ok(dark(await end(b.page, '.g')), `linked sheet: ${await end(b.page, '.g')}`);
  await b.page.close();
});

test('colors that a page sets with attributes (bgcolor, text, link, font color) are themed, and a rule of the page still wins', { timeout: 60000 }, async () => {
  const { page } = await open(`${servers.origin}/legacy.html`, ON);
  const lum = (css) => {
    const [r, g, b] = css.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const get = (sel, prop) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [sel, prop]);
  assert.ok(lum(await get('#outer', 'backgroundColor')) < 0.3, `table bgcolor: ${await get('#outer', 'backgroundColor')}`);
  assert.ok(lum(await get('body', 'backgroundColor')) < 0.3, 'body bgcolor');
  assert.ok(lum(await get('#small', 'color')) > 0.35, `font color: ${await get('#small', 'color')}`);
  assert.ok(lum(await get('#cell', 'color')) > 0.5, `body text attribute: ${await get('#cell', 'color')}`);
  // The orange bar keeps a visible color that is not the page background.
  assert.notEqual(await get('#bar', 'backgroundColor'), await get('#outer', 'backgroundColor'));
  // A page rule beats the attribute: this link is black in the page's CSS, and is lightened by the sheet copy.
  assert.ok(lum(await get('#lnk', 'color')) > 0.5, `link: ${await get('#lnk', 'color')}`);
  const stats = await browser.stats(`${servers.origin}/legacy.html`);
  assert.ok(stats.attrs >= 3, JSON.stringify(stats));
  await page.close();
});

test('a style element and a link that sit deep inside the body, also when they arrive after load, are themed', { timeout: 60000 }, async () => {
  const { page } = await open(`${servers.origin}/basic.html`, ON);
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = '';
    const wrap = document.createElement('section');
    const inner = document.createElement('div');
    const style = document.createElement('style');
    style.textContent = '.deep { color: #123456; background-color: #ffffff; }';
    const p = document.createElement('p');
    p.className = 'deep';
    p.id = 'deep-style';
    p.textContent = 'deep style';
    inner.append(style, p);
    wrap.append(inner);
    host.append(wrap);
    document.body.append(host);
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/css/grad.css';
    const g = document.createElement('div');
    g.className = 'g';
    g.id = 'deep-link';
    const box = document.createElement('div');
    box.append(l, g);
    wrap.append(box);
  });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('deep-style')).backgroundColor !== 'rgb(255, 255, 255)', undefined, { timeout: 15000 });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('deep-link')).backgroundColor !== 'rgb(238, 238, 238)', undefined, { timeout: 15000 });
  await page.close();
});

test('fallbacks of var() and colors built from a variable channel list are themed', { timeout: 60000 }, async () => {
  const { page } = await open(`${servers.origin}/var-forms.html`, ON);
  const colors = await page.evaluate(() => [1, 2, 3, 4, 5, 6, 7, 8].map((n) => getComputedStyle(document.querySelector(`.t${n}`)).backgroundImage + '|' + getComputedStyle(document.querySelector(`.t${n}`)).backgroundColor));
  const light = (s) => (s.match(/rgba?\(([^)]+)\)/g) ?? []).some((c) => {
    const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number);
    return (r + g + b) / 3 > 150;
  });
  const bad = colors.map((c, i) => [i + 1, c]).filter(([, c]) => light(c));
  assert.deepEqual(bad, []);
  await page.close();
});

test('colors set as SVG attributes are themed: icons become light, a large white drawing background becomes dark', { timeout: 60000 }, async () => {
  const { page } = await open(`${servers.origin}/svg-attrs.html`, ON);
  const get = (id, prop) => page.evaluate(([i, p]) => getComputedStyle(document.getElementById(i))[p], [id, prop]);
  const lum = (css) => {
    const [r, g, b] = css.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  assert.ok(lum(await get('p', 'fill')) > 0.5, `icon fill ${await get('p', 'fill')}`);
  assert.ok(lum(await get('s', 'stroke')) > 0.5, `icon stroke ${await get('s', 'stroke')}`);
  assert.ok(lum(await get('r', 'fill')) < 0.3, `big white rect ${await get('r', 'fill')}`);
  assert.ok(lum(await get('c', 'fill')) > 0.5, `big dark circle ${await get('c', 'fill')}`);
  // An accent keeps its hue: still blue.
  const [r, g, b] = (await get('b', 'fill')).match(/\d+/g).map(Number);
  assert.ok(b > r + 40, `blue accent ${r},${g},${b}`);
  assert.equal(await get('none', 'fill'), 'none');
  await page.close();
});

test('text that sits directly on a picture keeps the color the page gave it, other text is themed', { timeout: 60000 }, async () => {
  const { page } = await open(`${servers.origin}/hero.html`, ON);
  const color = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).color, id);
  const lum = (css) => {
    const [r, g, b] = css.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  await page.waitForFunction(() => document.getElementById('over-img').hasAttribute('data-dk-k'), undefined, { timeout: 15000 });
  assert.equal(await color('over-img'), 'rgb(17, 17, 17)', 'a title on a light photo stays dark');
  await page.waitForFunction(() => document.getElementById('over-bg').hasAttribute('data-dk-k'), undefined, { timeout: 15000 });
  assert.equal(await color('over-bg'), 'rgb(34, 34, 34)', 'text on a background picture stays dark');
  assert.ok(lum(await color('over-canvas')) > 0.6, `text over a canvas is themed: ${await color('over-canvas')}`);
  assert.ok(lum(await color('on-box')) > 0.6, `text on a colored box is themed: ${await color('on-box')}`);
  assert.ok(lum(await color('plain')) > 0.6, 'plain text is themed');
  assert.equal(await page.evaluate(() => document.getElementById('on-box').hasAttribute('data-dk-k') || document.getElementById('over-canvas').hasAttribute('data-dk-k') || document.getElementById('plain').hasAttribute('data-dk-k')), false);
  await page.close();
});
