// Repair after the page's own dark theme: the theme is kept, and what it leaves light is made dark.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, paintedLightness, pixelsOf } from './harness.mjs';

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
const opened = [];
afterEach(async () => {
  for (const page of opened.splice(0)) await page.close().catch(() => {});
});
const lumaOf = ([r, g, b]) => {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const style = (page, selector, prop) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [selector, prop]);

async function open(path, storage = ON) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  opened.push(page);
  const url = `${servers.origin}${path}`;
  await page.goto(url);
  await waitState(page, 'ready', 30000);
  await settled(url);
  return { page, url };
}

/** The repair pass can end a moment after the first look: wait for it. */
async function settled(url) {
  for (let i = 0; i < 200; i++) {
    const s = await browser.stats(url);
    if (!s || s.siteDark.state !== 'on' || s.siteDark.repair.state === 'done') return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the repair did not finish');
}

/**
 * Scroll through the whole page. At each position read, from a screenshot, the color of points in the right margin (no text there),
 * and from the DOM the effective background under points of the window. Returns the places that are light.
 */
async function lightPlaces(page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const light = [];
  for (let y = 0; y < height; y += 250) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(80);
    const at = await page.evaluate(() => window.scrollY);
    const px = await pixelsOf(page, helper, [[985, 10], [985, 300], [985, 560], [985, 780]]);
    px.forEach((p, i) => {
      if (lumaOf(p) > 0.3) light.push(`pixel at page y ${at + [10, 300, 560, 780][i]}: rgb(${p.join(',')})`);
    });
    const dom = await page.evaluate(() => {
      const parse = (s) => {
        const m = /rgba?\(([^)]+)\)/.exec(s);
        if (!m) return null;
        const q = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { r: q[0], g: q[1], b: q[2], a: q[3] ?? 1 };
      };
      const f = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const out = [];
      for (const [x, vy] of [[200, 20], [500, 300], [800, 560], [300, 780]]) {
        for (const el of document.elementsFromPoint(x, vy)) {
          const cs = getComputedStyle(el);
          const c = parse(cs.backgroundColor);
          let y = null;
          if (c && c.a >= 0.5) y = 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
          else if (cs.backgroundImage.includes('gradient(')) {
            const all = [...cs.backgroundImage.matchAll(/rgba?\([^)]*\)/g)].map((m) => parse(m[0])).filter((g) => g && g.a >= 0.5);
            if (all.length) y = all.reduce((s, g) => s + 0.2126 * f(g.r) + 0.7152 * f(g.g) + 0.0722 * f(g.b), 0) / all.length;
          }
          if (y !== null) {
            if (y > 0.3) out.push(`${el.id || el.localName} at ${x},${vy} luminance ${y.toFixed(2)}`);
            break;
          }
        }
      }
      return out;
    });
    for (const d of dom) light.push(`dom at scroll ${at}: ${d}`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return light;
}

test('a white gradient section below the fold of a page with a dark theme in media rules becomes dark; the theme stays exact', { timeout: 120000 }, async () => {
  const { page, url } = await open('/site-repair-media.html');
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  assert.equal(s.siteDark.reason, 'ok');
  assert.equal(s.siteDark.repair.state, 'done');
  assert.equal(s.siteDark.repairNeeded, true, 'the gate saw the light section');
  // The page's own colors, exactly.
  assert.equal(await style(page, 'body', 'backgroundColor'), 'rgb(16, 20, 24)');
  assert.equal(await style(page, '#hero', 'backgroundColor'), 'rgb(22, 27, 34)');
  assert.equal(await style(page, '#card', 'backgroundColor'), 'rgb(27, 33, 40)');
  assert.equal(await style(page, '#link', 'color'), 'rgb(138, 180, 248)');
  assert.equal(await style(page, '#footer', 'backgroundColor'), 'rgb(13, 17, 23)');
  assert.equal(await style(page, '#promo-text', 'color'), 'rgb(232, 234, 237)');
  // The parts the theme does not cover are dark.
  const promo = await style(page, '#promo', 'backgroundImage');
  assert.ok(promo.includes('gradient'), promo);
  for (const m of promo.matchAll(/rgba?\(([^)]+)\)/g)) assert.ok(lumaOf(m[1].split(/[,\s/]+/).filter(Boolean).map(Number)) < 0.1, promo);
  assert.ok(lumaOf((await style(page, '#inline', 'backgroundColor')).match(/\d+/g).map(Number)) < 0.1);
  const shadowBox = await page.evaluate(() => getComputedStyle(document.getElementById('host').shadowRoot.querySelector('.w')).backgroundColor);
  assert.ok(lumaOf(shadowBox.match(/\d+/g).map(Number)) < 0.1, shadowBox);
  assert.deepEqual(await lightPlaces(page), []);
  const pieces = await page.evaluate(() => [...document.querySelectorAll('style[data-dk="sheet"]')].map((el) => el.textContent.length));
  console.log(`# repair copy: ${s.siteDark.repair.pieces} piece(s), ${s.siteDark.repair.chars} chars, ${s.siteDark.repair.ms.toFixed(1)} ms, ${s.siteDark.repair.covered} covered selectors; piece sizes ${pieces.join(',')}`);
  // The site's rules that the theme covers are not written again.
  const text = await page.evaluate(() => [...document.querySelectorAll('style[data-dk="sheet"]')].map((el) => el.textContent).join('\n'));
  assert.ok(!/#card|\.card|footer\{/.test(text), text);
  assert.ok(s.siteDark.repair.chars < 2500, String(s.siteDark.repair.chars));
  await page.close();
});

