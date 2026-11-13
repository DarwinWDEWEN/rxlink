# shlink 功能清单 vs rxlink 复刻对照（2026-11-12 订正）

> **用途**：回答「shlink 有的功能，rxlink 是否都复刻了」。
> **来源**：vendored 上游源码 `shlink/`（5.x，`UPGRADE.md` 最新段为 v4→v5）、`shlink-web-client/`（v4.9.0）+ `@shlinkio/shlink-web-component` 0.20.0 + `shlink-js-sdk` 3.2.1；rxlink 实现见 `supabase/functions/compat/handler.ts`（入口 `index.ts`）、`fc/redirect/`、`fc/console/`、`supabase/migrations/`。
> **口径**：✅ 已实现且验收；⚠️ 部分实现 / 降级 / 只读；❌ 未实现。**Shlink Plus（付费版）不在范围内**（用户已定：先验收，付费版之后再议）。
> **核对方法**：REST 动作逐条对 `shlink/config/autoload/routes.config.php` + 各 Action 的 `ROUTE_PATH` 常量；UI 逐条对 web-component 的路由表与 SDK 的端点清单；线上实测见文末「证据」。
> **2026-11-12 订正**：本清单此前列在 `singleStepCreateShortUrl` / 追踪开关 / API key 过期 的 3 处 ❌ 均为**陈旧**（I8 的 R4/R8/R6 已实现，只是清单没跟着更新）。本轮逐条做了线上复核，证据见文末。

---

## A. REST API —— 24 个动作（契约文档按 23 个方法统计，不含 `/short-urls/shorten`）

| # | shlink 动作 | 方法 + 路径 | rxlink | 说明 |
|---|---|---|---|---|
| 1 | `health` | GET `/health` | ✅ | 不校验 key，返回 `{status:'pass',version:'5.1.0'}` |
| 2 | `listShortUrls` | GET `/short-urls` | ✅ | 搜索/标签（all·any）/域名/时间区间/排除max·过期/排序/分页全支持 |
| 3 | `createShortUrl` | POST `/short-urls` | ✅ | 自定义 slug、短码长度、findIfExists、标签、标题、crawlable、forwardQuery、有效期、maxVisits、**未填标题时自动抓目标页 `<title>`**（I10；env `AUTO_RESOLVE_TITLES` 控制，我们默认开，上游默认关） |
| 4 | `getShortUrl` | GET `/short-urls/{code}` | ✅ | 含 `domain` 查询参数 |
| 5 | `updateShortUrl` | PATCH `/short-urls/{code}` | ✅ | 整组替换标签、**改长链时刷新自动解析的标题（手填标题不被覆盖）** |
| 6 | `deleteShortUrl` | DELETE `/short-urls/{code}` | ✅ | 软删（`enabled=false`） |
| 7 | `singleStepCreateShortUrl` | GET `/short-urls/shorten` | ✅ | **I8/R4 已实现**：query 或 header 鉴权都认（shlink 唯一的 query 鉴权例外）、支持 `format=txt` 纯文本、`domain` 参数；5 条单测 |
| 8 | `getShortUrlVisits` | GET `/short-urls/{code}/visits` | ✅ | 时间区间 / excludeBots / 分页 |
| 9 | `deleteShortUrlVisits` | DELETE `/short-urls/{code}/visits` | ✅ | 返回 `{deletedVisits}` |
| 10 | `getTagVisits` | GET `/tags/{tag}/visits` | ✅ | |
| 11 | `getDomainVisits` | GET `/domains/{domain}/visits` | ✅ | |
| 12 | `getVisitsOverview` | GET `/visits` | ✅ | `{nonOrphanVisits, orphanVisits}`，各带 bots 拆分 |
| 13 | `getOrphanVisits` | GET `/visits/orphan` | ✅ | 三类孤儿（`base_url`/`invalid_short_url`/`regular_404`） |
| 14 | `deleteOrphanVisits` | DELETE `/visits/orphan` | ✅ | 返回 `{deletedVisits}` |
| 15 | `getNonOrphanVisits` | GET `/visits/non-orphan` | ✅ | |
| 16 | `listTags` | GET `/tags` | ✅ | |
| 17 | `tagsStats` | GET `/tags/stats` | ✅ | 每条带 `visitsSummary` |
| 18 | `editTag` | PUT `/tags` | ✅ | `{oldName,newName}`，空响应 |
| 19 | `deleteTags` | DELETE `/tags` | ✅ | `tags[]` 查询串，空响应 |
| 20 | `listDomains` | GET `/domains` | ✅ | 含 `defaultRedirects` |
| 21 | `editDomainRedirects` | PATCH `/domains/redirects` | ✅ | 三项回退地址 |
| 22 | `getShortUrlRedirectRules` | GET `/short-urls/{code}/redirect-rules` | ✅ | 返回 `{defaultLongUrl, redirectRules}`，**真读规则表**（I9） |
| 23 | `setShortUrlRedirectRules` | POST/PATCH `/short-urls/{code}/redirect-rules` | ✅ | **I9 已实现**：11 种条件类型 + 值域校验，非法值 400 `invalid-data` |
| 24 | `mercureInfo` | GET `/mercure-info` | ⚠️ | **404 `MERCURE_NOT_CONFIGURED`**（未配置 Mercure，界面自动降级） |

