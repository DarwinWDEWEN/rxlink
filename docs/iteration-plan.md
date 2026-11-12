# rxlink 迭代开发与迁移方案（v1.0，2026-11-09）

> 定位：`docs/tech-framework.md` 回答「做成什么样」，`docs/shlink-migration-analysis.md` 回答「shlink 有什么」，`docs/shlink-api-contract.md` 回答「控制台要什么字段」。这份文档回答**「按什么顺序做、每轮做到哪算完」**。
> 用法：每轮只做本轮的「范围」，做完逐条勾【B】验收，再回【C】更新状态。**验收没勾完不算完成**，不允许把没验的项带进下一轮。
> 所有判断都建立在已有实测之上（见 `docs/verification/p0-results.md`）；这里只引用，不重新论证。

---

# 【A】迭代开发文档

## A0. 现状快照（2026-11-09）

| 已有 | 证据 |
|---|---|
| 平台能力与硬限制摸清 | `docs/verification/p0-results.md`；ADB Supabase 禁 `SECURITY DEFINER`、新表默认裸奔、PG14 保守子集 |
| 跳转层定案并上线 | `fc/redirect/index.js` + `cache.js` 跑在 FC 自定义域名 `example.com` 的 `/*`，两文件版已上线实测（I2） |
| 两级缓存与失效链路 | `0002_link_cache_version.sql` + `0007_link_version_row_trigger.sql`（行级触发器，避免 0 行 UPDATE 也 bump） |
| 兼容层 B1 | `0008_compat_api.sql` 五个 RPC + `supabase/functions/compat/index.ts`，控制台已能建改删查（I3） |
| 兼容层 B2 | `0009_visits_api.sql` 五个 RPC + 8 条路由；概览/明细/筛选/删访问已与控制台联调（I4） |
| 兼容层 B3/B4 | `0010_console_api.sql` 七个 RPC + 9 条路由；标签/域名/Mercure/跳转规则已与控制台联调（I5） |
| 控制台静态托管 | 已上传用户 FC 函数 `console-prod` 并配证书，`https://console.example.com` 全通（I5 已验收） |
| 死链清理方案 B | `0003_dead_link_prune.sql`，cron jobid=5，dry-run |
| 控制台可构建 | `shlink-web-client/` v4.9.0，Node 24 下 build 通过，产物浏览器可跑 |
| 契约摸清 | `docs/shlink-api-contract.md`（23 方法 / 18 路径）+ 原件存档 `docs/reference/shlink-sdk-3.2.1/` |
| 404 回退 | `0011_fallback_and_scheme.sql` 的 `not_found_redirects` RPC + 跳转函数 404 分支回跳（域名级优先、占位符、双斜杠折叠）；孤儿分类对齐 shlink（收尾已验收） |
| 地理富化设计 | `docs/geo-enrichment.md`：NAT 出网=FC 双网络（不用 NAT 网关）；事件函数 + 定时触发器 + mmdb 放 /tmp（方案 A）；IP 短暂留存（富化后清空，7 天兜底） |
| 交接文档 | `docs/handover.md`：项目定位/架构、当前线上状态、仓库地图、跑验证命令、平台坑、凭据红线、待办（地理富化 #41–#44 + 发布前置）、工作约定 |

**还没有的**：无阻塞项（I0–I6 全部验收；三个域名证书齐备；404 回退已上线；地理富化方案已定稿待实现）。交接文档已备（`docs/handover.md`）。云上待办：cdndev 域名/解析下线、FC 账号探针残留、闲置 `console` Edge 函数；发布前置：Supabase 升付费版（免费版禁生产）；地理富化前置：MaxMind License key（他申请）。

**当前数据面状态**：跳转函数代码与线上均为两文件版、读正式表（I2 已验收）；控制台可连兼容层并看访问统计（I3、I4 已验收）；23 个方法全部有实现，控制台已在 `https://console.example.com` 验收（I5）；404 回退已上线（域名级/全局/占位符/双斜杠折叠实测，收尾已验收）。

---

## A1. 迭代设计原则（四条，决定下面的切法）

1. **先纵切、后横切**：每一轮结束时，**至少有一条真实链路能从入口打到库里再回到界面**（或回到一个可验证的响应）。不做「先把所有表建完、最后一起联调」。
2. **每轮只有一个主题**，且能让他在浏览器或 `curl` 里看到差别；看不到差别的轮次不算迭代，算内部整理。
3. **临时态必须收敛**：探针表、单文件部署、`/tmp` 里的脚本这类临时物，在对应轮次里明确写清「哪一轮退场」，不能留到无限期。
4. **云侧动作前置声明**：凡是需要他在阿里云控制台点的，本轮开头就列全（页签 + 下拉框名），不让代码等他，也不让他等代码。

通用完成定义（每轮都适用）：

- 迁移脚本按语句逐条应用到线上库，且**先备份**；
- 新增表的 `enable/force RLS + revoke` 四行齐全（`tech-framework.md` §4.1）；
- 本轮涉及的文档同步更新；
- 交付物里**不出现任何密钥值**（含日志、截图、文档）。

---

## A2. 迭代总表

| 轮 | 主题 | 一句话目标 | 前置 | 估时（我一人实现） |
|---|---|---|---|---|
| **I0** | 决策冻结 | 把还悬着的 4 个决策拍完，否则 I1 的 DDL 会返工 | — | 0.5 天 |
| **I1** | 数据面正式化（0004） | 建真表 + `resolve`/`create_short_url` RPC + 权限收口，**仍不切跳转函数** | I0 | 2–3 天 |
| **I2** | 跳转切正式表 | 函数改常量、写正式 inbox、drain + cron、prune 搬迁；两文件版上线 | I1 | 1–2 天（含他上传） |
| **I3** | 控制台连通（B1） | `api_key` + 兼容层 health + 短链读写 5 方法 ⇒ 控制台能加服务器、能建能改能删 | I1（表就绪） | 2–3 天 |
| **I4** | 统计读接口（B2） | 8 个访问统计方法 ⇒ 控制台能看数与删访问 | I2、I3 | 2 天 |
| **I5** | 控制台补全（B3/B4） | 标签 4 + 域名/健康/Mercure/规则 6 ⇒ 全 23 个方法收口；控制台上线托管 | I4 | 2–3 天 |
| **I6** | 生产硬化 | 探针全退场、prune 转真、HTTPS、告警与 runbook、压测复核 | I5 | 2–3 天 |

合计约 **12–17 人日**（不含他准备备案/证书的日历时间）。**I3 与 I1 之间可以并行**：I2 不依赖兼容层，I3 不依赖跳转切开，只要 I1 的表冻结。

---

## I0 —— 决策冻结（0.5 天，无代码）

**为什么单独成轮**：I1 一旦建表，`snapshot` 的 key 形态、`resolve` 的 path 解析、`domain` 的列都定了；D3 选错要删表重建。

**要做的事**

- 把 `docs/shlink-migration-analysis.md` §9 的 D2–D5 逐条给出结论，并写回该表（D1 已结案＝开放）。
- **0004/0005 DDL 评审稿已产出**（2026-11-09）：SQL 在 `supabase/migrations/`，差异说明、设计决策、线上待验证项、应用顺序与待拍问题在 `docs/ddl-review-0004-0005.md`。**尚未执行**。
- 定两件事：控制台静态站托管位置（FC 静态 / OSS+CDN / Supabase Storage）、Domains 页红标的处置（见契约 §6 坑 3 的 a/b/c）。

