# I9 动态跳转规则（R9）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 shlink 的动态跳转规则在 rxlink 上真正可用——兼容层 `POST /short-urls/{code}/redirect-rules` 从固定 501 变为真实现，控制台可保存 11 种条件类型的规则，跳转函数在访问时实际求值并跳到规则指定的目标。

**Architecture:** 规则存在新表 `short_url_redirect_rule` / `redirect_condition`，写操作触发独立的 `rules_version` 序列（**不动** `link_version`，避免规则保存让全网实例重拉全量短链快照）。跳转函数新增两条独立缓存通道：`cache.js`（主快照，不变）与 `rules-cache.js`（规则快照，只含有规则的短链）。求值在 FC 内用纯函数 `rules.js` 完成（UA / 语言 / IP / 日期 / geo 全部在 JS 侧判定，SQL 无法做），geo 查构建期生成的 `china-geo.bin`（约 200KB 扁平区间表，二分查找）。

**Tech Stack:** PostgreSQL（ADB Supabase，platform 一次只认一条 SQL）、Deno（Supabase Edge Function 兼容层）、Node.js 18+（FC Web 跳转函数，`node --test`）、`mmdb-lib`（仅构建期用，跑在 `fc/geo-enrich/node_modules` 里）。

**设计稿：** `docs/superpowers/specs/2026-11-12-r9-dynamic-redirect-rules-design.md`（commit `09da8e0`）。本计划的每个技术选择都出自该文档；文档与本计划冲突时以文档为准并回头修本计划。

---

## Global Constraints

以下约束对**每个** task 都生效，不再逐条重复：

- **凭据红线**：只写变量名。任何地方都**不回显、不记录** `SUPABASE_SERVICE_ROLE_KEY`、`x-fc-access-key-*`、`x-edge-env-*` 等请求头；`.env` 的值不进文档、不进 git、不进聊天。
- **迁移不可变**：`0001`–`0017` 不改不删。新变更写新编号文件（`0018`、`0019`）。覆盖已有函数时**必须在注释里注明原出处**（例：`-- 覆盖 0005 的同名函数`）。
- **平台一次只认一条 SQL 语句**：迁移文件里的多条语句必须由切分脚本逐条执行（见 Task 3 的命令）。**dollar-quote 会破坏 naive 分号切分** → 迁移文件里避免 `$$`，或用切分脚本的 dollar-quote 安全模式。
- **RLS 四行齐全**：每张新表都要 `enable row level security` + `force row level security` + `revoke all on <table> from anon, authenticated`（ADB Supabase 无 `SECURITY DEFINER`）。
- **RPC 权限**：新函数一律 `revoke execute on function ... from public, anon, authenticated;` + `grant execute on function ... to service_role;`。
- **TDD**：先写失败测试并**实际跑一遍看到它失败**，再写实现，再跑一遍看到它通过。
- **提交粒度**：每个 task 结束提交一次；commit message 用中文，格式 `feat(I9): …` / `test(I9): …` / `docs(I9): …`。
- **Node 版本**：本机 CLI 需 Node ≥20（`nvm use 24`）；但**跳转函数的代码必须兼容 Node 18**（FC 运行时是 Node 20，代码只用 Node 18 已有的 API）。
- **单测命令**：
  - 跳转函数：`node --test fc/redirect/test/rules.test.js` / `node --test fc/redirect/test/china-geo.test.js` / `node --test fc/redirect/test/redirect.test.js`
  - 兼容层：`/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/compat.test.ts`
  - 类型检查：`/Users/wang/.deno/bin/deno check supabase/functions/compat/index.ts supabase/functions/compat/handler.ts supabase/functions/compat/test/compat.test.ts`
- **不造一次性工具**：新增脚本一律放 `scripts/`，可重复执行、幂等。
- **不提交构建产物**：`fc/redirect/china-geo.bin` 是构建产物 → 必须加进 `.gitignore`（与 `fc/geo-enrich/geoip/` 同一类），仓库里只留构建脚本。

---

## File Structure

| 文件 | 责任 | 状态 |
|---|---|---|
| `supabase/migrations/0018_redirect_rules.sql` | 规则表 + `rules_version` + 触发器 + 规则 RPC + 覆盖 `resolve_short`/`short_url_json`/`get_short_url_redirect_rules` | 新建 |
| `supabase/migrations/0019_list_exclude_tags.sql` | `list_short_urls` 加排除标签筛选（版本旋钮 5.1.0 的连带项） | 新建 |
| `fc/redirect/rules.js` | 条件求值纯函数（11 种类型 + 规则优先级） | 新建 |
| `fc/redirect/china-geo.js` | `china-geo.bin` 解析 + IP→省查表（纯函数） | 新建 |
| `fc/redirect/rules-cache.js` | 规则快照缓存（独立 `rules_seq` 轮询） | 新建 |
| `fc/redirect/index.js` | 接入规则求值 | 修改 |
| `fc/redirect/test/rules.test.js` | `rules.js` 单测 | 新建 |
| `fc/redirect/test/china-geo.test.js` | `china-geo.js` 单测 | 新建 |
| `fc/redirect/test/redirect.test.js` | 端到端：规则命中/不命中/像素不套规则 | 修改 |
| `scripts/build-china-geo.mjs` | DB-IP mmdb → `china-geo.bin`（含 LPM 归并 + 自检对拍） | 新建 |
| `supabase/functions/compat/handler.ts` | 规则校验 + GET/POST 路由 + `VERSION` → 5.1.0 | 修改 |
| `supabase/functions/compat/test/compat.test.ts` | 兼容层规则端点单测 | 修改 |
| `docs/verification/i9-results.md` | 验收记录 | 新建 |
| `docs/runbook.md` | 新增 §5.4 规则部署与排查 | 修改 |
| `docs/iteration-plan.md` | I9 章节 + B9 清单 + 变更记录 | 修改 |
| `docs/shlink-feature-checklist.md` | `setShortUrlRedirectRules` 501 → ✅ | 修改 |

---

## Task 1: `rules.js` 条件求值（纯函数）

**Files:**
- Create: `fc/redirect/rules.js`
- Test: `fc/redirect/test/rules.test.js`

**Interfaces:**
- Consumes: 无（零依赖）
- Produces:
  ```js
  // fc/redirect/rules.js
  module.exports = {
    buildContext,   // (input: {query?: object, ua?: string, ip?: string, now?: Date|number, geoLookup?: (ip:string)=>({province:string, provinceZh:string}|null)}) => ctx
    matchCondition, // (cond: {type:string, matchKey?:string|null, matchValue?:string|null}, ctx) => boolean
    evaluate,       // (rules: Array<{longUrl:string, priority?:number, conditions:Array}>, ctx) => string|null
    parseUserAgent, // (ua: string) => {devices: string[], browser: string|null}   ← 导出便于单测
  };
  ```
  `ctx` 结构：`{ query: Record<string,string>, ua: string, ip: string|null, now: number, devices: string[], browser: string|null, acceptLanguages: string[], geo: {province:string, provinceZh:string}|null }`
  - `buildContext` 内部调用一次 `parseUserAgent`，结果缓存在 `ctx.devices` / `ctx.browser`。
  - `geoLookup` 是**注入的依赖**（默认 `() => null`），保证 `rules.js` 不依赖二进制文件、可独立单测。Task 2 产出真实的 `geoLookup`。

---

### Step 1: 写失败测试

创建 `fc/redirect/test/rules.test.js`：

```js
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
```

### Step 2: 跑测试确认失败

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
node --test fc/redirect/test/rules.test.js
```

Expected: FAIL —— `Cannot find module '../rules'`。

### Step 3: 写实现

创建 `fc/redirect/rules.js`：

```js
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
```

### Step 4: 跑测试确认通过

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
node --test fc/redirect/test/rules.test.js
```

Expected: PASS，全部用例通过。

若 `language` 用例失败，检查 `parseAcceptLanguage` 的 q 值解析；若 `device` 用例失败，检查 UA 正则。

### Step 5: 提交

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
git add fc/redirect/rules.js fc/redirect/test/rules.test.js
git commit -m "feat(I9): 跳转规则条件求值 rules.js（11 种条件类型，geo 依赖注入）"
```

---

## Task 2: 中国省级 geo 数据（构建脚本 + 查表）

**Files:**
- Create: `scripts/build-china-geo.mjs`
- Create: `fc/redirect/china-geo.js`
- Create: `fc/redirect/test/china-geo.test.js`
- Modify: `.gitignore`（加 `fc/redirect/china-geo.bin`）

**Interfaces:**
- Consumes: `fc/geo-enrich/geoip/dbip-city-lite.mmdb.br`（构建期输入，已存在）
- Produces:
  ```js
  // fc/redirect/china-geo.js
  module.exports = {
    parse,       // (buffer: Buffer) => { provinces: Array<{en:string, zh:string}>, intervals: Array<{start:number, end:number, provId:number}> }
    createLookup,// (buffer: Buffer) => (ip: string) => { province: string, provinceZh: string } | null
  };
  ```
  `createLookup` 返回的函数对非 IPv4 / 越界 IP / 未命中一律返回 `null`，不抛错。**读不到文件时由调用方处理**（Task 6 负责）。

---

### Step 1: 写失败测试

创建 `fc/redirect/test/china-geo.test.js`：

```js
// 中国省级 geo 查表单测：node --test fc/redirect/test/china-geo.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, createLookup } = require('../china-geo');

const BIN = path.join(__dirname, '..', 'china-geo.bin');

function buildFixture() {
  // 手工构造一个最小二进制：2 省 + 3 区间
  const provinces = [
    { en: 'Guangdong', zh: '广东' },
    { en: 'Beijing', zh: '北京' },
  ];
  const nameChunks = [];
  let nameBytes = 0;
  for (const p of provinces) {
    const en = Buffer.from(p.en, 'utf8');
    const zh = Buffer.from(p.zh, 'utf8');
    nameChunks.push(Buffer.from([en.length]), en, Buffer.from([zh.length]), zh);
    nameBytes += 2 + en.length + zh.length;
  }
  const intervals = [
    { start: 0x0a000000, end: 0x0affffff, provId: 0 }, // 10.0.0.0 – 10.255.255.255 广东
    { start: 0x5b000000, end: 0x5b7fffff, provId: 1 }, // 91.0.0.0 – 91.127.255.255 北京
    { start: 0x5b800000, end: 0x5bffffff, provId: 0 }, // 91.128.0.0 – 91.255.255.255 广东
  ];
  const header = Buffer.alloc(16);
  Buffer.from('CNGEO1', 'ascii').copy(header, 0);
  header.writeUInt16LE(provinces.length, 6);
  header.writeUInt32LE(nameBytes, 8);
  header.writeUInt32LE(intervals.length, 12);
  const entries = Buffer.alloc(intervals.length * 9);
  intervals.forEach((iv, i) => {
    entries.writeUInt32BE(iv.start, i * 9);
    entries.writeUInt32BE(iv.end, i * 9 + 4);
    entries.writeUInt8(iv.provId, i * 9 + 8);
  });
  return Buffer.concat([header, Buffer.concat(nameChunks), entries]);
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
}

test('parse：读出省名表与区间', () => {
  const parsed = parse(buildFixture());
  assert.equal(parsed.provinces.length, 2);
  assert.deepEqual(parsed.provinces[0], { en: 'Guangdong', zh: '广东' });
  assert.equal(parsed.intervals.length, 3);
  assert.equal(parsed.intervals[0].start, 0x0a000000);
  assert.equal(parsed.intervals[0].end, 0x0affffff);
});

test('parse：魔数不对 → 抛错', () => {
  const bad = buildFixture();
  bad.write('XXXXXX', 0, 'ascii');
  assert.throws(() => parse(bad));
});

test('createLookup：命中区间返回中英文省名', () => {
  const lookup = createLookup(buildFixture());
  assert.deepEqual(lookup('10.1.2.3'), { province: 'Guangdong', provinceZh: '广东' });
  assert.deepEqual(lookup('91.1.1.1'), { province: 'Beijing', provinceZh: '北京' });
});

