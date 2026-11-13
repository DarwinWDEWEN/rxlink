# I9 —— R9 动态跳转规则 验证记录

> 执行日期：2026-11-12。通道：`supabase db query --db-url`（逐条）、`functions-cli`、`curl`、Node 24 / Deno 2.9.7 测试。
> 状态：**已验收** —— 兼容层、数据面、跳转函数均已上线并线上复验（见 §7）。
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

## 7. 跳转侧线上验收（FC 已上传部署，2026-11-12）

用户把 `dist/redirect.zip` 上传到 FC 跳转函数并部署后，逐项线上实测。

**规则命中 / 不命中**（`query-param src=wechat`）：

| 请求 | Location |
|---|---|
| `GET /2b9yj?src=wechat` | `https://example.com/i9-mobile?src=wechat` |
| `GET /2b9yj?src=other` | `https://example.com/a?x=1&y=2&src=other`（默认长链 + forwardQuery） |
| `GET /2b9yj`（无 query） | `https://example.com/a?x=1&y=2` |

连测 3 次结果一致 → 不是新旧代码混跑。

**11 种条件类型逐条线上命中**（每条单独写规则、等 ≤7s 规则缓存生效、再 curl）：

| 条件 | 构造的请求 | 结果 |
|---|---|---|
| `device=mobile` | 移动 UA | ✅ 命中 |
| `device=ios` | iPhone UA | ✅ 命中 |
| `device=android` | Android UA | ✅ 命中 |
| `browser=chrome` | Chrome UA | ✅ 命中 |
| `language=zh-CN` | `Accept-Language: zh-CN,zh;q=0.9` | ✅ 命中 |
| `query-param src=wechat` | `?src=wechat` | ✅ 命中 |
| `any-value-query-param src` | `?src=x` | ✅ 命中 |
| `valueless-query-param src` | `?src`（无值） | ✅ 命中 |
| `ip-address=120.235.196.208` | 伪造 `x-forwarded-for` | ✅ 命中 |
| `ip-address=120.235.0.0/16` | 同上（CIDR） | ✅ 命中 |
| `geolocation-country-code=CN` | 广东 IP | ✅ 命中 |
| `geolocation-city-name=广东` | 广东 IP | ✅ 命中 |
| `geolocation-city-name=Guangdong` | 广东 IP | ✅ 命中（英文省名也认） |
| `before-date=2030-01-01` | 当前时间 | ✅ 命中 |
| `after-date=2020-01-01` | 当前时间 | ✅ 命中 |

**反向用例**：境外 IP `8.8.8.8` 配 geo 省名规则 → **不命中**（落回默认长链）；桌面 UA 配 `device=mobile` → **不命中**。

**像素路由不套用规则**：`GET /2b9yj/track?src=wechat`（规则此刻是命中的）→ 200 `image/gif`，无 Location。

**旧行为回归**：robots 200 / 陌生码 404 / 像素 200 / `/2b9yj` 302 默认长链，全部与 I8 口径一致。

## 7b. 控制台界面验收（浏览器实测）

控制台从 `GET /health` 的 `version` 驱动 feature flag（`shlink-web-client/src/servers/reducers/selectedServer.ts:24` → `health().then(({version}) => …)`）。web-component 的阈值表（`@shlinkio/shlink-web-component/dist/index.js` 的 `Ui`）：

| flag | minVersion | 5.1.0 下 |
|---|---|---|
| `ipRedirectCondition` | 4.2.0 | ✅ 开 |
| `geolocationRedirectCondition` | 4.3.0 | ✅ 开 |
| `advancedQueryRedirectConditions` | 4.5.0 | ✅ 开 |
| `desktopDeviceTypes` | 4.5.0 | ✅ 开 |
| `filterShortUrlsByExcludedTags` | 4.6.0 | ✅ 开 |
| `dateRedirectConditions` | 5.0.0 | ✅ 开 |
| `browserRedirectConditions` | **5.1.0** | ✅ 开（**选 5.1.0 正是为了这个**） |

> ⚠️ 若版本停在 4.x，控制台**根本不会显示** browser 条件与「排除标签」筛选器 —— 这就是版本旋钮要提到 5.1.0 的原因。

