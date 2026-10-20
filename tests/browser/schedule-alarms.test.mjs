// The schedule with the optional `alarms` permission: without it the page decides, as before; the Schedule tab explains the
// permission and asks for it from a click; with it, a page that is off by the hours gets no script of ours, a real alarm brings the
// registration back before the start, and taking the permission away restores the registration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch, waitState, SLOW } from './harness.mjs';

let servers;
let browser;
let extId;

before(async () => {
  servers = await startServers();
  browser = await launch();
  extId = new URL(browser.worker.url()).host;
});
after(async () => {
  await browser?.close();
  await servers?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const registered = () => browser.worker.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((list) => list.filter((s) => s.id === 'dk-hook' || s.id === 'dk-engine').map((s) => s.id).sort()));
const alarmNames = () => browser.worker.evaluate(() => (chrome.alarms ? chrome.alarms.getAll().then((list) => list.map((a) => a.name).sort()) : null));
const granted = () => browser.worker.evaluate(() => chrome.permissions.contains({ permissions: ['alarms'] }));

/** Poll until `read()` gives `want` (deep equal by JSON), or fail with what it last gave. */
async function until(read, want, label, timeout = 15000 * SLOW) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (JSON.stringify(last) === JSON.stringify(want)) return;
    await sleep(100);
  }
  assert.deepEqual(last, want, label);
}

const lightness = (page) =>
  page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });

const hours = (fromMs, toMs) => ({ mode: 'time', behavior: 'onOff', time: { from: hhmm(new Date(fromMs)), to: hhmm(new Date(toMs)) } });
const hourAhead = () => hours(Date.now() + 3600_000, Date.now() + 7200_000);
const setHours = async (automation) => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, automation } });
};

async function traces(page) {
  const hook = await page.evaluate(() => {
    try {
      return Reflect.apply(Element.prototype.attachShadow, 'dk:hook?', []) === true;
    } catch {
      return false;
    }
  });
  const isolated = await browser.worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => typeof globalThis.__dk !== 'undefined' });
    return r.result;
  }, page.url());
  return { hook, isolated };
}

async function scheduleTab() {
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${extId}/pages/options/options.html`);
  await page.waitForFunction(() => !document.body.hasAttribute('data-loading'));
  await page.click('#tab-schedule');
  return page;
}

test('without the permission the schedule works as before: the files are registered also outside the hours', { timeout: 60000 * SLOW }, async () => {
  await setHours(hourAhead());
  assert.equal(await granted(), false);
  assert.equal(await browser.worker.evaluate(() => typeof chrome.alarms), 'undefined', 'the API is not in the worker');
  await until(registered, ['dk-engine', 'dk-hook'], 'registered');
});

test('the Schedule tab explains the permission before it asks, and a click grants it', { timeout: 60000 * SLOW }, async () => {
  await setHours(hourAhead());
  const page = await scheduleTab();
  assert.equal(await page.isVisible('#alarm-box'), true);
  assert.match(await page.textContent('#alarm-text'), /exactly at your hours/);
  assert.match(await page.textContent('#alarm-status'), /Not allowed/);
  assert.equal(await page.isVisible('#alarm-allow'), true);
  assert.equal(await page.isVisible('#alarm-remove'), false);

  await page.click('#alarm-allow');
  await page.waitForFunction(() => /^Allowed/.test(document.getElementById('alarm-status').textContent));
  assert.equal(await granted(), true);
  assert.equal(await page.isVisible('#alarm-allow'), false);
  assert.equal(await page.isVisible('#alarm-remove'), true);
  // The worker saw the permission: alarms exist and the page that is off loads nothing of ours.
  await until(alarmNames, ['dk-schedule-check', 'dk-schedule-next'], 'alarms');
  await until(registered, [], 'no script outside the hours');
  await page.close();
});

test('the note is only for the schedules the permission can serve', { timeout: 60000 * SLOW }, async () => {
  for (const automation of [{ mode: 'none' }, { mode: 'system', behavior: 'onOff' }, { mode: 'time', behavior: 'scheme', time: { from: '09:00', to: '10:00' } }]) {
    await setHours(automation);
    const page = await scheduleTab();
    assert.equal(await page.isVisible('#alarm-box'), false, JSON.stringify(automation));
    await page.close();
  }
  // And it follows the choices on the page.
  await setHours({ mode: 'none' });
  const page = await scheduleTab();
  await page.selectOption('#autoMode', 'time');
  await page.waitForSelector('#alarm-box', { state: 'visible' });
  await page.selectOption('#autoBehavior', 'scheme');
  await page.waitForSelector('#alarm-box', { state: 'hidden' });
  await page.close();
  await until(alarmNames, [], 'no schedule, no alarms');
});

test('a page that is off by the hours loads nothing of ours; an alarm brings the files back before the start, and the page turns on', { timeout: 240000 * SLOW }, async () => {
  assert.equal(await granted(), true);
  await setHours(hourAhead());
  await until(registered, [], 'outside the hours');
  const off = await browser.context.newPage();
  await off.goto(`${servers.origin}/basic.html`);
  assert.deepEqual(await traces(off), { hook: false, isolated: false });
  assert.equal(await off.evaluate(() => document.documentElement.hasAttribute('data-dk-go')), false);

  // A start between 61 and 125 seconds away: the alarm for the lead before it is 1 to 65 seconds away.
  let start = new Date(Math.ceil((Date.now() + 61_000) / 60_000) * 60_000);
  const automation = hours(start.getTime(), start.getTime() + 3600_000);
  await setHours(automation);
  await until(registered, [], 'still idle before the lead');
  const lead = await browser.worker.evaluate(async () => (await chrome.alarms.get('dk-schedule-next')).scheduledTime);
  assert.equal(lead, start.getTime() - 60_000, 'the boundary alarm is one minute before the start');

  // Nothing is done by hand: the alarm fires and the worker registers the files.
  await until(registered, ['dk-engine', 'dk-hook'], 'registered by the alarm', (start.getTime() - Date.now()) + 30_000);
  assert.ok(Date.now() < start.getTime() + 5000, 'registered before the start');
  // The tab that was open got the files; the gate keeps the page off until the start.
  await until(async () => (await traces(off)).isolated, true, 'the open tab got the files');
  assert.ok((await lightness(off)) > 0.9, 'the original page');
  await off.close();

  // Right after the start a new page is themed from its first frame.
  await sleep(Math.max(0, start.getTime() - Date.now()) + 1500);
  const on = await browser.context.newPage();
  await on.goto(`${servers.origin}/basic.html`);
  await waitState(on, 'ready');
  assert.ok((await lightness(on)) < 0.5, 'themed');
  await on.close();
});

test('taking the permission away restores the registration and shows the note again', { timeout: 60000 * SLOW }, async () => {
  await setHours(hourAhead());
  await until(registered, [], 'idle');
  const page = await scheduleTab();
  await page.waitForFunction(() => /^Allowed/.test(document.getElementById('alarm-status').textContent));
  await page.click('#alarm-remove');
  await page.waitForFunction(() => /^Not allowed/.test(document.getElementById('alarm-status').textContent));
  assert.equal(await granted(), false);
  await until(registered, ['dk-engine', 'dk-hook'], 'back after the permission went');
  assert.equal(await page.isVisible('#alarm-allow'), true);
  await page.close();
});
