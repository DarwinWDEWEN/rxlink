# shlink 兼容层字段契约（v1.0，2026-11-09）

> 目的：`shlink-web-client` 一行不改地连上我们，靠的是「接口形状一字不差」。这份文档把 SDK 里的 23 个方法、18 条路径、40 个类型逐字段摊开，右侧接我们的 0004 表/RPC，凡是我们数据模型没覆盖到的字段都单独列出来。
> 契约存档：`docs/reference/shlink-sdk-3.2.1/`（`@shlinkio/shlink-js-sdk@3.2.1` 的逐字节副本 + tarball integrity）。以下所有 `index.js:行` 都指这个副本。
> 版本：web-client `4.9.0`（2026-10-31 发）/ `@shlinkio/shlink-web-component@0.20.0` / SDK `3.2.1`。三者在 `shlink-web-client/package-lock.json` 里锁死。
> **纠偏**：此前文档里写的「27 个方法」是错的。`ShlinkApiClient.d.ts` 实际是 **23 个方法**（含 `constructor` 共 24 行），`api-contract/ShlinkApiClient.d.ts` 的接口定义同样是 23 个。

---

## 1. 结论先行（实现前必须知道的 6 件事）

1. **只认 `/rest/v3`**：SDK 把版本号写死成 3（`index.js:21` 的 `this.#e = 3`），base = `${baseUrl}/rest/v3`（`index.js:1`）。v1/v2 不用做。
2. **控制台的「服务器地址」可以带路径**：因为 SDK 只是追加 `/rest/v3`，所以把 server URL 填成 `https://<api-host>/functions/v1/compat` 就会打到 `.../functions/v1/compat/rest/v3/...`。兼容层不需要任何 URL 重写。
3. **`/health` 是唯一的连通性闸门**：web-client 选中服务器时先打 `health()`，拿不到合法 semver 就整台服务器标红「不可达」（`src/servers/reducers/selectedServer.ts:21-28,51-62`）。它同时是**能力开关**——见 §5。
4. **非 2xx 一律 `throw` 响应体 JSON**（`@shlinkio/shlink-js-sdk` 的 `FetchHttpClient`：`if (!r.ok) throw i`），所以错误必须是 JSON 对象，裸文本会让界面报 `Unexpected token`。
5. **鉴权只有一个头**：`X-Api-Key`（`index.js:215`）。没有 cookie、没有 Bearer。必然引出一张 `api_key` 表——这是复用 web-client 的代价，不是可选设计。
6. **域名健康检查会打到每个短链域名上**：`health({ domain })` 会把 baseUrl 的 authority 换成该域名、**路径原样保留**（`index.js:7-11,212`）。也就是说 `https://api.xxx/functions/v1/compat/rest/v3/health` 在检查 `example.com` 时会变成 `https://example.com/functions/v1/compat/rest/v3/health`。见 §6 坑 3。

---

## 2. 传输层约定（逐条都有出处）

| 项 | 规则 | 出处 |
|---|---|---|
| base | `${baseUrl}/rest/v3`（baseUrl 末尾斜杠不清理） | `index.js:1,212` |
| 鉴权头 | `X-Api-Key: <key>` | `index.js:215` |
| 其他头 | 只在有 body 时加 `Content-Type: application/json`；无 body 不加 | SDK `FetchHttpClient`（`dist/fetch.js:1-8`） |
| body | `JSON.stringify`，仅 POST/PATCH/PUT | `index.js:214` |
| credentials | 默认不带；web-client 勾了「转发凭证」才 `credentials:'include'` | `src/api/services/ShlinkApiClientBuilder.ts:36` |
| 数组参数 | 展开成 `name[]=a&name[]=b`（注意带方括号） | `index.js:13` |
| `null`/`undefined` 参数 | 整个丢掉，不出现 `=null` | `index.js:13` |
| 布尔参数 | 序列化成字符串 `"true"`，且只在 `=== true` 时才发 | `index.js:4-5` |
| `orderBy` | 折叠成单个 `orderBy=<field>-<DIR>`，不是 `orderBy[field]` | `index.js:2` |
| 分页 | `page`（**字符串**）+ `itemsPerPage`（数字） | `types.d.ts:161-163` |
| 响应包装 | 列表类不直接返回数组：`shortUrls` / `visits` / `tags` / `domains` 各包一层，SDK 负责解包 | `index.js:28,125,147,153,181` |
| 错误体 | RFC7807 形状 `{type,detail,title,status,extra...}`，`type` 用 `https://shlink.io/api/error/*` | `errors.d.ts:4-19,23-29` |
| 版本前缀 | 只有 `/rest/health` 免版本；我们不需要 | shlink `module/Rest/src/ConfigProvider.php:24-49` |

