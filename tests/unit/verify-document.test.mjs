// The check of use runs in the document that asked, and a reply from another document is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { createVerifier } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'verify.js')).href);

const URL_A = 'https://cdn.example/a.css';
const who = (documentId, extra = {}) => ({ tabId: 1, frameId: 0, ...(documentId === undefined ? {} : { documentId }), ...extra });

/**
 * A scripting API in the way of the browsers. `live` is the set of documents that exist; a call by documentIds fails for one that is gone,
 * a call by frameIds runs in `current` (the document of the frame now). With `byDocument` false the call by documentIds is refused as an
 * unknown property, as an older browser does. `replyId(d)` chooses the documentId the reply names (default: the one it ran in).
 */
function browser({ live = ['old-document'], current = 'old-document', byDocument = true, replyId, answer = () => true } = {}) {
  const calls = [];
  const api = {
    calls,
    live: new Set(live),
    current,
    async executeScript(d) {
      calls.push(d);
      let ran;
      if (d.target.documentIds) {
        if (!byDocument) throw new Error('Unexpected property "documentIds" found in the target');
        ran = d.target.documentIds[0];
        if (!api.live.has(ran)) throw new Error(`No document with id ${ran} in tab with id ${d.target.tabId}`);
      } else {
        ran = api.current;
      }
      const reply = { result: d.args[0].map((u) => answer(u, ran)) };
      const id = replyId ? replyId(ran) : ran;
      if (id !== undefined) reply.documentId = id;
      return [reply];
    },
  };
  return api;
}

const verifier = (b) => createVerifier({ scripting: b, now: () => 0 });

test('the review case: the frame moved to a new document, the old one is asked about, the answer is no', async () => {
  // A browser that can only target frames: the script runs in the new document, and the reply says so.
  const b = browser({ byDocument: false, current: 'new-document', live: ['new-document'] });
  assert.equal(await verifier(b)(who('old-document'), URL_A), false);
  assert.deepEqual(b.calls.at(-1).target, { tabId: 1, frameIds: [0] });
});

test('by frame, a reply that names the document that asked is accepted, and a reply that names none is not', async () => {
  const same = browser({ byDocument: false });
  assert.equal(await verifier(same)(who('old-document'), URL_A), true);
  const nameless = browser({ byDocument: false, replyId: () => undefined });
  assert.equal(await verifier(nameless)(who('old-document'), URL_A), false);
  const other = browser({ byDocument: false, replyId: () => 'new-document' });
  assert.equal(await verifier(other)(who('old-document'), URL_A), false);
});

test('the script is aimed at the document that asked, not at the frame', async () => {
  const b = browser();
  assert.equal(await verifier(b)(who('old-document', { frameId: 3 }), URL_A), true);
  assert.equal(b.calls.length, 1);
  assert.deepEqual(b.calls[0].target, { tabId: 1, documentIds: ['old-document'] });
  assert.equal('frameIds' in b.calls[0].target, false);
});

test('a document that is gone gets no answer, and the frame\'s new document is not asked in its place', async () => {
  const b = browser({ live: ['new-document'], current: 'new-document' });
  assert.equal(await verifier(b)(who('old-document'), URL_A), false);
  assert.equal(b.calls.length, 1, 'no second try by frame');
  assert.ok(b.calls.every((c) => c.target.documentIds));
});

test('a reply that names another document is refused also when the target was a document', async () => {
  const b = browser({ replyId: () => 'new-document' });
  assert.equal(await verifier(b)(who('old-document'), URL_A), false);
});

test('a browser that does not name documents in a reply is still served by document', async () => {
  const b = browser({ replyId: () => undefined });
  assert.equal(await verifier(b)(who('old-document'), URL_A), true);
});

test('without a document id (an older browser) the check is by frame as before', async () => {
  const b = browser();
  assert.equal(await verifier(b)(who(undefined), URL_A), true);
  assert.deepEqual(b.calls[0].target, { tabId: 1, frameIds: [0] });
});

