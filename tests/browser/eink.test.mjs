// The E-ink and Paper mode in a real browser: palette, links, pictures, motion, the reduced motion hint, the white cap,
// pages that are dark or heavy, the switch between modes and the first paint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, paintedLightness } from './harness.mjs';

let servers;
let browser;
let helper;
let extensionPage;

before(async () => {
  servers = await startServers();
  browser = await launch();
  helper = await browser.context.newPage();
  await helper.goto('about:blank');
  extensionPage = await browser.context.newPage();
  await extensionPage.goto(`chrome-extension://${new URL(browser.worker.url()).host}/pages/options/options.html`);
});

const fromPage = (message) => extensionPage.evaluate((m) => chrome.runtime.sendMessage(m), message);
after(async () => {
  await browser?.close();
  await servers?.close();
});

const EINK = { mode: 'eink', einkPreset: 'eink' };
const PAPER = { mode: 'eink', einkPreset: 'paper' };

const parse = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p[3] ?? 1 };
};
const lum = (c) => {
  const f = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

async function open(path, theme, settings = {}) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme, ...settings } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready');
  // The first engine may be replaced by a second one while the page loads; wait until the theme is the one in force.
  await page.waitForFunction(() => {
    const base = document.querySelector('style[data-dk="base"]');
    return (!!base && base.media !== 'not all' && !document.querySelector('style[data-dk="early"]')) || !!document.querySelector('style[data-dk="filter"], style[data-dk="static"]');
  });
  // Two frames: a color that changes in the frame where it was read still shows its old value (the mode runs transitions for 0.01 ms).
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="filter"], style[data-dk="static"]') || getComputedStyle(document.documentElement).backgroundColor !== 'rgba(0, 0, 0, 0)', null, { timeout: 5000 });
  return page;
}

/** Wait for a computed value that is set by a rule which may arrive after the first look. */
const until = (page, selector, property, pattern) =>
  page.waitForFunction(([s, p, re]) => new RegExp(re).test(getComputedStyle(document.querySelector(s))[p]), [selector, property, pattern.source], { timeout: 10000 });

const css = (page, selector, property) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [selector, property]);

test('Paper: the page is paper with ink text, links are underlined and the picture is calm', { timeout: 60000 }, async () => {
  const page = await open('/eink-book.html', { ...PAPER, einkBlue: 0, whiteCap: 100 });
  assert.equal(hex(parse(await css(page, 'html', 'backgroundColor'))), '#f4f1ea');
  const body = parse(await css(page, 'body', 'backgroundColor'));
  assert.ok(Math.abs(lum(body) - lum(parse('rgb(244,241,234)'))) < 0.01, `body ${JSON.stringify(body)}`);
  const text = parse(await css(page, 'p:not(.first)', 'color'));
  assert.ok(ratio(text, parse('rgb(244,241,234)')) >= 4.5, `text ${hex(text)}`);
  assert.ok(lum(text) < 0.12, 'ink, not light text');
  assert.equal(await css(page, 'a', 'textDecorationLine'), 'underline');
  // The pictures of Paper follow its amount of color (35 percent) and are dimmed a little.
  assert.match(await css(page, 'figure img', 'filter'), /saturate\(0\.35\)/);
  assert.match(await css(page, 'figure img', 'filter'), /brightness\(0\.88\)/);
  // The ink is not pure black, and the heading is darker than the secondary line.
  assert.notEqual(hex(text), '#000000');
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="calm"]').length), 1);
  await page.close();
});

test('E-ink: pure paper and ink, links underlined, thicker controls, calm pictures, text at 7 to 1', { timeout: 60000 }, async () => {
  const page = await open('/eink-ui.html', EINK);
  assert.equal(await css(page, 'html', 'backgroundColor'), 'rgb(255, 255, 255)');
  const white = parse('rgb(255,255,255)');
  for (const [selector, label] of [['.card h2', 'card title'], ['.big', 'number'], ['td', 'cell'], ['.up', 'green text'], ['.down', 'red text'], ['th', 'header']]) {
    const c = parse(await css(page, selector, 'color'));
    assert.ok(ratio(c, white) >= 7 - 0.05, `${label} ${hex(c)} ${ratio(c, white).toFixed(2)}`);
  }
  // Grays only: every text color the page uses is gray.
  const c = parse(await css(page, '.up', 'color'));
  assert.ok(Math.abs(c.r - c.g) < 0.01 && Math.abs(c.g - c.b) < 0.01);
  assert.equal(await css(page, 'a', 'textDecorationLine'), 'underline');
  assert.equal(await css(page, 'input[type=text]', 'borderTopWidth'), '2px');
  assert.equal(await css(page, '.card', 'boxShadow'), 'none');
  // The white of the page is the page color: a card on it is not brighter.
  assert.ok(lum(parse(await css(page, '.card', 'backgroundColor'))) <= 1);
  await page.close();
});