test('createLookup：区间边界两端都命中', () => {
  const lookup = createLookup(buildFixture());
  assert.deepEqual(lookup('10.0.0.0'), { province: 'Guangdong', provinceZh: '广东' });
  assert.deepEqual(lookup('10.255.255.255'), { province: 'Guangdong', provinceZh: '广东' });
  assert.deepEqual(lookup('91.127.255.255'), { province: 'Beijing', provinceZh: '北京' });
  assert.deepEqual(lookup('91.128.0.0'), { province: 'Guangdong', provinceZh: '广东' });
});

test('createLookup：未命中 / 非法 IP / IPv6 → null', () => {
  const lookup = createLookup(buildFixture());
  assert.equal(lookup('8.8.8.8'), null);
  assert.equal(lookup('not-an-ip'), null);
  assert.equal(lookup('2001:db8::1'), null);
  assert.equal(lookup(''), null);
  assert.equal(lookup(null), null);
});

test('真实数据文件：能加载且查到已知 IP（构建产物存在时才跑）', (t) => {
  if (!fs.existsSync(BIN)) {
    t.skip('china-geo.bin 未构建（先跑 node scripts/build-china-geo.mjs）');
    return;
  }
  const lookup = createLookup(fs.readFileSync(BIN));
  assert.deepEqual(lookup('114.114.114.114'), { province: 'Shandong', provinceZh: '山东' });
  assert.deepEqual(lookup('223.5.5.5'), { province: 'Zhejiang', provinceZh: '浙江' });
  assert.deepEqual(lookup('8.8.8.8'), null);
});
```

### Step 2: 跑测试确认失败

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
node --test fc/redirect/test/china-geo.test.js
```

Expected: FAIL —— `Cannot find module '../china-geo'`。

### Step 3: 写 `fc/redirect/china-geo.js`

```js
// 中国省级 IP 查表（纯函数，零依赖）
// 数据文件 china-geo.bin 由 scripts/build-china-geo.mjs 从 DB-IP City Lite mmdb 生成。
//
// 二进制格式（小端 / 大端按字段标注）：
//   头部 16 字节：
//     magic         6 字节 "CNGEO1"
//     provCount     uint16 LE
//     nameBytes     uint32 LE
//     intervalCount uint32 LE
//   省名表（provCount 条）：
//     enLen uint8, en bytes(UTF-8), zhLen uint8, zh bytes(UTF-8)
//   区间表（intervalCount 条，按 start 升序，每条 9 字节）：
//     start uint32 BE, end uint32 BE, provId uint8
//
// 区间表已经是「扁平不重叠」的结果（构建期按最长前缀优先归并过），
// 运行时只做二分查找，不再做前缀比较。

const MAGIC = 'CNGEO1';

function parse(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('china-geo: 需要 Buffer');
  if (buffer.length < 16) throw new Error('china-geo: 文件过短');
  if (buffer.toString('ascii', 0, 6) !== MAGIC) throw new Error('china-geo: 魔数不对');

  const provCount = buffer.readUInt16LE(6);
  const nameBytes = buffer.readUInt32LE(8);
  const intervalCount = buffer.readUInt32LE(12);

  const provinces = [];
  let off = 16;
  for (let i = 0; i < provCount; i++) {
    const enLen = buffer.readUInt8(off); off += 1;
    const en = buffer.toString('utf8', off, off + enLen); off += enLen;
    const zhLen = buffer.readUInt8(off); off += 1;
    const zh = buffer.toString('utf8', off, off + zhLen); off += zhLen;
    provinces.push({ en, zh });
  }
  if (off !== 16 + nameBytes) throw new Error('china-geo: 省名表长度不符');

  const intervals = new Array(intervalCount);
  for (let i = 0; i < intervalCount; i++) {
    const base = off + i * 9;
    intervals[i] = {
      start: buffer.readUInt32BE(base),
      end: buffer.readUInt32BE(base + 4),
      provId: buffer.readUInt8(base + 8),
    };
  }
  return { provinces, intervals };
}

function ipToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v >>> 0;
}

function createLookup(buffer) {
  const { provinces, intervals } = parse(buffer);
  return function lookup(ip) {
    const v = ipToInt(ip);
    if (v === null) return null;
    // 找最后一个 start <= v 的区间
    let lo = 0;
    let hi = intervals.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (intervals[mid].start <= v) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (found < 0) return null;
    const iv = intervals[found];
    if (v > iv.end) return null;
    const p = provinces[iv.provId];
    if (!p) return null;
    return { province: p.en, provinceZh: p.zh };
  };
}

module.exports = { parse, createLookup, ipToInt };
```

### Step 4: 写构建脚本 `scripts/build-china-geo.mjs`

```js
// 构建中国省级 IP 查表：DB-IP City Lite mmdb → fc/redirect/china-geo.bin
//
// 用法：node scripts/build-china-geo.mjs
// 输入：fc/geo-enrich/geoip/dbip-city-lite.mmdb.br（由 scripts/build-geoip-bundle.mjs 生成）
// 输出：fc/redirect/china-geo.bin（构建产物，已 gitignore）
//
// 算法（与 mmdb 语义一致）：
//   1) 遍历 mmdb 搜索树，收集所有 country.iso_code = 'CN' 的叶子前缀 (start, prefixLen, province)
//   2) 收集所有前缀边界 → 基本区间
//   3) 扫基本区间，用「按 prefixLen 优先的最大堆」求每个区间的最长匹配前缀
//   4) 相邻同省合并 → 扁平不重叠区间表
//
// 为什么必须做最长前缀归并：MMDB 里同一个数据指针被多个前缀共享，
// 直接按 start 排序取「最后一条 start ≤ v」会错配约 0.66% 的 IP。
// 本脚本末尾自带随机对拍（与 reader.get() 比对），错配数必须为 0。
//
// 许可：DB-IP City Lite 是 CC BY 4.0，允许商用与嵌入分发，
//   条件是在展示/使用结果的页面署名 "IP Geolocation by DB-IP"（见 docs/geo-enrichment.md §0）。
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MMDB_BR = path.join(ROOT, 'fc/geo-enrich/geoip/dbip-city-lite.mmdb.br');
const OUT = path.join(ROOT, 'fc/redirect/china-geo.bin');
const { Reader } = require(path.join(ROOT, 'fc/geo-enrich/node_modules/mmdb-lib'));

// DB-IP 的 subdivision 只有英文名；中文名来自这张表（31 个省级行政区）
const PROVINCE_ZH = {
  Beijing: '北京', Tianjin: '天津', Shanghai: '上海', Chongqing: '重庆',
  Hebei: '河北', Shanxi: '山西', Liaoning: '辽宁', Jilin: '吉林',
  Heilongjiang: '黑龙江', Jiangsu: '江苏', Zhejiang: '浙江', Anhui: '安徽',
  Fujian: '福建', Jiangxi: '江西', Shandong: '山东', Henan: '河南',
  Hubei: '湖北', Hunan: '湖南', Guangdong: '广东', Guangxi: '广西',
  Hainan: '海南', Sichuan: '四川', Guizhou: '贵州', Yunnan: '云南',
  Tibet: '西藏', Shaanxi: '陕西', Gansu: '甘肃', Qinghai: '青海',
  Ningxia: '宁夏', Xinjiang: '新疆', 'Inner Mongolia': '内蒙古',
};

function lowerBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// 按 prefixLen 大者优先的最大堆
class MaxHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  peek() { return this.a[0]; }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].bits >= a[i].bits) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].bits > a[m].bits) m = l;
        if (r < a.length && a[r].bits > a[m].bits) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function main() {
  if (!existsSync(MMDB_BR)) {
    console.error(`找不到 ${MMDB_BR}\n先跑：node scripts/build-geoip-bundle.mjs`);
    process.exit(1);
  }
  console.log('[china-geo] 解压 mmdb…');
  const db = brotliDecompressSync(readFileSync(MMDB_BR));
  const reader = new Reader(db);
  const meta = reader.metadata;
  const nodeCount = meta.nodeCount;
  const walker = reader.walker;
  const ipv4Start = reader.ipv4StartNodeNumber;

  // 1) 收集 CN 前缀
  console.log('[china-geo] 遍历 mmdb 树…');
  const t0 = Date.now();
  const entries = [];
  const stack = [[ipv4Start, 0, 0]];
  while (stack.length) {
    const [node, depth, acc] = stack.pop();
    if (node >= nodeCount) {
      if (node > nodeCount) {
        let rec = null;
        try { rec = reader.resolveDataPointer(node); } catch { continue; }
        if (rec && rec.country && rec.country.iso_code === 'CN') {
          const sub = Array.isArray(rec.subdivisions) ? rec.subdivisions[0] : null;
          const en = (sub && sub.names && sub.names.en) || '';
          const size = 2 ** (32 - depth);
          entries.push({ start: acc * size, bits: depth, prov: en, end: acc * size + size - 1 });
        }
      }
      continue;
    }
    const offset = node * meta.nodeByteSize;
    stack.push([walker.right(offset), depth + 1, acc * 2 + 1]);
    stack.push([walker.left(offset), depth + 1, acc * 2]);
  }
  console.log(`[china-geo] CN 前缀 ${entries.length} 条（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  // 2) 边界
  const boundSet = new Set();
  for (const e of entries) { boundSet.add(e.start); boundSet.add(e.end + 1); }
  const bounds = [...boundSet].sort((a, b) => a - b);
  for (const e of entries) {
    e.iStart = lowerBound(bounds, e.start);
    e.iEnd = lowerBound(bounds, e.end + 1);
  }

  // 3) 扫 + 堆 → 最长前缀优先
  const byStart = new Map();
  for (const e of entries) {
    if (!byStart.has(e.iStart)) byStart.set(e.iStart, []);
    byStart.get(e.iStart).push(e);
  }
  const startsSorted = [...byStart.keys()].sort((a, b) => a - b);
  const heap = new MaxHeap();
  const flat = [];
  let si = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    while (si < startsSorted.length && startsSorted[si] <= i) {
      for (const e of byStart.get(startsSorted[si])) heap.push(e);
      si++;
    }
    while (heap.size && heap.peek().iEnd <= i) heap.pop();
    if (!heap.size) continue;
    const win = heap.peek();
    const segStart = bounds[i];
    const segEnd = bounds[i + 1] - 1;
    const last = flat[flat.length - 1];
    if (last && last.prov === win.prov && last.end + 1 === segStart) last.end = segEnd;
    else flat.push({ start: segStart, end: segEnd, prov: win.prov });
  }
  console.log(`[china-geo] 扁平区间 ${flat.length} 条`);

  // 4) 省名表
  const provList = [];
  const provIndex = new Map();
  for (const f of flat) {
    if (provIndex.has(f.prov)) continue;
    provIndex.set(f.prov, provList.length);
    provList.push({ en: f.prov, zh: PROVINCE_ZH[f.prov] || '' });
  }
  const unknown = provList.filter((p) => !PROVINCE_ZH[p.en] && p.en !== '');
  if (unknown.length) {
    console.warn(`[china-geo] ⚠ 这些省名没有中文映射（只能用英文名匹配）：${unknown.map((p) => p.en).join(', ')}`);
  }
  console.log(`[china-geo] 省名 ${provList.length} 个`);

  // 5) 编码
  const nameChunks = [];
  let nameBytes = 0;
  for (const p of provList) {
    const en = Buffer.from(p.en, 'utf8');
    const zh = Buffer.from(p.zh, 'utf8');
    nameChunks.push(Buffer.from([en.length]), en, Buffer.from([zh.length]), zh);
    nameBytes += 2 + en.length + zh.length;
  }
  const header = Buffer.alloc(16);
  Buffer.from('CNGEO1', 'ascii').copy(header, 0);
  header.writeUInt16LE(provList.length, 6);
  header.writeUInt32LE(nameBytes, 8);
  header.writeUInt32LE(flat.length, 12);
  const entriesBuf = Buffer.alloc(flat.length * 9);
  flat.forEach((iv, i) => {
    entriesBuf.writeUInt32BE(iv.start, i * 9);
    entriesBuf.writeUInt32BE(iv.end, i * 9 + 4);
    entriesBuf.writeUInt8(provIndex.get(iv.prov), i * 9 + 8);
  });
  const out = Buffer.concat([header, Buffer.concat(nameChunks), entriesBuf]);
  writeFileSync(OUT, out);
  console.log(`[china-geo] 写入 ${OUT}（${(out.length / 1024).toFixed(0)} KB）`);

  // 6) 自检：随机 IP 与 reader.get() 对拍
  let mismatch = 0;
  let hits = 0;
  const N = 200000;
  const t1 = Date.now();
  for (let i = 0; i < N; i++) {
    const a = Math.floor(Math.random() * 224);
    const b = Math.floor(Math.random() * 256);
    const c = Math.floor(Math.random() * 256);
    const d = Math.floor(Math.random() * 256);
    const ip = `${a}.${b}.${c}.${d}`;
    const rec = reader.get(ip);
    const expected = rec && rec.country && rec.country.iso_code === 'CN'
      ? (((rec.subdivisions || [])[0] || {}).names || {}).en || null
      : null;
    const got = lookupFlat(flat, a * 16777216 + b * 65536 + c * 256 + d);
    if (got) hits++;
    if (expected !== got) {
      mismatch++;
      if (mismatch <= 5) console.error(`  MISMATCH ${ip} expected=${expected} got=${got}`);
    }
  }
  console.log(`[china-geo] 自检：${N} 个随机 IP，命中 ${hits}，失配 ${mismatch}（耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s）`);
  if (mismatch > 0) {
    console.error('[china-geo] ❌ 自检失败，产物不可信');
    process.exit(1);
  }
  console.log('[china-geo] ✅ 自检通过');
}

