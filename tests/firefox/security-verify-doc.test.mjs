// In Firefox, a script can be aimed at a document, a reply names the document it ran in, and a replaced document is refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServers } from '../browser/harness.mjs';
import { startFirefox, firefoxSkip } from './driver.mjs';

const skip = firefoxSkip();
let servers;
let ff;
let ext;

before(async () => {
  if (skip) return;
  servers = await startServers();
  ff = await startFirefox();
  console.log(`# Firefox ${ff.version}`);
  // An extension page as a tab of its own: `tabs` exists there.
  ext = await ff.extensionTab(servers.origin, '/pages/options/options.html');
});
after(async () => {
  await ff?.close();
  await servers?.close();
});

const probe = (arg) =>
  ff.run(
    ext,
    async (arg) => {
      const run = async (target) => {
        try {
          const r = await browser.scripting.executeScript({ target, world: 'ISOLATED', injectImmediately: true, func: () => location.pathname });
          return r.map((x) => ({ documentId: x.documentId, frameId: x.frameId, result: x.result }));
        } catch (e) {
          return `ERR ${e.message}`;
        }
      };
      const tab = (await browser.tabs.query({ url: 'http://127.0.0.1/*' })).find((t) => t.url.includes(arg.path));
      if (!tab) return { missing: true };
      if (!arg.old) {
        const first = await run({ tabId: tab.id, frameIds: [0] });
        return { first, byDocument: await run({ tabId: tab.id, documentIds: [first[0].documentId] }) };
      }
      return { byOld: await run({ tabId: tab.id, documentIds: [arg.old] }), byFrame: await run({ tabId: tab.id, frameIds: [0] }) };
    },
    arg,
  );

test('Firefox: documentIds is supported, replies name the document, a replaced document is refused', { skip, timeout: 90000 }, async () => {
  const tab = await ff.newTab(`${servers.origin}/basic.html`);
  const first = await probe({ path: '/basic.html' });
  assert.equal(typeof first.first[0].documentId, 'string');
  assert.deepEqual(first.byDocument[0].documentId, first.first[0].documentId);
  await ff.call('browsingContext.navigate', { context: tab, url: `${servers.origin}/gen/blank.html`, wait: 'complete' });
  const later = await probe({ path: '/gen/blank.html', old: first.first[0].documentId });
  console.log('# facts', JSON.stringify(later));
  assert.equal(typeof later.byOld, 'string', 'the old document cannot be scripted');
  assert.notEqual(later.byFrame[0].documentId, first.first[0].documentId, 'the frame has a new document');
});