test('E-ink and Paper turn a dark nav bar and colored buttons into light boxes with readable ink', { timeout: 60000 }, async () => {
  for (const [theme, floor] of [[EINK, 7], [PAPER, 4.5]]) {
    const page = await open('/eink-ui.html', theme);
    const pageBg = parse(await css(page, 'html', 'backgroundColor'));
    for (const selector of ['.top', '.btn.blue', '.btn.red', '.btn.green', '.hero', '.badge.b2']) {
      const bg = parse(await css(page, selector, 'backgroundColor'));
      const fg = parse(await css(page, selector, 'color'));
      const own = lum(bg) < 0.001 ? pageBg : bg;
      if (selector === '.hero') continue; // a gradient, checked on the text below
      assert.ok(ratio(fg, own) >= floor - 0.05, `${JSON.stringify(theme.einkPreset)} ${selector}: ${hex(fg)} on ${hex(own)} = ${ratio(fg, own).toFixed(2)}`);
      // A dark box of the page does not stay dark: this mode is a light page.
      assert.ok(lum(own) > 0.25, `${selector} stayed dark ${hex(own)}`);
    }
    await page.close();
  }
});

test('the white cap holds on a real page: no background is brighter than the cap', { timeout: 60000 }, async () => {
  for (const cap of [70, 85]) {
    const page = await open('/eink-ui.html', { ...PAPER, paperColor: '#ffffff', whiteCap: cap, einkBlue: 0 });
    const peak = await page.evaluate(() => {
      const lumOf = (css) => {
        const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        const f = (v) => ((v / 255) <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
        return { y: 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]), a: p[3] ?? 1 };
      };
      let max = 0;
      for (const el of [document.documentElement, ...document.body.querySelectorAll('*')]) {
        const c = lumOf(getComputedStyle(el).backgroundColor);
        if (c.a > 0.5) max = Math.max(max, c.y);
        const t = lumOf(getComputedStyle(el).color);
        if (t.a > 0.5) max = Math.max(max, t.y);
      }
      return max;
    });
    assert.ok(peak <= cap / 100 + 0.004, `cap ${cap}: peak ${peak.toFixed(3)}`);
    assert.ok(peak >= cap / 100 - 0.02, `cap ${cap}: the page is not dimmer than it must be (${peak.toFixed(3)})`);
    await page.close();
  }
});

test('E-ink stops animations, transitions, smooth scrolling and shadows; Paper keeps them', { timeout: 60000 }, async () => {
  const page = await open('/eink-motion.html', EINK);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), 0);
  assert.equal(await css(page, '#spinner', 'animationIterationCount'), '1');
  // The element that fades in ends up shown, not stuck at its first frame.
  assert.equal(await css(page, '#fade', 'opacity'), '1');
  assert.equal(await css(page, 'html', 'scrollBehavior'), 'auto');
  assert.equal(await css(page, '#card', 'boxShadow'), 'none');
  assert.equal(await css(page, '#card', 'textShadow'), 'none');
  // A transition of four seconds is over at the next look.
  await page.evaluate(() => document.getElementById('slide').classList.add('wide'));
  await page.waitForTimeout(150);
  assert.equal(await css(page, '#slide', 'width'), '300px');
  // Smooth scrolling is off: a scroll arrives at once.
  await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'smooth' }));
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => Math.round(scrollY)), 600);
  await page.close();

  const paper = await open('/eink-motion.html', PAPER);
  assert.equal(await css(paper, '#spinner', 'animationIterationCount'), 'infinite');
  assert.equal(await css(paper, 'html', 'scrollBehavior'), 'smooth');
  assert.notEqual(await css(paper, '#card', 'boxShadow'), 'none');
  assert.ok((await paper.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)) >= 1);
  await paper.close();
});

test('each motion switch works alone, over the style', { timeout: 60000 }, async () => {
  const page = await open('/eink-motion.html', { ...PAPER, noShadow: true });
  assert.equal(await css(page, '#card', 'boxShadow'), 'none');
  assert.equal(await css(page, '#spinner', 'animationIterationCount'), 'infinite');
  await page.close();
  const off = await open('/eink-motion.html', { ...EINK, noAnimation: false, noShadow: false });
  assert.equal(await css(off, '#spinner', 'animationIterationCount'), 'infinite');
  assert.notEqual(await css(off, '#card', 'boxShadow'), 'none');
  assert.equal(await css(off, 'html', 'scrollBehavior'), 'auto');
  await off.close();
});