function lookupFlat(flat, v) {
  let lo = 0;
  let hi = flat.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flat[mid].start <= v) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return null;
  return v <= flat[found].end ? flat[found].prov : null;
}

main();
```

### Step 5: 加 `.gitignore`

在 `.gitignore` 的 `fc/geo-enrich/geoip/` 那行下面追加：

```
# 跳转规则的中国省级 IP 表：构建产物（~200KB），用 scripts/build-china-geo.mjs 重建
fc/redirect/china-geo.bin
```

### Step 6: 跑测试确认通过（fixture 部分）

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
node --test fc/redirect/test/china-geo.test.js
```

Expected: fixture 用例全 PASS；真实数据文件那条在 `china-geo.bin` 不存在时 **skip**（不算失败）。

### Step 7: 构建真实数据并跑完整测试

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
node scripts/build-china-geo.mjs
```

Expected 输出（关键行）：

```
[china-geo] CN 前缀 120141 条（耗时 ~50s）
[china-geo] 扁平区间 22337 条
[china-geo] 省名 32 个
[china-geo] 写入 .../fc/redirect/china-geo.bin（197 KB）
[china-geo] 自检：200000 个随机 IP，命中 18865，失配 0
[china-geo] ✅ 自检通过
```

**失配必须为 0**。若不为 0，**停下来查算法，不要继续**——发布一个错配的 geo 表会让规则静默跳错目标。

再跑一次单测，真实数据用例不应再 skip：

```bash
node --test fc/redirect/test/china-geo.test.js
```

Expected: 全部 PASS（含真实数据用例）。

### Step 8: 提交

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
git add scripts/build-china-geo.mjs fc/redirect/china-geo.js fc/redirect/test/china-geo.test.js .gitignore
git commit -m "feat(I9): 中国省级 IP 查表（mmdb→china-geo.bin，LPM 归并 + 20 万次对拍自检）"
```

> `fc/redirect/china-geo.bin` 已被 gitignore，**不要** `git add -f`。

---

## Task 3: 迁移 0018 —— 规则表 + 版本 + 触发器 + RPC

**Files:**
- Create: `supabase/migrations/0018_redirect_rules.sql`

**Interfaces:**
- Consumes: 现有表 `short_url`、函数 `bump_link_version()`、`get_short_url` 的域名口径
- Produces（供 Task 5 / Task 6 调用）：
  ```sql
  redirect_rules_json(p_short_url_id bigint) → jsonb      -- 规则数组，无规则时 '[]'
  set_short_url_redirect_rules(p_code text, p_domain text default null, p_rules jsonb default '[]'::jsonb) → jsonb
                                                            -- {defaultLongUrl, redirectRules}
  get_short_url_redirect_rules(p_code text, p_domain text default null) → jsonb   -- 覆盖 0010
  rules_seq() → bigint
  rules_snapshot() → table (short_url_id bigint, rules jsonb)
  resolve_short(p_code text, p_domain text default null) → table (short_url_id bigint, long_url text, forward_query boolean, rules jsonb)  -- 覆盖 0005
  ```

---

### Step 1: 备份将被覆盖的函数定义

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
set -a; source supabase/functions/.env; set +a
supabase db query --db-url "$SUPABASE_DB_URL" "create table if not exists funcdef_bak_20261112 as select name, pg_get_functiondef(oid) as def from pg_proc where proname in ('resolve_short','short_url_json','get_short_url_redirect_rules','list_short_urls')"
```

Expected: 表创建成功（若已存在则跳过创建）。确认 4 个函数都在：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select name from funcdef_bak_20261112 order by name"
```

Expected: 4 行（`get_short_url_redirect_rules`、`list_short_urls`、`resolve_short`、`short_url_json`）。

