// The settings of the font, the text stroke, the scrollbar color and the selection color are applied by one small style
// element, and nothing is added when they are off.
import { test, before, after, afterEach } from 'node:test';
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
afterEach(async () => {
  for (const page of browser.context.pages()) await page.close().catch(() => {});
});

async function open(theme = {}, extra = {}) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme, ...extra } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/extras.html`);
  await waitState(page, 'ready', 30000);
  // The extras are a module injected after the page is ready, and a busy machine takes long to inject it.
  const wants = theme.mode !== 'eink' && ((theme.fontEnabled === true && !!theme.fontFamily) || theme.textStroke > 0 || (!!theme.scrollbar && theme.scrollbar !== 'auto') || (!!theme.selection && theme.selection !== 'auto'));
  if (wants) await page.waitForFunction(() => !!document.querySelector('style[data-dk=extras]'), null, { timeout: 15000 });
  return page;
}

const family = (page, id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).fontFamily, id);
const styles = (page) => page.evaluate(() => document.querySelectorAll('style[data-dk=extras]').length);

const FONT = { fontEnabled: true, fontFamily: 'Georgia' };

test('the font is applied to text and not to icons, code and hidden decoration that declare their own', { timeout: 60000 }, async () => {
  const page = await open(FONT);
  for (const id of ['title', 'para', 'inner']) assert.match(await family(page, id), /^Georgia/, id);
  // Left alone: an icon font by tag or by class, code and everything inside it, a hidden element.
  // An element that is skipped still inherits the font of its parent when it declares none; the ones below declare their own.
  assert.doesNotMatch(await family(page, 'italic'), /Georgia/);
  assert.doesNotMatch(await family(page, 'iconish'), /Georgia/);
  assert.match(await family(page, 'iconish'), /Icon Test Font/);
  assert.doesNotMatch(await family(page, 'pre'), /Georgia/);
  assert.doesNotMatch(await family(page, 'in-pre'), /Georgia/);
  assert.doesNotMatch(await family(page, 'code'), /Georgia/);
  assert.doesNotMatch(await family(page, 'hidden'), /Georgia/);
  assert.equal(await styles(page), 1);
});

test('a generic family name and a list are written safely; a bad name adds nothing', { timeout: 60000 }, async () => {
  const page = await open({ fontEnabled: true, fontFamily: 'My Font, serif' });
  assert.match(await family(page, 'para'), /My Font/);
  const bad = await open({ fontEnabled: true, fontFamily: '' });
  assert.equal(await styles(bad), 0);
});

test('text weight: the stroke is in tenths of a pixel', { timeout: 60000 }, async () => {
  const page = await open({ textStroke: 5 });
  await page.waitForFunction(() => getComputedStyle(document.body).webkitTextStrokeWidth === '0.5px', null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).webkitTextStrokeWidth), '0.5px');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('inner')).webkitTextStrokeWidth), '0.5px');
});

test('the scrollbar color is applied to the page and to inner scrollers', { timeout: 60000 }, async () => {
  const page = await open({ scrollbar: '#ff0000' });
  const got = await page.evaluate(() => [document.documentElement, document.getElementById('scroller')].map((e) => getComputedStyle(e).scrollbarColor));
  for (const c of got) assert.match(c, /^rgb\(255, 0, 0\)/);
});

test('the selection color sets the highlight with a text color that reads on it', { timeout: 60000 }, async () => {
  const page = await open({ selection: '#ffcc00' });
  const got = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById('para'), '::selection');
    return [s.backgroundColor, s.color];
  });
  assert.equal(got[0], 'rgb(255, 204, 0)');
  assert.equal(got[1], 'rgb(0, 0, 0)');
  const dark = await open({ selection: '#102040' });
  const d = await dark.evaluate(() => getComputedStyle(document.getElementById('para'), '::selection').color);
  assert.equal(d, 'rgb(255, 255, 255)');
});

test('nothing is added when the settings are off or automatic', { timeout: 60000 }, async () => {
  const page = await open({ fontEnabled: false, fontFamily: 'Georgia', textStroke: 0, scrollbar: 'auto', selection: 'auto' });
  assert.equal(await styles(page), 0);
  assert.doesNotMatch(await family(page, 'para'), /Georgia/);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).webkitTextStrokeWidth), '0px');
});

test('under a Filter engine the font and the weight apply, the colors do not', { timeout: 60000 }, async () => {
  const page = await open({ ...FONT, textStroke: 3, scrollbar: '#ff0000', selection: '#ffcc00' }, { engine: 'filter' });
  assert.match(await family(page, 'para'), /^Georgia/);
  const text = await page.evaluate(() => document.querySelector('style[data-dk=extras]').textContent);
  assert.doesNotMatch(text, /scrollbar-color|::selection/);
});

test('the E-ink and Paper mode keeps its own font and weight; the extras are not used', { timeout: 60000 }, async () => {
  const page = await open({ mode: 'eink', einkPreset: 'paper', ...FONT, scrollbar: '#ff0000' });
  assert.equal(await styles(page), 0);
});

test('switching the engine off removes the element', { timeout: 60000 }, async () => {
  const page = await open(FONT);
  assert.equal(await styles(page), 1);
  await browser.setStorage({ settings: { enabled: false } });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dk-state'), undefined, { timeout: 10000 });
  assert.equal(await styles(page), 0);
  assert.doesNotMatch(await family(page, 'para'), /Georgia/);
});