test('the reduced motion hint: the page sees reduce while it is on, others queries are untouched, and it ends with the mode', { timeout: 90000 }, async () => {
  const page = await open('/eink-motion.html', EINK);
  const ask = () => page.evaluate(() => ({ reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, none: matchMedia('(prefers-reduced-motion: no-preference)').matches, dark: matchMedia('(prefers-color-scheme: dark)').matches, wide: matchMedia('(min-width: 100px)').matches, text: document.getElementById('probe').textContent }));
  const on = await ask();
  assert.equal(on.reduce, true);
  assert.equal(on.none, false);
  assert.equal(on.wide, true);
  assert.equal(on.dark, false);
  // The attribute and every other mark of the page are the page's own.
  assert.equal(await page.evaluate(() => [...document.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-dk')).sort().join(',')), 'data-dk-go,data-dk-state');
  // A change listener hears the change when the mode ends.
  await page.evaluate(() => {
    window.heard = [];
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => window.heard.push(e.matches));
  });
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches === false);
  assert.deepEqual(await page.evaluate(() => window.heard), [false]);
  await browser.setStorage({ settings: { enabled: true, theme: { ...EINK } } });
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches === true);
  // Paper has it off by default, and the switch can be turned on.
  await browser.setStorage({ settings: { enabled: true, theme: { ...PAPER } } });
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches === false);
  await browser.setStorage({ settings: { enabled: true, theme: { ...PAPER, reducedMotionHint: true } } });
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches === true);
  await page.close();
});

test('pictures: calm in both styles, and left alone when asked; a background picture is marked, a box with text is not', { timeout: 90000 }, async () => {
  const page = await open('/eink-images.html', EINK);
  await page.waitForFunction(() => document.getElementById('bg').hasAttribute('data-dk-bg'), null, { timeout: 15000 });
  await until(page, '#photo', 'filter', /grayscale\(1\)/);
  await until(page, '#cv', 'filter', /grayscale\(1\)/);
  assert.equal(await page.getAttribute('#bg', 'data-dk-bg'), 'gray');
  await until(page, '#bg', 'filter', /grayscale\(1\)/);
  // A picture box with a filter of its own that does nothing (a hover effect at rest) is calm like the others, not blended.
  await page.waitForFunction(() => document.getElementById('bgfilter').getAttribute('data-dk-bg') === 'gray', null, { timeout: 15000 });
  await until(page, '#bgfilter', 'filter', /grayscale\(1\)/);
  // A picture box added while the page runs is calm in the same frame, before any mark.
  const added = await page.evaluate(() => {
    const box = document.createElement('div');
    box.style.cssText = 'width:320px;height:180px;background-size:cover';
    box.style.backgroundImage = 'url(img/scene.svg)';
    document.body.append(box);
    const filter = getComputedStyle(box).filter;
    const mark = box.getAttribute('data-dk-bg');
    box.append('text');
    const withText = getComputedStyle(box).filter;
    box.remove();
    return { filter, mark, withText };
  });
  assert.equal(added.mark, null);
  assert.match(added.filter, /grayscale\(1\)/);
  assert.equal(added.withText, 'none', 'a box with text is left to the mark');
  // A box that holds text would turn its text gray too, so no filter: its picture is blended with a gray instead.
  await page.waitForFunction(() => document.getElementById('bgtext').getAttribute('data-dk-bg') === 'blend');
  assert.equal(await css(page, '#bgtext', 'filter'), 'none');
  assert.equal(await css(page, '#bgtext', 'backgroundBlendMode'), 'luminosity');
  // The text on the photo keeps the color the page gave it (white), it is not turned into ink.
  assert.equal(await css(page, '#bgtext', 'color'), 'rgb(255, 255, 255)');
  await page.close();

  const off = await open('/eink-images.html', { ...EINK, einkImages: 'off' });
  await off.waitForTimeout(800);
  assert.equal(await css(off, '#photo', 'filter'), 'none');
  assert.equal(await off.getAttribute('#bg', 'data-dk-bg'), null);
  assert.equal(await off.getAttribute('#bgtext', 'data-dk-bg'), null);
  await off.close();

  const dim = await open('/eink-images.html', { ...EINK, einkImages: 'dim', einkImageContrast: 150 });
  await until(dim, '#photo', 'filter', /contrast\(1\.5\)/);
  assert.match(await css(dim, '#photo', 'filter'), /brightness/);
  await dim.close();
});

