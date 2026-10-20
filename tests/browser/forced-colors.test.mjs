// Forced colors (high contrast) is followed while the page stays open: the engine stops when it starts and comes back when it ends.
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

const residue = (page) => page.evaluate(() => document.querySelectorAll('style[data-dk]:not([data-dk="css"])').length);

for (const [path, engine] of [['/dynamic.html', 'auto'], ['/filter-base.html', 'filter'], ['/filter-base.html', 'filterPlus']]) {
  test(`forced colors stop and restart the ${engine} engine without a reload`, { timeout: 90000 }, async () => {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, engine } });
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}${path}`);
    await waitState(page, 'ready');
    assert.ok((await residue(page)) > 0, 'themed');
    await page.emulateMedia({ forcedColors: 'active' });
    await waitState(page, null);
    await page.waitForFunction(() => document.querySelectorAll('style[data-dk]:not([data-dk="css"])').length === 0, null, { timeout: 10000 });
    await page.emulateMedia({ forcedColors: 'none' });
    await waitState(page, 'ready');
    assert.ok((await residue(page)) > 0, 'themed again');
    await page.close();
  });
}