**我的推荐（供他一次拍完）**

| # | 推荐 | 理由 |
|---|---|---|
| D2 状态码 | 全局固定 302 | 301/308 会被浏览器自己缓存，统计必丢，与「逐次准确」冲突 |
| D3 多段 slug | **本期不支持** | 支持它要改 FC 的 path 解析和快照 key（`a/b` 会被 `/` 切开）；先锁 `[a-z0-9-_]{1,64}` 单段，快照 key 保持 `domain|code` |
| D4 地理定位 | M3 再说，本期只存 `visitor_key` | 要 License + NAT 出网 + mmdb 落盘，三项都是新成本 |
| D5 存量数据 | 不搬 | 历史短码大小写冲突、访问归属都对不齐，重开更干净 |
| 静态托管 | **OSS + CDN**（或 FC 静态，若他已有 OSS 桶则 OSS 更省事） | 产物是纯静态 + service worker；Supabase Storage 当静态站会有额外域名与缓存策略成本 |
| 域名红标 | 先接受红标（方案 a） | 纯展示，不阻断操作；等 I6 有空再决定要不要给每个域名加 health 路由 |

**出口判据**：上表六行全部有明确结论，写进 §9 与本文档【C】的备注列。

---

## I1 —— 数据面正式化（0004，2–3 天）

> **状态：已验收（2026-11-09）。** 0004（32 条）+ 0005（8 条）+ 0006（7 条）全部应用成功，验证记录见 `docs/verification/i1-results.md`。0006 是按评审稿 §8-1 的缺口补的 UA 解析（规则表 `ua_rule` + `ua_parse`，在 drain 时算）。

**目标**：把「探针版能跑」变成「正式表能跑」，但**不碰线上跳转函数**。这一轮结束时用 SQL/`curl` 能证明整条数据面闭环。

**范围**

1. `supabase/migrations/0004_core_tables.sql`：`domain`（含哨兵行 0）、`short_url`、`tag`、`short_url_tag`、`short_url_visits_counts`、`orphan_visits_counts`、`visit_inbox`、`visit`（按月分区）、`link_version`、`bot_pattern`。
2. `0005_shorten_and_resolve.sql`：`create_short_url(...)`、`resolve_short(...)`、`snapshot_short_links()`、`link_seq()`、`drain_visit_inbox(...)`、`prune_dead_links(...)`（后两个先建好但不调度，I2 再挂 cron）。
3. 权限：每张表四行；`resolve`/`snapshot` 只授给 `service_role`；`anon` 一律 revoke。
4. 短码规则：入库统一小写、`[a-z0-9-_]{1,64}` 白名单、随机码 5 位起、自定义 slug 冲突 409、并发用 `pg_advisory_xact_lock`。
5. 把 `link_version` 触发器从 `probe_short_url` 改挂 `short_url`（**新触发器，旧的不动**，I6 一起删）。

**建表前必须对齐的 7 处差异**（现有 `tech-framework.md` §4 DDL 与 §5、契约文档对不上，照抄会缺字段；逐条取舍见 `docs/ddl-review-0004-0005.md` §2）：

| # | 缺什么 | 谁需要 | 处理 |
|---|---|---|---|
| 1 | `short_url.enabled` | §5.2.2 快照 `where enabled`、§5.4 软删 | **必加**，`not null default true` |
| 2 | `short_url.last_visit_at` | §5.4 死链判定唯一依据 | **必加**，`timestamptz` |
| 3 | `visit.referer / ua / visited_url / redirect_url / potential_bot / orphan_type` | 契约 `ShlinkVisit`（6 个字段） | **必加**；`ua` 截断 512、`referer` 1024、`visited_url`/`redirect_url` 2048 |
| 4 | `domain` 三个 404 回退列（`base_url_redirect` / `regular404_redirect` / `invalid_short_url_redirect`） | `listDomains` / `editDomainRedirects` | **必加**（现有只有 `landing_url`，语义是它的一部分，保留 `landing_url` 作为兜底） |
| 5 | `api_key` + `api_key_role` | 兼容层鉴权（I3） | 本轮建表但不用；`key_hash bytea unique`、`name unique`、`enabled`、roles 三型 + 作用域 |
| 6 | `visit_inbox` 的 `visited_url` | 孤儿访问 `visitedUrl` | **必加**；现有 `redirect_to` 保留 |
| 7 | `short_url.author_api_key_id` | 作用域 `AUTHORED_SHORT_URLS`（I3） | **必加**；外键在 `api_key` 建好后补，`on delete set null` |

**不做什么**：不切跳转函数、不写兼容层、不动 cron、不删探针。

**本机验证（不出公网依赖）**：直接对线上库跑 SQL——建链 → resolve（域名优先/回落全局）→ 快照行数 → 改 long_url 后 seq +1 → 软删后快照少一行 → 权限矩阵（anon 直连表必须 42501/0 行）。

**出口判据**：`docs/verification/i1-results.md` 记录全部 SQL 与输出；【B】I1 全勾。

---

## I2 —— 跳转切正式表（1–2 天）

> **状态：已验收（2026-11-09）。** 两文件版已上传 FC、最小实例数 = 1；线上 302/`cached=1`/0.31s 传播/停用 0.28s 404/drain 全部实测通过。追加 `0007` 把触发器改行级（语句级在 0 行更新时也 bump）。按他决定**不配 `VISITOR_SALT`**，`visitor_key` 恒 null、不做 UV。验证见 `docs/verification/i2-local-results.md`。

**目标**：线上 `http://example.com/{code}` 从正式表 302，访问落正式 inbox，计数在分钟内更新，死链清理能出真清单。

**范围**

1. 改 `fc/redirect/index.js` 顶部常量：`probe_resolve` → `resolve_short`、`probe_inbox` → `visit_inbox`、`probe_link_seq`/`probe_link_snapshot` → `link_seq`/`snapshot_short_links`。
2. **不只是改常量**——现有函数有四处要改（评审 0004/0005 时核出来的，见 `docs/ddl-review-0004-0005.md` §5）：
   - `cache.js` 目前只存 `long_url` 字符串，要改成存 `{id, long_url, forward_query, valid_since, valid_until, visits_limited}`；快照里默认域名的 `domain` 是 `null`，按「有 domain 进域名表、否则进全局表」建索引。
   - 缓存命中路径要补三项判定：有效期（本机时钟）、`visits_limited` 为真时回落查库（`max_visits` 的计数分钟级变化，不能靠快照）、`forward_query` 为真时把原请求 query 拼到 Location 后面（**现在完全没实现**）。
   - 404 分支要写 `orphan_type`（`regular_404`），命中分支要写 `short_url_id`，两者都要带 `visitor_key = sha256(ip + VISITOR_SALT)`（新环境变量）、`ua`、`referer`、`visited_url`、`redirect_to`。
   - `recordVisit` 的 body 从探针形状 `{payload: {...}}` 改成正式表的列形状。
