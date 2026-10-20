import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framesStarted, pageStatus } from '../helpers/gate.mjs';

/** A worker whose `evaluate` runs the function here, against a fake `chrome`. */
function fakeBrowser({ tabId = 7, session = {}, frames = [true] } = {}) {
  const chromeFake = {
    tabs: { query: async () => [{ id: tabId }] },
    storage: { session: { get: async (key) => ({ [key]: session[key] }) } },
    scripting: { executeScript: async () => frames.map((result) => ({ result })) },
  };
  return {
    worker: {
      evaluate: async (fn, arg) => {
        const old = globalThis.chrome;
        globalThis.chrome = chromeFake;
        try {
          return await fn(arg);
        } finally {
          globalThis.chrome = old;
        }
      },
    },
    session,
  };
}

test('pageStatus returns the reported status and waits for a wanted one', async () => {
  const b = fakeBrowser({ session: { 'tab:7': { status: 'site-off' } } });
  assert.equal(await pageStatus(b, 'http://a.test/x#h'), 'site-off');
  assert.equal(await pageStatus(b, 'http://a.test/x', { want: ['site-off', 'off'] }), 'site-off');
  setTimeout(() => (b.session['tab:7'] = { status: 'dark-detected' }), 120);
  assert.equal(await pageStatus(b, 'http://a.test/x', { want: ['dark-detected'], timeout: 3000 }), 'dark-detected');
});

test('pageStatus fails when the page never reports, or reports another status', async () => {
  await assert.rejects(pageStatus(fakeBrowser(), 'http://a.test/x', { timeout: 200 }), /did not report a status/);
  const b = fakeBrowser({ session: { 'tab:7': { status: 'on' } } });
  await assert.rejects(pageStatus(b, 'http://a.test/x', { want: ['site-off'], timeout: 200 }), /site-off.*last: on/);
});

test('framesStarted needs every frame to have started', async () => {
  assert.equal(await framesStarted(fakeBrowser({ frames: [true, true] }), 'http://a.test/x'), 2);
  await assert.rejects(framesStarted(fakeBrowser({ frames: [true, false] }), 'http://a.test/x', { timeout: 200 }), /1 of 2 frames/);
  await assert.rejects(framesStarted(fakeBrowser({ frames: [true] }), 'http://a.test/x', { timeout: 200 }), /0 of 0 frames|1 of 1/);
});

test('frameProbed waits for detection in the named frame', async () => {
  const b = fakeBrowser({ frames: [] });
  let call = 0;
  b.worker.evaluate = async (fn, arg) => {
    const old = globalThis.chrome;
    globalThis.chrome = {
      tabs: { query: async () => [{ id: 3 }] },
      scripting: { executeScript: async () => [{ result: { href: 'http://a.test/', probes: 1 } }, { result: { href: 'http://b.test/detect/dark-css.html', probes: call++ ? 2 : 0 } }] },
    };
    try {
      return await fn(arg);
    } finally {
      globalThis.chrome = old;
    }
  };
  const { frameProbed } = await import('../helpers/gate.mjs');
  assert.equal(await frameProbed(b, 'http://a.test/', '/detect/dark-css.html', { timeout: 3000 }), 2);
  await assert.rejects(frameProbed(b, 'http://a.test/', '/never', { timeout: 200 }), /did not run in the frame "\/never"/);
});