test('a dark theme by an attribute of the root in a linked sheet: the white band is repaired in the CSSOM path and the text path alike', { timeout: 120000 }, async () => {
  const { page, url } = await open('/site-repair-attr.html');
  let s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  assert.equal(s.siteDark.repair.state, 'done');
  assert.equal(await style(page, 'body', 'backgroundColor'), 'rgb(16, 20, 24)');
  assert.equal(await style(page, '#card', 'backgroundColor'), 'rgb(27, 33, 40)');
  assert.equal(await style(page, '#link', 'color'), 'rgb(138, 180, 248)');
  const read = () =>
    page.evaluate(() =>
      ['#top', '#band', '#cta', '#card', '#band-text', '#cta-text', '#link'].map((sel) => {
        const cs = getComputedStyle(document.querySelector(sel));
        return [sel, cs.backgroundColor, cs.backgroundImage, cs.color, cs.borderTopColor, cs.boxShadow].join('|');
      }),
    );
  const viaDefault = await read();
  assert.deepEqual(await lightPlaces(page), []);
  const forced = await browser.restartEngine(url, { textPath: false });
  assert.equal(forced.siteDark.state, 'on');
  assert.equal(forced.textSheets, 0);
  await settled(url);
  assert.deepEqual(await read(), viaDefault);
  assert.deepEqual(await lightPlaces(page), []);
  const textOnly = await browser.restartEngine(url, {});
  await settled(url);
  assert.deepEqual(await read(), viaDefault);
  s = textOnly;
  await page.close();
});

test('the CSSOM path and the text path write the same repair for an inline sheet', { timeout: 120000 }, async () => {
  const { page, url } = await open('/site-repair-media.html');
  const read = () =>
    page.evaluate(() =>
      ['#hero', '#features', '#promo', '#promo h2', '#inline', '#footer', '#card', '#link'].map((sel) => {
        const cs = getComputedStyle(document.querySelector(sel));
        return [sel, cs.backgroundColor, cs.backgroundImage, cs.color, cs.borderBottomColor].join('|') + '|' + getComputedStyle(document.querySelector('#host').shadowRoot.querySelector('.w')).backgroundColor;
      }),
    );
  const text = await read();
  const forced = await browser.restartEngine(url, { textPath: false });
  assert.equal(forced.textSheets, 0);
  await settled(url);
  assert.deepEqual(await read(), text);
  await page.close();
});

test('a complete dark theme gets no repair: the copy is empty or tiny, and the page is the site exact', { timeout: 120000 }, async () => {
  const { page, url } = await open('/site-repair-complete.html');
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  assert.equal(s.siteDark.repairNeeded, false);
  const text = await page.evaluate(() => [...document.querySelectorAll('style[data-dk="sheet"], style[data-dk="inline"]')].map((el) => el.textContent).join('\n'));
  console.log(`# complete theme: repair ${s.siteDark.repair.pieces} piece(s), ${s.siteDark.repair.chars} chars, ${s.siteDark.repair.ms.toFixed(1)} ms; text ${JSON.stringify(text)}`);
  assert.ok(s.siteDark.repair.chars <= 120, `${s.siteDark.repair.chars}: ${text}`);
  assert.equal(await style(page, 'body', 'backgroundColor'), 'rgb(16, 20, 24)');
  assert.equal(await style(page, '#one', 'backgroundColor'), 'rgb(22, 27, 34)');
  assert.equal(await style(page, '#card', 'boxShadow'), 'rgba(0, 0, 0, 0.5) 0px 1px 3px 0px');
  assert.deepEqual(await lightPlaces(page), []);
  await page.close();
});