3. `cron.schedule` 挂两条：`drain`（每分钟）、`prune`（每天 GMT 19:00，**先 dry-run**）。
4. 打包 `index.js` + `cache.js` 上传 FC（他操作），配 **最小实例数 ≥ 1**。
5. 复测缓存数字：命中 `dur=0;cached=1`、seq 传播 ≤5s。
6. 补三条行为用例：`?a=1` 透传、`valid_until` 到期后 404、`max_visits` 打满后 404。
7. `0007_link_version_row_trigger.sql`：`short_url` 上的 `link_version` 触发器由语句级改行级——线上实测语句级在 0 行更新时也会触发，dry-run prune 会白 bump seq。

**他要在控制台做的（精确到位置）**

- 函数计算 > 函数 > `test-supabase` > 代码 > 上传 ZIP（`dist/redirect.zip`，含 `index.js` + `cache.js` 两文件）；
- 弹性配置 > 最小实例数 **1**；
- 环境变量：确认 `SUPABASE_URL`（VPC 内网）+ `SUPABASE_SERVICE_ROLE_KEY`；**新增 `VISITOR_SALT`**（值由他生成，我不接触明文；不配则 `visitor_key` 为 null）；
- 域名管理 > `example.com` > 路由 `/*` 指向该函数（应已如此，确认即可）。

**不做什么**：不做 HTTPS（I6）、不改 path 规则、不加多段 slug。

**出口判据**：真实 `curl -i` 拿到 `302 + Location`；`select count(*) from visit` 在 1–2 分钟内增长；`short_url_visits_counts` 出现 slot 行；停用一条后 ≤5s 变 404；prune dry-run 清单只含预期行。

---

## I3 —— 控制台连通（B1，2–3 天）

**目标**：浏览器里的 shlink-web-client 能连上我们，加服务器不报「不可达」，能建/改/删/查短链。

**范围**

1. `supabase/functions/compat/index.ts`（`--no-verify-jwt`）：路由前缀 `/rest/v3/*`，`OPTIONS` 预检，CORS 头，`X-Api-Key` 校验（sha256 查 `api_key`），失败返回 `ErrorType.INVALID_AUTHORIZATION` / `INVALID_API_KEY`。
2. 五个方法：`GET /health`（返回 `{status:'pass',version:'4.0.0'}`）、`listShortUrls`、`createShortUrl`、`getShortUrl`、`updateShortUrl`、`deleteShortUrl`。
3. 统一响应装配：`shortUrls` 包装、`pagination` 三字段、`meta` 三键恒在、`domain` 空串 → `null`、`shortUrl` 拼完整地址、`visitsSummary`（本轮先查计数表聚合）。
4. 统一错误体：`{type,detail,title,status}`，409/404/400 三种映射。
5. `api_key` 的第一条记录怎么来：`scripts/new-api-key.sh` 本地生成明文、只把 sha256 入库，明文只打印一次（**我不接触正式明文**）。

**他要在控制台做的**：跑一次 `scripts/new-api-key.sh console` 拿正式 key 并保存。（`compat` 函数已用 `./functions-cli deploy compat --no-verify-jwt` 部署为 ACTIVE，无需再手动操作。）

**状态**：已验收，证据见 `docs/verification/i3-results.md`。

**出口判据**：浏览器 Add server → 无红标、页脚显示 `v4.0.0` → 新建一条带 tags 的短链 → 列表可见 → 编辑 title → 删除。Network 里每个写请求前有 OPTIONS 且 204。

---

## I4 —— 统计读接口（B2，2 天）

**目标**：控制台短链详情页/概览页的数字与库里一致，能删访问。

**范围**：8 个方法（`getVisitsOverview`、`getShortUrlVisits`、`deleteShortUrlVisits`、`getTagVisits`、`getDomainVisits`、`getOrphanVisits`、`deleteOrphanVisits`、`getNonOrphanVisits`）。要点：`visits` 包装、`visitLocation` 恒 `null`、孤儿带 `type`、两个 `delete` 必须返回 `{deletedVisits}` JSON。

**不做什么**：不做地理富化、不做 Bot 字典精修（先用最简 UA 子串规则，写进 `bot_pattern` 初始集）。

**出口判据**：从浏览器打 3 次真实跳转 → 1–2 分钟后详情页出现 3 条、概览数字同步；`deleteShortUrlVisits` 返回的 `deletedVisits` 与页面提示一致；`/visits/orphan` 三类都能靠造数据命中。

**状态**：已验收，证据见 `docs/verification/i4-results.md`。

---

## I5 —— 控制台补全 + 上线（B3/B4，2–3 天）

**状态**：**已验收**。`https://console.example.com` 证书有效，页面/资源/深链/Service Worker/跨域 API 全通；证据见 `docs/verification/i5-results.md`。

**目标**：23 个方法全部有实现，控制台静态站挂到正式地址，界面无死链。

**范围**

1. B3：`listTags`、`tagsStats`（每条带 `visitsSummary`）、`deleteTags`（`tags[]` 查询串，空响应）、`editTag`（PUT，空响应）。
2. B4：`listDomains`（含 `defaultRedirects`）、`editDomainRedirects`、`mercureInfo`（404 + `MERCURE_NOT_CONFIGURED`，让界面降级）、`getShortUrlRedirectRules`（返回 `{defaultLongUrl, redirectRules: []}`）、`setShortUrlRedirectRules`（M3 前返回 501）。
3. 版本旋钮：D 系列能力未实现前 `version` 保持 `4.0.0`（契约 §5）。
4. 控制台构建产物上线 + 自定义域名/CORS 联调；`build/` 加一条部署说明（谁上传、传什么、怎么回滚）。

**出口判据**：Domains 页能列出域名（红标按 I0 决定）；Mercure 报错不白屏；跳转规则页能打开且显示「无规则」；短链/标签/访问三类页面无 4xx 报错（Network 面板核）；控制台地址在正式域名下可访问。

---

## I6 —— 生产硬化（2–3 天）

**状态**：已验收（2026-11-10）。探针退场、prune 转真（job 8）、50 并发压测（p95 416ms）、可观测查询、runbook、HTTPS 复测（302/301 强制跳转/404/统计落库）全部完成。证据见 `docs/verification/i6-results.md`。

**目标**：把临时态清干净，并让系统在出问题时能被发现。

**范围**

1. 探针退场：删 `probe_*` 表/函数、`supabase/functions/probe*`、`fc/redirect-probe/`；确认无引用后再删。
2. `prune_dead_links` 由 dry-run 转真实（**他先看清单**）。
3. HTTPS：`example.com`（FC 域名）挂证书，复测 302。（`cdn.example.com` 为 P0 CDN 测试域名，无运行引用，2026-11-10 定案放弃，云上可下线。）
4. 可观测：FC 日志检索口径、`Server-Timing` 采样、inbox 积压告警（`processed_at is null` 行数阈值）、快照 seq 停滞检查。**只做能跑在现成组件上的**，不引入新服务。
5. 压测复核：50 并发下 302 成功率与 p95（对标 §5.2.1 的 50 并发 p95≈804ms）；控制台列表 50 条翻页。
6. `docs/runbook.md`：加域名 SOP（备案 → FC 域名 → 证书 → 路由 → CORS）、回滚步骤、故障排查树。

**出口判据**：探针零引用（`grep` 证据）；prune 真跑一次且清单与结果一致；HTTPS 下 `curl` 拿 302；告警阈值能在库里查出一行；runbook 能让一个没参与过的人照做。

---

## I7 —— 地理富化（#41–#44）

