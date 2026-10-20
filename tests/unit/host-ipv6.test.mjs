// one contract for the host of a site rule, with IPv6 literals (settings, shared match, the content twin, the gate bucket, registration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../helpers/content.mjs';
import { normalizePattern } from '../../extension/shared/settings.js';
import { candidates, find, patternFor, siteEnabled, parsePage } from '../../extension/shared/match.js';
import { bucketOf } from '../../extension/background/modules/gate.js';
import { parseKey, hostPattern, planFor, covers } from '../../extension/background/modules/register.js';

// prefetch.js needs a page; the part under test is the bucket function it defines.
globalThis.document = { readyState: 'loading' };
globalThis.location = { protocol: 'http:', host: 'x.test' };
globalThis.chrome = { storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener() {}, removeListener() {} } } };
const content = await loadContent('core/prefetch.js', 'core/match.js');

test('the rule key of an IPv6 page is its host as the browser writes it', () => {
  assert.equal(patternFor('http://[::1]:8080/'), '[::1]:8080');
  assert.equal(patternFor('http://[::1]/'), '[::1]');
  assert.equal(patternFor('https://[2001:db8::1]:8443/a/b?c#d'), '[2001:db8::1]:8443');
  assert.equal(patternFor('http://[2001:DB8:0:0:0:0:0:1]/'), '[2001:db8::1]');
  assert.equal(patternFor('http://[::ffff:127.0.0.1]/'), '[::ffff:7f00:1]');
  assert.equal(patternFor('http://example.com:8080/'), 'example.com:8080');
  assert.equal(patternFor('http://127.0.0.1:3000/'), '127.0.0.1:3000');
});

test('compressed, expanded and upper-case spellings are one key', () => {
  const forms = ['[::1]', '[0:0:0:0:0:0:0:1]', '[0000:0000:0000:0000:0000:0000:0000:0001]', '[0::1]', '[::0001]', 'http://[::1]/', 'HTTP://[::1]'];
  for (const f of forms) assert.equal(normalizePattern(f), '[::1]', f);
  assert.equal(normalizePattern('[2001:DB8::A]'), '[2001:db8::a]');
  assert.equal(normalizePattern('[2001:db8:0:0:0:0:0:a]'), '[2001:db8::a]');
});

test('a port and a path are kept, a port is written without leading zeros', () => {
  assert.equal(normalizePattern('[::1]:8080'), '[::1]:8080');
  assert.equal(normalizePattern('[::1]:08080'), '[::1]:8080');
  assert.equal(normalizePattern('[::1]:80/docs/'), '[::1]:80/docs');
  assert.equal(normalizePattern('http://[2001:db8::1]:9000/a/b?x=1#y'), '[2001:db8::1]:9000/a/b');
  assert.equal(normalizePattern('[::1]/'), '[::1]');
  assert.equal(normalizePattern('[::1]:0'), '[::1]:0');
  assert.equal(normalizePattern('[::1]:65535'), '[::1]:65535');
});

test('bad brackets, bad ports, zones, wildcards and non-addresses are refused', () => {
  for (const bad of ['[::1', '::1]', '[::1]]', '[[::1]]', '[]', '[:]', '[:::]', '[1:2:3]', '[g::1]', '[::1]:65536', '[::1]:99999', '[::1]:', '[::1]:x', '[::1]:-1', '[::1]x', 'x[::1]', '[::1]:1:2', '[fe80::1%25eth0]', '[fe80::1%eth0]', '*.[::1]', '[*]', '[::1]*', '[1.2.3.4]', '[example.com]', '[::1] ', '[::1]\u0000']) {
    const got = normalizePattern(bad.trim() === bad ? bad : bad);
    // A trailing space is trimmed like for any pattern; the rest must not be accepted as an address.
    if (bad === '[::1] ') assert.equal(got, '[::1]');
    else assert.equal(got, null, JSON.stringify(bad));
  }
  assert.equal(normalizePattern('[' + '1:'.repeat(30) + ':1]'), null);
});

test('DNS, IPv4, wildcard and path keys are as before; a port is checked the same way for every host', () => {
  assert.equal(normalizePattern('Example.COM'), 'example.com');
  assert.equal(normalizePattern('https://www.example.com/a/b/?q=1'), 'www.example.com/a/b');
  assert.equal(normalizePattern('*.example.com'), '*.example.com');
  assert.equal(normalizePattern('127.0.0.1:3000'), '127.0.0.1:3000');
  assert.equal(normalizePattern('localhost:8080/app'), 'localhost:8080/app');
  assert.equal(normalizePattern('example.com:80'), 'example.com:80');
  assert.equal(normalizePattern('example.com:080'), 'example.com:80');
  assert.equal(normalizePattern('example.com:65536'), null);
  assert.equal(normalizePattern('*.example.com:99999'), null);
  assert.equal(normalizePattern('bad_host'), null);
  assert.equal(normalizePattern(''), null);
});

