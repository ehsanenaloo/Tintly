// the check of use is bound to the document that asked. Facts of the browser, then the real flow across a navigation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch } from './harness.mjs';

let browser;
let site;
let sheets;
let siteOrigin;
let sheetOrigin;
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  sheets = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' });
    res.end('body{color:#123456}');
  });
  sheetOrigin = await listen(sheets);
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const uses = req.url.startsWith('/uses');
    res.end(`<!doctype html><title>${uses ? 'uses' : 'plain'}</title>${uses ? `<link rel="stylesheet" href="${sheetOrigin}/shared.css">` : ''}<body><p>x</p></body>`);
  });
  siteOrigin = await listen(site);
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await new Promise((r) => site?.close(r));
  await new Promise((r) => sheets?.close(r));
});

const fromContent = (message) =>
  browser.worker.evaluate(async (m) => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (msg) => chrome.runtime.sendMessage(msg), args: [m] });
    return r.result;
  }, message);

test('the browser refuses a script aimed at a document that has been replaced, and names the document in a reply by frame', { timeout: 60000 }, async () => {
  const page = await browser.context.newPage();
  await page.goto(`${siteOrigin}/uses-1`);
  const first = await browser.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: () => location.pathname });
    return { tabId: tab.id, documentId: r.documentId, path: r.result };
  });
  assert.equal(typeof first.documentId, 'string');
  await page.goto(`${siteOrigin}/plain`);
  const later = await browser.worker.evaluate(async ({ tabId, old }) => {
    const byFrame = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: () => location.pathname });
    let byOld;
    try {
      byOld = await chrome.scripting.executeScript({ target: { tabId, documentIds: [old] }, world: 'ISOLATED', func: () => location.pathname });
    } catch (e) {
      byOld = String(e.message);
    }
    return { frameDoc: byFrame[0].documentId, frameResult: byFrame[0].result, byOld };
  }, { tabId: first.tabId, old: first.documentId });
  console.log('# facts', JSON.stringify(later));
  assert.notEqual(later.frameDoc, first.documentId, 'the frame has a new document');
  assert.equal(typeof later.byOld, 'string', 'the old document cannot be scripted');
  assert.match(later.byOld, /document/i);
  await page.close();
});

test('a page that uses a sheet may ask for it; after a navigation the new page, which does not use it, may not', { timeout: 90000 }, async () => {
  await browser.clearStorage();
  await browser.setStorage({ settings: { enabled: false } });
  const page = await browser.context.newPage();
  await page.goto(`${siteOrigin}/uses-2`);
  const ask = { type: 'dk.net.text', url: `${sheetOrigin}/shared.css` };
  const one = await fromContent(ask);
  assert.equal(one.ok, true, JSON.stringify(one));
  // The same address, asked twice: the second answer comes from the memory of the same document.
  assert.equal((await fromContent(ask)).ok, true);
  await page.goto(`${siteOrigin}/plain`);
  const two = await fromContent(ask);
  assert.deepEqual(two, { ok: false, code: 'unused' }, 'the new document did not inherit the verdict of the old one');
  await page.close();
});