**CORS（我们现在还没有任何实测）**：控制台是独立静态站，跨域调 Edge Function；因为带 `X-Api-Key` + `Content-Type: application/json`，**每个写请求都会先发 OPTIONS 预检**。兼容层必须自己应答 OPTIONS（204 + `Access-Control-Allow-Headers: X-Api-Key, Content-Type` + `Allow-Methods: GET,POST,PATCH,PUT,DELETE,OPTIONS`）。若用户勾了「转发凭证」（`credentials:'include'`），则 `Allow-Origin` **不能**是 `*`，必须回显 Origin 并加 `Allow-Credentials: true`。网关是否替我们应答 OPTIONS 未验证，列入 §8 验收。

---

## 3. 23 个方法 → 18 条路径（实现顺序就是批次顺序）

批次：**B1** 短链读写；**B2** 访问统计；**B3** 标签；**B4** 域名/健康/Mercure/跳转规则。每批做完就能在浏览器里跑通对应页面。

| # | 方法 | HTTP | 路径 | 入参位置 | 响应包装 → 返回类型 | 落点 | 批 |
|---|---|---|---|---|---|---|---|
| 1 | `listShortUrls` | GET | `/short-urls` | query | `{shortUrls}` → `ShlinkShortUrlsList` | `SQL` 视图 + RPC（筛选/排序/分页） | B1 |
| 2 | `createShortUrl` | POST | `/short-urls` | body | — → `ShlinkShortUrl` | `SQL` RPC `create_short_url` | B1 |
| 3 | `getShortUrl` | GET | `/short-urls/{code}` | query `domain` | — → `ShlinkShortUrl` | `SQL` 视图 | B1 |
| 4 | `updateShortUrl` | PATCH | `/short-urls/{code}` | query `domain` + body | — → `ShlinkShortUrl` | `SQL` RPC | B1 |
| 5 | `deleteShortUrl` | DELETE | `/short-urls/{code}` | query `domain` | 空响应（SDK 不解析 body） | `SQL` 软删 RPC | B1 |
| 6 | `getVisitsOverview` | GET | `/visits` | — | `{visits}` → `ShlinkVisitsOverview` | `SQL` 聚合 | B2 |
| 7 | `getShortUrlVisits` | GET | `/short-urls/{code}/visits` | query（含 `domain`） | `{visits}` → `ShlinkVisitsList` | `SQL` 视图 | B2 |
| 8 | `deleteShortUrlVisits` | DELETE | `/short-urls/{code}/visits` | query `domain` | — → `{deletedVisits}` | `SQL` RPC | B2 |
| 9 | `getTagVisits` | GET | `/tags/{tag}/visits` | query（含 `domain`） | `{visits}` → `ShlinkVisitsList` | `SQL` 视图 | B2 |
| 10 | `getDomainVisits` | GET | `/domains/{domain}/visits` | query | `{visits}` → `ShlinkVisitsList` | `SQL` 视图 | B2 |
| 11 | `getOrphanVisits` | GET | `/visits/orphan` | query（含 `type`） | `{visits}` → `ShlinkVisitsList` | `SQL` 视图 | B2 |
| 12 | `deleteOrphanVisits` | DELETE | `/visits/orphan` | — | — → `{deletedVisits}` | `SQL` RPC | B2 |
| 13 | `getNonOrphanVisits` | GET | `/visits/non-orphan` | query（含 `domain`） | `{visits}` → `ShlinkVisitsList` | `SQL` 视图 | B2 |
| 14 | `listTags` | GET | `/tags` | — | `{tags}` → `ShlinkTagsList` | `SQL` | B3 |
| 15 | `tagsStats` | GET | `/tags/stats` | — | `{tags}` → `ShlinkTagsStatsList` | `SQL` 聚合 | B3 |
| 16 | `deleteTags` | DELETE | `/tags` | query `tags[]` | 空响应（客户端自己回填 `{tags}`） | `SQL` RPC | B3 |
| 17 | `editTag` | PUT | `/tags` | body `{oldName,newName}` | 空响应（客户端自己回填 `ShlinkRenaming`） | `SQL` RPC | B3 |
| 18 | `listDomains` | GET | `/domains` | — | `{domains}` → `ShlinkDomainsList` | `SQL` + 云侧状态另算 | B4 |
| 19 | `editDomainRedirects` | PATCH | `/domains/redirects` | body（`domain` + 部分三列） | — → `ShlinkDomainRedirects` | `SQL` 更新 | B4 |
| 20 | `health` | GET | `/health`（`domain` 会换 authority） | query `domain` | — → `ShlinkHealth` | `GW` 常量 + 版本旋钮 | B4（**必须最先）** |
| 21 | `mercureInfo` | GET | `/mercure-info` | — | — → `ShlinkMercureInfo` | 故意失败（降级见坑 4） | B4 |
| 22 | `getShortUrlRedirectRules` | GET | `/short-urls/{code}/redirect-rules` | query `domain` | — → `ShlinkRedirectRulesList` | M3 建表前先返回空规则 | B4 |
| 23 | `setShortUrlRedirectRules` | POST | `/short-urls/{code}/redirect-rules` | query `domain` + body | — → `ShlinkRedirectRulesList` | M3 前返回 501 或空实现 | B4 |

