// Text on colored boxes in the E-ink and Paper mode keeps the floor of the mode, whether the label is in the rule of the box,
// in another rule, inherited, from a variable, or on a gradient.
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

const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const rgb = (css) => /rgba?\(([^)]+)\)/.exec(css)[1].split(/[,\s/]+/).filter(Boolean).map(Number);

const IDS = [['one', '#one'], ['two', '#two .label'], ['three', '#three'], ['green', '#green'], ['red', '#red'], ['yellow', '#yellow'], ['mid', '#mid'], ['gradient', '#gradbtn'], ['variable', '#var'], ['banner', '#banner']];

/** The contrast of each label against the box that holds it, after the net had its turns. */
async function measure(theme, waitMs) {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: true, theme } });
  const page = await browser.context.newPage();
  await page.goto(`${servers.origin}/eink-buttons.html`);
  await waitState(page, 'ready', 30000);
  await page.waitForTimeout(waitMs);
  const out = await page.evaluate((list) => {
    const parse = (s) => /rgba?\(([^)]+)\)/.exec(s)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return list.map(([name, sel]) => {
      const el = document.querySelector(sel);
      const cs = getComputedStyle(el);
      let bgEl = el;
      let bg = null;
      let image = false;
      for (let n = el; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.backgroundImage !== 'none') image = true;
        const c = parse(s.backgroundColor);
        if ((c[3] ?? 1) > 0.5) {
          bg = c;
          bgEl = n;
          break;
        }
      }
      return { name, fg: parse(cs.color), bg: bg ?? [255, 255, 255], image, box: bgEl.id };
    });
  }, IDS);
  await page.close();
  return out;
}

for (const [name, theme, floor] of [['E-ink', { mode: 'eink', einkPreset: 'eink' }, 7], ['Paper', { mode: 'eink', einkPreset: 'paper' }, 4.5]]) {
  test(`${name}: every label on a colored box keeps ${floor} to 1 (the palette alone, before the net)`, { timeout: 90000 }, async () => {
    // Stop the net from helping: the palette must hold the floor by itself.
    const rows = await measure(theme, 300);
    const bad = rows.filter((r) => !r.image && ratio(r.fg, r.bg) < floor - 0.05).map((r) => `${r.name} ${ratio(r.fg, r.bg).toFixed(2)}`);
    assert.deepEqual(bad, [], bad.join(', '));
  });
}

for (const [name, theme, floor] of [['E-ink', { mode: 'eink', einkPreset: 'eink' }, 7], ['Paper', { mode: 'eink', einkPreset: 'paper' }, 4.5]]) {
  test(`${name}: a button with its own color on a hero picture is themed with its own box; the title on the picture keeps its color`, { timeout: 90000 }, async () => {
    await browser.clearStorage();
    await browser.setStorage({ settings: { enabled: true, theme } });
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/hero-button.html`);
    await waitState(page, 'ready', 30000);
    // The sweep of the picture module runs a while after the load.
    await page.waitForTimeout(3500);
    const r = await page.evaluate(() => {
      const parse = (s) => /rgba?\(([^)]+)\)/.exec(s)[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      const read = (id) => {
        const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        return { fg: parse(cs.color), bg: parse(cs.backgroundColor), kept: el.hasAttribute('data-dk-k') };
      };
      return { btn: read('btn'), pill: read('pill'), title: read('title') };
    });
    for (const id of ['btn', 'pill']) {
      assert.equal(r[id].kept, false, `${id} is not text on the picture`);
      assert.ok(ratio(r[id].fg, r[id].bg) >= floor - 0.05, `${id} ${ratio(r[id].fg, r[id].bg).toFixed(2)}`);
    }
    assert.equal(r.title.kept, true, 'the title stands on the picture');
    await page.close();
  });
}