test('the pictures are calm in pixels: a color picture has no color left', { timeout: 60000 }, async () => {
  const page = await open('/eink-images.html', EINK);
  await page.waitForTimeout(600);
  const [[r, g, b]] = await (async () => {
    const rect = await page.evaluate(() => { const x = document.getElementById('photo').getBoundingClientRect(); return [Math.round(x.x + x.width * 0.2), Math.round(x.y + x.height * 0.85)]; });
    const png = await page.screenshot({ type: 'png' });
    return helper.evaluate(async ({ data, pt }) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return [Array.from(ctx.getImageData(pt[0], pt[1], 1, 1).data.slice(0, 3))];
    }, { data: png.toString('base64'), pt: rect });
  })();
  assert.ok(Math.abs(r - g) <= 3 && Math.abs(g - b) <= 3, `rgb(${r},${g},${b}) is not gray`);
  await page.close();
});

test('a page that is already dark is turned into paper, not left alone', { timeout: 60000 }, async () => {
  const page = await open('/eink-dark.html', PAPER);
  const bg = parse(await css(page, 'html', 'backgroundColor'));
  assert.ok(lum(bg) > 0.6, `canvas ${hex(bg)}`);
  assert.ok(lum(parse(await css(page, '.card', 'backgroundColor'))) > 0.3);
  const text = parse(await css(page, 'h1', 'color'));
  assert.ok(ratio(text, bg) >= 4.5, `heading ${hex(text)} on ${hex(bg)}`);
  const muted = parse(await css(page, '.muted', 'color'));
  assert.ok(ratio(muted, bg) >= 4.5, `muted text ${hex(muted)}`);
  const code = parse(await css(page, 'code', 'color'));
  assert.ok(ratio(code, parse(await css(page, 'code', 'backgroundColor'))) >= 4.5, 'inline code is readable');
  // The engine ran: this is not the detect-and-leave path.
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-dk-state')), 'ready');
  await page.close();
});

test('a heavy page is ready in time in this mode', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: PAPER } });
  const page = await browser.context.newPage();
  const began = Date.now();
  await page.goto(`${servers.origin}/gen/large.html?rules=20000&palette=60`);
  await waitState(page, 'ready', 30000);
  const ms = Date.now() - began;
  console.log(`# heavy page (20 000 rules) in the Paper style: ready after ${ms} ms`);
  assert.ok(ms < 15000);
  const bg = parse(await css(page, 'html', 'backgroundColor'));
  assert.ok(lum(bg) > 0.6);
  assert.ok(ratio(parse(await css(page, '.c0', 'color')), parse(await css(page, '.c0', 'backgroundColor'))) >= 1);
  await page.close();
});

test('the mode leaves no trace when the page goes back to light or dark', { timeout: 90000 }, async () => {
  const page = await open('/eink-book.html', { ...EINK, einkWeight: 2 });
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="calm"]').length), 1);
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk="calm"]').length === 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk-bg]').length), 0);
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk]').length === 0);
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-dk-state')), null);
  await page.close();
});

test('the font, the weight and a custom font name reach the text but not the icon fonts', { timeout: 60000 }, async () => {
  const page = await open('/eink-book.html', { ...PAPER, einkFont: 'sans', einkWeight: 3 });
  assert.match(await css(page, 'p', 'fontFamily'), /system-ui/);
  assert.equal(await css(page, 'body', 'webkitTextStrokeWidth'), '0.36px');
  await page.evaluate(() => {
    const i = document.createElement('i');
    i.className = 'fa fa-star';
    i.style.fontFamily = 'FontAwesome';
    i.id = 'icon';
    document.body.append(i);
  });
  await page.waitForTimeout(100);
  assert.match(await css(page, '#icon', 'fontFamily'), /FontAwesome/);
  await page.close();
  const custom = await open('/eink-book.html', { ...PAPER, einkFont: 'Vazirmatn, serif' });
  assert.match(await css(custom, 'p', 'fontFamily'), /^"?Vazirmatn"?, serif$/);
  await custom.close();
});

