// Chromium lists no resource entry for a CSS picture whose load starts in a style read of the extension's script, as the
// engine's reads do. The check of use must still find an address that a style of the page names, and must still refuse one it does not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers, launch } from './harness.mjs';

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

/** Add elements from the extension's world and read their style there at once, as the engine does. */
const addAndRead = (url, html) =>
  browser.worker.evaluate(
    async ({ u, h }) => {
      const [tab] = await chrome.tabs.query({ url: u });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: (markup) => {
          const box = document.createElement('div');
          box.innerHTML = markup;
          document.body.append(box);
          for (const el of box.querySelectorAll('*')) void (getComputedStyle(el).backgroundImage + getComputedStyle(el, '::before').backgroundImage);
        },
        args: [h],
      });
    },
    { u: url, h: html },
  );

const askImage = (url, image) =>
  browser.worker.evaluate(
    async ({ u, i }) => {
      const [tab] = await chrome.tabs.query({ url: u });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (x) => chrome.runtime.sendMessage({ type: 'dk.net.image', url: x }), args: [i] });
      return r.result;
    },
    { u: url, i: image },
  );

test('a CSS picture that loads without a resource entry is still counted as used; an address no style names is not', { timeout: 60000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: false } });
  const page = await browser.context.newPage();
  // The page and the pictures are of different origins, as a page and its image host are.
  const pageUrl = `${servers.origin.replace('127.0.0.1', 'localhost')}/basic.html`;
  await page.goto(pageUrl);
  const sheet = `${servers.origin}/img/black-icon.svg?by=sheet`;
  const inline = `${servers.origin}/img/black-icon.svg?by=attribute`;
  await page.evaluate((u) => {
    const s = document.createElement('style');
    s.textContent = `.dk-t::before{content:"";display:block;width:8px;height:8px;background:url(${u}) center/contain no-repeat}`;
    document.head.append(s);
  }, sheet);
  await addAndRead(pageUrl, `<div class="dk-t"></div><div style="width:8px;height:8px;background-image:url('${inline}')"></div>`);
  await page.waitForTimeout(500);
  const listed = await page.evaluate((list) => list.map((u) => performance.getEntriesByName(u, 'resource').length), [sheet, inline]);
  console.log(`# resource entries for the two pictures: ${listed.join(', ')}`);
  for (const icon of [sheet, inline]) {
    const used = await askImage(pageUrl, icon);
    assert.equal(used.ok, true, `${icon}: ${JSON.stringify(used).slice(0, 80)}`);
  }
  const other = await askImage(pageUrl, `${servers.origin}/img/black-icon.svg?by=nothing`);
  assert.deepEqual([other.ok, other.code], [false, 'unused']);
  await page.close();
});
