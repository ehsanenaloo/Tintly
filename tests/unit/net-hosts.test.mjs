import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPO } from '../helpers/tree.mjs';

const { isPrivateHost, checkTarget } = await import(pathToFileURL(join(REPO, 'extension', 'background', 'modules', 'net.js')).href);

test('reserved and intranet-style names are private', () => {
  const names = [
    'router.home.arpa', 'home.arpa', 'nas.private', 'x.intra', 'a.b.intra', 'wiki.corp', 'files.lan', 'db.internal', 'printer.local',
    'host.localdomain', 'app.home', 'x.intranet', 'a.localhost', 'ROUTER.HOME.ARPA', 'router.home.arpa.',
  ];
  for (const h of names) assert.equal(isPrivateHost(h), true, h);
});

test('real public names that only look similar stay public', () => {
  const names = [
    'arpa.example.com', 'home.example.com', 'myhome.arpa.example', 'in-addr.arpa', 'privatebank.com', 'private.example.com', 'intra.example.com',
    'intranet.example.com', 'corp.example.com', 'lan.example.com', 'internal.example.com', 'local.example.com', 'homearpa.com', 'cdn.home-arpa.com',
  ];
  for (const h of names) assert.equal(isPrivateHost(h), false, h);
});

test('a public page cannot fetch from a reserved intranet name, a page on one can', () => {
  assert.equal(checkTarget('https://router.home.arpa/a.css', 'https://site.example/').code, 'private');
  assert.equal(checkTarget('https://nas.private/a.css', 'https://site.example/').code, 'private');
  assert.equal(checkTarget('https://nas.private/a.css', 'https://wiki.intra/').ok, true);
});

test('loopback is open only to a page on loopback, link-local only to a page on link-local', () => {
  const lan = 'http://192.168.1.20/';
  // A page on the home network may not read this machine or the next hop, in any spelling.
  for (const t of ['http://127.0.0.1:9000/a.css', 'http://localhost:9000/a.css', 'http://a.localhost/a.css', 'http://[::1]/a.css', 'http://[::ffff:127.0.0.1]/a.css', 'http://0.0.0.0/a.css', 'http://2130706433/a.css']) {
    assert.deepEqual(checkTarget(t, lan), { ok: false, code: 'private' }, t);
  }
  for (const t of ['http://169.254.169.254/latest/meta-data', 'http://[fe80::1]/a.css', 'http://[::ffff:169.254.1.1]/a.css']) {
    assert.deepEqual(checkTarget(t, lan), { ok: false, code: 'private' }, t);
  }
  assert.equal(checkTarget('http://169.254.169.254/a.css', 'http://127.0.0.1/').ok, false, 'loopback is not link-local');
  assert.equal(checkTarget('http://127.0.0.1/a.css', 'http://169.254.1.1/').ok, false, 'link-local is not loopback');
  assert.equal(checkTarget('http://127.0.0.1/a.css', 'http://intranet/').ok, false, 'an intranet name is not loopback');
  // Each reaches its own kind.
  assert.equal(checkTarget('http://127.0.0.1:8000/a.css', 'http://localhost:3000/').ok, true);
  assert.equal(checkTarget('http://[::1]:8000/a.css', 'http://127.0.0.1/').ok, true);
  assert.equal(checkTarget('http://169.254.1.2/a.css', 'http://169.254.1.1/').ok, true);
  assert.equal(checkTarget('http://[fe80::2]/a.css', 'http://[fe80::1]/').ok, true);
  // Any other private network is open to any page that is not public, a page on this machine included.
  assert.equal(checkTarget('http://192.168.1.5/a.css', lan).ok, true);
  assert.equal(checkTarget('http://10.0.0.5/a.css', 'http://localhost:3000/').ok, true);
  assert.equal(checkTarget('http://nas.lan/a.css', 'http://169.254.1.1/').ok, true);
  assert.equal(checkTarget('http://10.0.0.5/a.css', 'https://site.example/').ok, false);
});

test('the reserved names .test and .invalid are private, .example stays a public stand-in', () => {
  for (const h of ['app.test', 'a.b.test', 'APP.TEST.', 'x.invalid']) assert.equal(isPrivateHost(h), true, h);
  for (const h of ['site.example', 'test.example.com', 'invalid.example.org', 'contest.com']) assert.equal(isPrivateHost(h), false, h);
  assert.equal(checkTarget('http://app.test/a.css', 'https://site.example/').code, 'private', 'a public page cannot reach a development name');
  assert.equal(checkTarget('http://cdn.app.test/a.css', 'http://app.test/').ok, true);
  assert.equal(checkTarget('http://127.0.0.1/a.css', 'http://app.test/').ok, false, 'a .test name is not known to be loopback');
});