去重后 **18 条路径**（`/short-urls`、`/short-urls/{code}/visits`、`/visits/orphan`、`/tags`、`/short-urls/{code}/redirect-rules` 各挂两个方法；`/domains/{domain}/visits` 与 `/short-urls/{code}` 的 `{code}` 是同一种占位）。

**不在 SDK 里的端点**：`/short-urls/shorten`（单步建链，给书签/分享按钮用的）**不会被控制台调用**。要不要给第三方留着，属决策 D1 的延伸，不影响兼容层最小集。

---

## 4. 40 个类型 → 字段字典

只列有信息量的 12 个核心类型；其余是它们的组合或参数别名。标「必须」= 类型上不可省，缺席会让 React 渲染出 `undefined`。

### 4.1 `ShlinkShortUrl`（列表与详情共用，`types.d.ts:16-31`）

| 字段 | 类型 | 必须 | 我们的来源 | 备注 |
|---|---|---|---|---|
| `shortCode` | string | ✅ | `short_url.short_code` | 入库已统一小写 |
| `domain` | string \| null | ✅ | `short_url.domain` | 我们全局短码存 `''` 哨兵 → **必须序列化成 `null`**，不能输出空串 |
| `shortUrl` | string | ✅ | 由 `domain` + `shortCode` + 协议拼 | 全局短码用配置里的默认域名拼 |
| `longUrl` | string | ✅ | `short_url.long_url` | |
| `dateCreated` | string | ✅ | `created_at` | 带时区偏移的 ISO8601 |
| `visitsSummary` | `{total,nonBots,bots}` | ✅ | 计数表 `SUM(count)` 按 `potential_bot` 分 | **列表每行都要**，N+1 查询会拖死列表页 → 用视图一次 group |
| `meta` | `{validSince,validUntil,maxVisits}` 且三键必在、值可 null | ✅ | 三个列 | 少一个键就是 `undefined`，界面显示异常 |
| `tags` | string[] | ✅ | `short_url_tag` join | 空数组，不是 null |
| `title` | string \| null | 可选 | `short_url.title` | |
| `crawlable` | boolean | 可选 | `short_url.crawlable` | |
| `forwardQuery` | boolean | 可选 | `short_url.forward_query` | |
| `hasRedirectRules` | boolean | 可选（4.3.0+） | 规则表 `EXISTS` | M3 前恒 `false` |

### 4.2 写入载荷（`types.d.ts:32-48`）

- `ShlinkEditShortUrlData`：`longUrl`、`title`、`tags`（**整组替换**）、`crawlable`、`forwardQuery`、`validSince`、`validUntil`、`maxVisits`；清空用显式 `null`。
- `ShlinkCreateShortUrlData`：在上面基础上加 `customSlug`、`shortCodeLength`、`domain`、`findIfExists`。
- **SDK 会把 body 里的 falsy 值整个丢掉**（`index.js:31` 的 `n && (e[t] = n)`）⇒ `crawlable: false`、`maxVisits: 0` 永远不会发到服务端。所以「取消勾选 crawlable」只能走 PATCH，而 PATCH 不过滤（`index.js:54-61` 原样透传）。这条决定了创建和编辑不能共用一条写路径。

### 4.3 `ShlinkVisit`（`types.d.ts:93-112`）

| 字段 | 类型 | 我们的来源 |
|---|---|---|
| `date` | string | `visit.visited_at` |
| `referer` | string | `visit.referer`（入库前截断 1024） |
| `userAgent` | string | `visit.user_agent`（截断 512） |
| `potentialBot` | boolean | `visit.potential_bot` |
| `visitLocation` | 对象 \| **null** | M1/M2 恒 `null`（不定位） |
| `visitedUrl` | string（孤儿必填） | `visit.visited_url`（截断 2048） |
| `redirectUrl` | string \| null | `visit.redirect_url` ← **我们现有设计里没有这一列，0004 要补** |
| `type` | `base_url`\|`invalid_short_url`\|`regular_404` | 仅孤儿访问，`visit.orphan_type` |