**小计：23 ✅ / 1 ⚠️ / 0 ❌。** 24 个动作里唯一非 ✅ 的是 `mercureInfo` —— 404 `MERCURE_NOT_CONFIGURED` 降级（平台无 Realtime/Mercure 对应物，已定不做）；`setShortUrlRedirectRules` 自 I9 起不再是 501，`singleStepCreateShortUrl` 自 I8 起已实现。

---

## B. 服务端非 REST 能力

| 能力 | shlink | rxlink | 说明 |
|---|---|---|---|
| 短链跳转 `/{code}` | ✅ | ✅ | 302 固定；实例内存快照 + `link_version` 失效；forwardQuery、有效期、maxVisits、停用、404 回退（域名级优先/占位符/双斜杠折叠） |
| 追踪像素 `/{code}/track` | ✅ | ✅ | 1×1 gif（`image/gif`），用于邮件/埋点追踪；**线上实测 200** |
| `robots.txt` | ✅ | ✅ | 按 `crawlable` 列出 `Allow: /<码>` + `Disallow: /`；**线上实测 200** |
| QR 码 | ✅（v5 起客户端生成，服务端无 `/qr-code` 路由） | ✅ | 控制台内生成，口径一致 |
| 多段 slug / extraPath | ✅（default/append/ignore 三模式） | ❌ | **D3 本期不支持**；短码锁单段 `[a-z0-9_-]{1,64}` |
| 动态跳转规则 | ✅ | ✅ | **I9 已实现**：device / browser / language / query-param / any-value-query-param / valueless-query-param / ip-address / geolocation-country-code / geolocation-city-name / before-date / after-date。规则保存不 bump `link_version`，走独立 `rules_version` |
| 地理定位 | ✅（GeoLite2） | ✅ | DB-IP City Lite（免 key、可商用）；**无 `time_zone` 字段** → `visit.timezone` 恒 NULL |
| Bot 识别 | ✅（crawler-detect 库） | ✅ | rxlink 用 `ua_rule` 规则表 + `ua_parse`，覆盖较简 |
| API key 角色/作用域 | ✅（**上游已标 `@deprecated`**） | ⚠️ | rxlink 有 `api_key_role` 表结构，但兼容层 `authenticate()` 只校验 key 有效性，不校验角色 |
| API key 过期 | ✅（`expirationDate`） | ✅ | **I8/R6 已实现**：迁移 `0015_api_key_expires_at.sql` 加 `expires_at` 列 + `compat_auth` 判过期；**线上实测过期 key → 401 `invalid-api-key`（文案含 "has expired"）** |
| 跟踪开关 | ✅（env：disableTracking / disableIpTracking / disableReferrer / disableUa / anonymizeRemoteAddr / disableTrackParam / disableTrackingFrom） | ✅ | **I8/R8 已实现**：6 个开关全在 `fc/redirect/index.js`（`DISABLE_TRACKING` / `DISABLE_IP_TRACKING` / `DISABLE_REFERRER_TRACKING` / `DISABLE_UA_TRACKING` / `DISABLE_TRACK_PARAM` / `DISABLE_TRACKING_FROM`），默认全关（与上游一致）；`anonymizeRemoteAddr` 由「富化后立即清空 + 7 天硬兜底」的口径替代 |
| Matomo 集成 | ✅（访问上报 + CLI `matomo:send-visits`） | ❌ | — |
| 导入其他平台短链 | ✅（`shlinkio/shlink-importer`） | ❌ | — |
| CLI（31 个命令） | ✅ | ❌ | rxlink 用脚本代替（`new-api-key.sh`、`build-*.mjs`），无交互式 CLI |
| Mercure 实时推送 | ✅ | ❌ | 未配置；控制台实时开关降级 |
| 多域名 + 域名级 404 回退 | ✅ | ✅ | 0011（`not_found_redirects` RPC） |
| 死链清理 | ❌（shlink 无此功能） | ✅ | rxlink 自有：`prune_dead_links(180)`，cron job 8 |

