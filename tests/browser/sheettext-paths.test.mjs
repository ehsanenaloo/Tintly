// Which path reads a sheet, and what the copy does to the cascade. The same-copy check over a large corpus is in
// sheettext.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState } from './harness.mjs';

let servers;
let browser;

before(async () => {
  servers = await startServers();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const ON = { settings: { enabled: true } };

const luminance = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};

async function openBlank() {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  const url = `${servers.origin}/gen/blank.html`;
  await page.goto(url);
  await waitState(page, 'ready');
  return { page, url };
}

/** Wait until the engine has nothing queued and has made `n` copies or more. */
async function settle(url, n) {
  for (let i = 0; i < 200; i++) {
    const s = await browser.stats(url);
    if (s.sheets >= n && !s.waiting.pending && !s.waiting.pumping && !s.waiting.fetching) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  return browser.stats(url);
}

const colorOf = (page, id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).color, id);

test('a linked sheet of this origin is read from the cache, one of another origin through the worker, both as text', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const linked = await browser.context.newPage();
  const url = `${servers.origin}/gen/large.html?rules=800&palette=40&linked=1`;
  await linked.goto(url);
  await waitState(linked, 'ready');
  const s = await browser.stats(url);
  // On the first load the browser may not have written the file to its cache yet; then the CSSOM walk reads the sheet.
  assert.equal(s.textSheets + s.cssomSheets, 1);
  if (s.textSheets === 0) assert.ok(s.cacheMisses >= 1, JSON.stringify({ misses: s.cacheMisses, error: s.cacheError }));
  assert.ok(luminance(await linked.evaluate(() => getComputedStyle(document.body).backgroundColor)) < 0.3);
  // The second load has the file in the cache.
  await linked.reload();
  await waitState(linked, 'ready');
  const again = await browser.stats(url);
  assert.equal(again.textSheets, 1, JSON.stringify({ text: again.textSheets, cssom: again.cssomSheets, misses: again.cacheMisses, error: again.cacheError }));
  assert.equal(again.cssomSheets, 0);
  assert.ok(luminance(await linked.evaluate(() => getComputedStyle(document.body).backgroundColor)) < 0.3);
  await linked.close();

  const cross = await browser.context.newPage();
  const crossUrl = `${servers.origin}/cross-sheets.html`;
  await cross.goto(`${crossUrl}#${servers.other}`);
  await waitState(cross, 'ready');
  const c = await settle(crossUrl, 2);
  assert.ok(c.textSheets >= 2, JSON.stringify({ text: c.textSheets, cssom: c.cssomSheets, fetched: c.fetched, reasons: c.textReasons }));
  assert.ok(c.fetched >= 1);
  assert.ok(luminance(await cross.evaluate(() => getComputedStyle(document.querySelector('.linked-note')).color)) > 0.5);
  await cross.close();
});

test('a sheet that script changed is read through the CSSOM, and so is one that script built', { timeout: 60000 }, async () => {
  const { page, url } = await openBlank();
  await page.evaluate(() => {
    const edited = document.createElement('style');
    edited.textContent = '.a{color:#111111}';
    document.head.append(edited);
    // The text says one rule and the CSSOM two: the text is not the sheet.
    edited.sheet.insertRule('#edited{color:#222222}', 1);
    const built = document.createElement('style');
    document.head.append(built);
    // A library that fills an empty style element through the CSSOM.
    built.sheet.insertRule('#built{color:#333333}', 0);
    built.sheet.insertRule('#built2{background-color:#ffffff}', 1);
    for (const id of ['edited', 'built', 'built2']) {
      const p = document.createElement('p');
      p.id = id;
      p.textContent = id;
      document.body.append(p);
    }
  });
  const s = await settle(url, 2);
  assert.ok(s.cssomSheets >= 2, JSON.stringify({ text: s.textSheets, cssom: s.cssomSheets, reasons: s.textReasons }));
  assert.ok(luminance(await colorOf(page, 'edited')) > 0.5, await colorOf(page, 'edited'));
  assert.ok(luminance(await colorOf(page, 'built')) > 0.5, await colorOf(page, 'built'));
  assert.ok(luminance(await page.evaluate(() => getComputedStyle(document.getElementById('built2')).backgroundColor)) < 0.3);
  await page.close();
});

test('rules that the browser drops from the sheet do not send it to the CSSOM', { timeout: 60000 }, async () => {
  const { page, url } = await openBlank();
  await page.evaluate(() => {
    const style = document.createElement('style');
    // Chromium drops the first and the third rule (unknown pseudo-elements) and keeps the others.
    style.textContent = 'x::-moz-no-such-thing{color:red}#kept{color:#111111}y::-webkit-no-such-thing{color:red}#kept2{color:#222222}';
    document.head.append(style);
    for (const id of ['kept', 'kept2']) {
      const p = document.createElement('p');
      p.id = id;
      p.textContent = id;
      document.body.append(p);
    }
  });
  const s = await settle(url, 1);
  assert.equal(s.cssomSheets, 0, JSON.stringify(s.textReasons));
  assert.ok(luminance(await colorOf(page, 'kept')) > 0.5);
  assert.ok(luminance(await colorOf(page, 'kept2')) > 0.5);
  await page.close();
});