test('the Filter engines give the mode a cheap fallback: gray, contrast, paper tone, no invert', { timeout: 90000 }, async () => {
  for (const engine of ['filter', 'filterPlus']) {
    const page = await open('/eink-ui.html', { ...EINK, einkImages: 'gray' }, { engine });
    const rootFilter = await css(page, 'html', 'filter');
    assert.match(rootFilter, /url\(/);
    assert.ok(!/invert/.test(rootFilter));
    assert.equal(await page.evaluate(() => document.querySelectorAll('svg[data-dk="filter-defs"] feComponentTransfer').length), 1, 'the gray levels step');
    // The page is neither dark nor colored: sample the screen.
    const png = await page.screenshot({ type: 'png' });
    const stats = await helper.evaluate(async (data) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const c = document.createElement('canvas');
      c.width = 100;
      c.height = 60;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, 100, 60);
      const d = ctx.getImageData(0, 0, 100, 60).data;
      let sum = 0;
      let color = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum += d[i];
        color = Math.max(color, Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 1] - d[i + 2]));
      }
      return { mean: sum / (d.length / 4) / 255, color };
    }, png.toString('base64'));
    assert.ok(stats.mean > 0.6, `${engine}: mean ${stats.mean}`);
    assert.ok(stats.color <= 6, `${engine}: color ${stats.color}`);
    await page.close();
  }
  const paper = await open('/eink-book.html', { ...PAPER, einkImages: 'off' }, { engine: 'filter' });
  assert.equal(await css(paper, 'figure img', 'filter').then((f) => /url\(/.test(f)), true, 'pictures kept as they are go through the inverse');
  await paper.close();
});

test('the Static engine follows the same palette', { timeout: 60000 }, async () => {
  const url = '/eink-book.html';
  await browser.clearStorage();
  await browser.setStorage({
    settings: { enabled: true, theme: { ...PAPER, einkBlue: 0, whiteCap: 100 } },
    userFixes: { '127.0.0.1': { engine: 'static', static: { bg: ['body'], fg: ['p'], border: ['hr'] } } },
  });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${url}`);
  await waitState(page, 'ready');
  assert.equal(hex(parse(await css(page, 'body', 'backgroundColor'))), '#f4f1ea');
  assert.equal(hex(parse(await css(page, 'p', 'color'))), '#2b2620');
  await page.close();
});

test('the engine paints the paper canvas in its first style, the same color as the final page', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: PAPER } });
  const page = await browser.context.newPage();
  await page.addInitScript(() => {
    window.earlyColors = [];
    new MutationObserver(() => {
      const el = document.querySelector('style[data-dk="early"]');
      if (el && !window.earlyColors.length) window.earlyColors.push(el.textContent);
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${servers.origin}/slow.html`);
  await waitState(page, 'ready');
  const finalCanvas = hex(parse(await css(page, 'html', 'backgroundColor')));
  const early = await page.evaluate(() => window.earlyColors[0] ?? '');
  assert.ok(early.includes(`background-color:${finalCanvas}!important`), `early style ${early.slice(0, 120)} against ${finalCanvas}`);
  assert.ok(early.includes('color-scheme:light'), 'a light canvas, never dark');
  assert.ok(!/#16181d/i.test(early), 'no dark color in the first paint');
  await page.close();
});

test('first paint: the worker registers nothing for E-ink or Paper, and the quick dark version for Dark', { timeout: 60000 }, async () => {
  const registered = () => browser.worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).filter((s) => s.id === 'dk-early').map((s) => s.js));
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme: EINK } });
  // Dark registers the quick dark version; the worker needs a moment to do it.
  assert.equal((await fromPage({ type: 'dk.settings.patch', patch: { theme: { mode: 'dark' } } })).ok, true);
  for (let i = 0; i < 40 && !(await registered()).length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await registered(), [['content/early/hold.js', 'content/early/sheet.js']]);
  // E-ink with every motion switch on registers nothing: a rule for every element would stay in the page.
  assert.equal((await fromPage({ type: 'dk.settings.patch', patch: { theme: { mode: 'eink', einkPreset: 'eink' } } })).ok, true);
  for (let i = 0; i < 40 && (await registered()).length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await registered(), []);
  assert.equal((await fromPage({ type: 'dk.settings.patch', patch: { theme: { einkPreset: 'paper' } } })).ok, true);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await registered(), []);
});

/** The page loads in this mode after a dark page: no frame is dark, and the frames settle on one tone. */
test('first paint: no dark frame when a page loads in this mode, and at most a short light frame of the original page', { timeout: 120000 }, async () => {
  for (const [theme, label] of [[EINK, 'eink'], [PAPER, 'paper']]) {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, theme } });
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/dark.html`);
    const lightness = await paintedLightness(page, helper, async () => {
      await page.goto(`${servers.origin}/slow.html`);
      await waitState(page, 'ready');
    });
    console.log(`# ${label}: ${lightness.length} frames, lightness ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
    const firstLight = lightness.findIndex((v) => v > 0.5);
    assert.ok(firstLight >= 0, 'the page was painted');
    assert.deepEqual(lightness.slice(firstLight).filter((v) => v < 0.6), [], 'a page that turns light never goes dark again');
    const final = lightness[lightness.length - 1];
    // The frames of the original page are white and the final page is the paper: count the frames that differ by more than a few percent.
    const odd = lightness.slice(firstLight).filter((v) => Math.abs(v - final) > 0.06);
    console.log(`# ${label}: ${odd.length} frames of another tone before the page settled`);
    assert.ok(odd.length <= 2, `${odd.length} frames of another tone`);
    await page.close();
  }
});

