import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserBlocks } from '../../extension/shared/blocked.js';

test('the stores of extensions are pages the browser keeps extensions out of', () => {
  assert.equal(browserBlocks('https://chromewebstore.google.com/detail/example/abc'), true);
  assert.equal(browserBlocks('https://chrome.google.com/webstore/detail/example'), true);
  assert.equal(browserBlocks('https://microsoftedge.microsoft.com/addons/detail/example'), true);
  assert.equal(browserBlocks('https://addons.mozilla.org/en-US/firefox/addon/example/'), true);
});

test('other pages and bad input are not blocked by this check', () => {
  assert.equal(browserBlocks('https://example.com/'), false);
  assert.equal(browserBlocks('https://chrome.google.com/other'), false);
  assert.equal(browserBlocks('chrome://extensions'), false);
  assert.equal(browserBlocks(''), false);
  assert.equal(browserBlocks(undefined), false);
  assert.equal(browserBlocks('not a url'), false);
});