test('once the browser has refused documentIds, later checks go straight by frame', async () => {
  const b = browser({ byDocument: false });
  const verify = verifier(b);
  await verify(who('old-document'), URL_A);
  await verify(who('old-document'), 'https://cdn.example/b.css');
  assert.equal(b.calls.length, 3, 'one refused try, then two checks by frame');
  assert.ok(b.calls.slice(1).every((c) => c.target.frameIds));
});

test('a check of one document is not reused for another document of the same frame', async () => {
  const b = browser({ live: ['d1', 'd2'], current: 'd2', answer: (u, ran) => ran === 'd1' });
  const verify = verifier(b);
  assert.equal(await verify(who('d1'), URL_A), true);
  assert.equal(await verify(who('d2'), URL_A), false, 'the new document does not use it');
  assert.equal(await verify(who('d1'), URL_A), true, 'the answer of the first is still its own');
});

test('a late result of a document that has been replaced is not kept', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const b = browser({ live: ['d1', 'd2'] });
  const run = b.executeScript.bind(b);
  b.executeScript = async (d) => {
    if (d.target.documentIds[0] === 'd1') await gate;
    return run(d);
  };
  const verify = verifier(b);
  const first = verify(who('d1'), URL_A);
  await Promise.resolve();
  // The frame gets a new document while the old check is out.
  assert.equal(await verify(who('d2'), URL_A), true);
  release();
  assert.equal(await first, true, 'the old document, if it is alive, is answered');
  const before = b.calls.length;
  await verify(who('d1'), URL_A);
  assert.equal(b.calls.length, before + 1, 'the late answer was not kept: the check runs again');
});

test('a tab that closes while a check is out gets no answer and keeps nothing', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const b = browser();
  const run = b.executeScript.bind(b);
  b.executeScript = async (d) => (await gate, run(d));
  const verify = verifier(b);
  const waiting = verify(who('old-document'), URL_A);
  const queued = verify(who('old-document'), 'https://cdn.example/b.css');
  await Promise.resolve();
  verify.forgetTab(1);
  release();
  assert.equal(await waiting, false);
  assert.equal(await queued, false);
  const before = b.calls.length;
  b.executeScript = run;
  assert.equal(await verify(who('old-document'), URL_A), true);
  assert.equal(b.calls.length, before + 1, 'nothing was kept for the closed tab');
});

test('a batch that is still waiting when the frame changes is refused by the new reply, address by address', async () => {
  // First batch runs in the old document; the frame changes; the second batch is sent by frame (older browser) and runs in the new one.
  const b = browser({ byDocument: false, current: 'old-document' });
  const run = b.executeScript.bind(b);
  let first = true;
  let release;
  const gate = new Promise((r) => (release = r));
  b.executeScript = async (d) => {
    if (!d.target.frameIds) return run(d);
    if (first) {
      first = false;
      await gate;
      return run(d);
    }
    b.current = 'new-document';
    return run(d);
  };
  const verify = verifier(b);
  const a = verify(who('old-document'), URL_A);
  await new Promise((r) => setTimeout(r, 5));
  const c = verify(who('old-document'), 'https://cdn.example/b.css');
  const d = verify(who('old-document'), 'https://cdn.example/c.css');
  await new Promise((r) => setTimeout(r, 5));
  release();
  assert.equal(await a, true);
  assert.equal(await c, false);
  assert.equal(await d, false);
});

test('the same document is accepted again and again from the memory, and each frame has its own', async () => {
  const b = browser({ live: ['old-document', 'child'], current: 'old-document' });
  const verify = verifier(b);
  assert.equal(await verify(who('old-document'), URL_A), true);
  assert.equal(await verify(who('old-document'), URL_A), true);
  assert.equal(b.calls.length, 1);
  assert.equal(await verify(who('child', { frameId: 2 }), URL_A), true);
  assert.equal(b.calls.length, 2);
  assert.deepEqual(b.calls[1].target, { tabId: 1, documentIds: ['child'] });
});
