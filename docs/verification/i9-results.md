# I9 —— R9 动态跳转规则 验证记录

> 执行日期：2026-11-12。通道：`supabase db query --db-url`（逐条）、`functions-cli`、`curl`、Node 24 / Deno 2.9.7 测试。
> 状态：**兼容层与数据面已上线并验收；跳转函数待上传 `dist/redirect.zip`，上传后补做跳转侧线上验收**（见 §7）。
> 设计：`docs/superpowers/specs/2026-11-12-r9-dynamic-redirect-rules-design.md`；实施计划：`docs/superpowers/plans/2026-11-12-r9-dynamic-redirect-rules.md`；差距清单：`docs/shlink-feature-checklist.md`。

## 1. 迁移 0018（已应用，45 条语句）

**备份**（应用前建，`enable/force RLS` + `revoke` 收口）：

| 表 | 内容 |
|---|---|
| `funcdef_bak_20261112` | 4 个被覆盖函数的 `pg_get_functiondef`（`resolve_short` / `short_url_json` / `get_short_url_redirect_rules` / `list_short_urls`） |

**新建对象**

- `short_url_redirect_rule`（`short_url_id` / `long_url` / `priority`）、`redirect_condition`（`rule_id` / `type` / `match_key` / `match_value`）、`rules_version`（单行 seq）。
- 触发器 `bump_rules_version()`：`short_url_redirect_rule` 与 `redirect_condition` 上的 **行级** after 触发器 → 规则写入只 bump `rules_version`，**不动 `link_version`**。
- 三表全部 `enable RLS` + `force RLS`，0 policy；`revoke` 齐全，RPC 只授 `service_role`。

**函数**

| 函数 | 说明 |
|---|---|
| `redirect_rules_json(bigint)` | 规则 → `{longUrl, priority, conditions:[{type, matchKey, matchValue}]}`，对齐 shlink `ShortUrlRedirectRule::jsonSerialize` |
| `set_short_url_redirect_rules(text, text, jsonb)` | 全量替换规则，返回 `{defaultLongUrl, redirectRules}` |
| `get_short_url_redirect_rules(text, text)` | 读规则，返回同上 |
| `rules_seq()` | 规则通道的 seq（与 `link_seq` 平行） |
| `rules_snapshot()` | 只返回**有规则的**短链：`{short_url_id, rules}` |
| `resolve_short(text, text)`（**覆盖 0005**） | OUT 列 3 → 4，多一个 `rules` 列（回落路径用） |
| `short_url_json(bigint)`（**覆盖 0005**） | `hasRedirectRules` 由常量 `false` 改为动态判断 |

> ⚠️ `resolve_short` 改的是 OUT 列数（返回类型），Postgres 的 `CREATE OR REPLACE` 不允许（42P13）→ 必须先 `drop function if exists resolve_short(text, text);` 再重建，否则会退化成重载、PostgREST 具名调用歧义。`list_short_urls` 加参数（0019）同理。

**断言**

| 断言 | 结果 |
|---|---|
| 规则增删改只 bump `rules_seq`（0 → 5） | ✅ |
| 同期 `link_version.seq` 恒为 97，**不动** | ✅ |
| 短链删除后规则级联删除 | ✅ |
| `rules_snapshot()` 只返回有规则的短链 | ✅ |
| 应用后无重载残留（`pg_proc` 无重复签名） | ✅ |

**踩坑**：平台一次只认一条语句，迁移逐条 `supabase db query` 执行；**成败必须看退出码**——CLI 有两种报错文案（`failed to execute query: ERROR:` 与 `query error: ERROR:`），只 grep 前者会漏判。

## 2. 迁移 0019（已应用）

`list_short_urls` 加 `p_excluded_tags text[]` + `p_excluded_tags_mode`（先 `drop` 旧 12 参签名再重建，避免重载）。这是版本旋钮 5.1.0 的**连带项**——不补 `excludeTags` 筛选，控制台勾了「排除标签」会静默无反应。

**断言**（临时启用 id=4/id=5 并挂标签 `x`，测完恢复 `enabled=false` 并删临时标签）：

| 场景 | 结果 |
|---|---|
| 基线（无排除） | 3 条 |
| exclude `x`（mode=all） | 2 条 |
| exclude `x`（mode=any） | 2 条 |
| exclude `x`+`i3`（mode=any） | 1 条 |
| exclude `x`+`i3`（mode=all） | 3 条 |
| exclude 不存在的标签 | 3 条 |

## 3. 规则求值与 geo 数据（本机）

**`fc/redirect/rules.js`** —— 纯函数、零依赖、可单测；口径对齐 `shlink/module/Core/src/RedirectRule/Entity/RedirectCondition.php`。