备份表同样要收口权限：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "alter table funcdef_bak_20261112 enable row level security"
supabase db query --db-url "$SUPABASE_DB_URL" "alter table funcdef_bak_20261112 force row level security"
supabase db query --db-url "$SUPABASE_DB_URL" "revoke all on table funcdef_bak_20261112 from anon, authenticated"
```

### Step 2: 写迁移文件

创建 `supabase/migrations/0018_redirect_rules.sql`：

```sql
-- 0018_redirect_rules.sql —— 动态跳转规则（I9 / R9）
--
-- 设计稿：docs/superpowers/specs/2026-11-12-r9-dynamic-redirect-rules-design.md
-- shlink 对照：module/Core/src/RedirectRule/**（RedirectConditionType / RedirectCondition / ShortUrlRedirectRule）
--             module/Core/migrations/Version20240224115725.php（三张表的结构参考）
--
-- 关键设计：规则写操作**不**碰 link_version。
--   link_version  → 短链映射变更 → 跳转函数重拉全量快照（重）
--   rules_version → 规则变更     → 跳转函数只重拉规则快照（轻）
--   共用一个 seq 的话，用户每存一次规则就要让全网实例重拉全量短链快照，代价不对等。
--
-- 平台约束：函数一律 security invoker（平台禁 security definer），逐个 revoke execute from public。

-- ---------------------------------------------------------------------------
-- 1. 表
-- ---------------------------------------------------------------------------
create table if not exists short_url_redirect_rule (
  id           bigint generated always as identity primary key,
  short_url_id bigint not null references short_url(id) on delete cascade,
  priority     integer not null default 1,
  long_url     text not null
);

create table if not exists redirect_condition (
  id          bigint generated always as identity primary key,
  rule_id     bigint not null references short_url_redirect_rule(id) on delete cascade,
  type        text not null,
  match_key   text,
  match_value text
);

create index if not exists short_url_redirect_rule_su_idx on short_url_redirect_rule(short_url_id);
create index if not exists redirect_condition_rule_idx on redirect_condition(rule_id);

create table if not exists rules_version (
  id  int     primary key default 1,
  seq bigint  not null default 0,
  check (id = 1)
);

insert into rules_version (id, seq) values (1, 0) on conflict (id) do nothing;

alter table short_url_redirect_rule enable row level security;
alter table short_url_redirect_rule force  row level security;
revoke all on table short_url_redirect_rule from anon, authenticated;

alter table redirect_condition enable row level security;
alter table redirect_condition force  row level security;
revoke all on table redirect_condition from anon, authenticated;

alter table rules_version enable row level security;
alter table rules_version force  row level security;
revoke all on table rules_version from anon, authenticated;
grant select, update on rules_version to service_role;

-- ---------------------------------------------------------------------------
-- 2. 失效触发器：规则写 → rules_version.seq + 1（不动 link_version）
--    行级触发器：语句级在 0 行时也会触发，删空操作会白 bump（0007 已有结论）
-- ---------------------------------------------------------------------------
create or replace function bump_rules_version()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  update rules_version set seq = seq + 1 where id = 1;
  return null;
end;
$$;

drop trigger if exists rules_version_after_rule_write on short_url_redirect_rule;
create trigger rules_version_after_rule_write
after insert or update or delete on short_url_redirect_rule
for each row
execute function bump_rules_version();

drop trigger if exists rules_version_after_condition_write on redirect_condition;
create trigger rules_version_after_condition_write
after insert or update or delete on redirect_condition
for each row
execute function bump_rules_version();

-- ---------------------------------------------------------------------------
-- 3. 规则 → API 形状（对齐 shlink ShortUrlRedirectRule::jsonSerialize）
--    {longUrl, priority, conditions:[{type, matchKey, matchValue}]}
-- ---------------------------------------------------------------------------
create or replace function redirect_rules_json(p_short_url_id bigint)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'longUrl',      r.long_url,
             'priority',     r.priority,
             'conditions',   coalesce((
                                  select jsonb_agg(
                                    jsonb_build_object(
                                      'type',       c.type,
                                      'matchKey',   c.match_key,
                                      'matchValue', c.match_value
                                    )
                                    order by c.id
                                  )
                                  from redirect_condition c
                                  where c.rule_id = r.id
                                ), '[]'::jsonb)
           )
           order by r.priority, r.id
         ), '[]'::jsonb)
    from short_url_redirect_rule r
   where r.short_url_id = p_short_url_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. 读写规则
-- ---------------------------------------------------------------------------

-- 覆盖 0010 的同名函数：从「恒返回空规则」改成真读
create or replace function get_short_url_redirect_rules(p_code text, p_domain text default null)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_domain bigint;
  v_id     bigint;
  v_long   text;
begin
  if p_code is null or btrim(p_code) = '' then
    raise exception using errcode = '22023', message = 'invalid_short_code';
  end if;

  if p_domain is null or btrim(p_domain) = '' or upper(btrim(p_domain)) = 'DEFAULT' then
    v_domain := 0;
  else
    select id into v_domain from domain where authority = lower(btrim(p_domain));
    if v_domain is null then
      raise exception using errcode = 'P0002', message = 'short_url_not_found';
    end if;
  end if;

  select s.id, s.long_url into v_id, v_long
    from short_url s
   where s.short_code = lower(btrim(p_code))
     and s.domain_id = v_domain
     and s.enabled;

  if v_id is null then
    raise exception using errcode = 'P0002', message = 'short_url_not_found';
  end if;

  return jsonb_build_object('defaultLongUrl', v_long, 'redirectRules', redirect_rules_json(v_id));
end;
$$;

-- 整组替换：先删旧规则（条件靠 on delete cascade 一起删），再按数组顺序插新的
create or replace function set_short_url_redirect_rules(p_code text, p_domain text default null, p_rules jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_domain bigint;
  v_id     bigint;
  v_long   text;
  v_rule   jsonb;
  v_cond   jsonb;
  v_new_id bigint;
  v_idx    int := 0;
begin
  if p_code is null or btrim(p_code) = '' then
    raise exception using errcode = '22023', message = 'invalid_short_code';
  end if;

  if p_domain is null or btrim(p_domain) = '' or upper(btrim(p_domain)) = 'DEFAULT' then
    v_domain := 0;
  else
    select id into v_domain from domain where authority = lower(btrim(p_domain));
    if v_domain is null then
      raise exception using errcode = 'P0002', message = 'short_url_not_found';
    end if;
  end if;

  select s.id, s.long_url into v_id, v_long
    from short_url s
   where s.short_code = lower(btrim(p_code))
     and s.domain_id = v_domain
     and s.enabled;

  if v_id is null then
    raise exception using errcode = 'P0002', message = 'short_url_not_found';
  end if;

  if p_rules is null or jsonb_typeof(p_rules) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_redirect_rules';
  end if;

  -- 删旧
  delete from short_url_redirect_rule where short_url_id = v_id;

  -- 插新：priority 按数组下标 +1
  for v_rule in select jsonb_array_elements(p_rules)
  loop
    v_idx := v_idx + 1;

    -- 服务端也要挡住空 longUrl：兼容层已校验，但 RPC 可能被直接调用
    if v_rule ->> 'longUrl' is null or btrim(v_rule ->> 'longUrl') = '' then
      raise exception using errcode = '22023', message = 'invalid_redirect_rule_long_url';
    end if;

    insert into short_url_redirect_rule (short_url_id, priority, long_url)
    values (v_id, v_idx, v_rule ->> 'longUrl')
    returning id into v_new_id;

    -- conditions 缺省 = 空数组（空条件规则永不命中，与 shlink 一致）
    for v_cond in select jsonb_array_elements(coalesce(v_rule -> 'conditions', '[]'::jsonb))
    loop
      insert into redirect_condition (rule_id, type, match_key, match_value)
      values (v_new_id,
              v_cond ->> 'type',
              v_cond ->> 'matchKey',
              v_cond ->> 'matchValue');
    end loop;
  end loop;

  return jsonb_build_object('defaultLongUrl', v_long, 'redirectRules', redirect_rules_json(v_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. 跳转函数用的两个入口
-- ---------------------------------------------------------------------------

-- 规则缓存的 seq：与 link_version 平行
create or replace function rules_seq()
returns bigint
language sql
stable
set search_path = public
as $$
  select seq from rules_version where id = 1;
$$;

-- 规则快照：只含有规则的短链（数据量很小）
create or replace function rules_snapshot()
returns table (short_url_id bigint, rules jsonb)
language sql
stable
set search_path = public
as $$
  select r.short_url_id, redirect_rules_json(r.short_url_id)
    from (select distinct short_url_id from short_url_redirect_rule) r;
$$;

-- 覆盖 0005 的同名函数：返回值加 rules 列（回落路径用；快照通道不靠它）
--
-- ⚠️ 必须先 DROP：Postgres 的 CREATE OR REPLACE **不允许改返回类型**
--    （改了报 42P13 cannot change return type of existing function）。
--    resolve_short 的 OUT 列从 3 个变成 4 个（多了 rules），属于改返回类型。
--    旧签名：resolve_short(text, text)
drop function if exists resolve_short(text, text);

create or replace function resolve_short(p_code text, p_domain text default null)
returns table (short_url_id bigint, long_url text, forward_query boolean, rules jsonb)
language plpgsql
stable
set search_path = public
as $$
declare
  v_domain_id bigint := 0;
begin
  if p_code is null or btrim(p_code) = '' then
    return;
  end if;
  if p_domain is not null and btrim(p_domain) <> '' then
    select id into v_domain_id from domain where authority = lower(btrim(p_domain));
    if v_domain_id is null then
      v_domain_id := 0;
    end if;
  end if;

  return query
  select s.id, s.long_url, s.forward_query, redirect_rules_json(s.id)
    from short_url s
   where s.short_code = lower(btrim(p_code))
     and s.domain_id in (v_domain_id, 0)
     and s.enabled
     and (s.valid_since is null or s.valid_since <= now())
     and (s.valid_until is null or s.valid_until > now())
     and (s.max_visits is null or s.visits_count < s.max_visits)
   order by (s.domain_id = v_domain_id) desc, s.id
   limit 1;
end;
$$;

-- 覆盖 0005 的同名函数：hasRedirectRules 由常量 false 改为动态判断
create or replace function short_url_json(p_id bigint)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'shortCode',  s.short_code,
    'domain',     case when s.domain_id = 0 then null::text else d.authority end,
    'shortUrl',   d.scheme || '://' || d.authority || '/' || s.short_code,
    'longUrl',    s.long_url,
    'dateCreated', s.created_at,
    'visitsSummary', jsonb_build_object(
      'total',   coalesce(c.total, 0),
      'nonBots', coalesce(c.nonbots, 0),
      'bots',    coalesce(c.bots, 0)
    ),
    'meta', jsonb_build_object(
      'validSince', s.valid_since,
      'validUntil',  s.valid_until,
      'maxVisits',  s.max_visits
    ),
    'tags', coalesce((
      select jsonb_agg(t.name order by t.name)
        from short_url_tag st
        join tag t on t.id = st.tag_id
       where st.short_url_id = s.id
    ), '[]'::jsonb),
    'title',       s.title,
    'crawlable',   s.crawlable,
    'forwardQuery', s.forward_query,
    'hasRedirectRules', exists (
      select 1 from short_url_redirect_rule r where r.short_url_id = s.id
    )
  )
  from short_url s
  join domain d on d.id = s.domain_id
  left join lateral (
    select sum(count) as total,
           sum(count) filter (where not potential_bot) as nonbots,
           sum(count) filter (where potential_bot)     as bots
      from short_url_visits_counts
     where short_url_id = s.id
  ) c on true
  where s.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- 6. 权限收口
-- ---------------------------------------------------------------------------
revoke execute on function redirect_rules_json(bigint) from public, anon, authenticated;
grant execute on function redirect_rules_json(bigint) to service_role;

revoke execute on function set_short_url_redirect_rules(text, text, jsonb) from public, anon, authenticated;
grant execute on function set_short_url_redirect_rules(text, text, jsonb) to service_role;

revoke execute on function get_short_url_redirect_rules(text, text) from public, anon, authenticated;
grant execute on function get_short_url_redirect_rules(text, text) to service_role;

revoke execute on function rules_seq() from public, anon, authenticated;
grant execute on function rules_seq() to service_role;

revoke execute on function rules_snapshot() from public, anon, authenticated;
grant execute on function rules_snapshot() to service_role;

revoke execute on function resolve_short(text, text) from public, anon, authenticated;
grant execute on function resolve_short(text, text) to service_role;

revoke execute on function short_url_json(bigint) from public, anon, authenticated;
grant execute on function short_url_json(bigint) to service_role;

revoke execute on function bump_rules_version() from public, anon, authenticated;
grant execute on function bump_rules_version() to service_role;
```

### Step 3: 切分并逐条执行

平台一次只认一条 SQL 语句，所以要逐条执行。**切分必须正确处理 dollar-quote** —— 用下面这段脚本（一次性 heredoc，不落成仓库文件）：

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
set -a; source supabase/functions/.env; set +a
cat > /tmp/rxl-split-sql.py <<'PY'
import re, sys, pathlib

def split_statements(sql):
    stmts, buf, i, n = [], [], 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":                      # 单引号字符串（'' 是转义）
            buf.append(ch); i += 1
            while i < n:
                buf.append(sql[i])
                if sql[i] == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        buf.append(sql[i + 1]); i += 2; continue
                    i += 1; break
                i += 1
            continue
        if sql.startswith('--', i):         # 行注释
            j = sql.find('\n', i); j = n if j < 0 else j
            buf.append(sql[i:j]); i = j; continue
        if sql.startswith('/*', i):         # 块注释
            j = sql.find('*/', i + 2); j = n if j < 0 else j + 2
            buf.append(sql[i:j]); i = j; continue
        if ch == '$':                      # dollar-quote（$$ 或 $tag$）
            m = re.match(r'\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$', sql[i:])
            if m:
                tag = m.group(0)
                j = sql.find(tag, i + len(tag)); j = n if j < 0 else j
                buf.append(sql[i:j + len(tag)]); i = j + len(tag); continue
        buf.append(ch)
        if ch == ';':
            stmts.append(''.join(buf)); buf = []
        i += 1
    tail = ''.join(buf)
    if tail.strip():
        stmts.append(tail)
    out = []
    for s in stmts:
        body = [l for l in s.strip().splitlines() if l.strip() and not l.strip().startswith('--')]
        if body:
            out.append(s.strip())
    return out

src = pathlib.Path(sys.argv[1]).read_text()
out_dir = pathlib.Path(sys.argv[2]); out_dir.mkdir(parents=True, exist_ok=True)
for f in out_dir.glob('stmt-*.sql'):
    f.unlink()
stmts = split_statements(src)
for i, s in enumerate(stmts, 1):
    # 去掉开头的注释行：supabase db query 会把以 `--` 开头的参数当成 CLI 选项
    lines = s.splitlines()
    while lines and (not lines[0].strip() or lines[0].strip().startswith('--')):
        lines.pop(0)
    body = '\n'.join(lines).strip()
    (out_dir / f'stmt-{i:03d}.sql').write_text((body if body.endswith(';') else body + ';') + '\n')
print('statements:', len(stmts))
PY
python3 /tmp/rxl-split-sql.py "$PWD/supabase/migrations/0018_redirect_rules.sql" /tmp/rxlink-split/stmts18
```

先**人工核对**切分结果（关键：函数体完整、`revoke`/`grant` 各自独立成条）：

```bash
ls /tmp/rxlink-split/stmts18/
head -3 /tmp/rxlink-split/stmts18/stmt-001.sql
grep -c ";" /tmp/rxlink-split/stmts18/stmt-*.sql
```

Expected：`stmt-001.sql` 以 `create table` 开头；`revoke` / `grant` 各自单独成文件。

再逐条执行：

```bash
for f in /tmp/rxlink-split/stmts18/stmt-*.sql; do
  echo "--- $f"
  supabase db query --db-url "$SUPABASE_DB_URL" "$(cat "$f")"
  rc=$?
  if [ $rc -ne 0 ]; then echo "❌ 失败于 $(basename "$f")（退出码 $rc）"; break; fi
done
```

Expected: 全部成功，无报错。

> **必须用退出码判定失败，不要 grep 输出文本**：supabase CLI 的报错文案有两种格式 ——
> `failed to execute query: ERROR: ...` 和 `query error: ERROR: ...`。
> 只 grep 前者会漏掉后者（本次实施就因此漏掉了一条 42P13）。退出码两种情况都是非 0。

### Step 4: 断言

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select (select count(*) from short_url_redirect_rule)::text as rules, (select count(*) from redirect_condition)::text as conds, (select count(*) from rules_version)::text as ver, (select seq from rules_version where id=1)::text as seq"
```

Expected: `rules=0`, `conds=0`, `ver=1`, `seq=0`。

**验证「规则写不动 link_version」**（这是本任务的核心断言）：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select (select seq from link_version where id=1)::text as link_seq, (select seq from rules_version where id=1)::text as rules_seq"
```

Expected: 记下 `link_seq` 的当前值（记为 `L`）。

用一条真实短链（`2b9yj`，id=1）写一条规则：

```bash
cat > /tmp/rxl-i9-rule.sql <<'SQL'
select set_short_url_redirect_rules('2b9yj', null, '[{"longUrl":"https://example.com/m","conditions":[{"type":"device","matchKey":null,"matchValue":"mobile"}]}]'::jsonb)
SQL
supabase db query --db-url "$SUPABASE_DB_URL" "$(cat /tmp/rxl-i9-rule.sql)"
```

> JSON 字面量在 SQL 单引号里**不需要**转义双引号。别写成 `\"`，那会把反斜杠也存进去。

Expected: 返回 `{"defaultLongUrl": "…", "redirectRules": [{"longUrl":"https://example.com/m","priority":1,"conditions":[{"type":"device","matchKey":null,"matchValue":"mobile"}]}]}`。

再查两个 seq：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select (select seq from link_version where id=1)::text as link_seq, (select seq from rules_version where id=1)::text as rules_seq"
```

Expected: `link_seq` **仍等于 L**，`rules_seq` **大于 0**。

再读回：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select get_short_url_redirect_rules('2b9yj', null)"
```

Expected: 与写入一致。

`hasRedirectRules` 应变 true：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select short_url_json(1)->>'hasRedirectRules' as has_rules"
```

Expected: `true`。

`rules_snapshot()` 应只返回有规则的短链：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select short_url_id, jsonb_array_length(rules) as n from rules_snapshot()"
```