实测（`https://console.example.com`）：

| 项 | 结果 |
|---|---|
| 页脚版本 | `Server: v5.1.0 - Client: latest` |
| 跳转规则页 | 正常打开，显示已存规则与「If no conditions match, visitors will be redirected to: …」 |
| 条件类型下拉 | **11 种全在**：device / language / query-param / any-value-query-param / valueless-query-param / ip-address / geolocation-country-code / geolocation-city-name / before-date / after-date / browser |
| 设备值下拉 | **8 个**：Android / iOS / Any mobile device / Windows / MacOS / Linux / ChromeOS / Any desktop device |
| 新增规则并保存 | Network 面板 `POST /rest/v3/short-urls/2b9yj/redirect-rules` → **200**（不再是 501）；库里落库（id=35, device/mobile） |
| 删除规则并保存 | `POST …/redirect-rules` → **200**；库里 `short_url_redirect_rule` 0 行 / `redirect_condition` 0 行；页面显示「This short URL has no dynamic redirect rules」 |
| 「Without tags…」筛选器 | 出现，展开有 `Filter by excluded tag:` + `Mode: Any/All` |

> 交互口径（shlink 原生）：规则行上的垃圾桶**只改本地列表**，必须再点「Save rules」才落库；删除后页面上的「Redirect rules properly saved.」提示是上一次保存的残留 toast。Network 面板证实删除动作本身不发请求。

## 7c. 发现并修复的缺陷：多标签筛选被逗号串打哑

**现象**：控制台「排除标签」勾选后**结果条数不变**（静默无反应）。

**根因**：shlink 的 `tags` / `excludeTags` 走**逗号分隔**——上游有 `splitByComma()`（`shlink/module/Core/functions/functions.php:243`：`array_map(trim(...), explode(',', $value))`），web-component 也确实发的是 `excludeTags=i3,i4`（bundle 里 `excludeTags: s.length > 0 ? s.join(",") : void 0`）。而我们的兼容层只按数组参数取 `tags[]` / `tags`，**没有拆逗号** → `"i3,i4"` 被当成一个字面标签名 → `t.name = any(…)` 永不命中 → 筛选静默失效。

**影响面**：
- `excludeTags`（I9 新加）——完全失效。
- `tags`（**I5 起的既有缺陷**）——多标签筛选同样失效（单标签因无逗号而侥幸正常）。

**修复**（`handler.ts` 的 `parseTagList()`）：逗号串与数组写法都拆成数组再下发；`tagsMode` / `excludeTagsMode` 缺省值同时对齐上游的 `TagsMode::ANY`（原来是 `all`）。

**线上复验**（临时启用 id=4「compat1」(tag x) 与 id=11「i4v」(tag i4)，测完恢复 `enabled=false`）：

| 请求 | 修复前 | 修复后（期望） | 修复后（实测） |
|---|---|---|---|
| 无筛选 | 3 | 3 | 3 |
| `tags=i4,x` mode=any | 0 | 2 | **2** ✅ |
| `tags=i4,x` mode=all | 0 | 0 | 0 |
| `tags[]=i4&tags[]=x` mode=any | 2 | 2 | 2 |
| `excludeTags=i4,x` mode=any | 3 | 1 | **1** ✅ |
| `excludeTags=i4,x` mode=all | 3 | 3 | 3 |
| `excludeTags[]=i4&[]=x` mode=any | 1 | 1 | 1 |
| `tags=i4`（不带 mode，缺省 any） | 1 | 1 | 1 |

**UI 端到端**：控制台「Without tags…」填 `i3` + `i4` → URL 变成 `?excludeTags=i3%2Ci4`（正是逗号形态）→ 带 tag i4 的 i4v 被正确排除，列表只剩 2b9yj。

## 7d-1. 最终自审发现并修掉的健壮性问题

**畸形百分号编码导致 500**：`/short-urls/%ZZ/redirect-rules` 这类路径里 `decodeURIComponent('%ZZ')` 抛 `URIError`，被最外层 catch 兜成 **500 Internal error**。这是既有 5 处路由解码的通病（`/short-urls/{code}`、`/visits`、`/tags`、`/domains`），本次新增的规则路由沿用了同样的写法。修法：加 `safeDecode()`，解不出来就按原样传下去，走正常的「查不到」分支。