> **状态：主体已上线并验证（2026-11-11）。** #41（迁移 0012）、#42（跳转函数 + drain 带 remote_addr）、#43（富化函数，已部署上线）、#44（契约与兜底）全部落地；剩余仅「DB-IP 署名的控制台包重传」这一项用户动作。
> 设计定稿：`docs/geo-enrichment.md`。任务编号沿用交接文档的 #41–#44。

**目标**：访问明细能带上地理信息（国家/省/市/经纬度/时区），且原始 IP 只短暂留存。

**范围**

1. **#41 迁移 `0012_geo_location.sql`**（15 条语句，已应用）：
   - `visit_inbox.remote_addr`；`visit.remote_addr`
   - `country/region/city` 正名为 `country_name/region_name/city_name`（D4 推迟期留下的三个空列），补 `country_code/lat/lon/timezone`
   - 部分索引 `visit_pending_location_idx`（只装 `remote_addr` 非空的行）
   - 三个 RPC：`visits_pending_location` / `apply_visit_locations` / `retire_remote_addr`，只授 service_role
2. **#42 跳转函数与 drain 带上 `remote_addr`**：`fc/redirect/index.js` 的 visit payload 加 `remote_addr`（取 `x-forwarded-for` 首元素，截断 64，无值写 null）；`drain_visit_inbox` 的 insert 多写一列（覆盖 0006 同名函数，其余逻辑一致）。
3. **#43 富化函数 `fc/geo-enrich/`**：**事件函数**（`exports.handler`，FC 请求处理程序填 `index.handler`），定时触发器**每小时**（`0 0 * * * *` UTC，超时 ≥60s，内存 ≥512MB）；**mmdb 随 Layer 分发**（运行时不联网、不出公网；解压到 `/tmp` 约 1 秒），无 Layer 时才回退运行时下载；拉批 → 本地查 IP → 回写 → 清空 `remote_addr`；日志不得出现 IP。**代码已完成并端到端验证**（2026-11-11），差 FC 部署；数据源为 DB-IP City Lite（免 key，允许商用，见 `geo-enrichment.md` §0）。
4. **#44 契约 + 兜底**：`visit_json` 的 `visitLocation` 由恒 null 改为读列；`retire_remote_addr(7)` 由 pg_cron 每小时跑（jobid 9）做 7 天硬留存。
5. **I7 收尾（2026-11-11）**：
   - `0014_drain_clear_remote_addr.sql`（1 条，已应用）：覆盖 `drain_visit_inbox`，落库后立即清空入队侧的原始 IP —— 入队侧 IP 留存从「最长 1 天」压到「分钟级」；
   - DB-IP 署名：`fc/console/index.js` 在返回 HTML 时注入页脚（含 db-ip.com 链接）+ `<style>`，不重编 Angular；7 例单测全绿。

**隐私口径**（与设计 §7 一致）：原始 IP 富化后立即清空（`visit` 侧由回写同一条 UPDATE 清、`visit_inbox` 侧由 drain 落库后清）；7 天硬上限由纯 SQL cron 兜底；IP 不进契约、不写日志、不进快照。

**不做什么**：不在热路径定位；不长期存 IP；不做固定公网 IP；不抄 shlink 的 `geolocation_db_updates` 表。

**出口判据**：见 B7。

---

## I8 —— M2 收尾批次（R1–R8）

> **状态：已上线并验收（2026-11-11）。** 迁移 0015–0017、跳转函数 R1/R2/R3/R8、兼容层 R4/R6/R7、cron R5 全部落地；R9/R10 另立 I9/I10。
> 设计：`docs/i8-m2-closure-design.md`；差距清单：`docs/shlink-feature-checklist.md`；验证记录：`docs/verification/i8-results.md`。

**目标**：补齐 shlink 功能清单里 M2 阶段的差距项（默认 404 页 / 追踪像素 / robots.txt / 追踪开关 / 单步建链 / 访问导出 / key 过期 / 过期短链清理）。

**范围**

1. **迁移（已应用）**：`0015`（`api_key.expires_at` + `compat_auth` 覆盖）、`0016`（`robots_crawlable_codes`）、`0017`（`delete_expired_short_urls`）；应用前建库内快照，应用后逐条断言。
2. **跳转函数（R1/R2/R3/R8）**：`fc/redirect/index.js` + `ipmat.js`；404 返回内联 HTML（有回退仍 302）、`/{code}/track` 1×1 gif 像素（命中才记）、`robots.txt`、HEAD 不记访问、`DISABLE_*` 追踪开关。
3. **兼容层（R4/R6/R7）**：拆出 `handler.ts`；`GET /short-urls/shorten`（header 或 `?apiKey=`，`format=txt`/Accept）、`GET /visits/export`（CSV，rxlink 扩展端点）、过期 key 401。部署改走 `scripts/build-compat-function.mjs` 单文件包。
4. **cron R5**：jobid 10 `rxlink-expired`，每日 GMT 20:00 软删过期/超次短链。

**出口判据**：见 B8。

---

## I9 —— R9 动态跳转规则

> **状态：兼容层与数据面已上线并验收（2026-11-12）；跳转函数待上传 zip。** 迁移 0018/0019 已应用、兼容层已部署（version 5.1.0）、11 种条件端到端线上验通；`fc/redirect` 的规则接入已完成并本机全绿，等用户把 `dist/redirect.zip` 上传到 FC 后做跳转侧线上验收。
> 设计：`docs/superpowers/specs/2026-11-12-r9-dynamic-redirect-rules-design.md`；实施计划：`docs/superpowers/plans/2026-11-12-r9-dynamic-redirect-rules.md`；验证记录：`docs/verification/i9-results.md`。

**目标**：让 shlink 的动态跳转规则从「只读、恒空」变成「可存、可用」——控制台能保存 11 种条件的规则，跳转时按规则求值并跳到规则指定的目标。

**范围**

1. **规则求值（`fc/redirect/rules.js`）**：纯函数、零依赖、可单测；口径对齐 `shlink/module/Core/src/RedirectRule/Entity/RedirectCondition.php`。规则内条件 AND、空条件永不命中、priority 升序首命中即停、单条件出错降级为不匹配。
2. **geo 数据（`fc/redirect/china-geo.js` + `scripts/build-china-geo.mjs`）**：从 DB-IP City Lite mmdb 抽成 `china-geo.bin` 随包发布（197KB，不挂 Layer）；只覆盖中国大陆 31 省级，中英文省名都认。构建期做 20 万次随机 IP 对拍自检。
3. **数据面（迁移 0018/0019）**：`short_url_redirect_rule` + `redirect_condition` + `rules_version`（**独立于 `link_version`**）；`redirect_rules_json` / `set_short_url_redirect_rules` / `get_short_url_redirect_rules` / `rules_seq` / `rules_snapshot`；`resolve_short` 加 `rules` 列；`short_url_json.hasRedirectRules` 动态化；`list_short_urls` 加 `p_excluded_tags` + `p_excluded_tags_mode`（版本旋钮 5.1.0 的连带项）。
4. **兼容层（`handler.ts`）**：`GET/POST|PATCH /short-urls/{code}/redirect-rules` 从固定 501 变为真实现；11 种条件类型白名单 + 值域校验（非法值 400 `invalid-data`）；`VERSION` 4.0.0 → 5.1.0。
5. **跳转接入（`fc/redirect/rules-cache.js` + `index.js`）**：独立的 `rules_version` 轮询通道（默认 5s），命中规则跳规则目标、不命中跳默认长链；`forward_query` 同样作用在规则目标上；geo 表只在规则里真的出现 geo 条件时才读盘。

