import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, paintedLightness, SLOW } from './harness.mjs';

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

const settings = (engine, theme = {}) => ({ settings: { enabled: true, engine, theme } });

async function open(path, storage) {
  await browser.clearStorage();
  await browser.setStorage(storage);
  const page = await browser.context.newPage();
  // A tab in the background gets no frames, so the watcher would see nothing.
  await page.bringToFront();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready');
  return { page, url: `${servers.origin}${path}` };
}

/**
 * Look at the page before every frame is painted, and count the frames in which one of the elements is light.
 * `requestAnimationFrame` callbacks run just before the paint, so this sees what the paint would show.
 */
async function startWatching(page, selectors) {
  await page.evaluate((list) => {
    window.__watch = { frames: 0, light: [], stop: false };
    // An animation that changes nothing visible keeps frames coming; a still headless page may paint none.
    window.__watch.anim = document.documentElement.animate([{ opacity: 1 }, { opacity: 0.999 }], { duration: 1000, iterations: Infinity });
    const lum = (css) => {
      const m = /rgba?\(([^)]+)\)/.exec(css);
      if (!m) return 0;
      const [r, g, b] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const tick = () => {
      window.__watch.frames++;
      for (const s of list) {
        const el = document.querySelector(s);
        if (!el) continue;
        const l = lum(getComputedStyle(el).backgroundColor);
        if (l > 0.55 && window.__watch.light.length < 20) window.__watch.light.push(`${s} ${l.toFixed(2)} at frame ${window.__watch.frames}`);
      }
      if (!window.__watch.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, selectors);
}

async function stopWatching(page) {
  return page.evaluate(() => {
    window.__watch.stop = true;
    window.__watch.anim.cancel();
    return { frames: window.__watch.frames, light: window.__watch.light };
  });
}

/** Wait until the engine that themes the page is a different one from `before`. */
async function waitForSwap(url, before, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const s = await browser.stats(url);
    if (s && s.startedAt !== before.startedAt && s.ready) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('the new engine did not take over');
}

const WATCH = ['body', '.card', 'footer', 'p[style]'];

test('a change of theme never shows a light frame, also on a page that takes seconds to rebuild', { timeout: 120000 }, async () => {
  const { page, url } = await open('/gen/large.html?rules=30000&palette=40', settings('dynamic'));
  const before = await browser.stats(url);
  const colorBefore = await page.evaluate(() => getComputedStyle(document.querySelector('.c37')).backgroundColor);
  await startWatching(page, ['body', '.c37', '.c74']);
  const frameLightness = await paintedLightness(page, helper, async () => {
    await browser.setStorage(settings('dynamic', { brightness: 70 }));
    await waitForSwap(url, before);
  });
  const watched = await stopWatching(page);
  const after = await browser.stats(url);
  const colorAfter = await page.evaluate(() => getComputedStyle(document.querySelector('.c37')).backgroundColor);
  console.log(`# theme change on 30 000 rules: ${watched.frames} frames watched, ${watched.light.length} light; ${frameLightness.length} captured frames, lightest ${Math.max(...frameLightness).toFixed(2)}; swap after ${(after.readyAt - before.readyAt).toFixed(0)} ms`);
  assert.deepEqual(watched.light, []);
  assert.ok(Math.max(...frameLightness) < 0.4, `a captured frame had lightness ${Math.max(...frameLightness)}`);
  assert.notEqual(colorAfter, colorBefore, 'the new theme must show');
  await page.close();
});

test('control: turning the site off does show the page in its own colors, and the capture sees it', { timeout: 120000 }, async () => {
  const { page } = await open('/basic.html', settings('dynamic'));
  const lightness = await paintedLightness(page, helper, async () => {
    await browser.setStorage({ settings: { enabled: false } });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'));
    await new Promise((r) => setTimeout(r, 200));
  });
  console.log(`# control, extension turned off: captured frames ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
  assert.ok(Math.max(...lightness) > 0.6, 'the capture must be able to see a light frame');
  await page.close();
});

test('changes of the sliders and of the mode keep the page themed all the time, inline styles included', { timeout: 120000 }, async () => {
  const { page, url } = await open('/basic.html', settings('dynamic'));
  await startWatching(page, WATCH);
  for (const theme of [{ brightness: 80 }, { contrast: 120 }, { sepia: 30 }, { grayscale: 40, brightness: 95 }]) {
    const before = await browser.stats(url);
    await browser.setStorage(settings('dynamic', theme));
    await waitForSwap(url, before);
  }
  // Keep watching for a few more frames: the swaps themselves can be quicker than that.
  await page.waitForFunction(() => window.__watch.frames > 12);
  const watched = await stopWatching(page);
  console.log(`# four slider changes on the basic page: ${watched.frames} frames watched, ${watched.light.length} light`);
  assert.deepEqual(watched.light, []);
  assert.ok(watched.frames > 5, `only ${watched.frames} frames were watched`);
  await page.close();
});

test('switching to Filter+, to Filter and back to Dynamic never shows a light frame', { timeout: 120000 }, async () => {
  const { page, url } = await open('/basic.html', settings('dynamic'));
  const lightness = await paintedLightness(page, helper, async () => {
    await browser.setStorage(settings('filterPlus'));
    await page.waitForFunction(() => document.querySelectorAll('svg[data-dk]').length === 1);
    await new Promise((r) => setTimeout(r, 200));
    await browser.setStorage(settings('filter'));
    await page.waitForFunction(() => document.querySelectorAll('svg[data-dk]').length === 0 && document.querySelectorAll('style[data-dk="filter"]').length === 1);
    await new Promise((r) => setTimeout(r, 200));
    const before = await browser.stats(url);
    assert.equal(before.kind, 'filter');
    await browser.setStorage(settings('dynamic'));
    await page.waitForFunction(() => document.querySelectorAll('style[data-dk="sheet"]').length > 0 && document.querySelectorAll('style[data-dk="filter"]').length === 0);
    await new Promise((r) => setTimeout(r, 200));
  });
  console.log(`# engine switches: ${lightness.length} captured frames, lightness ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
  assert.ok(lightness.length >= 3);
  assert.ok(Math.max(...lightness) < 0.4, 'a frame was light');
  assert.notEqual((await browser.stats(url)).kind, 'filter');
  await page.close();
});

test('quick changes one after the other end in the last one, with nothing left over', { timeout: 120000 }, async () => {
  const { page, url } = await open('/basic.html', settings('dynamic'));
  const first = await browser.stats(url);
  // A sheet that loads late is themed after the engine says ready, so wait until the number of elements stops changing.
  for (let last = -1, same = 0; same < 3; ) {
    const n = await page.evaluate(() => document.querySelectorAll('style[data-dk]').length);
    same = n === last ? same + 1 : 0;
    last = n;
    await new Promise((r) => setTimeout(r, 200));
  }
  const pieces = await page.evaluate(() => document.querySelectorAll('style[data-dk]').length);
  const firstNames = await page.evaluate(() => [...document.querySelectorAll('style[data-dk]')].map((e) => e.getAttribute('data-dk')));
  for (let i = 0; i < 8; i++) {
    await browser.setStorage(settings('dynamic', { brightness: 60 + i * 5 }));
    await new Promise((r) => setTimeout(r, 30));
  }
  // The last value is brightness 95. Wait until no staged piece is left and the count has not changed for a while.
  const last = await waitForSwap(url, first);
  let quiet = 0;
  while (quiet < 3) {
    const staged = await page.evaluate(() => document.querySelectorAll('style[data-dk][media="not all"]').length);
    quiet = staged === 0 ? quiet + 1 : 0;
    await new Promise((r) => setTimeout(r, 150));
  }
  const settled = await browser.stats(url);
  assert.ok(settled.ready);
  const counts = await page.evaluate(() => ({
    styles: document.querySelectorAll('style[data-dk]').length,
    staged: document.querySelectorAll('style[data-dk][media="not all"]').length,
    attrs: [document.querySelectorAll('[data-dk-i]').length, document.querySelectorAll('[data-dk-j]').length],
    state: document.documentElement.getAttribute('data-dk-state'),
  }));
  console.log(`# after eight quick changes: ${JSON.stringify(counts)}, started ${last.startedAt.toFixed(0)}`);
  assert.equal(counts.staged, 0, 'no piece may stay switched off');
  assert.equal(counts.styles, pieces, `the number of elements must be the same as after the first start (first ${JSON.stringify(firstNames)}, now ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('style[data-dk]')].map((e) => e.getAttribute('data-dk'))))})`);
  assert.equal(counts.state, 'ready');
  // Inline styles belong to one engine only.
  assert.ok(counts.attrs[0] === 0 || counts.attrs[1] === 0, `both attributes are in use: ${counts.attrs}`);
  await page.close();
});

test('turning the site off after changes leaves the original page', { timeout: 120000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: false } });
  const plain = await browser.context.newPage();
  await plain.goto(`${servers.origin}/basic.html`);
  const original = await plain.evaluate(() => document.documentElement.outerHTML);
  await plain.close();

  const { page, url } = await open('/basic.html', settings('dynamic'));
  for (const theme of [{ brightness: 80 }, { sepia: 20 }]) {
    const before = await browser.stats(url);
    await browser.setStorage(settings('dynamic', theme));
    await waitForSwap(url, before);
  }
  await browser.setStorage({ settings: { enabled: false } });
  await waitState(page, null);
  assert.equal(await page.evaluate(() => document.documentElement.outerHTML), original);
  await page.close();
});

test('constructed sheets in shadow roots swap without a gap', { timeout: 120000 }, async () => {
  const { page, url } = await open('/shadow.html', settings('dynamic'));
  await page.waitForFunction(() => {
    const el = document.getElementById('adopted').shadowRoot.querySelector('.t');
    return getComputedStyle(el).backgroundColor !== 'rgb(243, 229, 245)';
  });
  await page.evaluate(() => {
    window.__light = 0;
    const el = document.getElementById('adopted').shadowRoot.querySelector('.t');
    const tick = () => {
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor);
      const [r, g, b] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55) window.__light++;
      if (!window.__done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const before = await browser.stats(url);
  await browser.setStorage(settings('dynamic', { brightness: 75 }));
  await waitForSwap(url, before);
  await new Promise((r) => setTimeout(r, 300));
  const light = await page.evaluate(() => {
    window.__done = true;
    return window.__light;
  });
  const lists = await page.evaluate(() => document.getElementById('adopted').shadowRoot.adoptedStyleSheets.length);
  assert.equal(light, 0, 'the adopted sheet of the component must stay themed during the swap');
  assert.equal(lists, 2, 'one original and one override');
  await page.close();
});

test('quick on and off switching never flips the page more than three times in a second', { timeout: 60000 }, async () => {
  const { page } = await open('/basic.html', settings('dynamic'));
  await page.evaluate(() => {
    window.__flips = [];
    let was = document.documentElement.getAttribute('data-dk-state') === 'ready';
    new MutationObserver(() => {
      const now = document.documentElement.getAttribute('data-dk-state') === 'ready';
      if (now !== was) window.__flips.push(performance.now());
      was = now;
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-dk-state'] });
  });
  for (let i = 0; i < 8; i++) {
    await browser.setStorage({ settings: { enabled: i % 2 === 1, engine: 'dynamic' } });
    await new Promise((r) => setTimeout(r, 70));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const flips = await page.evaluate(() => window.__flips);
  console.log(`# ${flips.length} flips: ${flips.map((f, i) => (i ? Math.round(f - flips[i - 1]) : 0)).join(' ')} ms apart`);
  for (let i = 1; i < flips.length; i++) assert.ok(flips[i] - flips[i - 1] >= 300, `flips ${flips[i] - flips[i - 1]} ms apart`);
  for (let i = 3; i < flips.length; i++) assert.ok(flips[i] - flips[i - 3] > 1000 - 1, 'more than three flips in one second');
  await page.close();
});

/** The lightness of the body background in every frame, from the moment this is called. */
async function recordLightness(page) {
  await page.evaluate(() => {
    window.__lum = { at: performance.now(), frames: [], stop: false };
    const lum = (css) => {
      const m = /rgba?\(([^)]+)\)/.exec(css);
      if (!m) return 1;
      const [r, g, b] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const tick = () => {
      window.__lum.frames.push([Math.round(performance.now() - window.__lum.at), lum(getComputedStyle(document.body).backgroundColor), lum(getComputedStyle(document.documentElement).backgroundColor)]);
      if (!window.__lum.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test('a change of mode shows the new look in one step, keeps it, and never goes back to the old one', { timeout: 180000 }, async () => {
  for (const [from, to, theme] of [
    ['dark', 'light', { mode: 'light' }],
    ['light', 'dark', { mode: 'dark' }],
    ['dark', 'paper', { mode: 'eink', einkPreset: 'paper' }],
    ['paper', 'eink', { mode: 'eink', einkPreset: 'eink' }],
    ['eink', 'dark', { mode: 'dark' }],
  ]) {
    const start = { dark: { mode: 'dark' }, light: { mode: 'light' }, paper: { mode: 'eink', einkPreset: 'paper' }, eink: { mode: 'eink', einkPreset: 'eink' } }[from];
    const { page, url } = await open('/gen/large.html?rules=30000&palette=40', settings('dynamic', start));
    const before = await browser.stats(url);
    await recordLightness(page);
    await browser.setStorage(settings('dynamic', theme));
    const after = await waitForSwap(url, before);
    const level = (v) => (v < 0.4 ? 'dark' : 'light');
    const goesTo = to === 'dark' ? 'dark' : 'light';
    // The old look stays until the new copy takes over; the frames are read until some follow the first frame of the new look.
    let rec = [];
    let seq = [];
    let first = -1;
    for (let i = 0; i < 400 && !(first >= 0 && seq.length - first > 8); i++) {
      await new Promise((r) => setTimeout(r, 50));
      rec = await page.evaluate(() => window.__lum.frames);
      seq = rec.map(([, body, root]) => level(Math.min(body, root < 0.05 ? body : root)));
      first = seq.findIndex((l) => l === goesTo);
    }
    await page.evaluate(() => {
      window.__lum.stop = true;
    });
    assert.ok(first >= 0, `${from} to ${to}: the new look never showed (${seq.join(' ')})`);
    // Once the new look shows, no later frame shows the old one.
    assert.deepEqual([...new Set(seq.slice(first))], [goesTo], `${from} to ${to}: the page went back (${seq.join(' ')})`);
    // The held transitions go after the second frame that follows the commit.
    await page.waitForFunction(() => !document.querySelector('style[data-dk="freeze"]'), null, { timeout: 8000 });
    const staged = await page.evaluate(() => ({ quick: document.querySelectorAll('style[data-dk="quick"]').length, off: document.querySelectorAll('style[data-dk][media="not all"]').length, freeze: document.querySelectorAll('style[data-dk="freeze"]').length }));
    assert.deepEqual(staged, { quick: 0, off: 0, freeze: 0 });
    const showAt = rec[first][0];
    console.log(`# ${from} to ${to} on 30 000 rules: the new look showed in frame ${first}, ${showAt} ms after the change; the real copy was ready ${Math.round(after.readyAt - before.readyAt)} ms (engine clock) after the old one`);
    assert.ok(showAt < 4000 * SLOW, `${from} to ${to}: the new look took ${showAt} ms to show`);
    await page.close();
  }
});

test('the painted frames of a change of mode on the big page leave the old look once and do not come back', { timeout: 120000 }, async () => {
  for (const [from, to, theme, startTheme] of [
    ['dark', 'light', { mode: 'light' }, { mode: 'dark' }],
    ['light', 'dark', { mode: 'dark' }, { mode: 'light' }],
  ]) {
    const { page, url } = await open('/gen/large.html?rules=30000&palette=40', settings('dynamic', startTheme));
    const before = await browser.stats(url);
    const lightness = await paintedLightness(page, helper, async () => {
      await browser.setStorage(settings('dynamic', theme));
      await waitForSwap(url, before);
    });
    // The real copy of a page of many colored boxes is neither as light nor as dark as a flat page, so the new look is not a
    // fixed level: it is whatever differs from the old one, and the old one must not come back.
    const old = lightness[0];
    const away = (v) => Math.abs(v - old) > 0.1;
    const first = lightness.findIndex(away);
    console.log(`# painted frames ${from} to ${to}: ${lightness.map((v) => v.toFixed(2)).join(' ')}`);
    assert.ok(first >= 0, 'the new look must be painted');
    assert.ok(lightness.slice(first).every(away), 'no painted frame goes back to the old look after the new one appeared');
    await page.close();
  }
});

test('switching to E-ink on a page of 14 000 elements does not freeze the page: the transitions of the E-ink rules are held at the commit', { timeout: 120000 }, async () => {
  const { page } = await open('/gen/code.html?blocks=60', settings('dynamic', { mode: 'dark' }));
  const elements = await page.evaluate(() => document.getElementsByTagName('*').length);
  const worst = [];
  for (const theme of [{ mode: 'eink', einkPreset: 'eink' }, { mode: 'dark' }, { mode: 'eink', einkPreset: 'eink' }]) {
    await page.evaluate(() => {
      window.__g = { gaps: [], stop: false };
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        window.__g.gaps.push(now - last);
        last = now;
        if (!window.__g.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await new Promise((r) => setTimeout(r, 200));
    const before = await browser.stats(page.url());
    await browser.setStorage(settings('dynamic', theme));
    await waitForSwap(page.url(), before);
    await new Promise((r) => setTimeout(r, 1500));
    const gaps = await page.evaluate(() => {
      window.__g.stop = true;
      return window.__g.gaps;
    });
    worst.push(Math.round(Math.max(...gaps)));
  }
  console.log(`# ${elements} elements, longest frame gap in three switches (E-ink, dark, E-ink): ${worst.join(', ')} ms (the build before : about 2 200 and 1 600 ms to E-ink)`);
  for (const w of worst) assert.ok(w < 1000, `a frame took ${w} ms`);
  await page.close();
});
