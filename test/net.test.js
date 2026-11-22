import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses, routedAddress } from '../src/net.js';

const nic = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra });

test('virtual adapters rank below the real network, even when listed first', () => {
  const interfaces = {
    'VirtualBox Host-Only Network': [nic('192.168.56.1')],
    'vEthernet (Default Switch)': [nic('172.20.64.1')],
    'Wi-Fi': [nic('192.168.1.23')],
  };
  assert.deepEqual(lanAddresses({ interfaces }), ['192.168.1.23', '192.168.56.1', '172.20.64.1']);
});

test('the address the computer really routes through ranks first among real adapters', () => {
  const interfaces = { en0: [nic('10.0.0.8')], en1: [nic('192.168.1.5')] };
  assert.equal(lanAddresses({ interfaces, routed: '192.168.1.5' })[0], '192.168.1.5');
});

test('a VPN that owns the default route does not beat the real Wi-Fi', () => {
  const interfaces = { utun3: [nic('10.8.0.2')], en0: [nic('192.168.1.5')] };
  assert.equal(lanAddresses({ interfaces, routed: '10.8.0.2' })[0], '192.168.1.5');
});

test('home-style private ranges come before public addresses', () => {
  const interfaces = { en0: [nic('203.0.113.9')], en1: [nic('192.168.0.4')] };
  assert.deepEqual(lanAddresses({ interfaces }), ['192.168.0.4', '203.0.113.9']);
});

test('loopback, link-local, IPv6 and duplicates are left out; numeric family values work', () => {
  const interfaces = {
    lo: [nic('127.0.0.1', { internal: true })],
    en0: [nic('169.254.10.2'), { address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.5', family: 4, internal: false }],
    en1: [nic('192.168.1.5')],
  };
  assert.deepEqual(lanAddresses({ interfaces }), ['192.168.1.5']);
});

test('no network at all gives an empty list', () => {
  assert.deepEqual(lanAddresses({ interfaces: {} }), []);
});

test('routedAddress resolves to an IPv4 string or null, never throws', async () => {
  const a = await routedAddress();
  assert.ok(a === null || /^\d+\.\d+\.\d+\.\d+$/.test(a), String(a));
});