**出口判据**：见 B9。

**关键设计决策**

- 规则**不进主快照**：规则是高频写操作，若与 `link_version` 共用 seq，每存一次规则就要让全网实例重拉全量短链快照 —— 代价不对等。规则走独立的 `rules_version` + 只含「有规则的短链」的小快照。
- geo 只做国内省级：海外 IP 一律不命中 geo 条件；`geolocation-country-code` 实际只匹配 `CN`。
- 版本旋钮提到 **5.1.0** 而不是 4.x：控制台靠 `version` 决定「跳转规则」页列出几种条件类型，不一起补 `excludeTags` 筛选就会出现静默错误（勾了没反应）。

---

# 【B】验收清单

> 规则：每条都要附**证据**（命令输出 / 截图 / SQL 结果），只写「已完成」不算。上一轮有未勾项，下一轮不启动。

## B0 —— I0 决策冻结
- [x] D2 跳转状态码结论已写入 §9（固定 302）
- [x] D3 多段 slug 结论已写入 §9（不支持；契约 §6 无需改，因本期不实现多段）
- [x] D4 地理定位结论已写入 §9（推迟）
- [x] D5 存量数据结论已写入 §9（不搬）
- [x] 控制台静态托管位置已定：FC 静态托管，不引入新技术栈（他 2026-11-09 决定）
- [x] Domains 页红标处置已定：先接受红标（方案 a）
- [x] 0004 DDL 评审稿已产出并被认可（2026-11-09，`docs/ddl-review-0004-0005.md`）

## B1 —— I1 数据面正式化
- [x] 0004/0005 在线上库应用成功：13 张表 + `ua_rule`（0006），32 + 8 + 7 条语句全 OK
- [x] 权限矩阵：`anon`/`authenticated` 对业务表与 RPC 全为 false，`service_role` 为 true；分区 `rls=true force=true`
- [x] `create_short_url`：自定义 slug 冲突 → PostgREST 409 `non_unique_slug`；随机码走单行 insert + 20 次重试
- [x] 短码入库为小写（`MiXeD` → `mixed`）
- [x] `resolve_short`：域名专属优先、回落 `domain_id=0`、过期/超次数/停用均判为不可跳
- [x] 快照 RPC 行数 = `enabled` 行数；改 `forward_query`/停用/删除后 `seq` +1；改 `visits_count`/`title` 不 +1
- [x] 软删后快照少一行、`seq` +1
- [x] `docs/verification/i1-results.md` 已写

## B2 —— I2 跳转切正式表
- [x] `curl -i http://example.com/<真码>` → `302 + Location`（`Location` 含透传 query）
- [x] 命中缓存：`Server-Timing` 含 `dur=0;cached=1`
- [x] 新建短链后 ≤5s 可跳（seq 传播）：实测 0.31s
- [x] 停用后 ≤5s 变 404 且不打库（实测 0.28s，`dur=0;cached=1`）
- [x] 1–2 分钟内 `visit` 明细出现、计数表出现 slot 行（本机请求经 cron 6 drain：`pending=0`、`visit=14`、`slots=8`；真域名 5 行也已 drain）
- [x] 未命中访问写 `visit_inbox` 且 `orphan_type` 正确（`regular_404` / `invalid_short_url`）
- [x] 本机行为用例全通：query 透传、`valid_until` 到期 404、`max_visits` 打满 404、HEAD 302、停用 404（`docs/verification/i2-local-results.md`）
- [x] prune dry-run 清单只含预期行、未 bump seq（发现 0 行也会 bump，已用 0007 行级触发器修复并复测）
- [x] 最小实例数 = 1 已确认（他 2026-11-09 复述）
- [x] `VISITOR_SALT` 不做（他 2026-11-09 决定：不在意该安全项、省资源）；代价是 `visitor_key` 恒为 null、无 UV 口径，PV/明细/计数不受影响

## B3 —— I3 控制台连通（B1）
- [x] Add server 后无「不可达」，页脚版本为 `4.0.0`
- [x] 新建短链（随机码 + 自定义 slug）各成功一条（随机 `9e6h3` 走 API、自定义 `dui3` 走 UI）
- [x] 列表分页、按 `dateCreated-DESC` 排序正确（API `itemsPerPage=2&page=2` → `pagesCount=2,totalItems=4`；UI 列表按创建时间倒序）
- [x] 编辑 title/longUrl 生效，且跳转目标随之改变（6s 后 `302` 指向新目标）
- [x] 删除后列表消失，跳转变 404（≤5s，实测 6s 轮询点已 404）
- [x] 错误 key → 界面提示鉴权失败，不是 JSON 解析错误（`401 invalid-api-key` → 列表错误态）
- [x] 重复 slug → 界面提示冲突文案（409，`Custom slug "dui3" is already in use`）
- [x] OPTIONS 预检 204，CORS 无报错

## B4 —— I4 统计读接口（B2）
- [x] 3 次真实访问后详情页显示 3 条，字段（referer/UA/bot）与库一致（2 条 iPhone/Safari 非 Bot + 1 条 curl Bot）
- [x] 概览页 `nonOrphanVisits` / `orphanVisits` 与 SQL 对得上（19/12 → 删后 16/0）
- [x] 标签页访问、域名页访问两种筛选正确（`tag=i4` 3 条；域名 16 条）
- [x] 孤儿访问三分类各造一条，列表 `type` 正确（`base_url` / `invalid_short_url` / `regular_404`）
- [x] 删除访问返回 `{deletedVisits:n}` 且界面数字同步（`deletedVisits` 3 与 12；概览 19→16、孤儿 12→0）
- [x] 时间区间筛选（startDate/endDate）边界正确（1 分钟窗口命中 3 条）

## B5 —— I5 控制台补全（B3/B4）
- [x] 标签：新建 → 统计计数 → 重命名 → 删除四条全通（UI `PUT/DELETE /tags` 均 204；`/tags/stats` 计数 2/1）
- [x] `tagsMode=all/any` 两种筛选结果不同且正确（`all` → 1 条；`any` → 2 条）
- [x] Domains 页列出全部域名，`defaultRedirects` 显示正确（`example.com` + 三项 null）
- [x] 编辑域名回退地址后回读一致（`PATCH /domains/redirects` 200，UI 显示，再置回 null）
- [x] Mercure 失败不白屏，实时开关降级（端点 404；v4.9.0 控制台无 `mercureInfo` 调用路径，页面正常）
- [x] 跳转规则页可打开、显示空规则、保存给出明确报错（501）
- [x] 控制台在正式地址可访问，刷新任意深链不 404（history fallback）——`https://console.example.com` 页面/资源/深链/跨域 API 全通；证书未覆盖，见下一条
- [x] PWA service worker 注册成功且不缓存 API 响应（正式域名 active 1 条、controller true；`/rest/v3/*` 直连）