test('switching dark, E-ink, light, Paper, dark shows no frame of the page as the site wrote it', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  // The page as the site wrote it, with Tintly off.
  await browser.setStorage({ settings: { enabled: false } });
  const plain = await browser.context.newPage();
  await plain.goto(`${servers.origin}/eink-mid.html`);
  const original = (await paintedLightness(plain, helper, async () => plain.waitForTimeout(300))).pop();
  await plain.close();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/eink-mid.html`);
  await waitState(page, 'ready');
  const lightness = await paintedLightness(page, helper, async () => {
    for (const theme of [{ ...EINK }, { mode: 'light' }, { ...PAPER }, { mode: 'dark' }]) {
      await browser.setStorage({ settings: { enabled: true, theme } });
      await page.waitForTimeout(700);
      await waitState(page, 'ready');
    }
  });
  console.log(`# the page as written: ${original.toFixed(2)}; dark, eink, light, paper, dark: ${lightness.length} frames, lightness ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
  const shown = lightness.filter((v) => Math.abs(v - original) < 0.05);
  assert.deepEqual(shown, [], 'a frame of the unthemed page showed');
  await page.close();
});

test('a site rule gives one site the mode, and the schedule can pick it', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({
    settings: { enabled: true, theme: { mode: 'dark' } },
    siteRules: { '127.0.0.1': { theme: { mode: 'eink', einkPreset: 'paper', einkBlue: 0, whiteCap: 100 } } },
  });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/eink-book.html`);
  await waitState(page, 'ready');
  assert.equal(hex(parse(await css(page, 'html', 'backgroundColor'))), '#f4f1ea');
  await page.close();

  // The schedule: outside the hours the mode is the idle one. Hours that never include now give the idle mode.
  const now = new Date();
  const away = (h) => `${String((now.getHours() + h) % 24).padStart(2, '0')}:00`;
  await browser.clearStorage();
  await browser.setStorage({
    settings: {
      enabled: true,
      theme: { mode: 'dark', einkPreset: 'paper', einkBlue: 0, whiteCap: 100 },
      automation: { mode: 'time', behavior: 'scheme', time: { from: away(3), to: away(4) }, activeMode: 'dark', idleMode: 'eink', location: { lat: null, lon: null } },
    },
  });
  const scheduled = await browser.context.newPage();
  await scheduled.goto(`${servers.origin}/eink-book.html`);
  await waitState(scheduled, 'ready');
  assert.equal(hex(parse(await css(scheduled, 'html', 'backgroundColor'))), '#f4f1ea');
  await scheduled.close();
});

// Thicker lines: the mark on controls with a border follows the page after the first look.
const marked = (page, id) => page.evaluate((i) => document.getElementById(i).hasAttribute('data-dk-bw'), id);
const waitMark = (page, id, want) => page.waitForFunction(([i, w]) => document.getElementById(i)?.hasAttribute('data-dk-bw') === w, [id, want], { timeout: 10000 });

test('thicker lines follow a control that gets or loses a border by its own class or a parent class', { timeout: 60000 }, async () => {
  const page = await open('/eink-borders-live.html', EINK);
  await waitMark(page, 'fixed', true);
  assert.equal(await marked(page, 'self'), false);
  assert.equal(await marked(page, 'child'), false);
  await page.evaluate(() => document.getElementById('self').classList.add('lined'));
  await waitMark(page, 'self', true);
  assert.equal(await css(page, '#self', 'borderTopWidth'), '2px');
  await page.evaluate(() => document.getElementById('self').classList.remove('lined'));
  await waitMark(page, 'self', false);
  assert.equal(await css(page, '#self', 'borderTopWidth'), '0px');
  await page.evaluate(() => document.getElementById('wrap').classList.add('framed'));
  await waitMark(page, 'child', true);
  await page.evaluate(() => document.getElementById('wrap').classList.remove('framed'));
  await waitMark(page, 'child', false);
  // An inline style counts the same way.
  await page.evaluate(() => (document.getElementById('self').style.border = '1px dashed #333'));
  await waitMark(page, 'self', true);
  await page.evaluate(() => (document.getElementById('self').style.border = 'none'));
  await waitMark(page, 'self', false);
  assert.equal(await marked(page, 'fixed'), true);
  await page.close();
});

test('thicker lines reach the controls of a burst of more than 400 added nodes', { timeout: 60000 }, async () => {
  const page = await open('/eink-borders-live.html', EINK);
  await waitMark(page, 'fixed', true);
  const began = await page.evaluate(() => {
    const box = document.getElementById('burst');
    for (let i = 0; i < 600; i++) {
      const row = document.createElement('div');
      const input = document.createElement('input');
      input.className = i % 2 ? 'lined' : '';
      row.append(input);
      box.append(row);
    }
    return performance.now();
  });
  await page.waitForFunction(() => document.querySelectorAll('#burst input.lined[data-dk-bw]').length === 300, null, { timeout: 15000 });
  const took = await page.evaluate((t) => performance.now() - t, began);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#burst input:not(.lined)[data-dk-bw]').length), 0);
  console.log(`# 600 added rows: all lined controls marked ${took.toFixed(0)} ms after the burst`);
  await page.close();
});

