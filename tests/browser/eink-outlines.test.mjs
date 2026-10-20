// E-ink thickens the borders a control has and draws none where the page drew none. A page that resets borders to `0 solid`
// (width 0, style solid, color from the text) must not get a black frame on every button and field. Faint borders stay faint
// or become a solid gray; Paper changes no widths.
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

async function open(theme, engine = 'dynamic') {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, engine, theme } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/eink-outlines.html`);
  await waitState(page, 'ready', 30000);
  return page;
}

const widths = (page) =>
  page.evaluate(() => Object.fromEntries([...document.querySelectorAll('button,input,[role=button],li')].filter((e) => e.id).map((e) => [e.id, getComputedStyle(e).borderTopWidth])));

const UNDRAWN = ['btnplain', 'field', 'e5', 'e8', 'none'];
const DRAWN = ['btn', 'e1', 'e2', 'e4'];

for (const engine of ['dynamic', 'filterPlus']) {
  test(`E-ink (${engine}): controls the page did not outline stay without outline; drawn borders are thickened`, { timeout: 60000 }, async () => {
    const page = await open({ mode: 'eink', einkPreset: 'eink' }, engine);
    await page.waitForFunction(() => !!document.querySelector('style[data-dk="calm"]'), null, { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('e1') && getComputedStyle(document.getElementById('e1')).borderTopWidth === '2px', null, { timeout: 10000 });
    const w = await widths(page);
    for (const id of UNDRAWN) assert.equal(w[id], '0px', `${id} got a border the page did not draw`);
    for (const id of DRAWN) assert.equal(w[id], '2px', `${id} has a border and was not thickened`);
    await page.close();
  });
}

test('E-ink: controls added later follow the same rule', { timeout: 60000 }, async () => {
  const page = await open({ mode: 'eink', einkPreset: 'eink' });
  await page.waitForFunction(() => document.getElementById('e1') && getComputedStyle(document.getElementById('e1')).borderTopWidth === '2px', null, { timeout: 10000 });
  await page.evaluate(() => {
    const a = document.createElement('button');
    a.id = 'late0';
    a.style.cssText = 'border:0 solid';
    const b = document.createElement('button');
    b.id = 'late1';
    b.style.cssText = 'border:1px solid #999';
    document.body.append(a, b);
  });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('late1')).borderTopWidth === '2px', null, { timeout: 10000 });
  const w = await page.evaluate(() => getComputedStyle(document.getElementById('late0')).borderTopWidth);
  assert.equal(w, '0px');
  await page.close();
});

test('E-ink: no element that had no visible border has one, and no faint border turns black', { timeout: 60000 }, async () => {
  const page = await open({ mode: 'eink', einkPreset: 'eink' });
  await page.waitForFunction(() => document.getElementById('e1') && getComputedStyle(document.getElementById('e1')).borderTopWidth === '2px', null, { timeout: 10000 });
  const bad = await page.evaluate(() => {
    const visible = (c) => parseFloat(c.borderTopWidth) > 0 && c.borderTopStyle !== 'none' && !/ 0\)$/.test(c.borderTopColor);
    const out = [];
    for (const e of document.querySelectorAll('li,button,input,[role=button]')) {
      const c = getComputedStyle(e);
      const nums = (/\(([^)]+)\)/.exec(c.borderTopColor)?.[1] ?? '').split(/[\s,/]+/).map(Number);
      const rgb = c.borderTopColor.startsWith('color(') ? nums.slice(1, 4).map((v) => v * 255) : nums.slice(0, 3);
      const alpha = nums.length > 3 ? nums[nums.length - 1] : 1;
      const p = rgb;
      if (visible(c) && alpha > 0.5 && p[0] < 40 && !['strong'].includes(e.id) && !e.id.startsWith('e5')) out.push(`${e.id} ${c.borderTopColor}`);
    }
    return out;
  });
  assert.deepEqual(bad, []);
  await page.close();
});

test('Paper: no widths change', { timeout: 60000 }, async () => {
  const page = await open({ mode: 'eink', einkPreset: 'paper' });
  await page.waitForFunction(() => !!document.querySelector('style[data-dk="calm"]') || document.documentElement.getAttribute('data-dk-state') === 'ready', null, { timeout: 15000 });
  await page.waitForTimeout(600);
  const w = await widths(page);
  for (const id of UNDRAWN) assert.equal(w[id], '0px', id);
  for (const id of ['btn', 'e1', 'e2', 'e4']) assert.equal(w[id], '1px', id);
  await page.close();
});
