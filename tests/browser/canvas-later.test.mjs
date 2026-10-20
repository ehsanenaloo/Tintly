// A canvas that is drawn long after the first looks is looked at again, also on a page that nobody touches.
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

for (const [name, theme] of Object.entries({ light: { mode: 'light' }, paper: { mode: 'eink', einkPreset: 'paper' } })) {
  test(`${name}: a dark wallpaper drawn on a canvas after 12 s is blended without a scroll`, { timeout: 90000 }, async () => {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, theme } });
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/canvas-later.html`);
    await waitState(page, 'ready');
    const mark = (id) => page.evaluate((i) => document.getElementById(i).getAttribute('data-dk-img'), id);
    await page.waitForFunction(() => document.getElementById('c-now').getAttribute('data-dk-img') === 'wall', null, { timeout: 15000 });
    // Before the second drawing there is nothing to mark on the late canvas.
    assert.equal(await mark('c-late'), null);
    await page.waitForFunction(() => document.getElementById('c-late').getAttribute('data-dk-img') === 'wall', null, { timeout: 40000 });
    await page.close();
  });
}
