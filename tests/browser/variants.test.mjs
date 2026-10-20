import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

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

const ON = { settings: { enabled: true, theme: { mode: 'dark' } } };

async function open(path = '/variants.html') {
  await browser.clearStorage();
  await browser.setStorage(ON);
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}${path}`);
  await waitState(page, 'ready', 30000 * SLOW);
  return page;
}

/** The text of the copies of the sheets, as the browser holds it. */
const copies = (page) => page.evaluate(() => [...document.querySelectorAll('style[data-dk="sheet"]')].map((s) => s.textContent).join('\n'));
const colors = (page, ids) =>
  page.evaluate(
    (list) =>
      Object.fromEntries(
        list.map((id) => {
          const cs = getComputedStyle(document.getElementById(id));
          return [id, { bg: cs.backgroundColor, fg: cs.color, bd: cs.borderTopColor, sh: cs.boxShadow }];
        }),
      ),
    ids,
  );
const light = (css) => {
  const p = /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};

test('the variants of a color variable are written for the roles it is read for, and the page is themed as before', { timeout: 60000 }, async () => {
  const page = await open();
  const text = await copies(page);
  assert.ok(!text.includes('/*~'), 'no marker stays in the page');
  // Read as a background, a text color and a border color, and by a shadow (which falls back to the background variant).
  assert.match(text, /--dk-bg--page:/);
  assert.match(text, /--dk-fg--ink:/);
  assert.match(text, /--dk-bd--line:/);
  assert.match(text, /--dk-sh--glow:|--dk-bg--glow:/);
  // Never read: nothing is written for it. A role nobody reads is not written either.
  assert.ok(!/--dk-\w+--unused/.test(text), 'a variable that nothing reads has no variant');
  assert.ok(!/--dk-\w+--size/.test(text));
  assert.ok(!text.includes('--dk-bd--page:'), 'the border variant of --page is not read yet');
  const c = await colors(page, ['bg', 'chain', 'chan', 'bd', 'lit']);
  assert.ok(light(c.bg.bg) < 0.25, c.bg.bg);
  assert.equal(c.bg.bg, c.lit.bg, 'a variable and a literal of the same color are themed alike');
  assert.equal(c.chain.bg, c.lit.bg, 'a variable that points at a variable follows it');
  assert.ok(light(c.chan.bg) < 0.25, c.chan.bg);
  assert.ok(c.bd.bd !== 'rgb(204, 204, 204)', c.bd.bd);
  assert.ok(light(c.bg.fg) > 0.6, c.bg.fg);
  const stats = await browser.stats(page.url());
  assert.ok(stats.variants.names >= 4, JSON.stringify(stats.variants));
  await page.close();
});

test('a sheet that arrives later and reads a new role gets the variant', { timeout: 60000 }, async () => {
  const page = await open();
  const before = await copies(page);
  assert.ok(!before.includes('--dk-fg--page:'));
  assert.ok(!/--dk-bd--unused:/.test(before));
  await page.evaluate(() => window.addLateSheet());
  await page.waitForFunction(() => [...document.querySelectorAll('style[data-dk="sheet"]')].some((s) => s.textContent.includes('#late')), null, { timeout: 15000 * SLOW });
  const state = await page.evaluate(() => {
    const text = [...document.querySelectorAll('style[data-dk="sheet"]')].map((s) => s.textContent).join('\n');
    const cs = getComputedStyle(document.getElementById('late'));
    return { fg: text.includes('--dk-fg--page:'), bg: text.includes('--dk-bg--ink:'), bd: text.includes('--dk-bd--unused:'), color: cs.color, back: cs.backgroundColor, border: cs.borderTopColor };
  });
  // The variants are in the page when the copy of the late sheet is: no frame shows the page's own colors.
  assert.equal(state.fg, true);
  assert.equal(state.bg, true);
  assert.equal(state.bd, true);
  assert.notEqual(state.color, 'rgb(255, 255, 255)');
  assert.notEqual(state.back, 'rgb(34, 34, 34)');
  assert.notEqual(state.border, 'rgb(255, 0, 255)');
  await page.close();
});

test('a variable that changes value under a selector keeps its variants under that selector', { timeout: 60000 }, async () => {
  const page = await open();
  const before = await page.evaluate(() => getComputedStyle(document.getElementById('bg')).backgroundColor);
  await page.evaluate(() => document.documentElement.setAttribute('data-flip', ''));
  const after = await page.evaluate(() => getComputedStyle(document.getElementById('bg')).backgroundColor);
  assert.notEqual(before, after, 'the flipped value is themed to its own color');
  assert.ok(light(after) < 0.3, after);
  await page.close();
});

test('an inline style that reads a variable after the page is ready gets the role it needs', { timeout: 60000 }, async () => {
  const page = await open();
  assert.ok(!(await copies(page)).includes('--dk-fg--line:'));
  await page.evaluate(() => {
    document.getElementById('sh').setAttribute('style', 'color: var(--line)');
  });
  await page.waitForFunction(() => [...document.querySelectorAll('style[data-dk="sheet"]')].some((s) => s.textContent.includes('--dk-fg--line:')), null, { timeout: 15000 * SLOW });
  await page.close();
});

test('a switched-off site keeps no marker and no element', { timeout: 60000 }, async () => {
  const page = await open();
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => document.querySelectorAll('[data-dk]').length === 0, null, { timeout: 15000 * SLOW });
  await page.close();
});

test('a style element in a shadow root and a constructed sheet read the variables of the page', { timeout: 60000 }, async () => {
  const page = await open();
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'host';
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>.in { background: var(--page); color: var(--ink); height: 20px }</style><div class="in" id="in">in</div>';
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.ad { background: var(--alias); height: 20px }');
    const host2 = document.createElement('div');
    host2.id = 'host2';
    document.body.append(host2);
    const root2 = host2.attachShadow({ mode: 'open' });
    root2.adoptedStyleSheets = [sheet];
    root2.innerHTML = '<div class="ad" id="ad">ad</div>';
  });
  await page.waitForFunction(
    () => {
      const a = getComputedStyle(document.getElementById('host').shadowRoot.getElementById('in')).backgroundColor;
      const b = getComputedStyle(document.getElementById('host2').shadowRoot.getElementById('ad')).backgroundColor;
      return a !== 'rgb(255, 255, 255)' && b !== 'rgb(255, 255, 255)';
    },
    null,
    { timeout: 15000 * SLOW },
  );
  const [inner, adopted, outer] = await page.evaluate(() => [
    getComputedStyle(document.getElementById('host').shadowRoot.getElementById('in')).backgroundColor,
    getComputedStyle(document.getElementById('host2').shadowRoot.getElementById('ad')).backgroundColor,
    getComputedStyle(document.getElementById('bg')).backgroundColor,
  ]);
  assert.equal(inner, outer);
  assert.equal(adopted, outer);
  await page.close();
});

test('a change of the look reads the same variables again and shows no marker', { timeout: 90000 }, async () => {
  const page = await open();
  await browser.setStorage({ settings: { enabled: true, theme: { mode: 'light' } } });
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="sheet"]'), null, { timeout: 15000 * SLOW });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-dk-state') === 'ready', null, { timeout: 15000 * SLOW });
  const text = await copies(page);
  assert.ok(!text.includes('/*~'), 'no marker stays in the page');
  assert.match(text, /--dk-bg--page:/);
  const c = await colors(page, ['bg', 'lit']);
  assert.equal(c.bg.bg, c.lit.bg);
  await page.close();
});
