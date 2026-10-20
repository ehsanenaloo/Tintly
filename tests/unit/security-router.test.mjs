import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const load = (p) => import(pathToFileURL(join(REPO, 'extension', p)).href);
const { createRouter } = await load('background/modules/router.js');

const RID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${RID}/`;

function router() {
  const router = createRouter({ runtimeId: RID, extensionOrigin: ORIGIN, state: {}, net: {}, icon: {}, data: {}, tabs: {}, ondemand: {} });
  return router;
}

test('SEC: a frame without an address belongs to the origin that made it, not to the top page', () => {
  const r = router();
  // top.example > ads.example > a frame that ads.example made with script
  const blank = { id: RID, url: 'about:blank', origin: 'https://ads.example', tab: { id: 3, url: 'https://top.example/mail/inbox' }, frameId: 7 };
  const who = r.classify(blank);
  assert.equal(who.kind, 'content');
  assert.equal(who.who.host, 'ads.example');
  assert.equal(new URL(who.who.pageUrl).origin, 'https://ads.example');
});

test('SEC: a frame without an address of the same origin as the top page keeps the path of the top page', () => {
  const r = router();
  const blank = { id: RID, url: 'about:srcdoc', origin: 'https://top.example', tab: { id: 3, url: 'https://top.example/mail/inbox' }, frameId: 7 };
  const who = r.classify(blank);
  assert.equal(who.who.host, 'top.example');
  assert.equal(who.who.pathname, '/mail/inbox');
});

test('SEC: a frame without an address and without an origin of the web is refused or falls back to the top page', () => {
  const r = router();
  const opaque = { id: RID, url: 'about:blank', origin: 'null', tab: { id: 3, url: 'https://top.example/x' }, frameId: 7 };
  const who = r.classify(opaque);
  // A sandboxed frame has an opaque origin; the top page is the best owner that is left.
  assert.equal(who.who.host, 'top.example');
  const noOrigin = { id: RID, url: 'about:blank', tab: { id: 3, url: 'https://top.example/x' }, frameId: 7 };
  assert.equal(r.classify(noOrigin).who.host, 'top.example');
});

test('SEC: a frame without an address gets network rights only from an origin the browser reported', () => {
  const r = router();
  const top = 'http://192.168.1.5/admin';
  const tab = { id: 3, url: top };
  const rightsOf = (extra) => r.classify({ id: RID, url: 'about:blank', tab, frameId: 7, ...extra }).who.rights;
  assert.equal(rightsOf({ origin: 'http://192.168.1.5' }), top, 'same origin as the top page');
  assert.equal(rightsOf({ origin: 'https://ads.example' }), 'https://ads.example/', 'a third party gets its own');
  assert.equal(rightsOf({}), '', 'no origin: no rights');
  assert.equal(rightsOf({ origin: 'null' }), '', 'opaque origin: no rights');
  assert.equal(rightsOf({ origin: 5 }), '', 'a wrong type: no rights');
  const own = r.classify({ id: RID, url: 'http://192.168.1.5/x', tab, frameId: 0 });
  assert.equal(own.who.rights, 'http://192.168.1.5/x');
  const stillTop = r.classify({ id: RID, url: 'about:blank', tab, frameId: 7 });
  assert.equal(stillTop.who.host, '192.168.1.5', 'the fixes still follow the top page');
});