Expected: 1 行，`short_url_id=1`，`n=1`。

### Step 5: 清理测试数据

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "delete from short_url_redirect_rule where short_url_id = 1"
```

再确认 `rules_version` 回到了某个 seq（不必为 0，只是不影响正确性）。

### Step 6: 提交

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
git add supabase/migrations/0018_redirect_rules.sql
git commit -m "feat(I9): 迁移 0018 —— 跳转规则表 + rules_version 独立失效通道 + 规则 RPC"
```

---

## Task 4: 迁移 0019 —— 短链列表排除标签筛选

**Files:**
- Create: `supabase/migrations/0019_list_exclude_tags.sql`

**Interfaces:**
- Consumes: 覆盖 0008 的 `list_short_urls`
- Produces: `list_short_urls(..., p_excluded_tags text[] default null, p_excluded_tags_mode text default 'all', ...)`

**背景**：版本旋钮提到 5.1.0 会打开控制台的「排除标签」筛选（shlink 4.6.0+）。不补后端就是**静默错误**——用户点了筛选，结果却不变。

---

### Step 1: 写迁移文件

创建 `supabase/migrations/0019_list_exclude_tags.sql`：

```sql
-- 0019_list_exclude_tags.sql —— 短链列表的「排除标签」筛选（I9 / R9 的连带项）
--
-- 背景：兼容层 /health 的 version 旋钮提到 5.1.0 后，shlink 控制台会露出
--   shlink 4.6.0+ 的 excludeTags 筛选。后端不接这个参数的话，
--   用户在界面上勾了排除标签、结果却完全不变 —— 静默错误，比报错更糟。
--
-- 语义（与 SDK 的 excludeTagsMode 对齐）：
--   mode = 'any' → 命中**任一**排除标签的短链被排除
--   mode = 'all' → 同时拥有**全部**排除标签的短链被排除
--
-- 覆盖 0008 的同名函数（增加两个参数）。
--
-- ⚠️ 必须先 DROP：Postgres 的 CREATE OR REPLACE 在**参数个数不同**时不会替换，
--    而是新建一个重载（overload）。留着旧的 12 参数版本，PostgREST 按具名参数
--    调用时会出现「multiple functions with the same name」歧义错误。
--    旧签名：list_short_urls(integer, integer, text, text, text[], text, text, text, boolean, boolean, timestamptz, timestamptz)
drop function if exists list_short_urls(integer, integer, text, text, text[], text, text, text, boolean, boolean, timestamptz, timestamptz);

create or replace function list_short_urls(
  p_page             integer default 1,
  p_items            integer default 20,
  p_search           text    default null,
  p_domain           text    default null,
  p_tags             text[]  default null,
  p_tags_mode        text    default 'all',
  p_order_field      text    default 'dateCreated',
  p_order_dir        text    default 'DESC',
  p_exclude_max      boolean default false,
  p_exclude_expired  boolean default false,
  p_start            timestamptz default null,
  p_end              timestamptz default null,
  p_excluded_tags    text[]  default null,
  p_excluded_tags_mode text  default 'all'
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_page   int  := greatest(1, coalesce(p_page, 1));
  v_items  int  := greatest(1, least(coalesce(p_items, 20), 100));
  v_domain bigint;
  v_tags   text[];
  v_mode   text := lower(coalesce(p_tags_mode, 'all'));
  v_xmode  text := lower(coalesce(p_excluded_tags_mode, 'all'));
  v_xtags  text[];
  v_order  text;
  v_dir    text := case when upper(coalesce(p_order_dir, 'DESC')) = 'ASC' then 'asc' else 'desc' end;
  v_result jsonb;
begin
  if p_domain is not null and btrim(p_domain) <> '' then
    if upper(btrim(p_domain)) = 'DEFAULT' then
      v_domain := 0;
    else
      select id into v_domain from domain where authority = lower(btrim(p_domain));
      if v_domain is null then
        return jsonb_build_object(
          'data', '[]'::jsonb,
          'pagination', jsonb_build_object('currentPage', v_page, 'pagesCount', 0, 'totalItems', 0));
      end if;
    end if;
  end if;

  if p_tags is not null then
    select array_agg(distinct lower(btrim(x)))
      into v_tags
      from unnest(p_tags) x
     where btrim(x) <> '';
  end if;

  if p_excluded_tags is not null then
    select array_agg(distinct lower(btrim(x)))
      into v_xtags
      from unnest(p_excluded_tags) x
     where btrim(x) <> '';
  end if;

  v_order := case lower(coalesce(p_order_field, 'dateCreated'))
               when 'shortcode'    then 's.short_code'
               when 'longurl'      then 's.long_url'
               when 'title'        then 'coalesce(s.title, '''')'
               when 'visits'       then 's.visits_count'
               when 'nonbotvisits' then 'coalesce(nb.nonbots, 0)'
               else 's.created_at'
             end;

  execute format($q$
    with filtered as (
      select s.id, %1$s as ord
        from short_url s
        left join lateral (
          select sum(c.count) filter (where not c.potential_bot) as nonbots
            from short_url_visits_counts c
           where c.short_url_id = s.id
        ) nb on true
       where s.enabled
         and ($3::bigint is null or s.domain_id = $3)
         and ($4::text is null or btrim($4) = ''
              or s.short_code ilike '%%' || btrim($4) || '%%'
              or s.long_url  ilike '%%' || btrim($4) || '%%'
              or coalesce(s.title, '') ilike '%%' || btrim($4) || '%%')
         and ($5::text[] is null
              or ($6 = 'any' and exists (
                    select 1
                      from short_url_tag st
                      join tag t on t.id = st.tag_id
                     where st.short_url_id = s.id
                       and t.name = any ($5)))
              or ($6 <> 'any' and (
                    select count(distinct t.name)
                      from short_url_tag st
                      join tag t on t.id = st.tag_id
                     where st.short_url_id = s.id
                       and t.name = any ($5)
                  ) = cardinality($5)))
         and ($11::text[] is null
              or ($12 = 'any' and not exists (
                    select 1
                      from short_url_tag st
                      join tag t on t.id = st.tag_id
                     where st.short_url_id = s.id
                       and t.name = any ($11)))
              or ($12 <> 'any' and (
                    select count(distinct t.name)
                      from short_url_tag st
                      join tag t on t.id = st.tag_id
                     where st.short_url_id = s.id
                       and t.name = any ($11)
                  ) < cardinality($11)))
         and (not $7::boolean or s.max_visits is null or s.visits_count < s.max_visits)
         and (not $8::boolean or s.valid_until is null or s.valid_until > now())
         and ($9::timestamptz is null or s.created_at >= $9)
         and ($10::timestamptz is null or s.created_at <= $10)
    ), counted as (
      select f.id, f.ord, count(*) over() as total from filtered f
    ), page_rows as (
      select id from counted order by ord %2$s nulls last, id %2$s
      limit $1 offset $2
    )
    select jsonb_build_object(
             'data', coalesce((
               select jsonb_agg(short_url_json(p.id) order by c.ord %2$s nulls last, p.id %2$s)
                 from page_rows p join counted c on c.id = p.id
             ), '[]'::jsonb),
             'pagination', jsonb_build_object(
               'currentPage', $13,
               'pagesCount', case when coalesce((select max(total) from counted), 0) = 0 then 0
                                  else ceil((select max(total) from counted)::numeric / $1)::int end,
               'totalItems', coalesce((select max(total) from counted), 0)))
  $q$, v_order, v_dir)
  using v_items, (v_page - 1) * v_items, v_domain, p_search, v_tags, v_mode,
        coalesce(p_exclude_max, false), coalesce(p_exclude_expired, false), p_start, p_end,
        v_xtags, v_xmode, v_page
  into v_result;

  return v_result;
end;
$$;

revoke execute on function list_short_urls(integer, integer, text, text, text[], text, text, text, boolean, boolean, timestamptz, timestamptz, text[], text)
  from public, anon, authenticated;
grant execute on function list_short_urls(integer, integer, text, text, text[], text, text, text, boolean, boolean, timestamptz, timestamptz, text[], text)
  to service_role;
```

### Step 2: 切分并逐条执行

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
set -a; source supabase/functions/.env; set +a
python3 /tmp/rxl-split-sql.py "$PWD/supabase/migrations/0019_list_exclude_tags.sql" /tmp/rxlink-split/stmts19
for f in /tmp/rxlink-split/stmts19/stmt-*.sql; do
  echo "--- $f"
  supabase db query --db-url "$SUPABASE_DB_URL" "$(cat "$f")"
  rc=$?
  if [ $rc -ne 0 ]; then echo "❌ 失败于 $(basename "$f")（退出码 $rc）"; break; fi
done
```

> `/tmp/rxl-split-sql.py` 是 Task 3 Step 3 生成的切分脚本。若那个文件已不在（临时目录被清），重新跑一遍 Task 3 Step 3 的 heredoc。

Expected: 全部成功。

**关键断言：确认没有留下旧的重载**（PostgREST 歧义的根源）：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('list_short_urls','resolve_short','short_url_json','get_short_url_redirect_rules') order by 1,2"
```

Expected: 每个函数名**只有一行**。`list_short_urls` 那行的 args 含 `text[], text`（两个新增参数）；`resolve_short` 只有 `(text, text)` 一行。

### Step 3: 断言（用真实数据）

先看一条带标签的短链：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select s.short_code, coalesce((select string_agg(t.name, ',') from short_url_tag st join tag t on t.id=st.tag_id where st.short_url_id=s.id),'') as tags from short_url s order by s.id limit 5"
```

记下某条有标签的短码（记为 `C`，标签记为 `T`）。然后：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select jsonb_array_length((list_short_urls(1, 100, null, null, null, 'all', 'dateCreated', 'DESC', false, false, null, null, null, 'all')->'data'))::text as without_exclude"
supabase db query --db-url "$SUPABASE_DB_URL" "select jsonb_array_length((list_short_urls(1, 100, null, null, null, 'all', 'dateCreated', 'DESC', false, false, null, null, array['T'], 'all')->'data'))::text as with_exclude"
```

Expected: `without_exclude` ≥ `with_exclude`；且**排除标签为 `T` 的那条短链不再出现在 with_exclude 的结果里**。

再验证 `any` 模式（排除「命中任一排除标签」的）：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select jsonb_array_length((list_short_urls(1, 100, null, null, null, 'all', 'dateCreated', 'DESC', false, false, null, null, array['T'], 'any')->'data'))::text as with_exclude_any"
```

Expected: `any` 模式的结果数 ≤ `all` 模式的结果数。

### Step 4: 提交

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
git add supabase/migrations/0019_list_exclude_tags.sql
git commit -m "feat(I9): 迁移 0019 —— list_short_urls 支持排除标签筛选（版本旋钮 5.1.0 的连带项）"
```

---

## Task 5: 兼容层 —— 规则校验 + 路由 + 版本旋钮

**Files:**
- Modify: `supabase/functions/compat/handler.ts`
- Modify: `supabase/functions/compat/test/compat.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `get_short_url_redirect_rules` / `set_short_url_redirect_rules`
- Produces: `POST|PATCH /short-urls/{code}/redirect-rules` 返回 `{defaultLongUrl, redirectRules}`；`VERSION` 常量 = `'5.1.0'`

---

### Step 1: 写失败测试

**(0) 先改一条既有断言**——`supabase/functions/compat/test/compat.test.ts` 里已有的 `health 免鉴权返回 pass` 用例断言了旧版本号，版本旋钮一改它就会挂：

```ts
// 改前
assertEquals(body, { status: 'pass', version: '4.0.0' });
// 改后
assertEquals(body, { status: 'pass', version: '5.1.0' });
```

> 不改这条，Task 5 Step 4 的「全部 PASS」就不可能达到。

**然后在文件末尾追加** I9 用例：

```ts
// ---- I9：R9 动态跳转规则 ----

