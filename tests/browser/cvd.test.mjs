// Color vision: the correction changes colors and nothing else, a setting that is off changes nothing, and each engine
// puts the correction where theme-engines.md section 11 says.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, pixelsOf } from './harness.mjs';

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

const IDS = ['red', 'green', 'chan', 'gray', 'link', 's-red', 's-green', 's-blue', 'pic'];
// The properties a color change may touch.
const COLORS = new Set(['row-rule-color', 'color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-block-start-color', 'border-block-end-color', 'border-inline-start-color', 'border-inline-end-color', 'outline-color', 'text-decoration-color', 'text-emphasis-color', 'caret-color', 'column-rule-color', 'fill', 'stroke', '-webkit-text-fill-color', '-webkit-text-stroke-color', 'accent-color', 'box-shadow', 'text-shadow', 'background-image', 'flood-color', 'lighting-color', 'stop-color']);

async function open(settings, state = 'ready') {
  await browser.clearStorage();
  await browser.setStorage({ settings });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/cvd.html`);
  if (state) await waitState(page, state, 30000);
  // A page with the extension off has nothing of ours and no state: a read before that is a read of a page in transition.
  else if (settings.enabled === false) await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state') && !document.querySelector('[data-dk]'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  return page;
}

/** Every computed property and the box of each element, and the root filter. */
const snapshot = (page) =>
  page.evaluate((ids) => {
    const out = {};
    for (const id of [...ids, 'bar']) {
      const el = id === 'bar' ? document.querySelector('.bar') : document.getElementById(id);
      const cs = getComputedStyle(el);
      const props = {};
      for (const name of cs) props[name] = cs.getPropertyValue(name);
      const r = el.getBoundingClientRect();
      out[id] = { props, box: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10) };
    }
    out.root = getComputedStyle(document.documentElement).filter;
    out.own = document.querySelectorAll('style[data-dk], svg[data-dk]').length;
    return out;
  }, IDS);

function changed(a, b) {
  const diff = [];
  for (const id of Object.keys(a)) {
    if (typeof a[id] !== 'object') continue;
    assert.deepEqual(b[id].box, a[id].box, `${id}: the box stays`);
    for (const [k, v] of Object.entries(a[id].props)) if (b[id].props[k] !== v) diff.push(`${id}.${k}`);
  }
  return diff;
}

const OFF = { enabled: false };
/** The two values of a property that differ, for a failure message. */
const shown = (a, b, d) => {
  const [id, ...k] = d.split('.');
  return `${d}: ${a[id].props[k.join('.')]} -> ${b[id].props[k.join('.')]}`;
};

test('the original mode with a correction changes only colors, keeps grays and boxes, and moves the confused colors', { timeout: 90000 }, async () => {
  const off = await open(OFF, null);
  const a = await snapshot(off);
  await off.close();
  const on = await open({ enabled: true, theme: { mode: 'original', cvdType: 'deutan', cvdSeverity: 100, cvdMedia: false } });
  const b = await snapshot(on);
  await on.close();
  const diff = changed(a, b);
  assert.ok(diff.length > 0, 'something changed');
  for (const d of diff) assert.ok(COLORS.has(d.split('.').slice(1).join('.')), `only colors change: ${shown(a, b, d)}`);
  assert.notEqual(b.red.props.color, a.red.props.color, 'the red text moves');
  assert.notEqual(b['s-red'].props['background-color'], a['s-red'].props['background-color']);
  assert.notEqual(b.chan.props.color, a.chan.props.color, 'a red built from channels moves too');
  assert.equal(b.gray.props.color, a.gray.props.color, 'gray stays');
  assert.equal(b.gray.props['background-color'], a.gray.props['background-color']);
  assert.equal(b.gray.props['border-top-color'], a.gray.props['border-top-color']);
  assert.equal(b.root, 'none', 'no page-wide filter');
  assert.equal(b.pic.props.filter, 'none', 'pictures stay without the option');
  assert.equal(b.bar.props.position, 'fixed');
});

test('a correction that is off changes nothing: the original mode with nothing to do leaves the page, a theme is the same with or without the type none', { timeout: 90000 }, async () => {
  const off = await open(OFF, null);
  const a = await snapshot(off);
  await off.close();
  const idle = await open({ enabled: true, theme: { mode: 'original', cvdType: 'none' } }, null);
  const b = await snapshot(idle);
  await idle.close();
  assert.deepEqual(changed(a, b), []);
  assert.equal(b.own, 0, 'no style of ours');
  const dark = await open({ enabled: true, theme: { mode: 'dark' } });
  const d1 = await snapshot(dark);
  await dark.close();
  const none = await open({ enabled: true, theme: { mode: 'dark', cvdType: 'none', cvdSeverity: 40, cvdMedia: true } });
  const d2 = await snapshot(none);
  await none.close();
  assert.deepEqual(changed(d1, d2), []);
  const zero = await open({ enabled: true, theme: { mode: 'dark', cvdType: 'protan', cvdSeverity: 0 } });
  const d3 = await snapshot(zero);
  await zero.close();
  assert.deepEqual(changed(d1, d3), [], 'severity 0 is no correction');
});

test('the link underline works alone and changes only the decoration of links', { timeout: 60000 }, async () => {
  const off = await open(OFF, null);
  const a = await snapshot(off);
  await off.close();
  const on = await open({ enabled: true, theme: { mode: 'original', linkUnderline: true } }, null);
  await on.waitForFunction(() => getComputedStyle(document.getElementById('link')).textDecorationLine === 'underline', null, { timeout: 15000 });
  const b = await snapshot(on);
  await on.close();
  for (const d of changed(a, b)) assert.ok(/^link\.(text-|-webkit-text-decorations-in-effect)/.test(d), `only the link decoration changes: ${shown(a, b, d)}`);
});

test('with a theme the correction follows the theme colors in the Dynamic engine', { timeout: 60000 }, async () => {
  const dark = await open({ enabled: true, engine: 'dynamic', theme: { mode: 'dark' } });
  const a = await snapshot(dark);
  await dark.close();
  const fixed = await open({ enabled: true, engine: 'dynamic', theme: { mode: 'dark', cvdType: 'protan', cvdMedia: false } });
  const b = await snapshot(fixed);
  await fixed.close();
  // The engine's own color variables (`--dk-...`) hold colors too.
  for (const d of changed(a, b)) assert.ok(COLORS.has(d.split('.').slice(1).join('.')) || d.includes('.--dk'), `only colors change: ${d}`);
  assert.notEqual(b.red.props.color, a.red.props.color);
  assert.equal(b.root, 'none');
});

test('pictures follow the filter by default, by one filter on the picture, and the option turns that off', { timeout: 60000 }, async () => {
  const page = await open({ enabled: true, theme: { mode: 'original', cvdType: 'deutan' } });
  const s = await snapshot(page);
  assert.match(s.pic.props.filter, /dk-cvd-media/);
  assert.equal(s.root, 'none');
  await page.close();
  const off = await open({ enabled: true, theme: { mode: 'original', cvdType: 'deutan', cvdMedia: false } });
  assert.doesNotMatch((await snapshot(off)).pic.props.filter, /dk-cvd-media/);
  await off.close();
});

test('the plain filters change the page and its pictures in the original mode, and nothing with a theme', { timeout: 90000 }, async () => {
  const rgb = (v) => v.match(/[\d.]+/g).slice(0, 3).map(Number);
  const gray = await open({ enabled: true, theme: { mode: 'original', cvdType: 'grayscale' } });
  const g = await snapshot(gray);
  const [r, gg, b] = rgb(g.red.props.color);
  assert.ok(Math.abs(r - gg) <= 1 && Math.abs(gg - b) <= 1, `gray: ${g.red.props.color}`);
  assert.match(g.pic.props.filter, /dk-cvd-media/);
  const box = await gray.evaluate(() => { const r = document.getElementById('pic').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  const [px] = await pixelsOf(gray, helper, [box]);
  assert.ok(Math.abs(px[0] - px[1]) <= 3 && Math.abs(px[1] - px[2]) <= 3, `the picture is gray: ${px.slice(0, 3)}`);
  await gray.close();
  const inv = await open({ enabled: true, theme: { mode: 'original', cvdType: 'inverted' } });
  const bg = rgb(await inv.evaluate(() => getComputedStyle(document.body).backgroundColor));
  assert.ok(bg[0] + bg[1] + bg[2] < 60, `a white page turns black: ${bg}`);
  await inv.close();
  // With a theme a plain filter does nothing: the theme sets the whole look.
  const plain = await open({ enabled: true, theme: { mode: 'dark' } });
  const before = await plain.evaluate(() => getComputedStyle(document.getElementById('red')).color);
  await plain.close();
  const dark = await open({ enabled: true, theme: { mode: 'dark', cvdType: 'grayscaleInverted' } });
  assert.equal(await dark.evaluate(() => getComputedStyle(document.getElementById('red')).color), before);
  assert.equal(await dark.evaluate(() => document.querySelector('style[data-dk="cvd-media"]')), null);
  await dark.close();
});

test('the Filter engines put the correction last on the root, give frames its inverse, and reach the canvas below a short page', { timeout: 90000 }, async () => {
  for (const engine of ['filter', 'filterPlus']) {
    const plain = await open({ enabled: true, engine, theme: { mode: 'dark' } });
    const box = await plain.evaluate(() => {
      const r = document.getElementById('pic').getBoundingClientRect();
      return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
    });
    const [was] = await pixelsOf(plain, helper, [box]);
    await plain.close();
    const page = await open({ enabled: true, engine, theme: { mode: 'dark', cvdType: 'deutan' } });
    const s = await snapshot(page);
    // Filter+ adds the correction as the last step of its own filter.
    assert.match(s.root, engine === 'filter' ? /#dk-cvd"\)$/ : /#dk-fp"\)$/, `${engine}: ${s.root}`);
    const steps = await page.evaluate(() => [...document.querySelectorAll('svg[data-dk] filter')].map((f) => `${f.id}:${[...f.children].map((c) => c.getAttribute('color-interpolation-filters')).join(',')}`));
    assert.ok(steps.some((t) => /^dk-(cvd|fp):.*linearRGB$/.test(t)), `${engine}: ${steps}`);
    assert.doesNotMatch(s.pic.props.filter, /dk-cvd/, `${engine}: pictures keep the correction`);
    const frame = await page.evaluate(() => getComputedStyle(document.getElementById('frame')).filter);
    assert.match(frame, /#dk-cvd-undo"\)$/, `${engine}: ${frame}`);
    const [now, below] = await pixelsOf(page, helper, [box, [500, 760]]);
    assert.ok(now[2] > was[2] + 20, `${engine}: the red picture gets more blue ${now} vs ${was}`);
    assert.ok(below.every((v) => v < 60), `${engine}: the canvas below the page is dark ${below}`);
    await page.close();
  }
});

test('a page that turns dark by itself is themed and corrected when a type is chosen, and kept as it is when the type is none again', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  const url = `${servers.origin}/cvd-script-dark.html`;
  await page.goto(url);
  await page.waitForFunction(() => document.body.classList.contains('js-dark'), undefined, { timeout: 15000 });
  // The page is dark by itself: it is left as it is.
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk]').length === 0, undefined, { timeout: 15000 });
  const own = await page.evaluate(() => getComputedStyle(document.getElementById('red')).color);
  await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme: { mode: 'dark', cvdType: 'protan' } } });
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk]').length > 0, undefined, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const look = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, red: getComputedStyle(document.getElementById('red')).color }));
  const [r, g, b] = look.bg.match(/\d+/g).map(Number);
  assert.ok(r + g + b < 150, `the page stays dark: ${look.bg}`);
  assert.notEqual(look.red, own, 'the red is corrected');
  assert.equal((await browser.stats(url))?.siteDark?.state, 'off');
  await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme: { mode: 'dark', cvdType: 'none' } } });
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk]').length === 0 && document.body.classList.contains('js-dark'), undefined, { timeout: 15000 });
  await page.close();
});

test('pictures set in CSS get the filter on a box with no text, a mask icon keeps its corrected color, and a picture the theme inverts keeps the filter', { timeout: 120000 }, async () => {
  const IDS = ['photo', 'bg-icon', 'bg-hero', 'mask-icon', 'mark-icon'];
  const look = async (theme) => {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, engine: 'dynamic', theme } });
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/cvd-media.html`);
    await waitState(page, 'ready', 30000).catch(() => {});
    await page.waitForTimeout(1200);
    const info = await page.evaluate((ids) => ids.map((id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      return { point: [Math.round(r.x + (id === 'bg-hero' ? 20 : r.width / 2)), Math.round(r.y + r.height / 2)], filter: getComputedStyle(el).filter, mark: el.getAttribute('data-dk-img') };
    }), IDS);
    const px = await pixelsOf(page, helper, info.map((i) => i.point));
    await page.close();
    return Object.fromEntries(IDS.map((id, i) => [id, { ...info[i], px: px[i] }]));
  };
  const plain = await look({ mode: 'original' });
  const fixed = await look({ mode: 'original', cvdType: 'deutan' });
  assert.ok(fixed['bg-icon'].px[2] > plain['bg-icon'].px[2] + 40, `a CSS picture in an empty box is filtered: ${fixed['bg-icon'].px} vs ${plain['bg-icon'].px}`);
  assert.deepEqual(fixed['bg-hero'].px, plain['bg-hero'].px, 'a CSS picture under text is left as it is');
  assert.equal(fixed['mask-icon'].filter, 'none', 'a mask icon takes its color from the corrected background color');
  const dark = await look({ mode: 'dark', cvdType: 'deutan' });
  assert.equal(dark['mark-icon'].mark, 'invert');
  assert.match(dark['mark-icon'].filter, /invert\(1\).*#dk-cvd-media/, `the theme's inversion keeps the filter: ${dark['mark-icon'].filter}`);
});