### 4.4 其余关键结构

| 类型 | 形状 | 备注 |
|---|---|---|
| `ShlinkPaginator` | `{currentPage,pagesCount,totalItems}` | 空结果时 `pagesCount:0` 而不是 1，界面才能出空态 |
| `ShlinkVisitsSummary` | `{total,nonBots,bots}` | `total` **包含** bot |
| `ShlinkVisitsOverview` | `{nonOrphanVisits,orphanVisits}` | 两个都是 Summary，不是数字 |
| `ShlinkTagsStats` | `{tag,shortUrlsCount,visitsSummary}` | 每条标签都要 Summary → 聚合一次出 |
| `ShlinkDomain` | `{domain,isDefault,redirects}` | |
| `ShlinkDomainsList` | `{data, defaultRedirects}` | 注意是 `data` 不是 `domains`（SDK 解包后才是数组） |
| `ShlinkHealth` | `{status:'pass'\|'fail', version}` | `status` 只影响服务器连通，`version` 是能力旋钮 |
| `ShlinkMercureInfo` | `{token,mercureHubUrl}` | 我们不提供，见坑 4 |
| `ShlinkRedirectRulesList` | `{defaultLongUrl, redirectRules[]}` | 每条含 `priority` + `conditions[]` |
| `ShlinkDeleteVisitsResult` | `{deletedVisits}` | 数字，不是布尔 |

---

## 5. `version` 是能力旋钮（9 个开关，全部按 semver 比较）

`web-component` 里唯一的特性门是 `{minVersion}` 表（`@shlinkio/shlink-web-component dist/index.js`，`Object.freeze` 的 `Ui` 常量）：

| 能力 | 最低版本 | 打开后界面多出什么 |
|---|---|---|
| `ipRedirectCondition` | 4.2.0 | 跳转规则里可选「按 IP」 |
| `geolocationRedirectCondition` | 4.3.0 | 跳转规则里可选「按国家/城市」 |
| `filterShortUrlsByDomain` | 4.3.0 | 短链列表多一个域名筛选 |
| `advancedQueryRedirectConditions` | 4.5.0 | 跳转规则里 query 参数的高级匹配 |
| `desktopDeviceTypes` | 4.5.0 | 设备条件里多出桌面三系统 |
| `filterShortUrlsByExcludedTags` | 4.6.0 | 短链列表「排除标签」筛选 |
| `filterVisitsByDomain` | 4.6.0 | 访问列表多一个域名筛选 |
| `dateRedirectConditions` | 5.0.0 | 跳转规则里「按日期」 |
| `browserRedirectConditions` | 5.1.0 | 跳转规则里「按浏览器」 |

**推荐做法**：`/health` 的 `version` 报**我们真正实现的最低档**，随实现逐档上调。

- M1 报 **`4.0.0`**：9 个开关全关，界面只剩我们确实支撑的样式（这 9 个之外的页面不受版本门控制）。
- M2 上了「排除标签 + 按域名筛访问」后报 `4.6.0`。
- M3 做跳转规则时再往上走。
- **别报 `latest`**：`versionToSemVer('latest')` 会折成 `999.999.999`，能力检查里还特判成 `999.99.99`（`src/servers/reducers/selectedServer.ts:14-19`），等于把所有 5.x 能力也打开。

反过来说，报高版本会让界面出现我们没实现的入口（比如跳转规则编辑页在 M1 一定存在，与版本无关——所以 B4 即使不实现也必须给出「空规则 + 可读」的最小实现，否则短链详情页会崩）。

---

## 6. 六个实现坑（都会直接表现为界面故障）

1. **`/health` 必须是合法 semver**。`versionToSemVer` 兜底成 `'1.0.0'`，但 `health()` 抛错就是「服务器不可达」（`selectedServer.ts:51-62`）。返回 `{"status":"pass","version":"4.0.0"}` 是最小可行值。
2. **`createShortUrl` 的 falsy 丢弃**（见 §4.2）：创建走 RPC 时不要依赖「没传就是 false」，要按「缺席 = 用默认值」处理；取消勾选只能走 PATCH。
3. **域名健康检查打到每个短链域名**（`index.js:7-11`）。三个选项：
   - (a) 接受 Domains 页每个域名显示「invalid」红标（纯展示，不阻断操作）——**M1 推荐**；
   - (b) 给每个域名加一条 `/functions/v1/compat/rest/v3/health` 的 FC 路由（与跳转函数同域不同路径，要确认 FC 路径路由不会抢 `/*` 的热路径）；
   - (c) 控制台指向单一 api 域，Domains 页永远显示红标（等同 a）。