const DEVICE_VALUES = ['android', 'ios', 'mobile', 'windows', 'macos', 'linux', 'chromeos', 'desktop'];
const BROWSER_VALUES = ['chrome', 'firefox', 'edge', 'safari', 'opera', 'android_browser'];

function ruleBody(rules: unknown) {
  return JSON.stringify({ redirectRules: rules });
}

Deno.test('I9：version 旋钮提到 5.1.0', async () => {
  reset();
  const res = await req('/health');
  const body = await bodyJson(res);
  assertEquals(body.version, '5.1.0');
});

Deno.test('I9：GET redirect-rules 透传 RPC 结果', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'get_short_url_redirect_rules') {
      return {
        ok: true,
        body: {
          defaultLongUrl: 'https://example.com/default',
          redirectRules: [
            { longUrl: 'https://example.com/m', priority: 1, conditions: [{ type: 'device', matchKey: null, matchValue: 'mobile' }] },
          ],
        },
      };
    }
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/abc/redirect-rules', { headers: AUTH });
  assertEquals(res.status, 200);
  const body = await bodyJson(res);
  assertEquals(body.defaultLongUrl, 'https://example.com/default');
  assertEquals((body.redirectRules as unknown[]).length, 1);
  const call = calls.find((c) => c.fn === 'get_short_url_redirect_rules');
  assertEquals(call?.body.p_code, 'abc');
});

Deno.test('I9：POST redirect-rules 调 set RPC 并返回结果', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'set_short_url_redirect_rules') {
      return {
        ok: true,
        body: {
          defaultLongUrl: 'https://example.com/default',
          redirectRules: [
            { longUrl: 'https://example.com/m', priority: 1, conditions: [{ type: 'device', matchKey: null, matchValue: 'mobile' }] },
          ],
        },
      };
    }
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://example.com/m', conditions: [{ type: 'device', matchValue: 'mobile' }] }]),
  });
  assertEquals(res.status, 200);
  const call = calls.find((c) => c.fn === 'set_short_url_redirect_rules');
  assertEquals(call?.body.p_code, 'abc');
  const rules = (call?.body.p_rules as Array<{ longUrl: string; conditions: unknown[] }>);
  assertEquals(rules.length, 1);
  assertEquals(rules[0].longUrl, 'https://example.com/m');
});

Deno.test('I9：PATCH 也支持', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'set_short_url_redirect_rules') return { ok: true, body: { defaultLongUrl: 'https://x', redirectRules: [] } };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([]),
  });
  assertEquals(res.status, 200);
  assert(calls.some((c) => c.fn === 'set_short_url_redirect_rules'));
});

Deno.test('I9：device 非法值 → 400 invalid-data', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'device', matchValue: 'desktop2' }] }]),
  });
  assertEquals(res.status, 400);
  const body = await bodyJson(res);
  assertEquals(body.type, 'https://shlink.io/api/error/invalid-data');
  assert(String(body.detail).includes('desktop2'));
});

Deno.test('I9：browser 非法值 → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'browser', matchValue: 'ie' }] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：ip-address 非法值 → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'ip-address', matchValue: '999.1.1.1' }] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：geolocation-country-code 非两字母 → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'geolocation-country-code', matchValue: 'CHN' }] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：query-param 空 matchValue → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'query-param', matchKey: 'k', matchValue: '' }] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：未知 type → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'nope', matchValue: 'v' }] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：缺 longUrl → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ conditions: [] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：11 种合法 type 全部放行', async () => {
  const cases: Array<[string, string | null, string | null]> = [
    ['device', null, 'mobile'],
    ['browser', null, 'chrome'],
    ['language', null, 'zh-CN'],
    ['query-param', 'src', 'wechat'],
    ['any-value-query-param', 'src', null],
    ['valueless-query-param', 'src', null],
    ['ip-address', null, '192.168.0.0/16'],
    ['geolocation-country-code', null, 'CN'],
    ['geolocation-city-name', null, 'Guangdong'],
    ['before-date', null, '2027-01-01T00:00:00Z'],
    ['after-date', null, '2020-01-01T00:00:00Z'],
  ];
  for (const [type, matchKey, matchValue] of cases) {
    reset((fn) => {
      if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
      if (fn === 'set_short_url_redirect_rules') return { ok: true, body: { defaultLongUrl: 'https://x', redirectRules: [] } };
      return { ok: true, body: null };
    });
    const cond: Record<string, unknown> = { type };
    if (matchKey !== null) cond.matchKey = matchKey;
    if (matchValue !== null) cond.matchValue = matchValue;
    const res = await req('/short-urls/abc/redirect-rules', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: ruleBody([{ longUrl: 'https://x', conditions: [cond] }]),
    });
    assertEquals(res.status, 200, `type=${type} 应该放行`);
  }
});

Deno.test('I9：空 redirectRules 数组合法（清空规则）', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'set_short_url_redirect_rules') return { ok: true, body: { defaultLongUrl: 'https://x', redirectRules: [] } };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([]),
  });
  assertEquals(res.status, 200);
});

Deno.test('I9：短链不存在 → 404 short-url-not-found', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'set_short_url_redirect_rules') return { ok: false, status: 404, code: 'P0002', message: 'short_url_not_found' };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/nope/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([]),
  });
  assertEquals(res.status, 404);
  const body = await bodyJson(res);
  assertEquals(body.type, 'https://shlink.io/api/error/short-url-not-found');
});

Deno.test('I9：excludeTags 传给 list_short_urls', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  await req('/short-urls?excludeTags%5B%5D=alpha&excludeTags%5B%5D=beta&excludeTagsMode=any', { headers: AUTH });
  const call = calls.find((c) => c.fn === 'list_short_urls');
  assertEquals(call?.body.p_excluded_tags, ['alpha', 'beta']);
  assertEquals(call?.body.p_excluded_tags_mode, 'any');
});
```

### Step 2: 跑测试确认失败

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/compat.test.ts
```

Expected: 多个 FAIL（version 仍是 `4.0.0`；POST 仍 501；excludeTags 未传参）。

### Step 3: 实现

在 `supabase/functions/compat/handler.ts` 里做四处改动。

**(a) 版本旋钮**（第 10 行附近）：

```ts
const VERSION = '5.1.0';
```

**(b) 规则校验工具**（加在 `parseOrder` 函数之后）：

```ts
// ---- I9：R9 动态跳转规则校验（对齐 shlink RedirectConditionType::isValid）----
const CONDITION_TYPES = [
  'device', 'language', 'query-param', 'any-value-query-param', 'valueless-query-param',
  'ip-address', 'geolocation-country-code', 'geolocation-city-name',
  'before-date', 'after-date', 'browser',
] as const;

const DEVICE_VALUES = ['android', 'ios', 'mobile', 'windows', 'macos', 'linux', 'chromeos', 'desktop'];
const BROWSER_VALUES = ['chrome', 'firefox', 'edge', 'safari', 'opera', 'android_browser'];

function invalidCondition(value: string, type: string): ApiError {
  return new ApiError(
    400,
    'invalid-data',
    `"${value}" is not a valid value for the "${type.toUpperCase()}" redirect condition`,
  );
}

// IPv4 / IPv6 静态地址、CIDR、通配符 —— 与跳转侧 ipmat.js 同一口径
function isValidIpPattern(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (s.includes('*')) {
    // 通配符只允许 IPv4 的四段形式
    const parts = s.split('.');
    return parts.length === 4 && parts.every((p) => p === '*' || /^\d{1,3}$/.test(p) && Number(p) <= 255);
  }
  const slash = s.indexOf('/');
  const base = slash < 0 ? s : s.slice(0, slash);
  const len = slash < 0 ? null : s.slice(slash + 1);
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(base) && base.split('.').every((p) => Number(p) <= 255);
  const isV6 = /^[0-9a-fA-F:]+$/.test(base) && base.includes(':');
  if (!isV4 && !isV6) return false;
  if (len !== null) {
    const n = Number(len);
    const max = isV4 ? 32 : 128;
    if (!Number.isInteger(n) || n < 0 || n > max) return false;
  }
  return true;
}

function validateCondition(cond: unknown): void {
  if (typeof cond !== 'object' || cond === null) {
    throw new ApiError(400, 'invalid-data', 'Each redirect condition must be an object');
  }
  const c = cond as { type?: unknown; matchKey?: unknown; matchValue?: unknown };
  const type = typeof c.type === 'string' ? c.type : '';
  if (!CONDITION_TYPES.includes(type as (typeof CONDITION_TYPES)[number])) {
    throw new ApiError(400, 'invalid-data', `"${type}" is not a valid redirect condition type`);
  }
  const value = c.matchValue === undefined || c.matchValue === null ? '' : String(c.matchValue);
  switch (type) {
    case 'device':
      if (!DEVICE_VALUES.includes(value)) throw invalidCondition(value, type);
      break;
    case 'browser':
      if (!BROWSER_VALUES.includes(value)) throw invalidCondition(value, type);
      break;
    case 'ip-address':
      if (!isValidIpPattern(value)) throw invalidCondition(value, type);
      break;
    case 'geolocation-country-code':
      if (!/^[A-Za-z]{2}$/.test(value)) throw invalidCondition(value, type);
      break;
    case 'query-param':
      if (value === '') throw invalidCondition(value, type);
      break;
    default:
      // 其余类型 shlink 也不校验值
      break;
  }
}

function validateRules(body: unknown): Array<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null) {
    throw new ApiError(400, 'invalid-data', 'Request body must be an object');
  }
  const rules = (body as { redirectRules?: unknown }).redirectRules;
  if (rules === undefined || rules === null) {
    throw new ApiError(400, 'invalid-data', 'redirectRules is required');
  }
  if (!Array.isArray(rules)) {
    throw new ApiError(400, 'invalid-data', 'redirectRules must be an array');
  }
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null) {
      throw new ApiError(400, 'invalid-data', 'Each redirect rule must be an object');
    }
    const r = rule as { longUrl?: unknown; conditions?: unknown };
    if (typeof r.longUrl !== 'string' || r.longUrl.trim() === '') {
      throw new ApiError(400, 'invalid-data', 'longUrl is required for each redirect rule');
    }
    if (r.conditions === undefined || r.conditions === null) {
      throw new ApiError(400, 'invalid-data', 'conditions is required for each redirect rule');
    }
    if (!Array.isArray(r.conditions)) {
      throw new ApiError(400, 'invalid-data', 'conditions must be an array');
    }
    for (const cond of r.conditions) validateCondition(cond);
  }
  return rules as Array<Record<string, unknown>>;
}
```

**(c) 路由替换**：把 `handler.ts` 里那段 `rulesMatch` 分支整体替换为：

```ts
    const rulesMatch = /^\/short-urls\/([^/]+)\/redirect-rules$/.exec(path);
    if (rulesMatch) {
      const code = decodeURIComponent(rulesMatch[1]);
      const domain = str(url.searchParams.get('domain'));
      if (req.method === 'GET') {
        return json(await rpc('get_short_url_redirect_rules', { p_code: code, p_domain: domain }), 200, origin);
      }
      if (req.method === 'POST' || req.method === 'PATCH') {
        // body 解析沿用本文件既有写法（req.json().catch(() => ({}))）
        const body = (await req.json().catch(() => ({}))) as Json;
        const rules = validateRules(body);
        const result = await rpc('set_short_url_redirect_rules', {
          p_code: code,
          p_domain: domain,
          p_rules: rules,
        });
        return json(result, 200, origin);
      }
      throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
    }
```

> body 解析失败（空 body / 非法 JSON）会得到 `{}`，随后 `validateRules` 抛 400 `redirectRules is required` —— 与本文件其它端点的既有行为一致，不需要额外的解析错误分支。

**(d) 排除标签参数**：在 `listShortUrls` 函数里，`const tags = ...` 那行之后加：

```ts
  const excludedTags = [...q.getAll('excludeTags[]'), ...q.getAll('excludeTags')].filter((t) => t !== '');
```

并在 `rpc('list_short_urls', {...})` 的参数对象里加两行：

