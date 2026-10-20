// The pages of the app on enaloo.com: the values in the addresses, the welcome tab and the survey address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';
import { fakeArea } from '../helpers/area.mjs';

const { browserOf, osOf, ageOf, welcomeUrl, uninstallUrl, feedbackUrl, PAGES, INSTALLED_AT } = await import(pathToFileURL(join(REPO, 'extension', 'shared', 'site-pages.js')).href);
const { createSitePages } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'site-pages.js')).href);

const DAY = 864e5;
const query = (url) => Object.fromEntries(new URL(url).searchParams);

test('the browser is a name and a major version in digits', () => {
  assert.deepEqual(browserOf({ brands: [{ brand: 'Chromium', version: '131' }, { brand: 'Microsoft Edge', version: '131' }] }), { name: 'edge', major: '131' });
  assert.deepEqual(browserOf({ brands: [{ brand: 'Google Chrome', version: '130' }] }), { name: 'chrome', major: '130' });
  assert.deepEqual(browserOf({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:133.0) Gecko/20100101 Firefox/133.0' }), { name: 'firefox', major: '133' });
  assert.deepEqual(browserOf({ userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0' }), { name: 'edge', major: '131' });
  assert.deepEqual(browserOf({ userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' }), { name: 'chrome', major: '131' });
  assert.equal(browserOf({ userAgent: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0' }).name, 'other');
  assert.deepEqual(browserOf({}), { name: 'other', major: '' });
});

test('the system and the install age use only the values of the table', () => {
  for (const os of ['win', 'mac', 'linux', 'cros', 'android']) assert.equal(osOf(os), os);
  assert.equal(osOf('openbsd'), 'other');
  assert.equal(osOf(undefined), 'other');
  const now = 1000 * DAY;
  assert.equal(ageOf(undefined, now), 'unknown');
  assert.equal(ageOf(now + 1, now), 'unknown', 'a time in the future is not trusted');
  assert.equal(ageOf(now - DAY / 2, now), 'd1');
  assert.equal(ageOf(now - 3 * DAY, now), 'w1');
  assert.equal(ageOf(now - 20 * DAY, now), 'm1');
  assert.equal(ageOf(now - 60 * DAY, now), 'm3');
  assert.equal(ageOf(now - 200 * DAY, now), 'more');
});

test('each address carries only its own values', () => {
  const w = welcomeUrl({ version: '1.0.2', lang: 'pt-BR', browser: 'chrome' });
  assert.ok(w.startsWith(PAGES.welcome));
  assert.deepEqual(query(w), { v: '1.0.2', lang: 'pt-BR', b: 'chrome' });
  const u = uninstallUrl({ version: '1.0.2', lang: 'fa', browser: 'firefox', major: '133', os: 'win', age: 'm1' });
  assert.ok(u.startsWith(PAGES.uninstall));
  assert.deepEqual(query(u), { v: '1.0.2', lang: 'fa', b: 'firefox', bv: '133', os: 'win', age: 'm1' });
  assert.ok(u.length < 1000);
  assert.deepEqual(query(feedbackUrl('bug', { version: '1.0.2', browser: 'edge', major: '131' })), { kind: 'bug', v: '1.0.2', b: 'edge', bv: '131' });
  assert.deepEqual(query(feedbackUrl('feature', { version: '1.0.2', browser: 'edge', major: '131' })), { kind: 'feature', v: '1.0.2' });
  assert.equal(query(welcomeUrl({ version: '1', lang: 'x/../y?z', browser: 'other' })).lang, undefined, 'a strange language is left out');
});

function worker({ reason, stored = {}, os = 'mac', withSurvey = true, tabsCreate } = {}) {
  const local = fakeArea();
  const tabs = [];
  const surveys = [];
  const warnings = [];
  const runtime = {
    getManifest: () => ({ version: '1.0.2' }),
    getPlatformInfo: async () => ({ os }),
    ...(withSurvey ? { setUninstallURL: async (url) => void surveys.push(url) } : {}),
  };
  const pages = createSitePages({
    runtime,
    local,
    tabs: { create: tabsCreate ?? (async (props) => void tabs.push(props)) },
    warn: (error) => void warnings.push(error),
    lang: () => 'en',
    now: () => 500 * DAY,
    browser: { name: 'chrome', major: '131' },
  });
  return { pages, local, tabs, surveys, warnings, ready: local.set(stored), reason };
}

test('a fresh install opens one welcome tab in the background and keeps the install time', async () => {
  const w = worker();
  await w.ready;
  assert.equal(await w.pages.installed('install'), true);
  assert.equal(w.tabs.length, 1);
  assert.equal(w.tabs[0].active, false);
  assert.deepEqual(query(w.tabs[0].url), { v: '1.0.2', lang: 'en', b: 'chrome' });
  assert.equal((await w.local.get(INSTALLED_AT))[INSTALLED_AT], 500 * DAY);
  assert.equal(await w.pages.installed('install'), false, 'a second install event opens nothing');
  assert.equal(w.tabs.length, 1);
});

test('an update or a browser update opens nothing', async () => {
  const w = worker();
  await w.ready;
  for (const reason of ['update', 'chrome_update', 'shared_module_update', '']) assert.equal(await w.pages.installed(reason), false);
  assert.equal(w.tabs.length, 0);
  assert.deepEqual(await w.local.get(INSTALLED_AT), {});
});

test('the survey address is set with the age of the install, or unknown without one', async () => {
  const w = worker({ stored: { [INSTALLED_AT]: 497 * DAY }, os: 'linux' });
  await w.ready;
  const url = await w.pages.survey();
  assert.deepEqual(w.surveys, [url]);
  assert.deepEqual(query(url), { v: '1.0.2', lang: 'en', b: 'chrome', bv: '131', os: 'linux', age: 'w1' });
  const old = worker({ os: 'fuchsia' });
  await old.ready;
  assert.deepEqual(query(await old.pages.survey()), { v: '1.0.2', lang: 'en', b: 'chrome', bv: '131', os: 'other', age: 'unknown' });
  const none = worker({ withSurvey: false });
  await none.ready;
  assert.equal(await none.pages.survey(), '', 'a browser without the call is left alone');
});

test('the install event writes the install time before the survey address, so a first install has an age', async () => {
  const w = worker();
  await w.ready;
  const { opened, url } = await w.pages.onInstall('install');
  assert.equal(opened, true);
  assert.deepEqual(w.surveys, [url]);
  assert.equal(query(url).age, 'd1', 'not unknown');
});

test('an update keeps the old install time and sends its age', async () => {
  const w = worker({ stored: { [INSTALLED_AT]: 450 * DAY } });
  await w.ready;
  const { opened, url } = await w.pages.onInstall('update');
  assert.equal(opened, false);
  assert.equal((await w.local.get(INSTALLED_AT))[INSTALLED_AT], 450 * DAY);
  assert.equal(query(url).age, 'm3');
  assert.equal(w.tabs.length, 0);
});

test('a strange install time gives an unknown age, and a failed welcome tab does not stop the survey address', async () => {
  for (const bad of ['yesterday', -5, Number.NaN, 900 * DAY, null]) {
    const w = worker({ stored: { [INSTALLED_AT]: bad } });
    await w.ready;
    assert.equal(query((await w.pages.onInstall('update')).url).age, 'unknown', String(bad));
  }
  const broken = worker({ tabsCreate: async () => { throw new Error('no tab'); } });
  await broken.ready;
  const { url } = await broken.pages.onInstall('install');
  assert.equal(broken.warnings.length, 1);
  assert.deepEqual(broken.surveys, [url]);
  assert.equal(query(url).age, 'd1', 'the install time was written before the tab failed');
});