- 规则内条件 **AND**；空条件规则**永不命中**（对应 shlink 的 `conditions->count() > 0`）。
- 规则按 `priority` 升序，**第一条命中即用它的 longUrl**。
- 单条条件求值抛错 → 该条件判为不匹配，**不中断整条规则链**。
- geo 依赖注入（`geoLookup`，默认 `() => null`）→ 模块本身不读二进制，保持可独立单测、Node 18 兼容。

**`fc/redirect/china-geo.js` + `scripts/build-china-geo.mjs`** —— DB-IP City Lite mmdb → `china-geo.bin` 随包发布（不挂 Layer，避免 52MB Layer）。

- 二进制独立校验：**32 省名**（31 个有中文名 + 1 个空名条目，对应 3 条无 subdivision 的 CN 前缀）、**22,337 区间**、**0 重叠**、**0 provId 越界**。
- 抽样：`120.235.196.208 → 广东`、`8.147.181.152 → 北京`（这两个正是 LPM 归并修掉错配的样本）。
- 构建自检：120,141 前缀 → 22,337 区间 → **197KB / 201,523 字节**；**20 万随机 IP 对拍失配 0**，耗时约 50 秒。

> ⚠️ 坑：MMDB 树里同一个数据指针被多个前缀共享，必须按**最长前缀优先（LPM）**归并，否则约 0.66% 的 IP 会错配。DB-IP 的 subdivision **只有英文名**，中文名来自构建脚本内置的 31 条映射。

## 4. 兼容层

**代码**：`supabase/functions/compat/handler.ts`（全部逻辑，导出 `handleRequest`）+ `index.ts`（薄入口）+ `test/compat.test.ts`。

- 新增 `GET/POST|PATCH /short-urls/{code}/redirect-rules` → `get_short_url_redirect_rules` / `set_short_url_redirect_rules`（取代原先固定 501）。
- 11 种条件类型白名单 + 值域校验（`device` 8 值、`browser` 6 值、`ip-address` 支持静态地址/CIDR/通配符、`geolocation-country-code` 必两字母、`query-param` 不许空值），非法值 → 400 `invalid-data`，detail 指出是哪个值非法。
- `listShortUrls` 透传 `p_excluded_tags` / `p_excluded_tags_mode`。
- `VERSION` **4.0.0 → 5.1.0**（控制台靠 `version` 决定「跳转规则」页列出几种条件类型）。

**单测**：`deno test --allow-env` **30/30**（原 16 例 + 新增 14 例 I9 用例）；`deno check` 对入口/逻辑/测试全绿。

> 既有的 `deno lint` 告警 `deleteVisits`（`handler.ts:346`）缺 `await` **不是本次改动引入**，未动。

**部署**：`scripts/build-compat-function.mjs` → `functions-cli deploy compat -d supabase/functions/compat/dist --no-verify-jwt` → **status ACTIVE**（首次 500 `Failed to deploy Deno function`，重试即成功——平台已知偶发，见 `docs/reference/adb-supabase/README.md` 第 12 条）。

## 5. 线上实测（兼容层，2026-11-12）

| 项 | 请求 | 结果 |
|---|---|---|
| health | `GET /health` | 200 `{"status":"pass","version":"5.1.0"}` |
| 读规则 | `GET /short-urls/2b9yj/redirect-rules` | 200 `{"redirectRules":[],"defaultLongUrl":"https://example.com/a?x=1&y=2"}` |
| 写规则 | `POST …/redirect-rules`（`device=mobile`） | 200，`priority=1`，`conditions[0].matchKey=null` |
| 11 种类型 | `POST …/redirect-rules`（11 条规则） | 200，规则数 11，类型齐全，`priority` 1..11 递增 |
| 非法值 | `POST …/redirect-rules`（`device=desktop2`） | 400 `{"type":"https://shlink.io/api/error/invalid-data","detail":"\"desktop2\" is not a valid value for the \"DEVICE\" redirect condition"}` |
| 清空 | `POST …/redirect-rules`（`redirectRules:[]`） | 200，`redirectRules:[]` |

**seq 独立性线上复验**：改一次规则前后查库 →

| | 改前 | 改后 |
|---|---|---|
| `rules_version.seq` | 31 | **55**（bump） |
| `link_version.seq` | 101 | **101**（恒不动） |

**清理**：测试规则已清空 → `short_url_redirect_rule` 0 行 / `redirect_condition` 0 行。

## 6. 跳转函数（fc/redirect，本机）

**代码**：`fc/redirect/rules-cache.js`（新）+ `index.js` 接入 + `rules.js` + `china-geo.js` + `china-geo.bin`。