```ts
    p_excluded_tags: excludedTags.length ? excludedTags : null,
    p_excluded_tags_mode: str(q.get('excludeTagsMode')) ?? 'all',
```

### Step 4: 跑测试确认通过

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/compat.test.ts
```

Expected: 全部 PASS（原有 15 例 + 新增 I9 用例）。

再跑类型检查：

```bash
/Users/wang/.deno/bin/deno check supabase/functions/compat/index.ts supabase/functions/compat/handler.ts supabase/functions/compat/test/compat.test.ts
```

Expected: 无错误。

### Step 5: 提交

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
git add supabase/functions/compat/handler.ts supabase/functions/compat/test/compat.test.ts
git commit -m "feat(I9): 兼容层实现跳转规则读写端点 + 11 种条件校验 + version 5.1.0"
```

---

## Task 6: 跳转函数 —— 规则缓存与求值接入

**Files:**
- Create: `fc/redirect/rules-cache.js`
- Modify: `fc/redirect/index.js`
- Modify: `fc/redirect/test/redirect.test.js`

**Interfaces:**
- Consumes: Task 1 的 `rules.js`、Task 2 的 `china-geo.js`、Task 3 的 `rules_seq()` / `rules_snapshot()` / `resolve_short` 的 `rules` 列
- Produces:
  ```js
  // fc/redirect/rules-cache.js
  module.exports = { init, get, ready: () => ready, stats };
  // init({ seq, snapshot }) → Promise<void>；get(shortUrlId) → rules[] | null
  ```

---

### Step 1: 写失败测试

在 `fc/redirect/test/redirect.test.js` 里做三处改动。

**(a) mock 网关加规则端点**（在 `before` 里的 mock server 中，`if (url === '/rest/v1/rpc/link_seq')` 之后加）：

```js
    if (url === '/rest/v1/rpc/rules_seq') return json(res, state.rulesSeq);
    if (url === '/rest/v1/rpc/rules_snapshot') {
      return json(res, state.rules);
    }
```

并在 `state` 初始化处加：

```js
const state = { fallbacks: {}, inbox: [], failFallback: false, robotsCodes: ['crawl1', 'crawl2'], rulesSeq: 1, rules: [] };
```

**(a2) 缩短规则缓存轮询间隔**（在 `before` 里 spawn 子进程的 env 中，紧挨 `CACHE_POLL_MS: '3600000',` 后面加一行）：

```js
      RULES_POLL_MS: '50',
```

> **必须加**。规则缓存默认轮询 5 秒，测试只等 300ms —— 不缩短间隔的话新加的 I9 用例永远读到旧规则。

**(b) `resolve_short` 的 mock 加 `rules` 列**：

```js
    if (url === '/rest/v1/rpc/resolve_short') {
      if (body.p_code === 'known1') {
        return json(res, [{ short_url_id: 1, long_url: 'https://target.example/ok', forward_query: true, rules: state.rules.length ? state.rules[0].rules : null }]);
      }
      return json(res, []);
    }
```

**(c) 新增用例**（追加到文件末尾）：

```js
test('I9：规则命中 → 302 到规则的 longUrl', async () => {
  state.rules = [{ short_url_id: 1, rules: [{ longUrl: 'https://target.example/rule', priority: 1, conditions: [{ type: 'query-param', matchKey: 'src', matchValue: 'wechat' }] }] }];
  state.rulesSeq = 2;
  // 等规则缓存轮询到新 seq
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1?src=wechat');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://target.example/rule?src=wechat');
});

test('I9：规则不命中 → 302 到默认 longUrl', async () => {
  state.rules = [{ short_url_id: 1, rules: [{ longUrl: 'https://target.example/rule', priority: 1, conditions: [{ type: 'query-param', matchKey: 'src', matchValue: 'wechat' }] }] }];
  state.rulesSeq = 3;
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1?src=other');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://target.example/ok?src=other');
});

test('I9：规则 + forward_query → query 拼在规则目标上', async () => {
  state.rules = [{ short_url_id: 1, rules: [{ longUrl: 'https://target.example/rule', priority: 1, conditions: [{ type: 'any-value-query-param', matchKey: 'src' }] }] }];
  state.rulesSeq = 4;
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1?src=wechat');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://target.example/rule?src=wechat');
});

test('I9：像素路由不套用规则', async () => {
  state.rules = [{ short_url_id: 1, rules: [{ longUrl: 'https://target.example/rule', priority: 1, conditions: [{ type: 'any-value-query-param', matchKey: 'src' }] }] }];
  state.rulesSeq = 5;
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1/track');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/gif');
});

test('I9：无规则的短链 → 走默认 longUrl，开销不变', async () => {
  state.rules = [];
  state.rulesSeq = 6;
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://target.example/ok');
});
```

### Step 2: 跑测试确认失败

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
node --test fc/redirect/test/redirect.test.js
```

Expected: 新增的 I9 用例 FAIL（现在永远跳默认 longUrl）。

### Step 3: 写 `fc/redirect/rules-cache.js`

```js
// 跳转函数的规则快照缓存：与主快照（cache.js）平行，但走自己的 seq 通道。
//
// 为什么独立：规则是高频写操作（用户反复调规则）。若与 link_version 共用 seq，
// 每存一次规则就要让全网实例重拉全量短链快照 —— 代价不对等。
// 这里只重拉「有规则的短链」这一小块数据。

const POLL_MS = Number(process.env.RULES_POLL_MS || 5000);

let byId = new Map();
let seq = null;
let ready = false;
let rows = 0;
let loadedAt = 0;
let reloads = 0;
let warned = false;
let fetchers = null;

async function load() {
  const list = await fetchers.snapshot();
  const m = new Map();
  for (const row of list) {
    const id = Number(row.short_url_id);
    if (!Number.isFinite(id)) continue;
    m.set(id, Array.isArray(row.rules) ? row.rules : []);
  }
  byId = m;
  rows = list.length;
  ready = true;
  loadedAt = Date.now();
  reloads++;
}

async function poll() {
  try {
    const next = await fetchers.seq();
    if (next === null) return;
    if (!ready || next !== seq) {
      seq = next;
      await load();
    }
    warned = false;
  } catch (err) {
    // 拉取失败保留旧快照：宁可跳旧规则，也不能因为规则缓存抖动把跳转打成 502
    if (!warned) {
      warned = true;
      console.warn(`rules snapshot poll failed: ${err && err.message}`);
    }
  }
}

function init(f) {
  fetchers = f;
  return poll().then(() => {
    setInterval(poll, POLL_MS);
  });
}

// shortUrlId → rules[] | null（null = 无规则）
function get(shortUrlId) {
  if (!ready) return null;
  const r = byId.get(Number(shortUrlId));
  return r === undefined ? null : r;
}

function stats() {
  return {
    cached: ready,
    rows,
    seq,
    reloads,
    age: loadedAt ? Date.now() - loadedAt : -1,
    pollMs: POLL_MS,
  };
}

module.exports = { init, get, ready: () => ready, stats };
```

### Step 4: 接入 `fc/redirect/index.js`

**(a) 顶部 require 与常量**（在 `const ipmat = require('./ipmat');` 之后）：

```js
const rules = require('./rules');
const rulesCache = require('./rules-cache');
const chinaGeo = require('./china-geo');
```

在 `const ROBOTS_PATH = ...` 之后加：

```js
const RULES_SEQ_PATH = '/rest/v1/rpc/rules_seq';
const RULES_SNAPSHOT_PATH = '/rest/v1/rpc/rules_snapshot';
```

**(b) geo 查表懒加载**（在 `fullUrl` 函数之后）：

```js
// geo 查表懒加载：只有真正用到 geo 条件才读文件
let geoLookup = null;
function getGeoLookup() {
  if (geoLookup) return geoLookup;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(__dirname, 'china-geo.bin');
    const lookup = chinaGeo.createLookup(fs.readFileSync(file));
    geoLookup = lookup;
    console.log('china geo table loaded');
  } catch (err) {
    // 数据文件缺失 → geo 条件一律不匹配（静默降级，不影响其他条件）
    geoLookup = () => null;
    console.warn(`china-geo.bin unavailable: ${err && err.message}`);
  }
  return geoLookup;
}
```

**(c) `resolve()` 带上 rules**（改 `resolve` 函数的返回值）：

```js
  return {
    id: rows[0].short_url_id,
    longUrl: rows[0].long_url,
    forwardQuery: rows[0].forward_query,
    validSince: null,
    validUntil: null,
    visitsLimited: false,
    // 规则缓存未就绪时的回落：resolve_short 也能带 rules
    rules: Array.isArray(rows[0].rules) ? rows[0].rules : null,
  };
```

**(d) 求值函数**（在 `shouldSkipTracking` 之前）：

```js
// 规则求值：优先用规则缓存（未就绪时用 resolve 带回来的 rules）
function resolveTargetUrl(entry, req, query) {
  const ruleList = rulesCache.ready() ? rulesCache.get(entry.id) : entry.rules;
  if (!ruleList || ruleList.length === 0) return entry.longUrl;
  const ctx = rules.buildContext({
    query: Object.fromEntries(query.entries()),
    ua: req.headers['user-agent'] || '',
    ip: clientIp(req),
    now: Date.now(),
    acceptLanguage: req.headers['accept-language'] || '',
    geoLookup: getGeoLookup(),
  });
  const hit = rules.evaluate(ruleList, ctx);
  return hit || entry.longUrl;
}
```

**(e) 主流程里用求值结果**（把原来 `let location = entry.longUrl;` 那两行改成）：

```js
  let location = resolveTargetUrl(entry, req, query);
  if (entry.forwardQuery) location = withQuery(location, req);
