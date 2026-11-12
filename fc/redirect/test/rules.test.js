// 跳转规则求值单测：node --test fc/redirect/test/rules.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildContext, evaluate, parseUserAgent } = require('../rules');

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const UA_WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function ctxOf(over = {}) {
  return buildContext({
    query: over.query ?? {},
    ua: over.ua ?? '',
    ip: over.ip ?? null,
    now: over.now ?? Date.parse('2026-01-15T00:00:00Z'),
    geoLookup: over.geoLookup ?? (() => null),
  });
}

// 求值入口
function match(rules, ctx) {
  return evaluate(rules, ctx);
}

test('device：iPhone UA 同时匹配 ios 与 mobile', () => {
  const ctx = ctxOf({ ua: UA_IPHONE });
  assert.equal(match([{ longUrl: 'https://x/m', conditions: [{ type: 'device', matchValue: 'ios' }] }], ctx), 'https://x/m');
  assert.equal(match([{ longUrl: 'https://x/m2', conditions: [{ type: 'device', matchValue: 'mobile' }] }], ctx), 'https://x/m2');
  assert.equal(match([{ longUrl: 'https://x/d', conditions: [{ type: 'device', matchValue: 'desktop' }] }], ctx), null);
});

test('device：Android → android+mobile；Windows → windows+desktop', () => {
  const a = ctxOf({ ua: UA_ANDROID });
  assert.equal(match([{ longUrl: 'https://a', conditions: [{ type: 'device', matchValue: 'android' }] }], a), 'https://a');
  assert.equal(match([{ longUrl: 'https://b', conditions: [{ type: 'device', matchValue: 'mobile' }] }], a), 'https://b');
  assert.equal(match([{ longUrl: 'https://c', conditions: [{ type: 'device', matchValue: 'desktop' }] }], a), null);

  const w = ctxOf({ ua: UA_WINDOWS_CHROME });
  assert.equal(match([{ longUrl: 'https://w', conditions: [{ type: 'device', matchValue: 'windows' }] }], w), 'https://w');
  assert.equal(match([{ longUrl: 'https://d', conditions: [{ type: 'device', matchValue: 'desktop' }] }], w), 'https://d');
});

test('browser：Chrome 命中 chrome，Safari 命中 safari', () => {
  const c = ctxOf({ ua: UA_WINDOWS_CHROME });
  assert.equal(match([{ longUrl: 'https://c', conditions: [{ type: 'browser', matchValue: 'chrome' }] }], c), 'https://c');
  assert.equal(match([{ longUrl: 'https://f', conditions: [{ type: 'browser', matchValue: 'firefox' }] }], c), null);

  const s = ctxOf({ ua: UA_MAC_SAFARI });
  assert.equal(match([{ longUrl: 'https://s', conditions: [{ type: 'browser', matchValue: 'safari' }] }], s), 'https://s');
});

test('query-param：值严格相等才命中', () => {
  const ctx = ctxOf({ query: { src: 'wechat', other: 'x' } });
  assert.equal(match([{ longUrl: 'https://q', conditions: [{ type: 'query-param', matchKey: 'src', matchValue: 'wechat' }] }], ctx), 'https://q');
  assert.equal(match([{ longUrl: 'https://q', conditions: [{ type: 'query-param', matchKey: 'src', matchValue: 'weibo' }] }], ctx), null);
  assert.equal(match([{ longUrl: 'https://q', conditions: [{ type: 'query-param', matchKey: 'missing', matchValue: 'x' }] }], ctx), null);
});

test('any-value-query-param：只看 key 存在', () => {
  const ctx = ctxOf({ query: { src: 'wechat' } });
  assert.equal(match([{ longUrl: 'https://q', conditions: [{ type: 'any-value-query-param', matchKey: 'src' }] }], ctx), 'https://q');
  assert.equal(match([{ longUrl: 'https://q', conditions: [{ type: 'any-value-query-param', matchKey: 'nope' }] }], ctx), null);
});

