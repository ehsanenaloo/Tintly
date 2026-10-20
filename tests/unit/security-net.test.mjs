import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { checkTarget, isPrivateHost } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'net.js')).href);

const PUBLIC_PAGE = 'https://site.example/page';
const refused = (target, page = PUBLIC_PAGE) => checkTarget(target, page).ok === false;

test('SEC: addresses that carry a private IPv4 address inside an IPv6 address are private', () => {
  for (const host of ['[64:ff9b::7f00:1]', '[64:ff9b::c0a8:101]', '[64:ff9b::a00:1]', '[2002:7f00:1::]', '[2002:c0a8:101::1]', '[2002:a9fe:a9fe::]', '[::ffff:0:7f00:1]', '[2001:0:4136:e378:8000:63bf:3fff:fdd2]', '[fec0::1]', '[100::1]', '[64:ff9b:1::1]']) {
    assert.equal(isPrivateHost(host), true, host);
    assert.ok(refused(`http://${host}/x.css`), host);
  }
});

test('SEC: public IPv6 addresses and public embedded IPv4 addresses stay allowed', () => {
  for (const host of ['[2606:4700:4700::1111]', '[2001:4860:4860::8888]', '[64:ff9b::808:808]', '[2002:808:808::1]']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('SEC: every spelling of a loopback or private IPv4 address that the URL parser accepts is private', () => {
  for (const host of ['0x7f.1', '0177.0.0.1', '2130706433', '127.1', '0xc0a80101', '192.168.257', '10.1', '①②⑦.0.0.1', '127.0.0.1.', '0', '0x0', '[::1]', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]', 'LOCALHOST.', 'a.localhost']) {
    assert.ok(refused(`http://${host}/x.css`), host);
  }
});

test('SEC: credentials, other schemes and oversized or empty targets are refused', () => {
  for (const target of ['https://user:pw@site.example/a.css', 'https://user@site.example/a.css', 'ftp://site.example/a.css', 'file:///etc/passwd', 'data:text/css,a{}', 'blob:https://site.example/1', 'javascript:1', 'chrome-extension://abc/x.css', '', `https://site.example/${'a'.repeat(2100)}`, 5, null, undefined, {}]) {
    assert.ok(refused(target), String(target).slice(0, 40));
  }
});

test('SEC: a private page may reach its own network, a public page may not', () => {
  assert.equal(checkTarget('http://192.168.1.5/a.css', 'http://192.168.1.9/').ok, true);
  assert.equal(checkTarget('http://192.168.1.5/a.css', 'https://site.example/').ok, false);
  assert.equal(checkTarget('http://192.168.1.5/a.css', 'about:blank').ok, false);
  assert.equal(checkTarget('http://192.168.1.5/a.css', undefined).ok, false);
  assert.equal(checkTarget('http://192.168.1.5/a.css', 'file:///C:/a.html').ok, false);
});

test('SEC: a requester without network rights cannot reach a private address, even on a private page', async () => {
  const { createNet } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'net.js')).href);
  const css = () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/css' }), body: new Blob(['a{}']).stream() });
  const net = createNet({ publicSpace: true, verifyUsed: async () => true, fetchImpl: async (href) => ({ ...css(), url: href }) });
  const page = 'http://192.168.1.5/admin';
  const asPage = { tabId: 1, frameId: 0, pageUrl: page };
  const noRights = { tabId: 2, frameId: 7, pageUrl: page, rights: '' };
  assert.equal((await net.text('http://192.168.1.9/a.css', asPage)).ok, true);
  assert.deepEqual(await net.text('http://192.168.1.9/a.css', noRights), { ok: false, code: 'page' });
  assert.equal((await net.text('https://cdn.example/a.css', noRights)).ok, true, 'a public address is still fetched');
});
