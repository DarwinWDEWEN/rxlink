// 动态跳转规则求值（纯函数、零依赖、可单测）
// 口径对齐 shlink module/Core/src/RedirectRule/Entity/RedirectCondition.php 的 matchesRequest()。
//
// 语义要点：
//   * 一条规则内所有条件 AND；空条件规则永不命中（shlink 的 conditions->count() > 0 判断）
//   * 规则按 priority 升序，第一条命中即用它的 longUrl
//   * 单条条件求值抛错 → 该条件判为不匹配，不中断整条规则链
//
// geo 依赖是注入的（geoLookup），本文件不读二进制，便于独立单测。

const ipmat = require('./ipmat');

const DEVICE_VALUES = ['android', 'ios', 'mobile', 'windows', 'macos', 'linux', 'chromeos', 'desktop'];
const BROWSER_VALUES = ['chrome', 'firefox', 'edge', 'safari', 'opera', 'android_browser'];

// UA → 设备集合 + 浏览器名。口径对齐 shlink 的 DeviceType::matchFromUserAgent / Browser::matchFromUserAgent。
function parseUserAgent(ua) {
  const s = typeof ua === 'string' ? ua : '';
  const devices = [];
  let browser = null;

  const isIos = /iPhone|iPad|iPod/i.test(s);
  const isAndroid = /Android/i.test(s);
  const isWindows = /Windows/i.test(s);
  const isMac = /Macintosh|Mac OS X/i.test(s);
  const isLinux = /Linux/i.test(s) && !isAndroid;
  const isChromeOs = /CrOS/i.test(s);

  if (isIos) devices.push('ios', 'mobile');
  else if (isAndroid) devices.push('android', 'mobile');
  else if (isChromeOs) devices.push('chromeos', 'desktop');
  else if (isWindows) devices.push('windows', 'desktop');
  else if (isMac) devices.push('macos', 'desktop');
  else if (isLinux) devices.push('linux', 'desktop');

  // 浏览器判定放在 ChromeOS/Android 判定之前：Android 自带浏览器要单独识别
  if (/Android.*Version\/[\d.]+.*Safari/i.test(s) || /Android.*Chrome/i.test(s) === false && /Android.*Safari/i.test(s)) {
    browser = 'android_browser';
  } else if (/Edg\//i.test(s)) {
    browser = 'edge';
  } else if (/OPR\/|Opera/i.test(s)) {
    browser = 'opera';
  } else if (/Chrome\//i.test(s) || /CriOS\//i.test(s)) {
    browser = 'chrome';
  } else if (/Firefox\//i.test(s) || /FxiOS\//i.test(s)) {
    browser = 'firefox';
  } else if (/Safari\//i.test(s)) {
    browser = 'safari';
  }

  // Android 上跑 Chrome 仍是 chrome；只有「原生 Android 浏览器」才是 android_browser
  if (browser === 'android_browser' && /Chrome\//i.test(s)) browser = 'chrome';

  return { devices, browser };
}

// Accept-Language → 语言标签数组（只取 q >= 0.9），口径对齐 shlink acceptLanguageToLocales(minQuality: 0.9)
function parseAcceptLanguage(header) {
  const s = typeof header === 'string' ? header.trim() : '';
  if (!s || s === '*') return [];
  const out = [];
  for (const part of s.split(',')) {
    const bits = part.trim().split(';');
    const tag = (bits[0] || '').trim();
    if (!tag || tag === '*') continue;
    let q = 1;
    for (const b of bits.slice(1)) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(b);
      if (m) q = Number(m[1]);
    }
    if (q >= 0.9) out.push(tag);
  }
  return out;
}

// 省名归一：小写 + 去空格（让 'Guangdong' 与 ' 广东 ' 归一到同一个 key）
function normalizeName(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
}

function buildContext(input) {
  const opts = input || {};
  const ua = typeof opts.ua === 'string' ? opts.ua : '';
  const parsed = parseUserAgent(ua);
  const geoLookup = typeof opts.geoLookup === 'function' ? opts.geoLookup : () => null;
  let geo = null;
  if (opts.ip) {
    try {
      geo = geoLookup(opts.ip) || null;
    } catch {
      geo = null;
    }
  }
  return {
    query: opts.query && typeof opts.query === 'object' ? opts.query : {},
    ua,
    ip: opts.ip || null,
    now: typeof opts.now === 'number' ? opts.now : Date.now(),
    devices: parsed.devices,
    browser: parsed.browser,
    acceptLanguages: parseAcceptLanguage(opts.acceptLanguage),
    geo,
  };
}