---

## C. 控制台 UI 功能（shlink-web-client v4.9.0）

rxlink 控制台直接用同一套 build 产物，因此**页面与交互全部存在**；差异只在「某些页面背后的 API 是否完整」。

| 页面 / 功能 | 路由 | rxlink | 说明 |
|---|---|---|---|
| 概览 Overview | `/overview` | ✅ | 非孤儿/孤儿访问、bots 拆分 |
| 短链列表 | `/list-short-urls/:page` | ✅ | 搜索、标签（all/any）、域名、时间区间、排除 max·过期、排序、分页 |
| 创建短链 | `/create-short-url` | ✅ | |
| 编辑短链 | `/short-code/:shortCode/edit` | ✅ | |
| 短链访问明细 | `/short-code/:shortCode/visits` | ✅ | 地理列（DB-IP 结果） |
| 跳转规则 | `/short-code/:shortCode/redirect-rules` | ✅ | 可读可存；条件类型下拉随兼容层 `version` 决定（≥5.1.0 出 11 种） |
| 对比访问（短链） | `/short-urls/compare-visits` | ✅ | 客户端对比，调同一批 visits 端点 |
| 标签访问 | `/tag/:tag/visits` | ✅ | |
| 对比访问（标签） | `/tags/compare-visits` | ✅ | |
| 域名访问 | `/domain/:domain/visits` | ✅ | |
| 孤儿访问 | `/orphan-visits` | ✅ | |
| 非孤儿访问 | `/non-orphan-visits` | ✅ | |
| 管理标签 | `/manage-tags` | ✅ | 新建/改名/删除/统计 |
| 管理域名 | `/manage-domains` | ⚠️ | 域名红标（`/health` 在域名维度 404，I0 已决定先接受） |
| 对比访问（域名） | `/domains/compare-visits` | ✅ | |
| 设置（General / Short URLs / Visits / Tags / QR codes） | `/settings/*` | ✅ | 客户端本地设置（主题、默认短码长度、列表口径、QR 样式等） |
| 服务器管理（添加/编辑/切换） | `/manage-servers`、`/server/create`、`/server/:id/edit` | ✅ | 本地 localStorage |
| QR 码生成 | 短链详情页按钮 | ✅ | 客户端生成 |
| PWA / Service Worker | — | ✅ | 不缓存 API 响应 |
| 实时更新（Mercure） | 设置页开关 | ⚠️ | 端点 404，降级为轮询 |
| **中文界面** | — | ✅ | 构建期字面量替换（I12）；只翻界面文案，国家名 / 浏览器名 / OS 名保留英文 |

---

## D. 明确不做（YAGNI，已写进 `handover.md` §7.3）

多段 slug（D3）、存量数据搬迁（D5）、UV 口径（无 salt）、Mercure 实时推送、地理富化不进热路径、付费版功能。

---

## E. 结论与缺口（按建议优先级）

**已覆盖**：REST **23/24** 动作（唯一 ⚠ 是 `mercureInfo` 404 降级，平台无对应物）；UI 21 项功能里 19 项全通、2 项降级（域名红标 / 实时更新降级为轮询）；服务端非 REST 能力里核心链路（跳转 / 统计 / 标签 / 域名 / 地理 / 404 回退 / 死链清理 / robots / 追踪像素 / **动态跳转规则** / **标题自动解析** / **中文界面**）全部上线并验收。