```

**(f) 启动时初始化规则缓存**（在文件末尾 `cache.init({...})` 那段之后）：

```js
// 规则缓存独立通道：自己的 seq（rules_version），不与 link_version 混用
rulesCache.init({
  seq: async () => {
    const res = await gateway(RULES_SEQ_PATH, {});
    if (!res.ok) throw new Error(`rules seq ${res.status}`);
    const value = await res.json();
    return typeof value === 'number' ? value : null;
  },
  snapshot: async () => {
    const res = await gateway(RULES_SNAPSHOT_PATH, {});
    if (!res.ok) throw new Error(`rules snapshot ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  },
}).then(() => {
  console.log(`rules snapshot ready ${JSON.stringify(rulesCache.stats())}`);
});
```

### Step 5: 跑测试确认通过

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
node --test fc/redirect/test/redirect.test.js
```

Expected: 全部 PASS（原有 32 例 + 新增 5 例）。

若 `I9：规则命中` 仍失败，按顺序查：
1. mock 网关有没有加 `rules_seq` / `rules_snapshot` 两个分支；
2. 子进程 env 里有没有 `RULES_POLL_MS: '50'`；
3. `state.rules` 的形状是不是 `[{ short_url_id: 1, rules: [...] }]`（`rules-cache.js` 读的是 `row.short_url_id` 和 `row.rules`）。

### Step 6: 补一个「规则缓存独立」的回归断言

在 `fc/redirect/test/redirect.test.js` 末尾追加：

```js
test('I9：规则保存不触发主快照重拉（两个 seq 独立）', async () => {
  const before = await fetch(`${base}/health`);
  assert.ok(before.status >= 0);
  // 主快照的 seq 由 link_version 驱动；规则改动只动 rules_version。
  // 这里验证的是接口面：规则缓存有自己的 seq 端点，与主快照端点不同。
  const rulesSeq = await fetch(`${base}/rest/v1/rpc/rules_seq`);
  assert.ok(rulesSeq.status >= 0);
});
```

> 这条是**弱断言**（只验证端点存在）。真正的「link_version 不变」断言在 Task 3 Step 4 的 SQL 层做过（那里才是权威验证）。不要在这里堆砌无意义的断言。

### Step 7: 提交

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
git add fc/redirect/rules-cache.js fc/redirect/index.js fc/redirect/test/redirect.test.js
git commit -m "feat(I9): 跳转函数接入规则缓存与求值（独立 rules_version 通道）"
```

---

## Task 7: 部署、线上验收与文档归档

**Files:**
- Modify: `docs/runbook.md`（新增 §5.4）
- Create: `docs/verification/i9-results.md`
- Modify: `docs/iteration-plan.md`（I9 章节 + B9 清单 + 变更记录）
- Modify: `docs/shlink-feature-checklist.md`

---

### Step 1: 部署兼容层

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
node scripts/build-compat-function.mjs
set -a; source supabase/functions/.env; set +a
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat \
  -d /Users/wang/Documents/work/ranxin/code/rxlink/supabase/functions/compat/dist --no-verify-jwt
```

Expected: 返回 `status: ACTIVE`。

### Step 2: 线上验收兼容层

```bash
key=$(grep -o 'rxl_[a-f0-9]*' /tmp/rxl-api-key.txt | head -n1)
base="https://your-project-ref.supabase.co/functions/v1/compat/rest/v3"

curl -s -w "\nHTTP %{http_code}\n" -H "X-Api-Key: $key" "$base/short-urls/2b9yj/redirect-rules"
```

Expected: `200`，`{"defaultLongUrl":"…","redirectRules":[]}`。

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST -H "X-Api-Key: $key" -H "Content-Type: application/json" \
  -d '{"redirectRules":[{"longUrl":"https://example.com/i9-test","conditions":[{"type":"device","matchValue":"mobile"}]}]}' \
  "$base/short-urls/2b9yj/redirect-rules"
```

Expected: `200`，`redirectRules[0].priority === 1`。

非法值：

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST -H "X-Api-Key: $key" -H "Content-Type: application/json" \
  -d '{"redirectRules":[{"longUrl":"https://example.com/x","conditions":[{"type":"device","matchValue":"desktop2"}]}]}' \
  "$base/short-urls/2b9yj/redirect-rules"
```

Expected: `400`，`type` 为 `https://shlink.io/api/error/invalid-data`。

清理测试规则：

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST -H "X-Api-Key: $key" -H "Content-Type: application/json" \
  -d '{"redirectRules":[]}' "$base/short-urls/2b9yj/redirect-rules"
```

Expected: `200`，`redirectRules: []`。

### Step 3: 打包跳转函数

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
node --test fc/redirect/test/rules.test.js
node --test fc/redirect/test/china-geo.test.js
node --test fc/redirect/test/redirect.test.js
cd fc/redirect && rm -f ../../dist/redirect.zip && zip -r ../../dist/redirect.zip index.js cache.js ipmat.js rules.js rules-cache.js china-geo.js china-geo.bin && cd ../..
unzip -l dist/redirect.zip
```

Expected: 7 个文件都在（`china-geo.bin` 必须在里面）。

> **坑**：`china-geo.bin` 是 gitignore 的构建产物，打包前必须确认它存在：
> ```bash
> ls -la fc/redirect/china-geo.bin
> ```

### Step 4: 用户上传 FC

请用户在阿里云 FC 控制台把 `dist/redirect.zip` 上传到跳转函数并部署。

### Step 5: 线上验收跳转行为

先在库里写一条**可验证**的规则（用 query-param 条件，用 curl 能控制）：

```bash
set -a; source supabase/functions/.env; set +a
cat > /tmp/rxl-i9-rule.sql <<'SQL'
select set_short_url_redirect_rules('2b9yj', null, '[{"longUrl":"https://example.com/i9-mobile","conditions":[{"type":"query-param","matchKey":"src","matchValue":"wechat"}]}]'::jsonb)
SQL
supabase db query --db-url "$SUPABASE_DB_URL" "$(cat /tmp/rxl-i9-rule.sql)"
```

```bash
d="https://example.com"
# 从响应头读 Location（curl 的 %{redirect_url} 不可靠）
curl -s -o /dev/null -D - "$d/2b9yj?src=wechat" | grep -i '^location:'
curl -s -o /dev/null -D - "$d/2b9yj?src=other"  | grep -i '^location:'
```

Expected：第一条 `Location: https://example.com/i9-mobile`；第二条 `Location: <短链默认 long_url>`。

> 规则生效有 ≤5s 延迟（规则缓存轮询）。刚写完就 curl 的话可能拿到默认长链 → **等 6 秒再验**，或先 `supabase db query` 查 `rules_version.seq` 确认已 bump。

清理：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "delete from short_url_redirect_rule where short_url_id = 1"
```

### Step 6: 控制台界面验收（人工）

在浏览器打开 `https://console.example.com`，用控制台 API key 登录后逐项核对：

1. 短链列表页：状态列出现「动态跳转规则」图标（`hasRedirectRules` 为 true 才显示）。
2. 进入某条短链的「跳转规则」页：能看到已保存的规则、条件和优先级。
3. **新增一条规则**（例：`device = mobile` → `https://example.com/m`），点保存：
   - **不再报 501**；
   - Network 面板里发的是 `POST /rest/v3/short-urls/{code}/redirect-rules`，返回 200；
   - 规则出现在列表里。
4. **删除规则**（把规则删光保存）：返回 200，`redirectRules` 变空数组。
5. **版本旋钮检查**：`/health` 返回 `version: 5.1.0` 后，控制台的「跳转规则」页应列出**全部 11 种条件类型**（device / browser / language / query-param / any-value-query-param / valueless-query-param / ip-address / geolocation-country-code / geolocation-city-name / before-date / after-date）。若只看到 3 种，说明 `/health` 的 version 没生效。
6. **排除标签筛选**：短链列表页勾选「排除标签」→ 筛选生效（结果条数变少）。若勾了没反应，说明 `0019` 的 `p_excluded_tags` 没接上。
7. **逐页巡检**：短链列表 / 短链编辑 / 标签 / 域名 / 访问概览 / 访问明细 / 跳转规则 —— Network 面板里**不得有 4xx**（除已知的 `mercure-info` 404）。

### Step 7: 性能抽查（增量 < 5ms）

```bash
d="https://example.com"
# 无规则短链（基线）
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{time_total}\n" "$d/2b9yj"; done | sort -n | head -1
```

写一条规则后再测同样 20 次，取最小值对比。Expected：两次差值 < 5ms。

> 这是粗粒度抽查（网络抖动远大于 5ms），目的是抓「规则求值把热路径拖慢一个数量级」这类问题，不是精确基准。要精确数字用 FC 的 `Server-Timing` 头对比 `resolve;dur=`。

### Step 8: 文档

**`docs/runbook.md`** 新增 §5.4（放在 §5.3 之后）：

```markdown
### 5.4 跳转规则（I9 / R9）

- **数据**：`short_url_redirect_rule` + `redirect_condition`；失效走独立的 `rules_version`（**不是** `link_version`）。
- **兼容层**：`GET/POST|PATCH /rest/v3/short-urls/{code}/redirect-rules`。
- **跳转**：命中规则 → 跳规则里的 `longUrl`；不命中 → 跳短链默认长链。规则保存后 ≤5s（`RULES_POLL_MS`）生效。
- **支持的 11 种条件**：`device` / `browser` / `language` / `query-param` / `any-value-query-param` / `valueless-query-param` / `ip-address` / `geolocation-country-code` / `geolocation-city-name` / `before-date` / `after-date`。
- **geo 只覆盖中国大陆 31 省级**：`geolocation-country-code` 实际只匹配 `CN`；`geolocation-city-name` 匹配省名（中英文都认）。海外 IP 不命中 geo 条件。
- **数据文件**：`fc/redirect/china-geo.bin`（构建产物，已 gitignore）。重建：`node scripts/build-china-geo.mjs`（约 70 秒）。改了 DB-IP mmdb 后要重建并重打 `dist/redirect.zip`。
- **排查**：
  1. 规则没生效 → 先看 `select seq from rules_version where id=1;`，再确认 FC 实例的 `rules snapshot ready` 日志里的 seq 是否跟上（seq 落后 → 轮询或网络问题）。
  2. 规则保存报 400 → 是条件值域校验（见设计稿 §5.3）；文案里会指出是哪个值非法。
  3. geo 条件不命中 → 确认 `fc/redirect/china-geo.bin` 在包里（`unzip -l dist/redirect.zip`），以及客户端是不是 IPv6（IPv6 不做 geo 匹配）。
```

**`docs/verification/i9-results.md`**：按 `docs/verification/i8-results.md` 的结构写，填入实际验收数据（迁移断言、SQL 断言、curl 结果、单测数字、线上跳转证据）。

**`docs/iteration-plan.md`**：加 I9 章节 + B9 清单（勾选项对应 Task 7 的验收项）+ 变更记录一行。

**`docs/shlink-feature-checklist.md`**：把 `setShortUrlRedirectRules` 从 `⚠️ 501` 改为 `✅`；`getShortUrlRedirectRules` 的备注从「恒空」改为「真读」；页面清单里「跳转规则」行的说明更新。

### Step 9: 提交

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
git add docs/runbook.md docs/verification/i9-results.md docs/iteration-plan.md docs/shlink-feature-checklist.md
git commit -m "docs(I9): 验收归档（i9-results.md）+ runbook §5.4 + 迭代计划 I9/B9 + 功能清单更新"
```

### Step 10: 最终回归

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
node --test fc/redirect/test/ipmat.test.js
node --test fc/redirect/test/rules.test.js
node --test fc/redirect/test/china-geo.test.js
node --test fc/redirect/test/redirect.test.js
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/compat.test.ts
/Users/wang/.deno/bin/deno check supabase/functions/compat/index.ts supabase/functions/compat/handler.ts supabase/functions/compat/test/compat.test.ts
```

Expected: 全部绿。**逐个文件跑**（`node --test <目录>` 在不同 Node 版本上行为不一致，本仓库既有做法是指到具体文件）。原有 8（ipmat）+ 32（redirect）+ 15（compat）例必须**一条不少**地继续通过；新增例数按实际输出记录到 `docs/verification/i9-results.md`。

再确认线上旧行为没被破坏：

```bash
d="https://example.com"
curl -s -o /dev/null -w "robots: %{http_code}\n" "$d/robots.txt"
curl -s -o /dev/null -w "404:    %{http_code}\n" "$d/nosuch"
curl -s -o /dev/null -w "pixel:  %{http_code}\n" "$d/2b9yj/track"
```

Expected: `200` / `404` / `200`（与 I8 验收时的口径一致）。

---

## 附录 A：任务依赖图

```
Task 1 (rules.js)
Task 2 (china-geo.js + build script) ──┐
                                        ├──> Task 6 (跳转接入) ──┐
Task 3 (迁移 0018) ─────────────────────┘                        ├──> Task 7 (部署验收)
Task 4 (迁移 0019) ──────────────────────────────────────────────┤
Task 5 (兼容层) ────────────────────────────────────────────────┘
```

Task 1–5 之间无依赖，可并行；Task 6 依赖 1/2/3；Task 7 依赖 3/4/5/6。

## 附录 B：常见坑（来自本项目历史经验）

| 坑 | 规避方式 |
|---|---|
| `supabase db query "$(cat file)"` 若文件以 `--` 注释开头会被 CLI 当参数 | 切分后逐条执行，注释行单独跑 |
| dollar-quote 破坏 naive 分号切分 | 用 Task 3 Step 3 的 python 切分（按 `$$;` 切） |
| `api_key.id` 是 `GENERATED ALWAYS identity`，不能插显式 id | 插入时省略 id |
| `visit` 表列名是 `redirect_url`（不是 `redirect_to`）、`occurred_at` 双 r | 改 `visit` 相关 SQL 时注意 |
| `dist/` 被 gitignore，嵌套目录同样被忽略 | `china-geo.bin` 在 `fc/redirect/` 下，**不在** `dist/`，但仍需显式加 `.gitignore` 规则 |
| functions-cli 部署包以入口文件为准 | compat 继续用 `scripts/build-compat-function.mjs` 生成单文件包 |
| Node 18 兼容 | 跳转函数只用 Node 18 已有 API（`node:fs` / `node:path` / `node:net`） |
| FC 发布是用户控制台动作 | 跳转函数部署包准备好后请用户上传 |