## B6 —— I6 生产硬化
- [x] 探针代码/表零引用（库 0 表 0 函数、代码目录与 probe/probe-db 部署已删、cron 5 移除；残留 `probe_` 仅历史迁移与文档）
- [x] prune 转真后清单与结果一致，且可撤销（job 8 真实执行；i6prune 闭环：停用→404→enabled=true 恢复，测试数据已清）
- [x] `https://example.com/<码>` → 302（DigiCert DV 证书受信；HTTPS 302 + cached=1、HTTP 301 强制跳转、陌生码 404、访问 14→15 落库全验；cdndev 已放弃）
- [x] 50 并发 302 成功率 100%，p95 记录在案（i6load 1000/1000=302，p95 416ms，压后清理）
- [x] inbox 积压阈值查询能返回结果（健康查询：pending=0/oldest=0/drain≈4s/seq=85）
- [x] `docs/runbook.md` 覆盖加域名、回滚、三类故障排查（已建并核对命令）

## B7 —— I7 地理富化（#41–#44）
- [x] `0012_geo_location.sql` 15 条语句逐条应用成功（2026-11-10）
- [x] 列改名传播到既有分区：`visit` / `visit_2026_11` / `visit_2027_01` 均已无 `country/region/city`
- [x] 部分索引 `visit_pending_location_idx` 建在分区父表上
- [x] 三个 RPC 行为：`visits_pending_location` 拉到待富化批次 / `apply_visit_locations` 写列并清空 IP / `retire_remote_addr(7)` 清掉超期行
- [x] `drain_visit_inbox` 把 `remote_addr` 从 inbox 带到 `visit`（实测 inbox 1186 → visit 1185）
- [x] 契约两态：有定位 → `visitLocation` 对象；无定位 → `null`；`remote_addr` 不出现在契约里
- [x] 权限矩阵：三个 RPC 与两张表 `anon` 全部 401/拒绝，`service_role` 200
- [x] 兜底 cron `rxlink-retire-ip`（jobid 9，每小时）已挂
- [x] 跳转函数单测 15/15（含 4 条 remote_addr 新用例）
- [x] 契约回归：`list_visits` / `visits_overview` 输出形状不变
- [x] **跳转函数新包已上传 FC**（2026-11-11 确认：线上已有带 `remote_addr` 的真实流量行）
- [x] **#43 富化函数代码完成**：`fc/geo-enrich/`（`lib.js` 纯逻辑 + `index.js` handler），**26 例单测全绿**（含包内自带 mmdb 三例 + 时间预算一例）
- [x] **数据源换源**（2026-11-11）：MaxMind GeoLite2 → DB-IP City Lite（免费版仅个人使用，不适配对外服务；DB-IP 免 key 且允许商用）—— 详见 `geo-enrichment.md` §0
- [x] **真实 mmdb 端到端跑通**（2026-11-11）：下载 → gunzip → `maxmind.open` → 拉批 15 行 / 回写 15 行 / 369ms；库内 location 落（US·Ashburn、HK·Sheung Wan、MA·Rabat、PL·Warsaw）、`remote_addr` 清零
- [x] **`0013` 修回写失配**：PostgREST 的 timestamptz 只有毫秒精度，`(id, occurred_at)` 双条件匹配对亚毫秒行必然失配（实测 0 行、IP 不清）→ 改为只按 `id` 匹配（id 全局唯一）+ 单条 set-based UPDATE
- [x] **mmdb 随包分发**（2026-11-11，用户建议）：brotli q6 压到 52.35MB（q11 要 20+ 分钟只省 2MB，放弃）→ 走 FC Layer 分发（ZIP 直传上限 50MB，Layer 上限 250MB）；运行时不联网、不出公网、冷启动 1.0 秒（对比运行时下载 15.5 秒）
- [x] **触发频率改每小时**（用户建议）：批处理上限放大到 20 批 × 500 行 = 10000 行/轮，另加 `GEO_TIME_BUDGET_MS`（默认 45s）防超时被杀
- [x] **FC 富化函数部署**（2026-11-11 他操作完成）：建 Layer（`dist/geoip-layer.zip`）+ 代码上传 `dist/geo-enrich.zip` + 事件函数 `index.handler` + 每小时定时触发器 + 环境变量（`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`）→ 手动执行返回 `{"ok":true,"batches":1,"pulled":275,"updated":275}`；库内 291 行有地理结果、`ip_pending=0`
- [x] **`0014` 收紧入队侧 IP 留存**（2026-11-11，已应用）：`drain_visit_inbox` 落库后立即清空 `visit_inbox.remote_addr` → 线上 `visit_inbox` 持 IP 行数由 291 降到 **0**（每分钟 drain cron 自愈）。DO 块断言通过：`inbox_ip=<null>` 且 `visit_ip=203.0.113.7`（富化输入没丢）；测试数据已清理（visit 451 行、孤儿计数 429）
- [x] **真实流量端到端探针**（2026-11-11）：`curl -H "x-forwarded-for: 8.8.8.8"` 打真实短链 → 入队带 IP → 一轮 cron drain 后 inbox IP 清空、`visit` 拿到 IP → 富化写 `US / United States / California / Mountain View / 37.422,-122.085` 并清空 `visit.remote_addr`
- [x] **权限复核**（2026-11-11）：`visit` / `visit_inbox` / `visit_bak_0012` 均 `force RLS` + 0 policy，`anon`/`authenticated` 表级与列级授权均为空 —— 原始 IP 对外不可读
- [x] **DB-IP 署名（代码）**（2026-11-11）：`fc/console/index.js` 返回 HTML 时注入页脚「IP Geolocation by DB-IP」+ db-ip.com 链接，**7 例单测全绿**（不重编 Angular）
- [ ] **DB-IP 署名上线**：待他重传 `dist/console.zip`（`node scripts/build-console-fc.mjs` 已重新打包）
- [ ] **确认 FC 定时触发器 cron 已用 6 字段** `CRON_TZ=Asia/Shanghai 0 0 * * * *`（本机无法验证）

---

## B8 —— I8 M2 收尾批次（R1–R8）
- [x] 迁移 0015–0017 逐条应用成功（2026-11-11），应用前建 `api_key_bak_20261111` / `funcdef_bak_20261111`
- [x] 0015 断言：过期 key → `compat_auth` 返回 null；改未来时间 → 返回非 null
- [x] 0016 对账：`robots_crawlable_codes('example.com')` = `{9e6h3}`，与直接查询一致；不存在域名返回空
- [x] 0017 断言：临时过期/超次两行 dry-run 只列不改 → 真跑后 `enabled=false` → 临时行已删
- [x] cron job 10 `rxlink-expired`（`0 20 * * *`）active
- [x] 跳转函数单测 40/40（`ipmat` 8 + `redirect` 32）
- [x] 兼容层单测 15/15；`deno check` 全绿（含构建产物）
- [x] 线上 R1：`/nosuch` 404 HTML（invalid-short-code）、`/a/b` 与 `/` 404 HTML（404 页）；孤儿分类 `invalid_short_url`/`regular_404`/`base_url`
- [x] 线上 R2：`/2b9yj/track` 200 gif 43B 且落库 `redirect_url=NULL`；`/nosuch/track` 与 HEAD 不记访问
- [x] 线上 R3：`/robots.txt` 200 text/plain，`User-agent: *` + `Allow: /9e6h3` + `Disallow: /`
- [x] 线上 R8：HEAD `/2b9yj` 不记访问（`visits_count` 21→22，唯一新增是像素那条）
- [x] 线上 R4：`shorten` JSON / `format=txt` / `?apiKey=` 三形态 200
- [x] 线上 R7：`/visits/export` 200 CSV，`visitLocation` → `CN / Shanghai / Changning`
- [x] 线上 R6：过期 key → 401「has expired」
- [x] compat 单文件部署包上线（`functions-cli … -d supabase/functions/compat/dist`，status ACTIVE）
- [x] 测试数据清理（临时 key、3 条短链；库恢复 2 key / 9 短链）
- [x] 验收归档：`docs/verification/i8-results.md`