test('valueless-query-param：key 存在且值为空', () => {
  const ctx = ctxOf({ query: { src: '', other: 'v' } });
  assert.equal(match([{ longUrl: 'https://q', conditions: [{ type: 'valueless-query-param', matchKey: 'src' }] }], ctx), 'https://q');
  assert.equal(match([{ longUrl: 'https://q', conditions: [{ type: 'valueless-query-param', matchKey: 'other' }] }], ctx), null);
  assert.equal(match([{ longUrl: 'https://q', conditions: [{ type: 'valueless-query-param', matchKey: 'absent' }] }], ctx), null);
});

test('ip-address：静态 IP / CIDR / 通配符', () => {
  const ctx = ctxOf({ ip: '192.168.1.55' });
  assert.equal(match([{ longUrl: 'https://i', conditions: [{ type: 'ip-address', matchValue: '192.168.1.55' }] }], ctx), 'https://i');
  assert.equal(match([{ longUrl: 'https://i', conditions: [{ type: 'ip-address', matchValue: '192.168.1.0/24' }] }], ctx), 'https://i');
  assert.equal(match([{ longUrl: 'https://i', conditions: [{ type: 'ip-address', matchValue: '192.168.*.*' }] }], ctx), 'https://i');
  assert.equal(match([{ longUrl: 'https://i', conditions: [{ type: 'ip-address', matchValue: '10.0.0.0/8' }] }], ctx), null);
});

test('ip-address：IP 缺失或非法 → 不匹配且不抛错', () => {
  const ctx = ctxOf({ ip: null });
  assert.equal(match([{ longUrl: 'https://i', conditions: [{ type: 'ip-address', matchValue: '0.0.0.0/0' }] }], ctx), null);
  const bad = ctxOf({ ip: 'not-an-ip' });
  assert.equal(match([{ longUrl: 'https://i', conditions: [{ type: 'ip-address', matchValue: '0.0.0.0/0' }] }], bad), null);
});

test('geolocation-country-code：只有 CN 命中', () => {
  const geo = () => ({ province: 'Guangdong', provinceZh: '广东' });
  const ctx = ctxOf({ ip: '1.2.3.4', geoLookup: geo });
  assert.equal(match([{ longUrl: 'https://g', conditions: [{ type: 'geolocation-country-code', matchValue: 'CN' }] }], ctx), 'https://g');
  assert.equal(match([{ longUrl: 'https://g', conditions: [{ type: 'geolocation-country-code', matchValue: 'US' }] }], ctx), null);
});

test('geolocation-city-name：英文名与中文名都能匹配，忽略大小写', () => {
  const geo = () => ({ province: 'Guangdong', provinceZh: '广东' });
  const ctx = ctxOf({ ip: '1.2.3.4', geoLookup: geo });
  assert.equal(match([{ longUrl: 'https://g', conditions: [{ type: 'geolocation-city-name', matchValue: 'Guangdong' }] }], ctx), 'https://g');
  assert.equal(match([{ longUrl: 'https://g', conditions: [{ type: 'geolocation-city-name', matchValue: 'guangdong' }] }], ctx), 'https://g');
  assert.equal(match([{ longUrl: 'https://g', conditions: [{ type: 'geolocation-city-name', matchValue: '广东' }] }], ctx), 'https://g');
  assert.equal(match([{ longUrl: 'https://g', conditions: [{ type: 'geolocation-city-name', matchValue: 'Beijing' }] }], ctx), null);
});

test('geolocation：查不到地理 → 不匹配', () => {
  const ctx = ctxOf({ ip: '8.8.8.8', geoLookup: () => null });
  assert.equal(match([{ longUrl: 'https://g', conditions: [{ type: 'geolocation-city-name', matchValue: 'Guangdong' }] }], ctx), null);
});

