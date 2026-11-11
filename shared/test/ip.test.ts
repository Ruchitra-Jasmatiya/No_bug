import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getNetPolicy, isAlwaysBlockedAddress, isBlockedAddress, parseIPv6 } from '../src/net/ip.js';

describe('isBlockedAddress', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1',
    '100.64.0.1', '100.127.255.255', '198.18.0.1', '224.0.0.1', '239.255.255.255',
    '240.0.0.1', '255.255.255.255', '192.0.2.5', '203.0.113.9',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:169.254.169.254', '::ffff:7f00:1',
    '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2001:db8::1',
    'not-an-ip', '', '999.1.1.1',
  ];
  for (const addr of blocked) {
    it(`blocks ${JSON.stringify(addr)}`, () => assert.equal(isBlockedAddress(addr), true));
  }

  const allowed = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1',
    '100.63.255.255', '100.128.0.1', '192.169.0.1', '198.20.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808',
  ];
  for (const addr of allowed) {
    it(`allows public ${addr}`, () => assert.equal(isBlockedAddress(addr), false));
  }
});

describe('isAlwaysBlockedAddress', () => {
  it('blocks cloud metadata addresses in every form', () => {
    for (const a of ['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254', '::ffff:169.254.169.254']) {
      assert.equal(isAlwaysBlockedAddress(a), true, a);
    }
  });
  it('does not flag ordinary addresses', () => {
    assert.equal(isAlwaysBlockedAddress('8.8.8.8'), false);
    assert.equal(isAlwaysBlockedAddress('127.0.0.1'), false);
  });
});

describe('parseIPv6', () => {
  it('parses compressed and embedded forms', () => {
    assert.equal(parseIPv6('::1'), 1n);
    assert.equal(parseIPv6('::ffff:1.2.3.4'), 0xffff01020304n);
    assert.equal(parseIPv6('1::2::3'), null);
    assert.equal(parseIPv6('12345::'), null);
  });
});

describe('WHATWG URL canonicalisation of numeric hosts', () => {
  it('normalises decimal / hex / octal IPv4 so the guard sees dotted form', () => {
    for (const host of ['2130706433', '0x7f.1', '0177.0.0.1', '127.1']) {
      assert.equal(new URL(`http://${host}/`).hostname, '127.0.0.1', host);
    }
  });
});

describe('getNetPolicy', () => {
  it('defaults to strict', () => assert.equal(getNetPolicy({}).allowPrivateTargets, false));
  it('allows private targets outside production', () => {
    assert.equal(getNetPolicy({ NBA_ALLOW_PRIVATE_TARGETS: 'true', NODE_ENV: 'test' }).allowPrivateTargets, true);
  });
  it('refuses to enable private targets in production', () => {
    assert.throws(() => getNetPolicy({ NBA_ALLOW_PRIVATE_TARGETS: 'true', NODE_ENV: 'production' }));
  });
});