test('an IPv6 literal has no parent domains and no wildcard hosts', () => {
  assert.deepEqual(candidates('[::1]', '/'), ['[::1]']);
  assert.deepEqual(candidates('[::1]:8080', '/'), ['[::1]:8080', '[::1]']);
  assert.deepEqual(candidates('[2001:db8::1]:8080', '/a/b'), ['[2001:db8::1]:8080/a/b', '[2001:db8::1]:8080/a', '[2001:db8::1]:8080', '[2001:db8::1]/a/b', '[2001:db8::1]/a', '[2001:db8::1]']);
  for (const host of ['[::1]', '[::1]:8080', '[2001:db8::1]', '[::ffff:7f00:1]:1']) assert.ok(candidates(host, '/x').every((c) => !c.includes('*') && !c.startsWith('1]') && !c.startsWith('db8')), host);
  // DNS names keep their hierarchy.
  assert.deepEqual(candidates('www.example.com', '/'), ['www.example.com', 'example.com', '*.example.com']);
});

test('rules are found for IPv6 pages by host, host with port, and path; other hosts do not match', () => {
  const rules = { '[::1]': 'any port', '[::1]:8080': 'port 8080', '[::1]:8080/docs': 'docs', '[2001:db8::1]': 'public', '[::2]': 'other' };
  assert.equal(find(rules, '[::1]:8080', '/docs/x'), 'docs');
  assert.equal(find(rules, '[::1]:8080', '/'), 'port 8080');
  assert.equal(find(rules, '[::1]:9090', '/'), 'any port');
  assert.equal(find(rules, '[::1]', '/'), 'any port');
  assert.equal(find(rules, '[2001:db8::1]:443', '/'), 'public');
  assert.equal(find(rules, '[::3]', '/'), undefined);
  assert.equal(find({ '*.1]': 'x', '1]': 'y', '::1]': 'z', '1': 'w' }, '[::1]', '/'), undefined);
  assert.equal(find({ '127.0.0.1': 'v4' }, '[::ffff:7f00:1]', '/'), undefined);
});

test('the page address is split the way the keys are written', () => {
  assert.deepEqual(parsePage('http://[::1]:8080/a/b'), { host: '[::1]:8080', pathname: '/a/b' });
  assert.equal(siteEnabled({ listMode: 'onlyListed' }, { '[::1]': { enabled: true } }, 'http://[::1]:8080/x'), true);
  assert.equal(siteEnabled({ listMode: 'onlyListed' }, { '[::1]': { enabled: true } }, 'http://[::2]/x'), false);
  assert.equal(siteEnabled({}, { '[::1]:8080': { enabled: false } }, 'http://[::1]:8080/x'), false);
  assert.equal(siteEnabled({}, { '[::1]:8080': { enabled: false } }, 'http://[::1]:9090/x'), true);
});

test('the content script and the shared module give the same candidates and the same buckets', () => {
  const hosts = ['[::1]', '[::1]:8080', '[2001:db8::1]:443', '[::ffff:7f00:1]', 'www.example.com', 'example.com:8080', '127.0.0.1:3000', 'localhost', 'a.b.c.example.co.uk'];
  for (const host of hosts) {
    for (const path of ['/', '/a', '/a/b/c']) assert.deepEqual(content.match.candidates(host, path), candidates(host, path), `${host}${path}`);
    assert.equal(content.bucketOf(host), bucketOf(host), host);
  }
  assert.equal(bucketOf('[::1]:8080/docs'.split('/')[0]), '[::1]');
  assert.equal(bucketOf('[2001:db8::1]'), '[2001:db8::1]');
});

test('a stored key and a page host meet in the same bucket', () => {
  for (const url of ['http://[::1]:8080/a', 'https://[2001:db8::1]/', 'http://[::ffff:7f00:1]:81/']) {
    const key = patternFor(url);
    assert.equal(bucketOf(key.split('/')[0]), bucketOf(parsePage(url).host), url);
  }
});

test('the registration names an IPv6 host as itself', () => {
  assert.deepEqual(parseKey('[::1]'), { bare: '[::1]', valid: true, plain: true });
  assert.deepEqual(parseKey('[::1]:8080'), { bare: '[::1]', valid: true, plain: false });
  assert.deepEqual(parseKey('[2001:db8::1]/docs'), { bare: '[2001:db8::1]', valid: true, plain: false });
  assert.equal(parseKey('*.[::1]').valid, false);
  assert.equal(parseKey('[zz]').valid, false);
  assert.equal(parseKey('[::1').valid, false);
  assert.equal(hostPattern('[::1]'), '*://[::1]/*');
  assert.equal(hostPattern('example.com'), '*://*.example.com/*');
  const plan = planFor({ listMode: 'onlyListed' }, { '[2001:db8::1]': { enabled: true } });
  assert.deepEqual(plan.matches, ['*://[2001:db8::1]/*']);
  assert.equal(covers(plan, 'http://[2001:db8::1]:3000/a'), true);
  assert.equal(covers(plan, 'http://[2001:db8::2]/'), false);
});
