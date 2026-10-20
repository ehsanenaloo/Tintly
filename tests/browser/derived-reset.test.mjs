// a scope that overrides a variable with a value that holds no color (none, currentColor, initial, a system color,
// a picture, a list that is not channels) must not read the themed variant of an outer scope.
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

const MODES = { dark: { mode: 'dark' }, light: { mode: 'light' }, paper: { mode: 'eink', einkPreset: 'paper' } };

for (const [name, theme] of Object.entries(MODES)) {
  for (const textPath of [true, false]) {
    test(`${name}, ${textPath ? 'text' : 'CSSOM'} path: derived variables do not reach through a value with no color`, { timeout: 90000 }, async () => {
      await browser.clearStorage();
      await browser.setStorage({ settings: { enabled: true, theme } });
      const page = await browser.context.newPage();
      const url = `${servers.origin}/derived-reset.html`;
      await page.goto(url);
      await waitState(page, 'ready');
      await browser.restartEngine(url, textPath ? { early: false, hold: false } : { early: false, hold: false, textPath: false }, theme);
      const r = await page.evaluate(() => {
        const cs = (id) => getComputedStyle(document.getElementById(id));
        return {
          shadowOut: cs('s-out').boxShadow,
          shadowIn: cs('s-in').boxShadow,
          cur: cs('c-cur').color,
          curParent: cs('cc').color,
          ini: cs('c-ini').color,
          iniParent: cs('ini').color,
          uns: cs('c-uns').color,
          out: cs('c-out').color,
          sys: cs('c-sys').color,
          sysCtl: cs('c-sys-ctl').color,
          pic: cs('p-in').backgroundImage,
          nch: cs('n-in').backgroundColor,
        };
      });
      assert.notEqual(r.shadowOut, 'none', 'the outer shadow stays themed');
      assert.equal(r.shadowIn, 'none');
      assert.equal(r.cur, r.curParent, 'currentColor is the color of the element');
      assert.equal(r.ini, r.iniParent, 'initial makes var() invalid, so the color is inherited');
      assert.equal(r.uns, r.out, 'unset is inherit: the themed color of the outer scope stays');
      assert.equal(r.sys, r.sysCtl, 'a system color is not replaced by the outer variant');
      assert.match(r.pic, /url\(/);
      assert.equal(r.nch, 'rgba(0, 0, 0, 0)');
      await page.close();
    });
  }
}
