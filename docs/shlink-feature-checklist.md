# shlink 功能清单 vs rxlink 复刻对照（2026-11-11）

> **用途**：回答「shlink 有的功能，rxlink 是否都复刻了」。
> **来源**：vendored 上游源码 `shlink/`（5.x，`UPGRADE.md` 最新段为 v4→v5）、`shlink-web-client/`（v4.9.0）+ `@shlinkio/shlink-web-component` 0.20.0 + `shlink-js-sdk` 3.2.1；rxlink 实现见 `supabase/functions/compat/handler.ts`（入口 `index.ts`）、`fc/redirect/`、`fc/console/`、`supabase/migrations/`。
> **口径**：✅ 已实现且验收；⚠️ 部分实现 / 降级 / 只读；❌ 未实现。**Shlink Plus（付费版）不在范围内**（用户已定：先验收，付费版之后再议）。
> **核对方法**：REST 动作逐条对 `shlink/config/autoload/routes.config.php` + 各 Action 的 `ROUTE_PATH` 常量；UI 逐条对 web-component 的路由表与 SDK 的端点清单；线上实测见文末「证据」。

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
| 7 | `singleStepCreateShortUrl` | GET `/short-urls/shorten` | ❌ | 控制台不调它（契约 §3 注）；属决策 D1 延伸，未实现 |
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

**小计：22 ✅ / 1 ⚠️ / 1 ❌。** 23 个契约方法（不含 `shorten`）里只剩 `mercureInfo` 是 404 降级；`setShortUrlRedirectRules` 自 I9 起不再是 501。

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
| API key 过期 | ✅（`expirationDate`） | ❌ | rxlink `api_key` 无 `expires_at` 列 |
| 跟踪开关 | ✅（env：disableTracking / disableIpTracking / disableReferrer / disableUa / anonymizeRemoteAddr / disableTrackParam / disableTrackingFrom） | ❌ | rxlink 无这些开关；原始 IP 走「富化后立即清空 + 7 天硬兜底」的隐私口径（见 `geo-enrichment.md`） |
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
| **中文界面** | — | ❌ | 上游仅英文且 issue #31 被 `wontfix`；用中文操作手册代替（`docs/manual/`） |

---

## D. 明确不做（YAGNI，已写进 `handover.md` §7.3）

多段 slug（D3）、存量数据搬迁（D5）、UV 口径（无 salt）、Mercure 实时推送、地理富化不进热路径、付费版功能。

---

## E. 结论与缺口（按建议优先级）

**已覆盖**：REST 22/24 动作；UI 21 项功能里 18 项全通、2 项降级（域名红标 / 实时更新）、1 项无（中文界面）；核心链路（跳转 / 统计 / 标签 / 域名 / 地理 / 404 回退 / 死链清理 / **动态跳转规则**）全部上线并验收。

| 优先级 | 缺口 | 成本 | 建议 |
|---|---|---|---|
| 中 | `robots.txt`（`crawlable` 字段现在无效） | 低（跳转函数加一个分支） | 要做就顺手做，对 SEO 有意义 |
| 中 | 追踪像素 `/{code}/track` | 低（返回 1×1 gif + 记一条访问） | 有邮件追踪需求再做 |
| 低 | API key 过期 | 低（加列 + 鉴权检查） | 角色已上游废弃，可只做过期 |
| 低 | 时区字段 | 中（换带 `time_zone` 的 mmdb 源） | 控制台不渲染，可不做 |
| 低 | CLI / Matomo / Importer | 高 | 运营增强，非核心；按需 |

---

## 证据

- REST 动作清单：`shlink/config/autoload/routes.config.php` + `module/Rest/src/Action/**` 的 `ROUTE_PATH` 常量（24 条）。
- UI 路由清单：`shlink-web-client/src/app/App.tsx:49-62` + `@shlinkio/shlink-web-component/dist/index.js:7211-7286` + `settings-BOILmGcF.js:529-564`。
- SDK 端点清单：`@shlinkio/shlink-js-sdk/dist/` 中出现的路径（`/short-urls`、`/short-urls/{code}`、`/short-urls/{code}/visits`、`/short-urls/{code}/redirect-rules`、`/tags`、`/tags/stats`、`/tags/{tag}/visits`、`/visits`、`/visits/orphan`、`/visits/non-orphan`、`/domains`、`/domains/redirects`、`/domains/{domain}/visits`、`/health`、`/mercure-info`）——**不含 `/short-urls/shorten`**，与契约 §3 注一致。
- 线上实测（2026-11-12）：`https://example.com/robots.txt` → **200**（含 `Allow: /9e6h3`）；`https://example.com/2b9yj/track` → **200**（`Content-Type: image/gif`）；`/2b9yj` → **302**。
- 跳转规则端点（I9）：`supabase/functions/compat/handler.ts` 的 `GET|POST|PATCH /short-urls/{code}/redirect-rules`；条件类型白名单与值域校验见同文件 `CONDITION_TYPES` / `validateCondition`。
- Mercure 404：`supabase/functions/compat/handler.ts` 的 `/mercure-info` 分支。
- API key 角色未校验：`supabase/functions/compat/handler.ts:123-131`（`authenticate` 只查 `api_key`，不查 `api_key_role`）；上游 `module/Rest/src/ApiKey/Role.php` 标注 `@deprecated`。
- 中文界面结论：`shlink-web-client/src` 全量 grep 无 i18n；上游 issue `shlinkio/shlink-web-client#31` 状态 `wontfix`（2018-11-02）。