test('a dark theme that is broken or leaves most of the page light falls back to our full theme', { timeout: 120000 }, async () => {
  for (const path of ['/site-dark-broken.html', '/site-repair-mostly-light.html']) {
    const { page, url } = await open(path);
    const s = await browser.stats(url);
    assert.equal(s.siteDark.state, 'off', `${path} ${JSON.stringify(s.siteDark)}`);
    assert.equal(s.siteDark.reason, 'gate');
    assert.equal(s.siteDark.repair.state, 'off');
    assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-dk="site"]').length), 0);
    assert.ok((await page.evaluate(() => document.querySelectorAll('style[data-dk="sheet"]').length)) >= 1);
    assert.deepEqual(await lightPlaces(page), [], path);
    await page.close();
  }
});

test('the repair never shows a light frame: not at the first paint, not while the page is scrolled to the repaired part', { timeout: 180000 }, async () => {
  for (const path of ['/site-repair-media.html', '/site-repair-attr.html']) {
    await browser.clearStorage();
    await browser.setStorage(ON);
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/dark.html`);
    const lightness = await paintedLightness(page, helper, async () => {
      await page.goto(`${servers.origin}${path}`);
      await waitState(page, 'ready', 30000);
      await settled(`${servers.origin}${path}`);
      for (let y = 0; y < 2500; y += 400) {
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await page.waitForTimeout(120);
      }
    });
    console.log(`# ${path}: ${lightness.length} frames, ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
    assert.ok(lightness.length >= 1);
    assert.deepEqual(lightness.filter((v) => v > 0.5), [], `${path} showed a light frame`);
    await page.close();
  }
});

test('with the repair off the white section stays: the repair is what darkens it', { timeout: 120000 }, async () => {
  const { page, url } = await open('/site-repair-media.html');
  const forced = await browser.restartEngine(url, { repair: false });
  assert.equal(forced.siteDark.state, 'on');
  assert.equal(forced.siteDark.repair.state, 'off');
  const promo = await style(page, '#promo', 'backgroundImage');
  assert.ok(/255, 255, 255/.test(promo), promo);
  await page.close();
});

test('a large page with a complete dark theme: the repair copy is a small part of the full copy, and it is built quickly', { timeout: 180000 }, async () => {
  const { page, url } = await open('/gen/site-dark-large.html?rules=4000&uncovered=20');
  const s = await browser.stats(url);
  assert.equal(s.siteDark.state, 'on', JSON.stringify(s.siteDark));
  assert.equal(s.siteDark.repair.state, 'done');
  const repairChars = s.siteDark.repair.chars;
  const uncovered = await page.evaluate(() => getComputedStyle(document.querySelector('.u3')).backgroundColor);
  assert.ok(lumaOf(uncovered.match(/\d+/g).map(Number)) < 0.1, uncovered);
  const promo = await style(page, '#promo', 'backgroundImage');
  for (const m of promo.matchAll(/rgba?\(([^)]+)\)/g)) assert.ok(lumaOf(m[1].split(/[,\s/]+/).filter(Boolean).map(Number)) < 0.1, promo);
  assert.equal(await style(page, '.c37', 'backgroundColor'), 'rgb(23, 33, 40)');
  // The full copy of the same page, for comparison: the site theme off.
  const full = await browser.restartEngine(url, { siteDark: false });
  const fullChars = await page.evaluate(() => [...document.querySelectorAll('style[data-dk="sheet"]')].reduce((n, el) => n + el.textContent.length, 0));
  console.log(`# large page: repair ${repairChars} chars in ${s.siteDark.repair.ms.toFixed(0)} ms (${s.siteDark.repair.pieces} pieces), full copy ${fullChars} chars in ${(full.readyAt - full.startedAt).toFixed(0)} ms`);
  assert.ok(repairChars * 20 < fullChars, `repair ${repairChars}, full ${fullChars}`);
  await page.close();
});
