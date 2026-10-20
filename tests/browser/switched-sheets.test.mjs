// A sheet that script switches off (`style.disabled`, `sheet.disabled`, a link taken out and put back, a constructed sheet) must lose
// its themed copy, and one it switches on gets a copy; an alternate sheet nobody selected gets none.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

let servers;
let browser;
let page;
before(async () => {
  servers = await startServers();
  browser = await launch();
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true } });
  page = await browser.context.newPage();
  await page.goto(`${servers.origin}/switched-sheets.html`);
  await waitState(page, 'ready', 30000 * SLOW);
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const bg = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).backgroundColor, id);
const ORIGINAL = new Set(['rgb(255, 255, 0)', 'rgb(0, 255, 255)', 'rgb(255, 0, 255)', 'rgb(0, 255, 0)']);
const isClear = (css) => css === 'rgba(0, 0, 0, 0)';
const isThemed = (css) => !isClear(css) && !ORIGINAL.has(css);

/** Run `op` in the page from a click, then wait until `check` holds. */
async function act(op, id, check, what) {
  await page.evaluate((src) => {
    window.op = new Function(src);
  }, op);
  await page.click('#go');
  const until = Date.now() + 8000 * SLOW;
  let value = '';
  while (Date.now() < until) {
    value = await bg(id);
    if (check(value)) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`${what}: ${value}`);
}

test('the sheets of the page are themed to begin with', async () => {
  assert.ok(isThemed(await bg('a')));
  assert.ok(isThemed(await bg('plain-box')));
  assert.ok(isThemed(await bg('d')));
});

test('an alternate sheet nobody selected gets no copy', async () => {
  assert.ok(isClear(await bg('alt-box')), `the browser does not apply it: ${await bg('alt-box')}`);
  await page.waitForTimeout(600);
  assert.ok(isClear(await bg('alt-box')), 'its copy applied');
});

test('an alternate sheet the page switches on is themed', async () => {
  await act("const l = document.getElementById('alt'); l.disabled = true; l.disabled = false;", 'alt-box', isThemed, 'the selected alternate stays light');
});

test('a style element switched off loses its copy, and gets it back when it is switched on', async () => {
  await act("document.getElementById('s1').disabled = true;", 'a', isClear, 'style.disabled = true left the copy active');
  await act("document.getElementById('s1').disabled = false;", 'a', isThemed, 'style.disabled = false did not bring the copy back');
});

test('a sheet switched off through its sheet object loses its copy', async () => {
  await act("document.getElementById('s2').sheet.disabled = true;", 'b', isClear, 'sheet.disabled = true left the copy active');
  await act("document.getElementById('s2').sheet.disabled = false;", 'b', isThemed, 'sheet.disabled = false did not bring the copy back');
});

test('a link switched off and on keeps being themed', async () => {
  await act("document.getElementById('plain').disabled = true;", 'plain-box', isClear, 'link.disabled = true left the copy active');
  await act("document.getElementById('plain').disabled = false;", 'plain-box', isThemed, 'link.disabled = false did not bring the copy back');
});

test('a constructed sheet switched off loses its copy', async () => {
  await act('window.constructed.disabled = true;', 'd', isClear, 'constructed.disabled = true left the copy active');
  await act('window.constructed.disabled = false;', 'd', isThemed, 'constructed.disabled = false did not bring the copy back');
});