---

## B9 —— I9 R9 动态跳转规则
- [x] 迁移 0018 逐条应用成功（2026-11-12），应用前建 `funcdef_bak_20261112`（4 个函数定义，RLS + revoke 收口）
- [x] 0018 断言：规则增删改只 bump `rules_seq`（0→5），`link_version.seq` 恒为 97 不动；级联删除生效；`rules_snapshot()` 只返回有规则的短链；无重载残留
- [x] 0019 应用成功；`list_short_urls` 排除标签 6 条断言全通过（基线 3 / exclude x(all)→2 / x(any)→2 / x+i3(any)→1 / x+i3(all)→3 / 不存在标签→3）
- [x] 规则求值单测 `rules` 20/20；geo 查表单测 `china-geo` 6/6；`ipmat` 8/8；跳转回归 `redirect` 40/40（新增 8 条 I9 用例）
- [x] geo 二进制独立校验：32 省名（31 有中文名 + 1 空名）、22,337 区间、0 重叠、0 provId 越界；抽样 `120.235.196.208→广东`、`8.147.181.152→北京`
- [x] geo 构建自检：120,141 前缀 → 22,337 区间 → 197KB；20 万随机 IP 对拍失配 0
- [x] 兼容层单测 `compat` 30/30（新增 14 条 I9 用例）；`deno check` 全绿
- [x] compat 部署（`functions-cli … -d supabase/functions/compat/dist`，status ACTIVE）；`/health` → `version: 5.1.0`
- [x] 线上 GET `/short-urls/2b9yj/redirect-rules` → 200 `{defaultLongUrl, redirectRules:[]}`
- [x] 线上 POST 合法规则 → 200，`priority` 1..11 递增，11 种条件类型全部接受
- [x] 线上 POST 非法 `device=desktop2` → 400 `invalid-data`，detail 指出非法值
- [x] 线上 seq 独立性复验：改一次规则 `rules_seq` 31→55、`link_seq` 恒 101
- [x] 线上测试规则已清空（`short_url_redirect_rule` 0 行 / `redirect_condition` 0 行）
- [x] `dist/redirect.zip` 重打包（7 个文件，含 `china-geo.bin`），待上传
- [ ] **他上传 `dist/redirect.zip` 到 FC 跳转函数并部署**
- [ ] 线上跳转验收：写一条 `query-param src=wechat` 规则 → `?src=wechat` 跳规则目标、`?src=other` 跳默认长链（等 ≤6s 让规则缓存生效）
- [ ] 线上 geo 条件验收：国内 IP 命中省名规则，境外 IP 不命中
- [ ] 控制台界面人工验收：跳转规则页能存能删、条件类型下拉出 11 种、排除标签筛选生效、各页 Network 无 4xx（`mercure-info` 除外）
- [ ] 性能抽查：有规则 vs 无规则的 20 次最小耗时差 < 5ms
- [x] 验收归档：`docs/verification/i9-results.md`

---

# 【C】整体迭代进度清单

> 这是唯一需要频繁更新的表。每轮结束后改这里的「状态 / 实际起止 / 备注」，并在下方变更记录加一行。

| 轮 | 主题 | 状态 | 依赖 | 完成判据 | 实际起止 | 备注 |
|---|---|---|---|---|---|---|
| I0 | 决策冻结 | **已验收**（D2–D5 与默认域名已定；静态托管/红标后置到 I5 前） | — | B0 全勾 | 2026-11-09 当日 | D3 是 I1 的硬前置 |
| I1 | 数据面正式化 | **已验收** | I0 | B1 全勾 | 2026-11-09 当日 | 0004+0005+0006 三个迁移文件，验证见 `docs/verification/i1-results.md` |
| I2 | 跳转切正式表 | **已验收** | I1 | B2 全勾 | 2026-11-09 当日 | 线上 302/缓存/0.3s 传播/drain 全通；0007 修行级触发器；不做 `VISITOR_SALT`（他定） |
| I3 | 控制台连通（B1） | **已验收** | I1 | B3 全勾 | 2026-11-09 当日 | `0008` 五个 RPC + `compat` 函数；浏览器建改删查与跳转联动全通，见 `docs/verification/i3-results.md` |
| I4 | 统计读接口（B2） | **已验收** | I2、I3 | B4 全勾 | 2026-11-09 当日 | `0009` 五个 RPC + `compat` 8 条路由；概览对账、标签/域名/时间筛选、孤儿三类、删访问联动全通，见 `docs/verification/i4-results.md` |
| I5 | 控制台补全（B3/B4） | **已验收** | I4 | B5 全勾 | 2026-11-09 → 2026-11-10 | `0010` 七个 RPC + 9 条路由；用户 FC 函数 `console-prod` + 证书，正式域名页面/资源/深链/SW/跨域 API 全通，见 `docs/verification/i5-results.md` |
| I6 | 生产硬化 | **已验收** | I5 | B6 全勾 | 2026-11-10 当日 | 探针退场/prune 转真/压测(p95 416ms)/可观测/runbook/HTTPS 复测全通（B6 6/6；cdndev 放弃），见 `docs/verification/i6-results.md` |
| I7 | 地理富化（#41–#44） | **进行中（主体已上线）** | I6 | B7 全勾 | 2026-11-10 → 2026-11-11 | #41 迁移 0012 + #42 跳转/drain 带 remote_addr + #43 富化函数 + #44 契约与兜底**全部上线**；换源 DB-IP；`0013` 修回写失配；mmdb 随 Layer 分发 + 触发改每小时；`0014` 收紧入队侧 IP 留存（线上 inbox 持 IP 291→0）；FC 富化函数手动跑通 275/275；真实流量端到端探针闭环；DB-IP 署名代码完成（7 单测）；**剩他两个动作**：重传 `console.zip`、确认触发器 cron 是 6 字段 |
| I8 | M2 收尾批次（R1–R8） | **已验收** | I7 | B8 全勾 | 2026-11-11 当日 | 迁移 0015–0017 + 跳转 R1/R2/R3/R8 + 兼容层 R4/R6/R7 + cron R5 全上线；compat 改单文件构建包；见 `docs/verification/i8-results.md` |
| I9 | R9 动态跳转规则 | **进行中（兼容层与数据面已上线验收）** | I8 | B9 全勾 | 2026-11-12 | 迁移 0018/0019 已应用；兼容层 version 5.1.0 已部署，11 种条件端到端线上验通；`rules.js` + `china-geo.bin` + `rules-cache.js` 本机全绿（redirect 40/40）；**剩他上传 `dist/redirect.zip` 到 FC**，之后做跳转侧线上验收 |

状态词只用四个：**未开始 / 进行中 / 待他拍板 / 已验收**。

## 与既有任务编号的对应

