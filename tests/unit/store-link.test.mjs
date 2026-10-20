import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { storeReviewUrl, REPO_URL } = await import(pathToFileURL(join(REPO, 'extension', 'shared', 'store-link.js')).href);
const CHROME = 'Mozilla/5.0 Chrome/150.0 Safari/537.36';
const EDGE = `${CHROME} Edg/150.0`;
const FIREFOX = 'Mozilla/5.0 Gecko/20100101 Firefox/150.0';
const id = 'abcdefghijklmnopabcdefghijklmnop';

test('a copy loaded from a folder rates on the public repository', () => {
  assert.equal(REPO_URL, 'https://github.com/ehsanenaloo/Tintly');
  assert.equal(storeReviewUrl({ id, manifest: {}, userAgent: CHROME }), REPO_URL);
  assert.equal(storeReviewUrl({ id, manifest: {}, userAgent: EDGE }), REPO_URL);
});

test('a development install uses the repository even when the manifest looks like a store copy', () => {
  const chrome = { update_url: 'https://clients2.google.com/service/update2/crx' };
  assert.equal(storeReviewUrl({ id, manifest: chrome, userAgent: CHROME, installType: 'development' }), REPO_URL);
  const gecko = { browser_specific_settings: { gecko: { id: 'tintly@example.org' } } };
  assert.equal(storeReviewUrl({ id: 'tintly@example.org', manifest: gecko, userAgent: FIREFOX, installType: 'development' }), REPO_URL);
  assert.match(storeReviewUrl({ id, manifest: chrome, userAgent: CHROME, installType: 'normal' }), /chromewebstore/);
});

test('Chrome store install links to the Chrome review page', () => {
  const manifest = { update_url: 'https://clients2.google.com/service/update2/crx' };
  assert.equal(storeReviewUrl({ id, manifest, userAgent: CHROME }), `https://chromewebstore.google.com/detail/${id}/reviews`);
});

test('Edge store install links to the Edge add-on page', () => {
  const manifest = { update_url: 'https://edge.microsoft.com/extensionwebstorebase/v1/crx' };
  assert.equal(storeReviewUrl({ id, manifest, userAgent: EDGE }), `https://microsoftedge.microsoft.com/addons/detail/${id}`);
});

test('an unknown update address on Edge still picks the Edge page, on Chrome the Chrome page', () => {
  const manifest = { update_url: 'https://example.invalid/update' };
  assert.match(storeReviewUrl({ id, manifest, userAgent: EDGE }), /microsoftedge/);
  assert.match(storeReviewUrl({ id, manifest, userAgent: CHROME }), /chromewebstore/);
  assert.equal(storeReviewUrl({ id, manifest: { update_url: 'not a url' }, userAgent: CHROME }), REPO_URL);
});

test('Firefox uses the add-on id, and the repository without one', () => {
  const manifest = { browser_specific_settings: { gecko: { id: 'tintly@example.org' } } };
  assert.equal(storeReviewUrl({ id: 'tintly@example.org', manifest, userAgent: FIREFOX }), 'https://addons.mozilla.org/firefox/addon/tintly%40example.org/reviews/');
  assert.equal(storeReviewUrl({ id: 'x', manifest: {}, userAgent: FIREFOX }), REPO_URL);
});

test('no id, repository link', () => {
  assert.equal(storeReviewUrl({ id: '', manifest: { update_url: 'https://clients2.google.com/x' }, userAgent: CHROME }), REPO_URL);
});