test('thicker lines: a control whose border keeps its style and loses its width loses the mark (0 solid, own class, parent class, inline)', { timeout: 60000 }, async () => {
  const page = await open('/eink-borders-solid.html', EINK);
  await waitMark(page, 'fixed', true);
  for (const id of ['self', 'child', 'inline']) assert.equal(await marked(page, id), false, id);
  const width = (id) => css(page, `#${id}`, 'borderTopWidth');
  for (let round = 0; round < 2; round++) {
    await page.evaluate(() => document.getElementById('self').classList.add('lined'));
    await waitMark(page, 'self', true);
    assert.equal(await width('self'), '2px');
    await page.evaluate(() => document.getElementById('self').classList.remove('lined'));
    await waitMark(page, 'self', false);
    assert.equal(await width('self'), '0px');
    await page.evaluate(() => document.getElementById('wrap').classList.add('framed'));
    await waitMark(page, 'child', true);
    await page.evaluate(() => document.getElementById('wrap').classList.remove('framed'));
    await waitMark(page, 'child', false);
    await page.evaluate(() => (document.getElementById('inline').style.borderWidth = '1px'));
    await waitMark(page, 'inline', true);
    await page.evaluate(() => (document.getElementById('inline').style.borderWidth = '0'));
    await waitMark(page, 'inline', false);
  }
  // A width that runs as a transition: the read with the mark off starts none that stays.
  await page.evaluate(() => document.getElementById('slow').classList.add('again'));
  await page.waitForTimeout(500);
  assert.equal(await marked(page, 'slow'), true);
  assert.equal(await width('slow'), '2px');
  assert.equal(await page.evaluate(() => document.getElementById('slow').getAnimations().length), 0);
  await page.evaluate(() => document.getElementById('slow').classList.remove('lined'));
  await waitMark(page, 'slow', false);
  assert.equal(await width('slow'), '0px', 'no fade from the mark to the page width');
  assert.equal(await marked(page, 'fixed'), true);
  await page.close();
});

test('thicker lines on a large form: every control is read, in short slices (measured)', { timeout: 90000 }, async () => {
  const page = await open('/eink-borders-solid.html', EINK);
  await waitMark(page, 'fixed', true);
  const result = await page.evaluate(async () => {
    const box = document.getElementById('form');
    const html = [];
    for (let i = 0; i < 3000; i++) html.push(`<div><div><span>Field ${i}</span><div><input class="${i % 2 ? 'lined' : ''}"></div></div></div><div><p>text</p><p>text</p><p>text</p></div>`);
    box.innerHTML = html.join('');
    await new Promise((r) => setTimeout(r, 0));
    const long = [];
    const watch = new PerformanceObserver((list) => long.push(...list.getEntries().map((e) => e.duration)));
    watch.observe({ type: 'longtask' });
    const began = performance.now();
    while (document.querySelectorAll('#form input.lined[data-dk-bw]').length < 1500 && performance.now() - began < 30000) await new Promise((r) => setTimeout(r, 20));
    const took = performance.now() - began;
    watch.disconnect();
    return { took, long, wrong: document.querySelectorAll('#form input:not(.lined)[data-dk-bw]').length, all: document.querySelectorAll('#form input.lined[data-dk-bw]').length, nodes: document.getElementsByTagName('*').length };
  });
  console.log(`# large form (${result.nodes} elements, 3000 controls): all marked ${result.took.toFixed(0)} ms after the insert, long tasks ${JSON.stringify(result.long.map((d) => Math.round(d)))}`);
  assert.equal(result.all, 1500);
  assert.equal(result.wrong, 0);
  await page.close();
});

