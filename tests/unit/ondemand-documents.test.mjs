// the allowance of a frame belongs to one document. A tab that loads page after page keeps getting its modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnDemand, LIMITS } from '../../extension/background/modules/ondemand.js';

function make() {
  const calls = [];
  return { calls, od: createOnDemand({ scripting: { executeScript: async (injection) => (calls.push(injection), [{}]) }, now: () => 0 }) };
}

test('each document of a tab has its own allowance', async () => {
  const { od } = make();
  // A themed page asks for about seven modules; ten page loads in one minute ask for far more than one allowance.
  for (let load = 0; load < 10; load++) {
    for (let k = 0; k < 7; k++) assert.equal((await od.inject('calm', { tabId: 1, frameId: 0, documentId: `doc-${load}` })).ok, true, `load ${load} request ${k}`);
  }
});

test('one document is still limited, and the tab allowance holds over all its documents', async () => {
  const { od } = make();
  for (let i = 0; i < LIMITS.FRAME_COUNT; i++) assert.equal((await od.inject('calm', { tabId: 2, frameId: 0, documentId: 'a' })).ok, true);
  assert.deepEqual(await od.inject('calm', { tabId: 2, frameId: 0, documentId: 'a' }), { ok: false, code: 'rate' });
  const tab = make();
  let ok = 0;
  for (let d = 0; d < 1000; d++) if ((await tab.od.inject('calm', { tabId: 3, frameId: 0, documentId: `d${d}` })).ok) ok++;
  assert.equal(ok, LIMITS.TAB_COUNT);
});

test('forgetting a tab clears the counts of its documents', async () => {
  const { od } = make();
  for (let i = 0; i < LIMITS.FRAME_COUNT; i++) await od.inject('calm', { tabId: 4, frameId: 0, documentId: 'a' });
  od.forgetTab(4);
  assert.equal((await od.inject('calm', { tabId: 4, frameId: 0, documentId: 'a' })).ok, true);
});