test('language：q≥0.9 才生效，zh 与 zh-CN 有别', () => {
  const c1 = buildContext({ query: {}, ua: '', now: 0, acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' });
  assert.equal(match([{ longUrl: 'https://l', conditions: [{ type: 'language', matchValue: 'zh' }] }], c1), 'https://l');
  assert.equal(match([{ longUrl: 'https://l', conditions: [{ type: 'language', matchValue: 'zh-CN' }] }], c1), 'https://l');
  assert.equal(match([{ longUrl: 'https://l', conditions: [{ type: 'language', matchValue: 'en' }] }], c1), null);

  const c2 = buildContext({ query: {}, ua: '', now: 0, acceptLanguage: 'zh-CN;q=0.5' });
  assert.equal(match([{ longUrl: 'https://l', conditions: [{ type: 'language', matchValue: 'zh' }] }], c2), null);
});

test('language：* 与空 Accept-Language 不匹配', () => {
  const c1 = buildContext({ query: {}, ua: '', now: 0, acceptLanguage: '*' });
  assert.equal(match([{ longUrl: 'https://l', conditions: [{ type: 'language', matchValue: 'zh' }] }], c1), null);
  const c2 = buildContext({ query: {}, ua: '', now: 0, acceptLanguage: '' });
  assert.equal(match([{ longUrl: 'https://l', conditions: [{ type: 'language', matchValue: 'zh' }] }], c2), null);
});

test('before-date / after-date', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const ctx = ctxOf({ now });
  assert.equal(match([{ longUrl: 'https://d', conditions: [{ type: 'before-date', matchValue: '2026-12-31T00:00:00Z' }] }], ctx), 'https://d');
  assert.equal(match([{ longUrl: 'https://d', conditions: [{ type: 'before-date', matchValue: '2026-01-01T00:00:00Z' }] }], ctx), null);
  assert.equal(match([{ longUrl: 'https://d', conditions: [{ type: 'after-date', matchValue: '2026-01-01T00:00:00Z' }] }], ctx), 'https://d');
  assert.equal(match([{ longUrl: 'https://d', conditions: [{ type: 'after-date', matchValue: '2026-12-31T00:00:00Z' }] }], ctx), null);
});

test('一条规则内所有条件 AND：任一不满足则整条不匹配', () => {
  const ctx = ctxOf({ query: { src: 'a' }, ua: UA_IPHONE });
  const rules = [{
    longUrl: 'https://both',
    conditions: [
      { type: 'device', matchValue: 'mobile' },
      { type: 'query-param', matchKey: 'src', matchValue: 'a' },
    ],
  }];
  assert.equal(match(rules, ctx), 'https://both');
  rules[0].conditions[1].matchValue = 'b';
  assert.equal(match(rules, ctx), null);
});

test('空条件规则永不命中', () => {
  const ctx = ctxOf({});
  assert.equal(match([{ longUrl: 'https://never', conditions: [] }], ctx), null);
});

test('多条规则按 priority 升序，第一条命中即停', () => {
  const ctx = ctxOf({ query: { src: 'a' } });
  const rules = [
    { longUrl: 'https://p2', priority: 2, conditions: [{ type: 'query-param', matchKey: 'src', matchValue: 'a' }] },
    { longUrl: 'https://p1', priority: 1, conditions: [{ type: 'query-param', matchKey: 'src', matchValue: 'zzz' }] },
  ];
  assert.equal(match(rules, ctx), 'https://p2');
  rules.sort((a, b) => a.priority - b.priority);
  assert.equal(match(rules, ctx), 'https://p2');
});

test('都不命中 → 返回 null（调用方回落到默认长链）', () => {
  const ctx = ctxOf({});
  assert.equal(match([{ longUrl: 'https://x', conditions: [{ type: 'device', matchValue: 'ios' }] }], ctx), null);
});

test('未知条件类型 → 不匹配且不抛错', () => {
  const ctx = ctxOf({});
  assert.equal(match([{ longUrl: 'https://x', conditions: [{ type: 'nope', matchValue: 'v' }] }], ctx), null);
});

test('parseUserAgent：空 UA → 无设备无浏览器', () => {
  const ua = parseUserAgent('');
  assert.deepEqual(ua.devices, []);
  assert.equal(ua.browser, null);
});