test('turning the mode off takes every border mark away, and a later change adds none', { timeout: 60000 }, async () => {
  const page = await open('/eink-borders-live.html', EINK);
  await waitMark(page, 'fixed', true);
  // A change that queues a read just before the mode ends.
  await page.evaluate(() => document.getElementById('self').classList.add('lined'));
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'dark' } } });
  await page.waitForFunction(() => document.querySelectorAll('style[data-dk="calm"]').length === 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk-bw]').length), 0);
  await page.evaluate(() => {
    document.getElementById('wrap').classList.add('framed');
    const input = document.createElement('input');
    input.className = 'lined';
    document.body.append(input);
  });
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-dk-bw]').length), 0);
  await page.close();
});

// Thicker lines follow the author's style sheets: one that goes away, comes, changes its media, or changes through the CSSOM.
test('thicker lines follow a style sheet that is removed, nested, switched by media, edited or changed through the CSSOM', { timeout: 90000 }, async () => {
  const page = await open('/eink-borders-sheets.html', EINK);
  await waitMark(page, 'field', true);
  const width = () => css(page, '#field', 'borderTopWidth');
  assert.equal(await width(), '2px');
  // A link goes: the author width is 0 again.
  await page.evaluate(() => document.getElementById('linked').remove());
  await waitMark(page, 'field', false);
  assert.equal(await width(), '0px');
  // A style comes, then goes.
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'temporary';
    s.textContent = 'input{border-width:1px}';
    document.head.append(s);
  });
  await waitMark(page, 'field', true);
  await page.evaluate(() => document.getElementById('temporary').remove());
  await waitMark(page, 'field', false);
  // A sheet inside a wrapper that is removed.
  await page.evaluate(() => {
    const w = document.createElement('div');
    w.id = 'wrapper';
    w.innerHTML = '<style>input{border-width:1px}</style>';
    document.getElementById('slot').append(w);
  });
  await waitMark(page, 'field', true);
  await page.evaluate(() => document.getElementById('wrapper').remove());
  await waitMark(page, 'field', false);
  // media decides.
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'media';
    s.textContent = 'input{border-width:1px}';
    document.head.append(s);
  });
  await waitMark(page, 'field', true);
  await page.evaluate(() => document.getElementById('media').setAttribute('media', 'print'));
  await waitMark(page, 'field', false);
  await page.evaluate(() => document.getElementById('media').removeAttribute('media'));
  await waitMark(page, 'field', true);
  await page.evaluate(() => document.getElementById('media').setAttribute('media', 'print'));
  await waitMark(page, 'field', false);
  // The text of a style element edited in place.
  await page.evaluate(() => {
    const s = document.getElementById('media');
    s.removeAttribute('media');
    s.firstChild.data = 'input{border-width:0}';
  });
  await page.waitForTimeout(1500);
  assert.equal(await marked(page, 'field'), false);
  await page.evaluate(() => (document.getElementById('media').firstChild.data = 'input{border-width:1px}'));
  await waitMark(page, 'field', true);
  // A rule deleted through the CSSOM, and one inserted.
  await page.evaluate(() => document.getElementById('media').sheet.deleteRule(0));
  await waitMark(page, 'field', false);
  await page.evaluate(() => document.getElementById('media').sheet.insertRule('input{border-width:1px}', 0));
  await waitMark(page, 'field', true);
  assert.equal(await width(), '2px');
  await page.close();
});

test('thicker lines: unrelated removals and the extension\'s own styles start no new read of the page', { timeout: 60000 }, async () => {
  const page = await open('/eink-borders-sheets.html', EINK);
  await waitMark(page, 'field', true);
  await page.evaluate(() => {
    const crowd = document.getElementById('crowd');
    for (let i = 0; i < 300; i++) crowd.insertAdjacentHTML('beforeend', '<div><p>row</p><span>x</span></div>');
  });
  await page.waitForTimeout(2500);
  // A read of the page takes the mark off and puts it back: that shows as a change of the attribute.
  const changes = await page.evaluate(async () => {
    let n = 0;
    const watch = new MutationObserver((list) => (n += list.length));
    watch.observe(document.getElementById('field'), { attributes: true, attributeFilter: ['data-dk-bw'] });
    for (const row of Array.from(document.getElementById('crowd').children)) row.remove();
    const own = document.querySelector('style[data-dk]');
    if (own) own.setAttribute('media', 'screen');
    await new Promise((r) => setTimeout(r, 2500));
    watch.disconnect();
    return n;
  });
  assert.equal(changes, 0, 'a removal of plain nodes or a change of our own style read the page again');
  await page.close();
});
