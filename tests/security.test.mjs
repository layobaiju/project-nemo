import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, isAllowedHostHeader, originMatchesHost, generateCode, normalizeCode, tokenFor, createThrottle, parseCookies } from '../server/security.mjs';

test('only loopback and private network addresses are accepted', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.9', '10.2.3.4', '172.20.0.5', '169.254.1.1', '100.82.17.80', 'fe80::1%12', 'fd12:3456::1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::8888', '::ffff:1.1.1.1', '']) assert.ok(!isPrivateAddress(ip), ip);
});

test('host header must be localhost, an IP literal or this PC name (DNS rebinding guard)', () => {
  assert.ok(isAllowedHostHeader('localhost:4174'));
  assert.ok(isAllowedHostHeader('192.168.1.9:4174'));
  assert.ok(isAllowedHostHeader('[::1]:4174'));
  assert.ok(isAllowedHostHeader('desktop-abc.local:4174', ['DESKTOP-ABC.local']));
  assert.ok(!isAllowedHostHeader('evil.example.com:4174', ['desktop-abc']));
  assert.ok(!isAllowedHostHeader(''));
});

test('cross-site writes are rejected', () => {
  assert.ok(originMatchesHost(undefined, 'localhost:4174'));
  assert.ok(originMatchesHost('http://192.168.1.9:4174', '192.168.1.9:4174'));
  assert.ok(!originMatchesHost('https://evil.example', 'localhost:4174'));
  assert.ok(!originMatchesHost('null', 'localhost:4174'));
});

test('access codes are readable and tokens depend on the code', () => {
  const code = generateCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizeCode(code.toLowerCase().replace('-', ' ')), code.replace('-', ''));
  assert.notEqual(tokenFor('s', 'AAAA-BBBB'), tokenFor('s', 'AAAA-BBBC'));
  assert.equal(tokenFor('s', 'aaaa bbbb'), tokenFor('s', 'AAAA-BBBB'));
  assert.deepEqual(parseCookies('a=1; atlas_access=xyz'), { a: '1', atlas_access: 'xyz' });
});

test('throttle blocks after repeated failures', () => {
  const t = createThrottle(2, 60_000);
  t.fail('ip'); assert.ok(!t.blocked('ip'));
  t.fail('ip'); assert.ok(t.blocked('ip'));
  t.reset('ip'); assert.ok(!t.blocked('ip'));
});