test('an @import in a style element is followed through the CSSOM while the rest comes from the text', { timeout: 60000 }, async () => {
  const { page, url } = await openBlank();
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '@import url(/css/imported.css);#own{color:#111111}';
    document.head.append(style);
    for (const [id, cls] of [['own', ''], ['imp', 'imported-note']]) {
      const p = document.createElement('p');
      p.id = id;
      p.className = cls;
      p.textContent = id;
      document.body.append(p);
    }
  });
  // The imported file may arrive after the sheet is copied; the engine looks again. Its light background turns dark.
  await page.waitForFunction(() => {
    const css = getComputedStyle(document.getElementById('imp')).backgroundColor;
    if (css === 'rgba(0, 0, 0, 0)') return false;
    const [r, g, b] = css.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.3;
  }, null, { timeout: 15000 });
  const s = await browser.stats(url);
  assert.ok(s.textSheets >= 1, JSON.stringify({ text: s.textSheets, reasons: s.textReasons }));
  assert.ok(luminance(await colorOf(page, 'own')) > 0.5);
  assert.notEqual(await colorOf(page, 'imp'), 'rgb(74, 20, 140)');
  await page.close();
});

test('a rule inside a named container query is themed (the CSSOM walk used to write its head twice)', { timeout: 60000 }, async () => {
  const { page, url } = await openBlank();
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '.box{container-type:inline-size;container-name:card}@container card (min-width:1px){#cq{color:#111111}}';
    document.head.append(style);
    document.body.insertAdjacentHTML('beforeend', '<div class="box"><p id="cq">in a container</p></div>');
  });
  await settle(url, 1);
  assert.ok(luminance(await colorOf(page, 'cq')) > 0.5, await colorOf(page, 'cq'));
  // The same through the CSSOM walk.
  await browser.restartEngine(url, { early: false, hold: false, textPath: false });
  assert.ok(luminance(await colorOf(page, 'cq')) > 0.5, await colorOf(page, 'cq'));
  await page.close();
});

test('a shorthand in the copy never resets what a later rule of the page sets', { timeout: 60000 }, async () => {
  const { page, url } = await openBlank();
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '.s{border:3px solid #dddddd;background:#ffffff url(/gen/img/x.png) no-repeat;padding:0}.s{border-width:7px;border-style:dashed;background-size:50%;background-position:10px 20px}';
    document.head.append(style);
    document.body.insertAdjacentHTML('beforeend', '<div class="s" id="s">x</div>');
  });
  await settle(url, 1);
  const got = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('s'));
    return { width: cs.borderTopWidth, style: cs.borderTopStyle, size: cs.backgroundSize, repeat: cs.backgroundRepeat, position: cs.backgroundPosition, color: cs.borderTopColor };
  });
  assert.equal(got.width, '7px');
  assert.equal(got.style, 'dashed');
  assert.match(got.size, /^50%/);
  assert.equal(got.repeat, 'no-repeat');
  assert.equal(got.position, '10px 20px');
  assert.notEqual(got.color, 'rgb(221, 221, 221)');
  await page.close();
});

test('a change of only the media of a sheet moves the media of its copy and does not build it again', { timeout: 60000 }, async () => {
  const { page, url } = await openBlank();
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'media-sheet';
    style.media = 'screen';
    style.textContent = '#m{color:#111111}';
    document.head.append(style);
    document.body.insertAdjacentHTML('beforeend', '<p id="m">media</p>');
  });
  const first = await settle(url, 1);
  const pieceMedia = () => page.evaluate(() => document.getElementById('media-sheet').nextElementSibling.getAttribute('media'));
  assert.equal(await pieceMedia(), 'screen');
  await page.evaluate(() => {
    document.getElementById('media-sheet').media = 'screen and (min-width: 1px)';
  });
  await page.waitForFunction(() => document.getElementById('media-sheet').nextElementSibling.getAttribute('media') === 'screen and (min-width: 1px)', null, { timeout: 5000 });
  const after = await browser.stats(url);
  assert.equal(after.processed, first.processed, 'the sheet was built again');
  assert.ok(luminance(await colorOf(page, 'm')) > 0.5);
  // All media again: the attribute of the copy goes.
  await page.evaluate(() => {
    document.getElementById('media-sheet').removeAttribute('media');
  });
  await page.waitForFunction(() => !document.getElementById('media-sheet').nextElementSibling.hasAttribute('media'), null, { timeout: 5000 });
  assert.equal((await browser.stats(url)).processed, first.processed);
  // Print media is another matter: the copy goes.
  await page.evaluate(() => {
    document.getElementById('media-sheet').media = 'print';
  });
  await page.waitForFunction(() => !document.getElementById('media-sheet').nextElementSibling || document.getElementById('media-sheet').nextElementSibling.getAttribute('data-dk') !== 'sheet', null, { timeout: 5000 });
  await page.close();
});
