// IP 匹配：单 IP / CIDR / 通配符（对齐 shlink IpAddressUtils::ipAddressMatchesGroups）
// 纯函数、零依赖，可单测。IPv4 与 IPv6 都支持；通配符仅 IPv4（与 shlink 一致）。
//
// shlink 语义：
//   * 静态 IP  -> 严格相等
//   * CIDR     -> 命中的地址在该网段内
//   * 通配符   -> 静态段与 remote 对应段相等（`*` 段恒等）
//   * remote 不是合法 IP -> 不匹配（shlink 抛 InvalidIpFormatException 后按不匹配处理）

const net = require('node:net');

function v4PartsToBigInt(parts) {
  return ((BigInt(parts[0]) << 24n) | (BigInt(parts[1]) << 16n) |
    (BigInt(parts[2]) << 8n) | BigInt(parts[3])) & 0xffffffffn;
}

function bigIntToV4Parts(value) {
  return [0, 1, 2, 3].map((i) => Number((value >> BigInt(8 * (3 - i))) & 0xffn));
}

function groupsToBigInt(parts) {
  let value = 0n;
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    value = (value << 16n) | BigInt(parseInt(p, 16));
  }
  return value;
}

function parseV6(s) {
  if (!net.isIPv6(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    const value = groupsToBigInt(head);
    return value === null ? null : { kind: 6, value };
  }
  const tail = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  // `::` 至少要压缩一段，否则是非法地址
  if (missing < 1) return null;
  const value = groupsToBigInt([...head, ...Array(missing).fill('0'), ...tail]);
  return value === null ? null : { kind: 6, value };
}

function parseIp(ip) {
  if (typeof ip !== 'string') return null;
  const s = ip.trim().split('%')[0];
  if (!s) return null;
  if (s.includes('.')) {
    // IPv4 或 IPv4-mapped IPv6（::ffff:1.2.3.4）
    const v4 = s.slice(s.lastIndexOf(':') + 1);
    if (!net.isIPv4(v4)) return null;
    return { kind: 4, value: v4PartsToBigInt(v4.split('.').map(Number)) };
  }
  return parseV6(s);
}

function parseCandidate(candidate) {
  const s = String(candidate).trim();
  if (!s) return null;
  if (s.includes('*')) return { wildcard: s };
  const slash = s.indexOf('/');
  const base = slash < 0 ? s : s.slice(0, slash);
  const len = slash < 0 ? null : s.slice(slash + 1);
  const parsed = parseIp(base);
  if (!parsed) return null;
  const width = parsed.kind === 4 ? 32 : 128;
  let bits = width;
  if (len !== null) {
    bits = Number(len);
    if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  }
  return { kind: parsed.kind, value: parsed.value, bits };
}

function matchWildcard(parsed, pattern) {
  if (parsed.kind !== 4) return false;
  const octets = pattern.split('.');
  if (octets.length !== 4) return false;
  const remote = bigIntToV4Parts(parsed.value);
  // 与 shlink 一致：`*` 用 remote 对应段替换后做字符串相等比较
  const filled = octets.map((o, i) => (o === '*' ? String(remote[i]) : o)).join('.');
  return filled === remote.join('.');
}

function inRange(parsed, cand) {
  if (parsed.kind !== cand.kind) return false;
  const width = parsed.kind === 4 ? 32 : 128;
  const mask = cand.bits === 0
    ? 0n
    : ((1n << BigInt(cand.bits)) - 1n) << BigInt(width - cand.bits);
  return (parsed.value & mask) === (cand.value & mask);
}

function ipMatchesGroups(ip, groups) {
  if (!Array.isArray(groups) || groups.length === 0) return false;
  const parsed = parseIp(ip);
  if (!parsed) return false;
  for (const g of groups) {
    const cand = parseCandidate(g);
    if (!cand) continue;
    if (cand.wildcard ? matchWildcard(parsed, cand.wildcard) : inRange(parsed, cand)) {
      return true;
    }
  }
  return false;
}

module.exports = { ipMatchesGroups, parseIp, parseCandidate, matchWildcard, inRange };