线上复验（修后）：`/short-urls/%ZZ/redirect-rules` / `/short-urls/%ZZ` / `/short-urls/%ZZ/visits` 全部 **400**（不再是 500）。

## 7d. 性能抽查

规则求值的**进程内真实开销**（20 万次微基准，用线上真实的 `rules.js`）：

| 环节 | 耗时 |
|---|---|
| `buildContext`（UA + Accept-Language 解析） | 0.858 µs/次 |
| `evaluate`（1 条规则 1 个条件） | 0.179 µs/次 |
| **完整热路径求值** | **0.980 µs/次** |

网络层 ABBA 交错对照（有规则 / 无规则各 30 次，顺序偏差已抵消）：

| | min | p50 | mean |
|---|---|---|---|
| 有规则 | 109.7ms | 149.8ms | 164.8ms |
| 无规则 | 99.1ms | 159.4ms | 169.1ms |

差异在噪声里且**符号会翻转**（p50/mean 反而是「有规则」更快）——即**测不出影响**。早先一次非交错测量的 16ms 差值是顺序偏差（同一 URL 连续两次请求，后发者系统性偏慢），不是规则求值的代价。

## 8. 测试汇总

| 套件 | 用例数 | 结果 |
|---|---|---|
| `fc/redirect/test/ipmat.test.js` | 8 | ✅ 全绿 |
| `fc/redirect/test/rules.test.js` | 20 | ✅ 全绿 |
| `fc/redirect/test/china-geo.test.js` | 6 | ✅ 全绿 |
| `fc/redirect/test/redirect.test.js` | 40 | ✅ 全绿 |
| `supabase/functions/compat/test/compat.test.ts` | 35 | ✅ 全绿 |
| `deno check`（compat 入口/逻辑/测试） | — | ✅ 干净 |
| **合计** | **109** | ✅ |

## 9. 遗留与口径

1. **`china-geo.bin` 是 gitignore 的构建产物**：换 DB-IP mmdb 后要 `node scripts/build-china-geo.mjs`（约 70 秒）并重打 `dist/redirect.zip`。
2. **geo 只覆盖中国大陆 31 省级**：`geolocation-country-code` 实际只匹配 `CN`；`geolocation-city-name` 匹配省名（中英文都认）；海外 IP 与 IPv6 一律不命中 geo 条件。这是刻意的范围裁剪，不是缺陷。
3. **UA 解析与上游有差异**（Android WebView 判为 chrome 而非 `android_browser`）；已在设计稿 §10.1 记为已知限制。
4. **平台网关会代替客户端跟随函数的 3xx 跳转**（只对 Edge Function 直返 302 成立）；跳转跑在 FC 侧，不受影响。
5. **规则生效有 ≤5s 延迟**（`RULES_POLL_MS`）。刚写完就 curl 可能拿到默认长链——这是设计，不是 bug。
6. **`tags` 的多标签筛选缺陷是 I5 起的既有欠账**，本次（I9）在实现 `excludeTags` 时发现并一并修掉了（见 §7c）。修的是兼容层的参数解析，`list_short_urls` 的 SQL 侧没动。
7. **`deno lint` 有一条既有告警**（`handler.ts:346` `deleteVisits` 缺 `await`），不是本次改动引入，未动。
8. **`longUrl` 不校验 URL 格式**（只要求非空）。上游 shlink 用 `#[LooseUriConverter]` 校验，但 rxlink 的**短链创建**（`createShortUrl` / `shorten`）同样不校验——这是 rxlink 既有的全局口径，不是 I9 引入的偏差。要跟上游对齐应作为跨切面改动单独做，不在 I9 范围内动。
9. **`CACHE_POLL_MS` / `RULES_POLL_MS` 没有下限保护**：设成 0 或负数会让 `setInterval` 变成紧凑循环（烧 CPU）。与 `cache.js` 同款写法，是既有模式；线上未设这两个变量（默认 5 秒），无实际风险。已记为**下一次 FC 发版**时一并加下限（本次不动 `fc/redirect/`，以保证线上包与源码逐字节一致——runbook §5.1 的前提）。