- `rules-cache.js`：独立的 `rules_version` 轮询通道（`RULES_POLL_MS`，默认 5s）；`get(shortUrlId)` → `rules[] | null`；**拉取失败保留旧快照**——规则缓存抖动不能把跳转打成 502。
- `pickRules()`：查库直读的 `rules`（`resolve_short` 带回，更鲜）优先于轮询快照；主快照命中时 `entry` 里没有 `rules` 字段，只能走规则缓存。
- `resolveTargetUrl()`：构造规则上下文求值，命中跳规则目标、不命中落回默认长链；`forward_query` 同样作用在规则目标上。
- geo 表**只在规则里真的出现 geo 条件时才读盘**（`GEO_CONDITION_TYPES` 判断）——200KB 的表不该为无关规则付代价。
- 像素路由 `/track` 不套用规则。

**单测**：`ipmat` 8/8、`rules` 20/20、`china-geo` 6/6、`redirect` **40/40**（原 32 + 新 8 条 I9 用例，含 2 条 geo 端到端用例；`china-geo.bin` 未构建时自动 skip）。

**打包**：`dist/redirect.zip` = **7 个文件**（`index.js` / `cache.js` / `ipmat.js` / `rules.js` / `rules-cache.js` / `china-geo.js` / `china-geo.bin`），141,217 字节。

> 计划里的代码块**全部先在本机实跑再落地**，抓出 4 处真 bug，其中两处是计划里的断言写错了：`forward_query` 为 true 时，query 会拼在**规则目标**上（`…/rule?src=wechat`）也会拼在**默认长链**上（`…/ok?src=other`），计划原本期望的是不带 query 的版本。

## 7. 待办（跳转侧线上验收，需用户先上传 zip）

- [ ] **用户上传 `dist/redirect.zip` 到 FC 跳转函数并部署**（FC 发布是控制台动作，脚本代劳不了）。
- [ ] 线上跳转验收：写一条 `query-param src=wechat` 规则 → `?src=wechat` 跳规则目标、`?src=other` 跳默认长链（写完**等 ≤6 秒**让规则缓存轮询到新 seq）。
- [ ] 线上 geo 条件验收：国内 IP 命中省名规则、境外 IP 不命中。
- [ ] 控制台界面人工验收：跳转规则页能存能删、条件类型下拉出 **11 种**、排除标签筛选生效、各页 Network 无 4xx（`mercure-info` 除外）。
- [ ] 性能抽查：有规则 vs 无规则，20 次最小耗时差 < 5ms。

**上传前的线上基线**（2026-11-12，旧代码）：

| 项 | 结果 |
|---|---|
| `GET /robots.txt` | 200（`User-agent: *` + `Allow: /9e6h3` + `Disallow: /`） |
| `GET /nosuch` | 404 |
| `GET /2b9yj/track` | 200 `Content-Type: image/gif` |
| `GET /2b9yj` | 302 → `https://example.com/a?x=1&y=2` |
| `Server-Timing` | `resolve;dur=0;cached=1`；`X-Link-Snapshot: 1|101|7215` |
| 性能 | 20 次取最小 **85.0ms** |

## 8. 测试汇总

| 套件 | 用例数 | 结果 |
|---|---|---|
| `fc/redirect/test/ipmat.test.js` | 8 | ✅ 全绿 |
| `fc/redirect/test/rules.test.js` | 20 | ✅ 全绿 |
| `fc/redirect/test/china-geo.test.js` | 6 | ✅ 全绿 |
| `fc/redirect/test/redirect.test.js` | 40 | ✅ 全绿 |
| `supabase/functions/compat/test/compat.test.ts` | 30 | ✅ 全绿 |
| `deno check`（compat 入口/逻辑/测试） | — | ✅ 干净 |
| **合计** | **104** | ✅ |

## 9. 遗留与口径

1. **`china-geo.bin` 是 gitignore 的构建产物**：换 DB-IP mmdb 后要 `node scripts/build-china-geo.mjs`（约 70 秒）并重打 `dist/redirect.zip`。
2. **geo 只覆盖中国大陆 31 省级**：`geolocation-country-code` 实际只匹配 `CN`；`geolocation-city-name` 匹配省名（中英文都认）；海外 IP 与 IPv6 一律不命中 geo 条件。这是刻意的范围裁剪，不是缺陷。
3. **UA 解析与上游有差异**（Android WebView 判为 chrome 而非 `android_browser`）；已在设计稿 §10.1 记为已知限制。
4. **平台网关会代替客户端跟随函数的 3xx 跳转**（只对 Edge Function 直返 302 成立）；跳转跑在 FC 侧，不受影响。
5. **规则生效有 ≤5s 延迟**（`RULES_POLL_MS`）。刚写完就 curl 可能拿到默认长链——这是设计，不是 bug。