test('a picture box set in an inline style gets the filter in the frame it is added, also over a filter of its own that does nothing', { timeout: 120000 }, async () => {
  const add = (page) => page.evaluate(() => {
    const box = document.createElement('div');
    box.style.cssText = 'width:200px;height:120px;filter:brightness(1);background-size:cover';
    box.style.backgroundImage = 'url(img/scene.svg)';
    document.body.append(box);
    const filter = getComputedStyle(box).filter;
    box.append('text');
    const withText = getComputedStyle(box).filter;
    box.remove();
    return { filter, withText };
  });
  for (const cvdType of ['deutan', 'grayscale', 'grayscaleInverted', 'inverted']) {
    const page = await open({ enabled: true, engine: 'dynamic', theme: { mode: 'original', cvdType } });
    await page.waitForFunction(() => !!document.querySelector('style[data-dk="cvd-media"]'), null, { timeout: 15000 });
    const got = await add(page);
    assert.match(got.filter, /#dk-cvd-media/, `${cvdType}: ${got.filter}`);
    assert.equal(got.withText, 'brightness(1)', `${cvdType}: a box with text keeps its own filter`);
    await page.close();
  }
  // In Paper the calm filter wins over the correction, as on <img>.
  const paper = await open({ enabled: true, engine: 'dynamic', theme: { mode: 'eink', einkPreset: 'paper', cvdType: 'deutan' } });
  await paper.waitForFunction(() => !!document.querySelector('style[data-dk="calm"]'), null, { timeout: 15000 });
  const calm = await add(paper);
  assert.match(calm.filter, /saturate|grayscale/, calm.filter);
  await paper.close();
});
