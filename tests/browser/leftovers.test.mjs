// What a build leaves in a page when its world is gone (Firefox gives an updated add-on a new world, where the old namespace cannot be
// seen). The marks and elements of a page themed by the real extension are replayed in a browser without it. The namespace file of a
// new build must notice them, and leftovers.js (which the gate asks for) must give the page back as the page wrote it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServers, launch, launchPlain, waitState } from './harness.mjs';
import { REPO } from '../helpers/tree.mjs';

const NAMESPACE = readFileSync(join(REPO, 'extension', 'content', 'core', 'namespace.js'), 'utf8');
const LEFTOVERS = readFileSync(join(REPO, 'extension', 'content', 'core', 'leftovers.js'), 'utf8');

/** The two files as a new build runs them; what the namespace file noticed, and what the sweep answered. @param {import('playwright').Page} page */
async function newBuild(page) {
  await page.addScriptTag({ content: NAMESPACE });
  await page.addScriptTag({ content: LEFTOVERS });
  return page.evaluate(() => ({ leftover: globalThis.__dk.leftover === true, swept: globalThis.__dk.leftovers.sweep() }));
}

let servers;
let plain;
before(async () => {
  servers = await startServers();
  plain = await launchPlain();
});
after(async () => {
  await plain?.close();
  await servers?.close();
});

/** The background and text color of the body, and every mark of ours. @param {import('playwright').Page} page */
const look = (page) =>
  page.evaluate(() => {
    const marks = [];
    const visit = (scope) => {
      for (const el of scope.querySelectorAll('*')) {
        for (const a of el.getAttributeNames()) if (a.startsWith('data-dk-') || (a === 'data-dk' && el.getAttribute(a) !== 'page')) marks.push(`${el.localName}[${a}]`);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    const s = getComputedStyle(document.body);
    return { bg: s.backgroundColor, fg: s.color, marks };
  });

test('the marks a themed page holds are all removed by a new build that cannot see the old one', async () => {
  // The real look of a themed page.
  const browser = await launch();
  let html;
  try {
    const page = await browser.context.newPage();
    await page.goto(`${servers.origin}/basic.html`);
    await waitState(page, 'ready');
    html = await page.evaluate(() => document.documentElement.outerHTML);
  } finally {
    await browser.close();
  }
  assert.match(html, /data-dk-go/);
  assert.match(html, /<style[^>]*data-dk=/);

  const page = await plain.context.newPage();
  await page.goto(`${servers.origin}/basic.html`);
  const original = await look(page);
  // The same page with what the dead build left, plus an element of the page's own that uses the same attribute name.
  await page.setContent(`<!doctype html>${html.replace('<body', '<body data-mark="x"').replace('</body>', '<i data-dk="page">own</i></body>')}`);
  // An open shadow root with a nested one, as the shadow-root module leaves them.
  await page.evaluate(() => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style data-dk="inline">p{color:red}</style><p data-dk-i="4">x</p><span></span>';
    const inner = shadow.querySelector('span').attachShadow({ mode: 'open' });
    inner.innerHTML = '<style data-dk="attrs">b{color:red}</style><b data-dk-r="">y</b>';
  });
  const left = await look(page);
  assert.notEqual(left.bg, original.bg, 'the replayed page is still dark');
  assert.ok(left.marks.length > 2);

  assert.deepEqual(await newBuild(page), { leftover: true, swept: true });
  const after = await look(page);
  assert.deepEqual(after.marks, [], 'no mark of ours stays, in the document or in shadow roots');
  assert.equal(after.bg, original.bg);
  assert.equal(after.fg, original.fg);
  assert.equal(await page.locator('i[data-dk="page"]').count(), 1, "the page's own element stays");
  await page.close();
});

test('a page with no mark of a themed page is not touched', async () => {
  const page = await plain.context.newPage();
  await page.setContent('<!doctype html><html><head><style data-dk="page">body{background:#fff}</style></head><body><p data-dk-i="1">x</p></body></html>');
  assert.deepEqual(await newBuild(page), { leftover: false, swept: false });
  assert.equal(await page.locator('style[data-dk]').count(), 1);
  assert.equal(await page.locator('[data-dk-i]').count(), 1);
  await page.close();
});