4. **`mercureInfo` 失败是可接受的**。web-component 的 `loadMercureInfo` 失败只把状态置 `'error'`（`dist/index.js` 里 `ha.rejected → {status:'error'}`），实时统计降级为手动刷新，**不阻塞任何页面**。我们返回 `404 + type=MERCURE_NOT_CONFIGURED` 即可，别实现假 hub。
5. **错误体的两个特例字段**：界面只对两种 `type` 做特殊渲染——`INVALID_ARGUMENT` 要带 `invalidElements: string[]`（表单高亮哪几个字段），`INVALID_SHORT_URL_DELETION` 要带 `threshold: number`（提示「访问量超过 N 不能删」）。其余类型只显示 `title`/`detail` 文本。我们做软删，可以不返回第二种。
6. **DELETE 两种响应形状要分清**：`deleteShortUrl` / `deleteTags` / `editTag` 走 `emptyRequest`（不解析 body，204 即可）；`deleteShortUrlVisits` / `deleteOrphanVisits` 走 `jsonRequest`（**必须**返回 `{deletedVisits}` JSON，空 body 会抛 `Unexpected end of JSON input`）。

---

## 7. 0004 建表必须补的列（相对现有设计）

| 缺失项 | 用在哪 | 建议 |
|---|---|---|
| `visit.redirect_url` | `ShlinkVisit.redirectUrl`（4.3.0+） | 补一列（跳转侧本来就命中过目标地址，入队时带上） |
| `visit.visited_url` 截断上限 2048 | 孤儿访问明细 | 已有 visited_url，补长度约束/截断 |
| `short_url.crawlable` | 创建/编辑表单 | 计划中已有，确认落列 |
| `short_url.forward_query` | 同上 | 计划中已有 |
| `short_url.long_url_hash` | `findIfExists` | M2，`digest(long_url,'sha256')` + 索引 |
| `domain` 三个回退列 | `listDomains` / `editDomainRedirects` | M2，但 B4 就要返回字段（先恒 `null`） |
| `short_url` 计数聚合 | 列表每行的 `visitsSummary` | 不要加三列冗余，用视图 `SUM(count) FILTER (WHERE potential_bot)`；若列表页压测不过再考虑物化 |
| 规则表 `EXISTS` | `hasRedirectRules` | M3 前恒 `false`，不用建表 |

时间/序列化统一口径：所有日期出参用带偏移的 ISO8601（`created_at`、`visited_at`），前端直接 `new Date()` 解析；`domain=''` 一律序列化成 `null`。

---

## 8. 验收清单（每批做完在浏览器里点一遍）

前置：`shlink-web-client` 本地 build（`npm ci && npm run build`，Node 24；2026-11-09 实测通过），`build/` 用任意静态服务起在 4173。

- [ ] **连通**：控制台「Add server」填 server URL + 任意 key → 不出现「不可达」，页脚显示我们报的版本号。
- [ ] **B1**：新建短链（自定义 slug / 随机码各一条）→ 列表出现 → 编辑长链和 title → 删除 → 列表消失。
- [ ] **B2**：用 `curl -i` 打一次真实跳转 → 等 inbox 落库 → 短链详情出现 1 条访问，概览页数字同步；`deleteShortUrlVisits` 返回的 `deletedVisits` 与页面提示一致。
- [ ] **B3**：打标签 → 标签页出现计数 → 重命名 → 删除；`tagsMode=all/any` 两种筛选都对。
- [ ] **B4**：Domains 页能列出域名（健康标记按坑 3 的选项表现）；Mercure 报错不白屏；短链详情「跳转规则」页能打开且显示空规则。
- [ ] **跨域**：浏览器 Network 里每个写请求前有 OPTIONS 且 204；无 CORS 报错。
- [ ] **错误体**：故意用一个已存在的 slug 创建 → 界面弹出 409 文案而不是 `Unexpected token`。
- [ ] **长列表**：造 50 条短链，翻页/搜索/排序（`dateCreated-DESC`、`visits-ASC`）均正常。

---

## 9. 与其它文档的关系

- 功能面全景与分期：`docs/shlink-migration-analysis.md`
- 架构与权限两套并存：`docs/tech-framework.md` §1、§2、§4.1、§7
- 契约原件：`docs/reference/shlink-sdk-3.2.1/`