| 优先级 | 缺口 | 成本 | 建议 |
|---|---|---|---|
| 低 | API key 角色/作用域校验 | 低 | 上游已标 `@deprecated` → **建议不做** |
| 低 | 时区字段（`visit.timezone` 恒 NULL） | 中（换带 `time_zone` 的 mmdb 源） | 控制台不渲染，可不做 |
| 低 | CLI / Matomo / Importer | 高 | 运营增强，非核心；按需 |
| — | 实时推送（Mercure） | 中 | 平台无 Realtime/RabbitMQ/Redis 对应物 → 明确不做，控制台降级轮询 |
| — | 多段 slug | — | D3 排除 → 明确不做（中文界面已由 I12 实现） |

> **已订正（2026-11-12）**：原表里的 `robots.txt`、追踪像素、`API key 过期` 三项在 I8（R3/R6/R8）就已实现，本表已移除；`singleStepCreateShortUrl` 同理（I8/R4）。

---

## 证据

- REST 动作清单：`shlink/config/autoload/routes.config.php` + `module/Rest/src/Action/**` 的 `ROUTE_PATH` 常量（24 条）。
- UI 路由清单：`shlink-web-client/src/app/App.tsx:49-62` + `@shlinkio/shlink-web-component/dist/index.js:7211-7286` + `settings-BOILmGcF.js:529-564`。
- SDK 端点清单：`@shlinkio/shlink-js-sdk/dist/` 中出现的路径（`/short-urls`、`/short-urls/{code}`、`/short-urls/{code}/visits`、`/short-urls/{code}/redirect-rules`、`/tags`、`/tags/stats`、`/tags/{tag}/visits`、`/visits`、`/visits/orphan`、`/visits/non-orphan`、`/domains`、`/domains/redirects`、`/domains/{domain}/visits`、`/health`、`/mercure-info`）——**不含 `/short-urls/shorten`**，与契约 §3 注一致。
- 线上实测（2026-11-12）：`https://example.com/robots.txt` → **200**（含 `Allow: /9e6h3`）；`https://example.com/2b9yj/track` → **200**（`Content-Type: image/gif`）；`/2b9yj` → **302**。
- 跳转规则端点（I9）：`supabase/functions/compat/handler.ts` 的 `GET|POST|PATCH /short-urls/{code}/redirect-rules`；条件类型白名单与值域校验见同文件 `CONDITION_TYPES` / `validateCondition`。
- Mercure 404：`supabase/functions/compat/handler.ts` 的 `/mercure-info` 分支。
- API key 角色未校验：`supabase/functions/compat/handler.ts:123-131`（`authenticate` 只查 `api_key`，不查 `api_key_role`）；上游 `module/Rest/src/ApiKey/Role.php` 标注 `@deprecated`。
- 中文界面结论：`shlink-web-client/src` 全量 grep 无 i18n；上游 issue `shlinkio/shlink-web-client#31` 状态 `wontfix`（2018-11-02）→ **I12 用构建期字面量替换自行实现**（`scripts/i18n/`，见 `docs/verification/i12-results.md`）。

### 2026-11-12 订正轮的线上复核（逐条实测，非读代码推断）

| 结论 | 怎么验的 | 结果 |
|---|---|---|
| `singleStepCreateShortUrl` 已实现 | `GET /rest/v3/short-urls/shorten?longUrl=…&apiKey=…` | **200** + JSON；`&format=txt` → **200** 纯文本短链 |
| API key 过期已生效 | 用 `expires_at=2020-01-01` 的 key 调 `/short-urls` | **401** `invalid-api-key`，detail 含 "has expired" |
| 追踪开关 6 个都在已上传的 FC 包里 | `unzip -p dist/redirect.zip index.js \| grep DISABLE_` | 6 个开关全部命中（`DISABLE_TRACKING` / `_IP_` / `_REFERRER_` / `_UA_` / `DISABLE_TRACK_PARAM` / `_TRACKING_FROM`） |
| 追踪链路完好 | 访问新链 → 查 `visit` / `visit_inbox` | `visit` 2 行；`visit_inbox` 2 行且 `processed_at` 已置、`remote_addr` 已清空；全库 `processed_at is null` = **0** 行 |
| 跳转是真的（不是 404 回退） | `curl -D-` 看 Location | `HTTP/1.1 302` + `Location: https://example.com/r11`（目标即长链） |
| DB-IP 署名已上线（handover 说「待重传 console.zip」是陈旧项） | `curl https://console.example.com/ \| grep DB-IP` | 命中（页脚已含 `IP Geolocation by DB-IP`） |