function matchDevice(cond, ctx) {
  const v = String(cond.matchValue || '');
  if (!DEVICE_VALUES.includes(v)) return false;
  return ctx.devices.includes(v);
}

function matchBrowser(cond, ctx) {
  const v = String(cond.matchValue || '');
  if (!BROWSER_VALUES.includes(v)) return false;
  return ctx.browser === v;
}

function matchLanguage(cond, ctx) {
  const target = String(cond.matchValue || '');
  if (!target) return false;
  const [tLang, tCountry] = target.split('-');
  const tl = normalizeName(tLang);
  const tc = tCountry ? normalizeName(tCountry) : null;
  for (const tag of ctx.acceptLanguages) {
    const [lang, country] = tag.split('-');
    if (normalizeName(lang) !== tl) continue;
    if (tc === null) return true;
    if (country && normalizeName(country) === tc) return true;
  }
  return false;
}

function matchQueryParam(cond, ctx) {
  if (!cond.matchKey) return false;
  const v = ctx.query[cond.matchKey];
  return v !== undefined && v === String(cond.matchValue);
}

function matchAnyValueQueryParam(cond, ctx) {
  if (!cond.matchKey) return false;
  return Object.prototype.hasOwnProperty.call(ctx.query, cond.matchKey);
}

function matchValuelessQueryParam(cond, ctx) {
  if (!cond.matchKey) return false;
  if (!Object.prototype.hasOwnProperty.call(ctx.query, cond.matchKey)) return false;
  const v = ctx.query[cond.matchKey];
  return v === '' || v === undefined || v === null;
}

function matchIpAddress(cond, ctx) {
  if (!ctx.ip) return false;
  const groups = String(cond.matchValue || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!groups.length) return false;
  return ipmat.ipMatchesGroups(ctx.ip, groups);
}

function matchGeoCountry(cond, ctx) {
  if (!ctx.geo) return false;
  // 我们只出中国：geo 查到即代表该 IP 落在中国境内
  return normalizeName(cond.matchValue) === 'cn';
}

function matchGeoCity(cond, ctx) {
  if (!ctx.geo) return false;
  const target = normalizeName(cond.matchValue);
  if (!target) return false;
  return target === normalizeName(ctx.geo.province) || target === normalizeName(ctx.geo.provinceZh);
}

function matchBeforeDate(cond, ctx) {
  const t = Date.parse(String(cond.matchValue || ''));
  if (Number.isNaN(t)) return false;
  return ctx.now < t;
}

function matchAfterDate(cond, ctx) {
  const t = Date.parse(String(cond.matchValue || ''));
  if (Number.isNaN(t)) return false;
  return ctx.now > t;
}

const MATCHERS = {
  device: matchDevice,
  browser: matchBrowser,
  language: matchLanguage,
  'query-param': matchQueryParam,
  'any-value-query-param': matchAnyValueQueryParam,
  'valueless-query-param': matchValuelessQueryParam,
  'ip-address': matchIpAddress,
  'geolocation-country-code': matchGeoCountry,
  'geolocation-city-name': matchGeoCity,
  'before-date': matchBeforeDate,
  'after-date': matchAfterDate,
};

function matchCondition(cond, ctx) {
  if (!cond || typeof cond !== 'object') return false;
  const fn = MATCHERS[cond.type];
  if (!fn) return false;
  try {
    return fn(cond, ctx) === true;
  } catch {
    // 单条条件出错不该让整条规则链崩掉
    return false;
  }
}

// rules: [{longUrl, priority?, conditions: [...]}] → 命中的 longUrl 或 null
function evaluate(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const ordered = rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const pa = Number.isFinite(a.r.priority) ? a.r.priority : a.i + 1;
      const pb = Number.isFinite(b.r.priority) ? b.r.priority : b.i + 1;
      return pa - pb || a.i - b.i;
    });
  for (const { r } of ordered) {
    const conditions = Array.isArray(r.conditions) ? r.conditions : [];
    if (conditions.length === 0) continue; // 空条件规则永不命中
    let all = true;
    for (const c of conditions) {
      if (!matchCondition(c, ctx)) { all = false; break; }
    }
    if (all) return r.longUrl;
  }
  return null;
}

module.exports = {
  buildContext,
  matchCondition,
  evaluate,
  parseUserAgent,
  parseAcceptLanguage,
  normalizeName,
  DEVICE_VALUES,
  BROWSER_VALUES,
};