| 原任务 | 归入 |
|---|---|
| #18 部署两文件版并复测 | I2（可提前单独做） |
| #23 api_key + 兼容层鉴权与 CORS | I3 的前半 |
| #24 兼容层 B1 | I3 |
| #25 兼容层 B2 | I4 |
| #26 兼容层 B3 | I5 |
| #27 兼容层 B4 | I5 |
| #13 HTTPS 证书复测 | I6 |

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-09 | 首版；确立 I0–I6 切法与三份清单；标注 0004 与契约的 6 处字段差异 |
| 2026-11-09 | I0/I1 验收；0004+0005+0006 已应用；I2 代码与本机验证完成，挂 cron 6/7，状态转进行中 |
| 2026-11-09 | I2 线上复测通过（302/`cached=1`/0.3s 传播/drain）；发现并修复语句级触发器 0 行也 bump 的问题（0007 行级） |
| 2026-11-09 | I3 验收：0008 五个 RPC + `compat` 函数上线；控制台 Add server / 建改删查 / 重复 slug / 错误 key / CORS 全通 |
| 2026-11-09 | I4 验收：0009 五个 RPC + 8 条统计路由上线；概览对账、标签/域名/时间筛选、孤儿三类、删访问联动全通；修 `itemsPerPage=5000` 钳位与 ADB 无 WHERE 禁删 |
| 2026-11-09 | I5 代码完成：0010 七个 RPC + 9 条路由；标签/域名/Mercure/规则 UI 联调全通；build 产物内联为单文件 `console` 函数并部署 ACTIVE；差正式域名绑定 |
| 2026-11-10 | I5 正式地址：静态包改挂用户 FC 函数 `console-prod`；补证书后 `console.example.com` 页面/资源/深链/31 次跨域 API/SW 全通（0 页面错误）⇒ I5 验收 |
| 2026-11-10 | I6 进行中：探针全退场（库 0/代码删/部署删/cron 5 移除）；prune 转真 job 8 + i6prune 停用→404→撤销闭环；i6load 50 并发 1000/1000=302、p95 416ms；可观测健康查询 + runbook 落地；差 dev/cdndev 证书 |
| 2026-11-10 | cdn.example.com 定案放弃：全仓库仅 docs 历史引用、无运行代码/配置依赖（P0 CDN 测试域名）；B6 HTTPS 项收窄为仅 example.com，云上 CDN 域名与解析可下线 |
| 2026-11-10 | I6 验收：example.com 证书（DigiCert DV）受信，HTTPS 302/cached=1、HTTP 301 强制跳转、陌生码 404、访问统计 14→15 落库全通；B6 6/6；Domains 红标改因 health 路径 404（I0 观察项），runbook 口径同步 |
| 2026-11-10 | 收尾批次：0011 加 `not_found_redirects` RPC + 默认域名 scheme 改 https；跳转函数 404 分支按 shlink 语义回跳（域名级优先/占位符/双斜杠折叠），孤儿分类对齐；线上三类回跳闭环实测后临时配置已清；TDD 回归测试 11/11 |
| 2026-11-10 | 交接：新增 `docs/handover.md`（项目定位/架构、线上状态、仓库地图、跑验证、平台坑、凭据红线、待办 #41–#44 与发布前置、工作约定）；地理富化设计定稿（`geo-enrichment.md`）转入待实现 |
| 2026-11-10 | I7 起：仓库纳入 git（基线提交 3c95212）；`0012_geo_location.sql` 15 条语句上线（列改名已传播到三个分区、部分索引、三个 RPC、drain 覆盖、visit_json 覆盖、兜底 cron jobid 9）；跳转函数加 `remote_addr`（TDD，先红后绿，单测 15/15）；`dist/redirect.zip` 已重打包待上传；#43 富化函数等 MaxMind key |
| 2026-11-11 | 采纳用户两条建议：① mmdb 改为随包分发（brotli q6 → 52.35MB，走 FC Layer，运行时不联网、不出公网，冷启动 15.5s→1.0s，省每月约 29 元出网流量；新增 `build-geoip-bundle.mjs` / `build-geo-enrich-fc.mjs` 两个可复现构建脚本）② 定时触发器由每分钟改每小时（批处理上限 5→20 批，另加 45s 时间预算防超时）；单测 20→24 例 |
| 2026-11-11 | I7 主体完成：跳转包已上传（线上实测有真实流量带 remote_addr）；**发现并修 `apply_visit_locations` 回写失配** —— PostgREST 的 timestamptz 只有毫秒精度，`(id, occurred_at)` 双条件对亚毫秒行必然失配（实测 0 行、IP 不清）→ 新增 `0013` 改为只按 `id` 匹配（id 全局唯一）+ 单条 set-based UPDATE；**换源 MaxMind → DB-IP City Lite**（MaxMind 免费版「仅个人使用」不适配对外服务，DB-IP 免注册免 key 且 CC BY 4.0 允许商用，代价是无 time_zone 字段）；`fc/geo-enrich/` 实现完成（lib 纯逻辑 + index handler，20 例单测全绿），真实 mmdb 端到端跑通（拉批 15 / 回写 15 / 369ms，库内 location 落、IP 清零）；`dist/geo-enrich.zip` 已打包待部署 |
| 2026-11-11 | I7 上线与收尾：用户部署 FC 富化函数（Layer + 代码包 + 环境变量 + 每小时触发器），手动执行 `{"ok":true,"batches":1,"pulled":275,"updated":275}`，库内 291 行有地理结果、`ip_pending=0`；**新增 `0014`** 覆盖 `drain_visit_inbox`，落库后立即清空 `visit_inbox.remote_addr`（入队侧 IP 留存从最长 1 天 → 分钟级，线上 inbox 持 IP 行 291→0），DO 块断言「inbox 清空 + visit 仍拿到 IP」通过；真实流量端到端探针闭环（`x-forwarded-for: 8.8.8.8` → US·California·Mountain View）；**DB-IP 署名**实现在 `fc/console/index.js` 注入页脚（不重编 Angular，7 例单测全绿），`dist/console.zip` 已重打包待上传；权限复核：visit/visit_inbox 均 force RLS + 0 policy，anon/authenticated 无表级与列级授权；`design/`（另一任务产物，21MB）移出版本控制，文件保留在工作区 |
| 2026-11-12 | I9 R9 动态跳转规则启动：设计稿与实施计划定稿（`docs/superpowers/specs|plans/2026-11-12-r9-dynamic-redirect-rules*`）；`rules.js` 条件求值（20/20）、`china-geo.bin` 中国省级表（6/6 + 20 万 IP 对拍）、迁移 0018/0019（规则表 + 独立 `rules_version` + 排除标签筛选）、兼容层 11 种条件校验 + version 5.1.0（30/30）、跳转函数 `rules-cache.js` 接入（redirect 40/40）；**关键设计**：规则写操作只 bump `rules_version`，`link_version` 恒不动（线上复验 31→55 vs 恒 101）；计划里的代码块全部先实跑再落地，抓出 4 处真 bug（含两处 forward_query 断言错误）
| 2026-11-11 | I8 收尾批次完成并验收：迁移 0015–0017 应用 + 断言（备份表已建）、cron job 10 `rxlink-expired`；跳转函数 R1/R2/R3/R8（404 HTML / 追踪像素 / robots.txt / 追踪开关，单测 40/40）与兼容层 R4/R6/R7（shorten / 访问导出 / key 过期，单测 15/15）上线；compat 部署改单文件构建包（`scripts/build-compat-function.mjs`，消除多文件歧义）；线上 R1–R8 全通、测试数据已清；git `2437179`；归档 `docs/verification/i8-results.md` |
