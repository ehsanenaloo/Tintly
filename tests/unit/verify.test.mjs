import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const modules = join(REPO, 'extension', 'background', 'modules');
const { createVerifier } = await import(pathToFileURL(join(modules, 'verify.js')).href);
const { createNet } = await import(pathToFileURL(join(modules, 'net.js')).href);

function make() {
  const calls = [];
  const verify = createVerifier({ now: () => 0, scripting: { executeScript: async (d) => (calls.push(d), [{ result: d.args[0].map(() => true) }]) } });
  return { verify, calls };
}

test('an answer is kept per document: a new document in the frame asks again', async () => {
  const { verify, calls } = make();
  const url = 'https://a.example/a.css';
  assert.equal(await verify({ tabId: 1, frameId: 0, documentId: 'D1' }, url), true);
  assert.equal(await verify({ tabId: 1, frameId: 0, documentId: 'D1' }, url), true);
  assert.equal(calls.length, 1);
  assert.equal(await verify({ tabId: 1, frameId: 0, documentId: 'D2' }, url), true);
  assert.equal(calls.length, 2, 'the page was replaced');
  assert.equal(await verify({ tabId: 1, frameId: 1, documentId: 'D1' }, url), true);
  assert.equal(calls.length, 3, 'another frame');
});

test('answers of a tab are dropped when the tab goes', async () => {
  const { verify, calls } = make();
  const url = 'https://a.example/a.css';
  await verify({ tabId: 1, frameId: 0, documentId: 'D1' }, url);
  await verify({ tabId: 2, frameId: 0, documentId: 'E1' }, url);
  verify.forgetTab(1);
  await verify({ tabId: 1, frameId: 0, documentId: 'D1' }, url);
  await verify({ tabId: 2, frameId: 0, documentId: 'E1' }, url);
  assert.equal(calls.length, 3, 'only the other tab is still known');
});

test('without a document id the answer is kept as before', async () => {
  const { verify, calls } = make();
  await verify({ tabId: 1, frameId: 0 }, 'https://a.example/a.css');
  await verify({ tabId: 1, frameId: 0 }, 'https://a.example/a.css');
  assert.equal(calls.length, 1);
});

test('net.forgetTab clears the verifier of that tab', async () => {
  const { verify, calls } = make();
  const net = createNet({ publicSpace: true, 
    verifyUsed: verify,
    publicSpace: true,
    fetchImpl: async (href) => ({ ok: true, status: 200, url: href, headers: new Headers({ 'content-type': 'text/css' }), body: null }),
  });
  const who = { tabId: 4, frameId: 0, pageUrl: 'https://site.example/', documentId: 'D' };
  await net.text('https://cdn.example/a.css', who);
  net.forgetTab(4);
  await net.text('https://cdn.example/b.css', who);
  await net.text('https://cdn.example/c.css', who);
  assert.equal(calls.length, 3);
  net.forgetTab(4);
  await net.text('https://cdn.example/a.css', who);
  assert.equal(calls.length, 4, 'the cached sheet still asks the frame');
});
