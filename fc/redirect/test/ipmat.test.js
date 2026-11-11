// IP 匹配单测：node --test fc/redirect/test/ipmat.test.js
// 对齐 shlink IpAddressUtils::ipAddressMatchesGroups 的三种形态：静态 IP / CIDR / 通配符。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ipMatchesGroups } = require('../ipmat');

test('IPv4 静态 IP：严格相等', () => {
  assert.equal(ipMatchesGroups('192.168.1.10', ['192.168.1.10']), true);
  assert.equal(ipMatchesGroups('192.168.1.11', ['192.168.1.10']), false);
});

test('IPv4 CIDR：网段内命中', () => {
  assert.equal(ipMatchesGroups('192.168.1.10', ['192.168.1.0/24']), true);
  assert.equal(ipMatchesGroups('192.168.2.10', ['192.168.1.0/24']), false);
  assert.equal(ipMatchesGroups('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(ipMatchesGroups('10.1.2.3', ['10.0.0.0/32']), false);
  assert.equal(ipMatchesGroups('10.1.2.3', ['0.0.0.0/0']), true);
});

test('IPv4 通配符：静态段相等即可', () => {
  assert.equal(ipMatchesGroups('192.168.1.10', ['192.168.*.*']), true);
  assert.equal(ipMatchesGroups('192.168.1.10', ['192.168.1.*']), true);
  assert.equal(ipMatchesGroups('192.168.1.10', ['192.168.2.*']), false);
  assert.equal(ipMatchesGroups('192.168.1.10', ['192.168.*.10']), true);
  assert.equal(ipMatchesGroups('192.168.1.10', ['192.168.*.11']), false);
  assert.equal(ipMatchesGroups('192.168.1.10', ['*.*.*.*']), true);
});

test('IPv6：静态与 CIDR', () => {
  assert.equal(ipMatchesGroups('2001:db8::1', ['2001:db8::1']), true);
  assert.equal(ipMatchesGroups('2001:db8::2', ['2001:db8::1']), false);
  assert.equal(ipMatchesGroups('2001:db8:1::5', ['2001:db8::/32']), true);
  assert.equal(ipMatchesGroups('2001:db9:1::5', ['2001:db8::/32']), false);
  assert.equal(ipMatchesGroups('::1', ['::1/128']), true);
  assert.equal(ipMatchesGroups('::2', ['::1/128']), false);
});

test('IPv4-mapped IPv6：按 IPv4 处理', () => {
  assert.equal(ipMatchesGroups('::ffff:192.168.1.10', ['192.168.1.0/24']), true);
  assert.equal(ipMatchesGroups('::ffff:192.168.1.10', ['192.168.2.0/24']), false);
});

test('非法/空输入：不匹配', () => {
  assert.equal(ipMatchesGroups('not-an-ip', ['*.*.*.*']), false);
  assert.equal(ipMatchesGroups('', ['0.0.0.0/0']), false);
  assert.equal(ipMatchesGroups('192.168.1.10', []), false);
  assert.equal(ipMatchesGroups('192.168.1.10', ['not-a-cidr']), false);
  assert.equal(ipMatchesGroups('192.168.1.10', ['192.168.0.0/33']), false);
});

test('跨协议不串匹配', () => {
  assert.equal(ipMatchesGroups('192.168.1.10', ['2001:db8::/32']), false);
  assert.equal(ipMatchesGroups('2001:db8::1', ['192.168.1.0/24']), false);
});

test('多组任一命中即 true', () => {
  assert.equal(ipMatchesGroups('8.8.8.8', ['10.0.0.0/8', '8.8.8.8']), true);
  assert.equal(ipMatchesGroups('8.8.4.4', ['10.0.0.0/8', '8.8.8.8']), false);
});
