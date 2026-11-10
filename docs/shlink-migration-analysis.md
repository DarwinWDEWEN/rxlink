# shlink 功能面全景与迁移清单（v0.1，2026-11-09）

> 定位：`docs/tech-framework.md` §7 是「哪些做法照搬 / 换掉 / 砍掉」的结论表；这份文档是它的展开——把 shlink **到底有哪些功能、面向哪些终端、暴露哪些接口**摊开，逐项标出在我们这套栈上的落点和坑，再给出可执行的迁移准备清单。
> 证据：所有 shlink 断言按 `文件:行` 给出，基于仓库内只读副本 `shlink/`（v4，PHP `^8.4`，见 `composer.json:15`）。凡调研中确认「仓库内无」的，文档里照样写「仓库内无」，不补外部知识。
> 我们侧的结论不重复论证，只指回 `tech-framework.md` 对应小节。

---

## 1. 先给规模感（每个数字都有出处）

| 维度 | 数量 | 证据 |
|---|---|---|
| CLI 命令 | **31** | `module/CLI/config/cli.config.php:10-51`（注册表）；`module/CLI/src/Command/**` 共 39 个文件，其余 8 个是 Input/Util 辅助类 |
| REST 路由常量 | **26** 个 `ROUTE_PATH` | `module/Rest/src/Action/**`（一个 Action 可挂多个 path） |
| ORM 实体映射 | **12** 张表 | `module/Core/config/entities-mappings/` 10 个 + `module/Rest/config/entities-mappings/` 2 个 |
| Doctrine 迁移 | **19** 个 | `module/Core/migrations/Version20230211171904.php` → `Version20260607082210.php` |
| 环境变量 | **68** 个 | `module/Core/src/Config/EnvVars.php:24-91`（每个都额外支持 `<NAME>_FILE` 间接读取，`:93-113`） |
| 动态跳转条件类型 | **11** 种 | `module/Core/src/RedirectRule/Model/RedirectConditionType.php:16-28` |
| 长连接/推送通道 | 3 选 1（Mercure / RabbitMQ / Redis pub-sub） | `module/Core/config/event_dispatcher.config.php:59-95` |

一句话：**shlink 是一个「服务端功能很厚、客户端很薄」的产品**——所有管理动作都能走 CLI 或 REST，界面（shlink-web-client）只是这些接口的消费者，仓库内没有一行界面代码（`README.md:93` 指向外部 `shlinkio/shlink-web-client` / app.shlink.io）。这对我们是好消息：迁移的对照物是**接口和数据模型**，不是像素。

---

## 2. 功能全景表

分期标记：**M0** 已上线；**M1** 第一期（能建能跳能看数的最小可用平台）；**M2** 第二期（数据面完整）；**M3** 第三期（增值能力）；**❌** 明确不做；**❓** 需要他拍。

「落点」= 在我们这套栈里由谁承担：`SQL` = 表/函数/触发器/pg_cron；`FC` = 跳转函数（`fc/redirect/`）；`GW` = PostgREST/Edge Function 数据面；`WEB` = 控制台；`云` = 阿里云控制台侧的资源配置（不是代码）。

### 2.1 短链本体

| 功能 | shlink 证据 | 我们的落点 | 坑 / 依赖 | 期 |
|---|---|---|---|---|
| 随机短码生成（默认 5 位，下限 4 位硬编码） | `config/constants.php:11,13`；`module/Core/functions/functions.php:43-51` 字符集 STRICT=`[0-9a-zA-Z]` / LOOSE=`[0-9a-z]` | `SQL`：`generate_short_code()` 函数 + 创建 RPC 内循环重试 | 撞库语义（自定义 slug 撞→409，随机→重试）已在 §7 定为照搬 | M1 |
| 自定义 slug / pathPrefix | `module/Core/src/ShortUrl/Model/ShortUrlCreation.php:68-85`（保留字符 `:?#[]@` 拒绝，空格→`-`） | `SQL` + `GW` 入参校验 | 校验规则要照抄，否则同名短链会写出脏数据 | M1 |
| 多段 slug（`a/b/c`） | `config/autoload/multi-segment 处理`：`module/Core/src/Config/PostProcessor/MultiSegmentSlugProcessor.php:19`；env `MULTI_SEGMENT_SLUGS_ENABLED` | `FC`：路由要放开 `/` | 会改变跳转函数的 path 解析，**要就一期定，别后补** | ❓ |
| 同链查重 `find_if_exists` | `module/Core/migrations/Version20260524105410.php`（加 `long_url_hash`）+ `functions.php:269-273`（`hex2bin(sha256)`→PG `bytea`） | `SQL`：`digest(long_url,'sha256')` + 索引 | §7 已定照搬。注意 shlink 最新迁移还在**回填历史 hash**（`Version20260607082210.php`），我们从零建表不需要 | M2 |
| 标题自动解析 | `module/Core/src/ShortUrl/Helper/ShortUrlTitleResolutionHelper.php:30-31`（`MAX_REDIRECTS=15`、伪装 Chrome UA） | `GW`：建链时同步抓取，或改异步任务 | **需要函数出公网**。绑 VPC 后出站全进 VPC，公网要 NAT 网关（`tech-framework.md` §5.2.1 副作用清单）。→ 建议 M3 或干脆让控制台手填 | M3 |
| 短链编辑（长链/title/tags/有效期三元组/forwardQuery/crawlable） | REST `PATCH /short-urls/{code}`：`module/Rest/src/Action/ShortUrl/EditShortUrlAction.php:20` | `SQL` 更新函数 + `GW` | 写路径必须同事务 bump `link_version`——已由触发器保证（`supabase/migrations/0002_link_cache_version.sql`） | M1 |
| 短链删除（阈值保护 + 级联） | `DeleteShortUrlService.php:29`；阈值 `DEFAULT_DELETE_SHORT_URL_THRESHOLD=15`（`config/constants.php:9`），**env 没显式设就整体关闭检查**（`module/Core/src/Config/Options/DeleteShortUrlsOptions.php:20-25`） | `SQL`：软删 `enabled=false`（§5.4 口径） | shlink 是**物理删 + visits 级联删**（`short_url_visits_counts` FK CASCADE）；我们软删，所以不碰 FK | M1 |
| 过期短链批量清理 | `module/Core/src/ShortUrl/Repository/ExpiredShortUrlsRepository.php:50-69`（`valid_until < now` OR `max_visits <= SUM(count)`）；CLI `short-url:delete-expired` | `SQL` + `pg_cron` | 与我们 §5.4 的「长期无访问」是**两条不同规则**，都要有：三元组到期 与 180 天无访问 | M2 |
| 有效性三元组 `valid_since/valid_until/max_visits` + `isEnabled()` | `module/Core/src/ShortUrl/Entity/ShortUrl.php:227-246` | `SQL`：列 + 跳转侧判定 | **`enabled` 语义要拆开**：人工禁用 vs 规则过期。快照只装 `enabled` 行（§5.2.2），所以过期判定必须能把「过期」算进 `enabled`，否则过期短链还在快照里跳 | M2 |
| 短链列表（分页 + 多筛选） | `module/CLI/src/Command/ShortUrl/Input/ShortUrlsParamsInput.php`；REST `GET /short-urls`；`DEFAULT_ITEMS_PER_PAGE=10`（`ShortUrlsParams.php:21`） | `GW`：PostgREST 原生 filter + 视图 | tag 的「全部包含 vs 任一包含」两套语义（`ShortUrlRepository.php:182-198` `COUNT(t.id) GROUP BY`）在 PostgREST 里要落成 RPC | M1 |

### 2.2 跳转热路径（匿名访客）

| 功能 | shlink 证据 | 我们的落点 | 坑 / 依赖 | 期 |
|---|---|---|---|---|
| `GET /{shortCode}` → 302 | `config/autoload/routes.config.php:100`；`module/Core/src/Action/RedirectAction` | `FC`（已上线，§5.1/§5.2） | 状态码/域名/统计已实测 | M0 |
| 域名优先 > 全局短码的单查询选择 | `module/Core/src/ShortUrl/Repository/ShortUrlRepository.php:32-36`（PG 还要翻转 NULLS 排序） | `FC` 快照的双 Map（`byDomain` / `byGlobal`，`fc/redirect/cache.js`） | 已实现。注意 shlink 这个 `ORDER BY domain ASC` 就是为 PG 的 NULL 排位打的补丁，我们用两个 Map 绕过去了 | M0 |
| 大小写语义 | LOOSE 模式 `LOWER(short_code)=lower(:code)`，源码自带性能 FIXME（`ShortUrlRepository.php:39-40`） | 入库统一小写（§7） | 迁移过来的历史短码**不能直接小写**：`AbC123` 和 `abc123` 若同时存在即冲突，需要预检 | M1 |
| 跳转状态码可配（301/302/307/308） | `RedirectStatus.php:12-34`；301/302 会把路由限成 GET only（`:25-33`） | `SQL`：短链级/域名级列 + `FC` 读 | 301/308 一旦用了，浏览器自己就缓存了，**统计必然丢**——和「逐次准确」冲突 | ❓ |
| `Cache-Control` | 只在 `allowsCache()` 时发，而它**只对 301/308 为真**（`RedirectStatus.php:19-22`）；默认 302 ⇒ 响应里根本没有 `Cache-Control`（`module/Core/src/Helper/RedirectResponseHelper.php:19-30`） | — | 这条正好印证 §5.2.2 的判断：shlink 自己也不指望中间层缓存 302。**可当作论据引用** | — |
| query 参数转发 `forwardQuery` | `ShortUrlRedirectionBuilder.php:29-64`；列 `short_urls.forward_query` 默认 true（`ShortUrl.php:138-142`） | `FC` 拼接 | 拼接要防注入：只允许「原样转发 + 追加」，不接受来自 query 的目标地址 | M1 |
| `extraPath` 追加/忽略 | env `REDIRECT_EXTRA_PATH_MODE`（`UrlShortenerOptions.php:38-39`）；`ExtraPathRedirectMiddleware.php:52-99` | `FC` | 与多段 slug 是同一件事的两面 | ❓ |
| 禁用追踪参数 | env `DISABLE_TRACK_PARAM`（`TrackingOptions.php:41-49`） | `FC` | 小功能，顺手 | M2 |
| 404 三类回退（base_url / invalid_short_url / regular_404） | `NotFoundType.php:22-31`；`NotFoundRedirectHandler.php:25-51`（域名级优先，落回全局 env）；占位符 `{DOMAIN}`/`{ORIGINAL_PATH}`（`NotFoundRedirectResolver.php:20-21`） | `SQL`：domain 表三列 + `FC` 读快照 | 与 §5.3「孤儿访问三分类」成对出现：回跳配置 + 落库分类 | M2 |
| 默认 404 页 HTML | `module/Core/templates/404.html`、`invalid-short-code.html`（`NotFoundTemplateHandler.php:20-41`） | `FC` 内联 / `WEB` 静态页 | 三分类的**可见出口**，不做的话用户只会看到裸 404 | M2 |
| 追踪像素 `/{code}/track` | `routes.config.php`；`module/Core/src/Action/PixelAction.php:14-25`（成功失败都吐 1×1 GIF） | `FC` 一个分支 | 营销邮件场景。零依赖 GIF 可内联 base64 | M3 |
| `robots.txt`（枚举 crawlable 短码） | `module/Core/src/Action/RobotsAction.php:32-57`；`ROBOTS_ALLOW_ALL_SHORT_URLS`/`ROBOTS_USER_AGENTS` | `FC` | crawlable 列已在短链上；注意它会把**全部短码公开** | M3 |
| 尾斜杠 | env `SHORT_URL_TRAILING_SLASH` → 路由后缀 `[/]`（`routes.config.php:24,100`）+ `TrimTrailingSlashMiddleware.php:26-35` | `FC` 归一化 | 我们解析 path 时直接 `replace(/\/$/,'')` 即可，无需开关 | M1 |
| 子路径部署 `BASE_PATH` | `module/Core/src/Config/PostProcessor/BasePathPrefixer.php` | — | 我们绑自定义域名根路径，不需要 | ❌ |

### 2.3 统计与访客数据

| 功能 | shlink 证据 | 我们的落点 | 坑 / 依赖 | 期 |
|---|---|---|---|---|
| 访问明细落库（referer/UA/remoteAddr/visitedUrl/redirectUrl/type/bot） | 表 `visits`（`module/Core/config/entities-mappings/...Visit.php`，长度上限 `Visitor.php:20-24`：UA 512、referer 1024、addr 256、url 2048）；**跳转请求内同步事务写**（`module/Core/src/Visit/VisitsTracker.php:67-81`） | `SQL`：`visit_inbox` → `visit` 明细（§5.3）；`FC` 入队 | 长度上限要在入队前截断，否则一条超长 UA 打断整批落库 | M1 |
| **没有**队列/异步 processor | v4 `VisitProcessor`、`TransientParams`、`visit:process`、`visit:cleanup` 全部**仓库内无**（grep 无匹配）；`UPGRADE.md:66` 记「`ENABLE_PERIODIC_VISIT_LOCATE` 的 cron 已移除，因为访问即时定位」 | — | **重要纠偏**：shlink v4 是「跳转即写库」的同步模型，我们「inbox + cron 批量物化」反而是我们自己的设计，别在文档里写成「照搬 shlink」 | — |
| slot 打散计数表 | `short_url_visits_counts`（`UNIQUE(short_url_id,potential_bot,slot_id)`，`...ShortUrlVisitsCount.php:50`）+ PG upsert（`ShortUrlVisitsCountTracker.php:90-98`）；孤儿另有一张 `orphan_visits_counts`（`UNIQUE(potential_bot,slot_id)`） | `SQL`（§5.3 每批 ≤100 slot UPSERT） | 计数查询一律 `COALESCE(SUM(count),0)`，**不是 `COUNT(visits)`**（`ShortUrlVisitsCountRepository.php:16-31`）。列表页/阈值判定都读它 | M2 |
| Bot 判定 | `Jaybizzle/CrawlerDetect` 第三方库，`functions.php:155-158` 无条件执行，**没有关掉它的 env**（只有 `DISABLE_UA_TRACKING` 会清空 UA 但保留 flag，`Visitor.php:86-95`） | `SQL`：`bot_pattern` 表 + 落库前打标（§5.3 已定） | 正则库在 vendor，仓库内无源文件 → **规则得我们自己整理**，不能指望从这份副本里拷出来 | M2 |
| 孤儿访问三分类 | `RequestTracker.php:36-52`；`OrphanVisitType` | `SQL` + `FC` 上报（§5.3） | — | M2 |
| 匿名化 / 定向不追踪 | `TrackingOptions.php:17-49`：`ANONYMIZE_REMOTE_ADDR`(默认 true)、`DISABLE_TRACKING`、`DISABLE_IP_TRACKING`、`DISABLE_REFERRER_TRACKING`、`DISABLE_UA_TRACKING`、`DISABLE_TRACKING_FROM`(IP/CIDR 列表) | `SQL`：只存加盐哈希 `visitor_key`（§5.3 已定「不在热路径存 IP」） | 我们的口径比它更严；`DISABLE_TRACKING_FROM` 这类黑名单若要，得在入队前判定 | M2 |
| 唯一访客 / VisitorCodex | **仓库内无**（grep 无匹配） | — | 旧版有、v4 没有。列在这里是为了**下次别再当 shlink 现有功能提** | ❌ |
| 地理定位（mmdb + `visit_locations` + 自动更新器） | `visit_locations`（`lat/lon float NOT NULL`、`is_empty`）；`visit:locate` 回填；`GeolocationDbUpdater.php:28,79-98`（30 天刷新、连续 15 次失败退避 2 天）；`GEOLITE_LICENSE_KEY` 无默认（`UPGRADE.md`） | `SQL` 离线富化 / 后续 Edge Function | 三重依赖：License key、**出公网下载**（VPC 后需 NAT）、mmdb 文件落哪（FC `/code` 只读、`/tmp` 易失）。§5.3 已定不在热路径 | M3 |
| 统计查询（全局/短链/标签/域名/区间） | REST 6 个 visits 端点（§4 表） | `GW`：视图 + RPC | 时间区间在 shlink 全在 PHP 侧算（仓库内无 `date_trunc`/`INTERVAL` SQL），我们直接写 SQL 更省事 | M1 |
| CSV 导出 | CLI `--format=csv`（`VisitsListFormat.php:19`；表头 `VisitsCommandUtils.php:86-97`；1000 行分块）；REST **无**导出端点 | `WEB`：前端导出 or `GW` 端点 | 只有访问能导 CSV，短链列表不能（`shlink-importer` 是外部包，`composer.json:48`） | M2 |
| 实时推送 | Mercure / RabbitMQ / Redis 三选一（`event_dispatcher.config.php:59-95`）；4 个 topic（`Topic.php:12-15`：new-visit、new-visit/{code}、new-orphan-visit、new-short-url）；前端靠 `GET /mercure-info` 拿 hub+JWT（`MercureInfoAction.php:35-43`） | 待定：Supabase Realtime 或控制台轮询 | **长连接 + 独立 hub 服务**，我们这套没有；`tech-framework.md` §9 已把 Realtime 划出本期 | M3/❓ |
| Matomo 对接 | `event_dispatcher.config.php:44-46`、`MATOMO_*`（`EnvVars.php:53-56`）、CLI 补发 | ❌ | §9 已出界 | ❌ |

### 2.4 标签、域名、鉴权

| 功能 | shlink 证据 | 我们的落点 | 坑 / 依赖 | 期 |
|---|---|---|---|---|
| 标签 CRUD/重命名/删除/统计 | REST 4 个 tag 端点；`tags.name` UNIQUE；多对多 `short_urls_in_tags` | `SQL` + `GW` | shlink 的重命名**带悲观锁**防并发（`TagService.php:32`），我们靠 UNIQUE 约束 + 事务即可 | M1 |
| 标签可见性按 API key 作用域切 | `Role::toSpec` → `BelongsToApiKey`/`BelongsToDomain`（`module/Rest/src/ApiKey/Role.php:33-49`），整套是 Doctrine Specification 过滤 | `RLS`（§7 已定换成 Auth + RLS） | 这是 §7 里最重的一条替换：shlink 的数据可见性**贯穿每一张表的每个查询**，我们的对应物必须是 RLS 策略，不能只在接口层判 | M1 |
| 域名 = 一条数据 | `domains`（`authority` UNIQUE + 三个 404 列）；行由 `DomainService::getOrCreate` 在建短链时隐式创建；**无域名状态/SSL 字段**（`Domain.php`，`DomainStatus` 仓库内无） | `SQL` domain 表 **+ 云** | **迁移清单里最大的隐藏工作量**：shlink 加一个域名 = 插一行 + 改 env；我们加一个域名 = 备案 + FC 自定义域名 + 证书 + 路由（`tech-framework.md` §3、§6.2、§6.4）。数据模型抄得再像也抄不掉这一段 | M1 起持续 |
| API Key | `api_keys`（`key` 存 `sha256` hex、`name` UNIQUE 但**应用层加锁保证**，`ApiKey.php:51-54`、`ApiKeyRepository.php:45-60`）；roles 三种 `AUTHORED_SHORT_URLS`/`DOMAIN_SPECIFIC`/`NO_ORPHAN_VISITS` 且**整个 enum 已标 @deprecated**（`Role.php:17`）；零 role 即 admin（`ApiKey.php:95-97`）；**无 REST 管理端点，只能 CLI**（`README.md:95`、`config/autoload/routes.config.php:30-77`） | `GW`：换成 Supabase Auth / `service_role` | 要不要对第三方程序开放「用 API key 建链」是个**产品决策**，不是迁移细节 → 见 §9 决策 D1 | ❓ |
| 初始 key 引导 | `INITIAL_API_KEY` 只被 `docker/docker-entrypoint.sh:14,21-24` 读，交给外部 `shlink-installer`；`api-key:initial` 仅在表空时插（`ApiKeyRepository.php:19-42`） | — | 我们没有 installer，引导=控制台首个账号 | M1 |

### 2.5 运维与部署面（我们已由别的机制承担）

| shlink 的做法 | 证据 | 我们 | 期 |
|---|---|---|---|
| `db:create` / `db:migrate` CLI（hidden，带文件锁 TTL 600s） | `CreateDatabaseCommand.php:32-34,65`；`MigrateDatabaseCommand.php:22-24`；`LockConfig.php:9` | `supabase/migrations/NNNN_*.sql` 编号文件（§8 约定） | 已 |
| 全新安装**不重放迁移**，直接按元数据建表 | `CreateDatabaseCommand.php:65`（`orm:schema-tool:create`） | 我们同样以「§5 的当前形状」为准，19 个迁移只当变更史读 | — |
| RoadRunner：HTTP worker 循环 + `max_jobs: 250` 回收、`jobs` 内存队列跑异步监听 | `bin/roadrunner-worker.php:27-43`；`config/roadrunner/.rr.yml:15-30`；启动 `docker/docker-entrypoint.sh:28-31` | FC 实例 + `link_version` 轮询（§5.2.2）+ pg_cron | 已 |
| 进程内一切都会随 worker 回收丢失（每 250 请求） | `.rr.yml:15-23` 注释「to mitigate memory leaks」 | 我们的快照同样按「会丢」设计：首拉失败就走查库，不依赖快照常驻 | 已 |
| 单节点假设：`data/` 可写目录 6 个（cache/locks/log/proxies/temp-geolite + sqlite + mmdb）、文件锁、配置缓存 | `docker-entrypoint.sh:7`；`entity-manager.global.php:56-76`；`locks.global.php:15-16` | FC 无状态 + 库里 inbox；**这套横向扩展约束我们天然没有** | — |
| `TRUSTED_PROXIES` 手工声明前置代理链 | `config/autoload/ip-address.global.php:13-38`（探测 `CF-Connecting-IP`/`X-Forwarded-For`/`X-Real-IP`） | 按入口分派取 IP：FC 自定义域名取 `x-forwarded-for` 首元素，CDN→Supabase 取 `ali-cdn-real-ip`（§5.3 已实测） | 已 |
| crontab 配置 | **仓库内无 crontab 文件**，grep 到的唯一 `cron` 是 `UPGRADE.md:66` 说明它被删了 | 我们的定时全在 `pg_cron`（§5.3/§5.4） | — |

---

## 3. 终端清单

| 终端 | shlink 侧证据 | 迁移后由谁承担 | 备注 |
|---|---|---|---|
| **匿名访客浏览器** | 非 `/rest` 路由：`GET /{code}`、`/{code}/track`、`/robots.txt`、HTML 404 页（`routes.config.php:80-108`） | `FC` 自定义域名（`example.com` 已上线） | 唯一必须「免鉴权」的一层 |
| **管理控制台** | 外部 `shlink-web-client`（`README.md:93`）；服务端仅提供 `GET /domains`（含 `isDefault` + `defaultRedirects`，`ListDomainsAction.php:34-42`）与 `GET /mercure-info` 两个「界面自述」端点 | **2026-11-09 定案：复用 web-client v4.9.0**（源码已在仓库内 `shlink-web-client/`；本机 Node 24 下 build 通过，产物浏览器验证可跑） | 界面一行不改 ⇒ 它依赖的契约要逐字段对上：`docs/shlink-api-contract.md` |
| **第三方程序 / 脚本** | 全部 REST 端点 + `X-Api-Key`（`AuthenticationMiddleware.php:24,64`）；`apiKey` 查询参数**仅** `GET /short-urls/shorten` 一条路例外（`module/Rest/config/auth.config.php:16-18`） | 决策项 D1 | 那条「单步建链」例外就是为了把链接塞进浏览器书签/分享按钮 |
| **运维 CLI** | 31 个命令（§2.5） | 无对应物：`SQL` + `pg_cron` + 阿里云控制台 | 迁移时最容易漏的一类——命令背后隐含的**数据修复动作**要逐条找落点 |
| **桌面/移动/浏览器扩展 / SDK** | `shlink-sdk` **仓库内无**、非依赖；Slack、webhooks 均**仓库内无**（webhooks 已废弃并指向 real-time，`UPGRADE.md:30`） | 不做 | 之前调研里提过的「Slack/webhook 要不要迁」可以结案：**本期无对应物可迁** |
| **二维码 / 预览页** | 已从服务端移除，逻辑挪进 web-client 与 Dashboard（`UPGRADE.md:7`） | 若要，纯前端生成 | `/{code}/qr-code`、`/{code}/preview` 现在都是 404 |

---

## 4. 接口清单与我们的对应契约

> **契约的权威来源已确定（2026-11-09 实测）**：不在 PHP 源码里，也不在 OpenAPI（这份副本 `docs/` 是空的，`composer.json:153-154` 指向的 `docs/swagger/swagger.json` 没随仓提供），而在 **`@shlinkio/shlink-js-sdk@3.2.1`**（MIT，`registry.npmjs.org` 可达）。它的 `dist/api/ShlinkApiClient.d.ts` 列出 **23 个方法**（就是 web-client 实际会打的接口面；2026-11-09 二次核对，此前写的「27」是数错了）、`dist/api-contract/types.d.ts` 209 行 / 40 个类型定义了每个请求与响应的字段名。base 为 `{baseUrl}/rest/v{version}`，鉴权头在 `dist/index.js` 里是字面量 `{ "X-Api-Key": this.#n.apiKey }`。**兼容层照这两份 .d.ts 对齐即可，不需要反推 PHP。** 字段级契约见 `docs/shlink-api-contract.md`，原件存档在 `docs/reference/shlink-sdk-3.2.1/`。

### 4.1 REST（26 个 path，全部挂在 `/rest/v{1|2|3}`）

前缀定义 `module/Rest/src/ConfigProvider.php:15`。**v1/v2/v3 由同一个 Action 应答、行为无分支**，版本号只影响错误码（`UPGRADE.md:45`）；`/rest/health` 是唯一免版本的路由（`ConfigProvider.php:24-49`）。

| shlink 端点 | 方法 | 我们的对应 |
|---|---|---|
| `/health`（+`/rest/health`） | GET | `GW` 平台自带健康检查；我们自己出 `status/version` |
| `/mercure-info` | GET | ❌ 无对应（Realtime 出界） |
| `/short-urls` | POST / GET | `GW` RPC `create_short_url` / PostgREST 列表 |
| `/short-urls/shorten`（query 传参单步建链） | GET | `GW` RPC，若要给第三方按钮用 |
| `/short-urls/{code}` | GET / PATCH / DELETE | `GW` 读 + 更新 RPC + 软删 RPC |
| `/short-urls/{code}/visits` | GET / DELETE | `GW` 视图 + 删除 RPC（删明细，不删短链） |
| `/short-urls/{code}/redirect-rules` | GET / POST / PATCH | M3；**PATCH 语义是整套替换**，不是增删单条 |
| `/tags`、`/tags/stats`、`PUT /tags`（重命名）、`DELETE /tags` | GET/PUT/DELETE | `GW` 表 + RPC |
| `/tags/{tag}/visits` | GET | `GW` 视图 |
| `/domains`（含 default + redirects） | GET | `GW` domain 视图 + 「云」侧状态另说 |
| `/domains/redirects` | PATCH | `GW` 更新三个 404 列 |
| `/domains/{domain}/visits` | GET | `GW` 视图 |
| `/visits`（全局） | GET | `GW` 视图 |
| `/visits/orphan` | GET / DELETE | `GW` 视图 + RPC |
| `/visits/non-orphan` | GET | `GW` 视图 |
| — | — | **API key 无 REST**（CLI-only），我们对应物 = Supabase Auth 管理面 |

**错误体口径**：shlink 用 RFC7807 `application/problem+json`，type 前缀 `https://shlink.io/api/error/*`（`config/autoload/error-handler.global.php:12-17`）。`tech-framework.md` §9 若要保持对外可预测，我们抄这个格式成本很低 → 列入 §7 准备项。

**分页口径**：`page` + `itemsPerPage`（负数/缺省 = 全量，`AbstractInfinitePaginableListParams.php:27-30`），返回 `{data, pagination}`。

### 4.2 CLI 31 命令的逐条归属

按「我们用什么替代」分四类：

| 类别 | 命令 | 替代 |
|---|---|---|
| **表操作** | `short-url:create/edit/delete/resolve/list/visits/visits-delete/delete-expired`、`tag:*`、`domain:*`、`visit:orphan/non-orphan/orphan-delete` | `GW` REST/RPC + 控制台；批量类（`delete-expired`、`orphan-delete`）→ `pg_cron` 函数（§5.4 已是这个模式） |
| **DB 生命周期** | `db:create`、`db:migrate` | `supabase/migrations/`（人工，带备份） |
| **密钥** | `api-key:generate/list/disable/delete/rename/initial` | ❓ 决策 D1 |
| **需要外部 I/O 或本地文件的** | `visit:locate`、`visit:download-db`、`integration:matomo:send-visits`、`env-var:read` | 地理：M3 且需 NAT；Matomo：❌；`env-var:read`：❌（我们没有 installer 脚本） |

CSV 导出没有独立命令，是 `*-visits` 的 `--format=csv`（§2.3）→ 我们要么给 `GW` 加一个导出端点，要么让 `WEB` 自己导。

---

## 5. 数据模型对照（12 张表 → 我们的取舍）

| shlink 表 | 关键列/约束 | 我们 | 备注 |
|---|---|---|---|
| `short_urls` | `UNIQUE(short_code, domain_id)`（`ShortUrl.php:118`）；`long_url_hash bytea` + `IDX_long_url_hash`；`forward_query` 默认 true、`crawlable`/`title_was_auto_resolved` 默认 false；FK `domain_id` **RESTRICT**、`author_api_key_id` SET NULL | 🔁 建为正式 `short_url`（0004），FK 用 domain **text** 而非 id 已定（§4 探针表口径）；`author_api_key_id` → 换成 owner/RLS | `original_url` 是 `text` 但语义 2048（mapping 同时写 `TEXT` 和 `length(2048)`，DBAL 在 PG 下忽略长度）→ **我们要么加 CHECK 要么明确不限制** |
| `urls`（LongUrl） | — | ❌ **不存在** | `LongUrl` 实体在 v4 已合并进 `short_urls.original_url`（`...ShortUrl.php:26-29` 注释「Rename to long URL some day?」）。之前调研里按「有 LongUrl 表」写的 DDL 要更正 |
| `tags` | `name` UNIQUE | ✅ | |
| `short_urls_in_tags` | 复合主键、双向 CASCADE | ✅ | 迁移里从未被改动（19 个文件 grep 无匹配）→ 形状稳定 |
| `domains` | `authority` UNIQUE + 三个 2048 的 text 回退列 | 🔁 保留结构，但**默认域名来自云配置**（§3 多域名结论） | shlink 的 `DEFAULT_AUTHORITY='DEFAULT'` 哨兵行我们可以直接用 domain 列 `''` 表示全局（§5.2.2 已这么实现） |
| `visits` | 单表，`short_url_id` CASCADE、`visit_location_id` SET NULL；`IDX_visits_date`；`type` 枚举含 `imported` | 🔁 分区明细表 + inbox（§5.3） | `imported` 这个 type 值只有在做导入时才需要 |
| `visit_locations` | `lat/lon float NOT NULL`、`is_empty bool`，无索引无 FK | M3 | `is_empty` 是为了「定位失败也占一行」，我们若做要保留这个语义 |
| `short_url_visits_counts` | `UNIQUE(short_url_id,potential_bot,slot_id)`、`count` 默认 1、slot 0..100 | ✅ | 与 §5.3 的 ≤100 slot UPSERT 一致 |
| `orphan_visits_counts` | `UNIQUE(potential_bot,slot_id)` | ✅ | 容易漏：**孤儿也要计数**，否则首页统计对不齐 |
| `short_url_redirect_rules` + `redirect_conditions` + 中间表 | `priority` NOT NULL；`match_value` 已改可空（`Version20250722060208.php`）；条件类型 11 种 | M3 | 中间表名 `redirect_conditions_in_short_url_redirect_rules`，规则集**整套替换**语义 |
| `geolocation_db_updates` | `status` 枚举 + 两个索引，DB 侧默认 `in-progress`/`CURRENT_TIMESTAMP` | ❌ 不要 | 它存在的意义是「跨进程协调 mmdb 下载」，我们不在热路径定位，也不需要文件级协调 |
| `api_keys` + `api_key_roles` | `key` UNIQUE（sha256 hex）、`name` 唯一性靠应用层 `FOR UPDATE`、`enabled` 无 DB 默认（实体默认 true）、roles `meta json` 存 `domain_id`/`authority` | ❓ D1 | 若做开放 API，`api_key_roles.meta` 的**作用域 JSON** 是必须一起抄的部分 |

**方言分支处理**（§7「全砍」的展开，这 6 处是唯一还有信息量的）：

1. `orderBy domain ASC` 为 PG NULL 排位打的补丁（`ShortUrlRepository.php:32-36`）→ 我们双 Map，不需要。
2. `LOWER()` 匹配（`:39-40`）→ 入库小写。
3. **`character_not_in_repertoire`(SQLSTATE 22021) 用 savepoint 吞成「未找到」**（`:70-82`）→ 别照抄成「忽略异常」：它防的是脏短码把整个事务 abort。我们的快照路径不查库所以天然免疫，但**查库兜底路径要保留同等保护**，否则一个畸形 path 会让函数吐 500。
4. slot upsert 的 MySQL/通用分支 → 只写 PG `ON CONFLICT`。
5. 所有日期运算在 PHP 侧（仓库内无 `date_trunc`/`INTERVAL` 用法）→ 我们落成 SQL 谓词。
6. `unsigned` 列属性 PG 忽略 → DDL 里不写。

---

## 6. 配置面：68 个 env → 我们的三处

shlink 的 env 是「一个枚举 + 一个 `_FILE` 变体」（`EnvVars.php:93-113`）。按我们的架构，它们分裂成三处，**别再在代码里散落读字符串常量**：

| 去向 | 内容 | 现状 |
|---|---|---|
| **库里（配置表/函数）** — 因为是「数据」不是「部署参数」 | `domain` 三个 404 列、`short_url` 状态码/forward_query/crawlable/有效期、`bot_pattern`、短码长度与字符集、tag/domain 清单 | 0004 建表时定 |
| **FC 环境变量** — 进程级、改了要重启 | `SUPABASE_URL`（内网）、`SUPABASE_SERVICE_ROLE_KEY`、`CACHE_POLL_MS`、`CACHE_SNAPSHOT_LIMIT` | 已有（§5.2.2） |
| **pg_cron 作业参数** | 批次上限、清理阈值（180 天）、dry-run 开关 | 已有（0002/0003） |

**明确整体作废的 env 组**（因为没有对应子系统）：`DB_DRIVER`/`DB_UNIX_SOCKET`/`DB_USE_ENCRYPTION`、`REDIS_*`(4)、`RABBITMQ_*`(6)、`MERCURE_*`(5)、`MATOMO_*`(4)、`CORS_*`(3)、`LOGS_FORMAT`、`MEMORY_LIMIT`、`TIMEZONE`、`BASE_PATH`、`TRUSTED_PROXIES`、`GEOLITE_LICENSE_KEY`、`INITIAL_API_KEY`、`SKIP_INITIAL_GEOLITE_DOWNLOAD`、`IS_HTTPS_ENABLED`。

**必须保留语义、但换实现方式的**：`ANONYMIZE_REMOTE_ADDR`（→ 只存哈希，`visitor_key` 加盐）、`TRACK_ORPHAN_VISITS`、`DISABLE_TRACKING*`(4)、`DISABLE_TRACKING_FROM`、`DISABLE_TRACK_PARAM`、`REDIRECT_STATUS_CODE`/`CACHE_LIFETIME`/`CACHE_VISIBILITY`、`DEFAULT_*_REDIRECT`(3)、`SHORT_URL_TRAILING_SLASH`、`MULTI_SEGMENT_SLUGS_ENABLED`、`DEFAULT_DELETE_SHORT_URL_THRESHOLD`、`DEFAULT_SHORT_CODES_LENGTH`、`SHORT_URL_MODE`。

---

## 7. 迁移准备清单（按可执行顺序）

> 执行顺序、每轮验收标准与整体进度见 [docs/iteration-plan.md](iteration-plan.md)；下表是能力维度的清单，两者编号不同（本文档 M1/M2/M3 指能力期，迭代文档 I0–I6 指交付轮次）。

### M1 —— 最小可用平台（建链 / 跳转 / 看数）

- [ ] **M1-1 0004 正式表**：`domain`、`short_url`（含 `long_url text` + CHECK、`title`、`valid_since/until`、`max_visits`、`forward_query`、`crawlable`、`enabled`、`created_at`、`last_visit_at`）、`tag`、`short_url_tag`、`visit_inbox`、`visit`、`short_url_visits_count`、`orphan_visits_count`、`bot_pattern`
  - 每张表四行权限（§4.1 的收口铁律），探针期已实测 anon/authenticated 曾拥有全量 DML。
- [ ] **M1-2 短码生成与冲突**：字符集 `[0-9a-z]`（定 LOOSE 语义 + 入库小写）、长度默认 5、自定义 slug 保留字符校验；随机码重试、自定义 slug 冲突报 409；并发防重用 `pg_advisory_xact_lock`（§7 已定）。
- [ ] **M1-3 `resolve` RPC**：域名优先 > 全局（`domain=''` 作哨兵）、只出 `enabled` 行、带 `forward_query`/有效期判定；**保留 22021 类脏输入的防护**（不吞异常，改成入参白名单校验短码字符集）。
- [ ] **M1-4 快照函数切正式表**：`probe_link_snapshot()` → 读 `short_url`；触发器从 `probe_short_url` 改挂到 `short_url`；FC 只改 `SEQ_PATH`/`SNAPSHOT_PATH` 常量（§5.2.2「还没做」清单里已记）。
- [ ] **M1-5 写路径收口**：创建/编辑/删除一律走 RPC，同事务 bump seq（触发器保证，不靠调用方自觉）。
- [ ] **M1-6 统计入队切正式表**：`visit_inbox` + 现有 drain 函数改写 `visit` / 计数表；UA/referer/url 入队前按 shlink 上限截断（512/1024/2048）。
- [ ] **M1-7 权限与鉴权收口**：控制台固定走兼容层（`api_key` + 函数内作用域 + `service_role` 直连，见 `tech-framework.md` §4.1 两套并存）；Auth + RLS 只留给未来小程序/直连，仍要给出 RLS 草案。
- [ ] **M1-8 错误体与分页**：统一 RFC7807 + `{data,pagination}`（形状与特例字段见 `docs/shlink-api-contract.md` §2、§6）。
- [ ] **M1-9 多域名的云侧动作清单**（**代码之外，必须先排期**）：每个域名的 ICP 备案状态核查（§6.2 官方口径：有备案号 ≠ 能用于阿里云）、FC 自定义域名绑定、证书（#13）、路由 `/*`、VPC 与最小实例数（§5.2.1）。→ 产出「加一个域名的 SOP」文档，这条不做，M1 只能跑单域名。
- [ ] **M1-10 探针退场**：`probe_*` 表/函数/Edge Function 删除计划（含 `link_version` 触发器迁移与 `pg_cron` 作业重挂）。
- [ ] **M1-11 兼容层 B1–B4**：按 `docs/shlink-api-contract.md` §3 的顺序实现 23 个方法（B1 短链 → B2 统计 → B3 标签 → B4 域名/健康/Mercure/规则）；`/health` 先于一切，`version` 从 `4.0.0` 起步。

### M2 —— 数据面完整

- [ ] `bot_pattern` 字典整理（**无法从副本拷**，CrawlerDetect 在 vendor，需自建正则集）+ 落库前打标 + 展示侧「含/不含 Bot」切换。
- [ ] 计数读路径统一 `SUM(count)`（不是 `COUNT(visits)`）。
- [ ] 孤儿访问三分类 + `orphan_visits_count` + `/visits/orphan` 对应视图/删除 RPC。
- [ ] 域名级三类 404 回退 + 默认 404 / 无效短码 HTML 页（`{DOMAIN}`/`{ORIGINAL_PATH}` 占位符）。
- [ ] 有效期三元组进 `enabled` 判定 + `delete-expired` 的 pg_cron 版本。
- [ ] `find_if_exists`（`digest(long_url,'sha256')` + 索引）。
- [ ] 死链清理 cron 由 dry-run 转真实（§5.4，需他先看清单）。
- [ ] 访问明细 CSV 导出（`GW` 端点或 `WEB` 前端）。
- [ ] 追踪开关：`DISABLE_TRACKING*` / `DISABLE_TRACK_PARAM` / IP 黑名单。

### M3 —— 增值能力（每件都带前置依赖，先确认依赖再开工）

- [ ] 动态跳转规则：3 张表 + 11 种条件 + 优先级求值 + 整套替换语义 → **求值必须在 FC 或 RPC 里重做一遍**，是本期最大的单块工作量。
- [ ] 地理定位：前置 = ①License key（他申请）②出公网（VPC 后需 NAT 网关）③mmdb 存放位置；否则退化为「只存 `visitor_key`，不富化」。
- [ ] 标题自动解析：前置 = 同上出公网。
- [ ] 实时统计：前置 = 平台是否提供 Realtime（**先查 ADB Supabase 官方文档，别套开源经验**）；否则控制台轮询。
- [ ] 追踪像素 `/{code}/track`、`robots.txt`。
- [ ] 数据导入（历史短链/访问）：shlink 用外部 `shlink-importer`，我们若要迁**存量数据**需自写 `scripts/import-*`；纯功能重建可跳过。

---

## 8. 风险与不可用能力（迁移会改变产品形态的六处）

1. **多域名的成本结构完全不同**。shlink 是数据行，我们是云资源 + 备案 + 证书。→ 风险：M1 交付了「多域名支持」的代码，却交付不了多域名。缓解：M1-9 的 SOP 和「本期支持几个域名」要明确写。
2. **实时推送没有对应物——但不是阻塞项（2026-11-09 更正）**。Mercure/RabbitMQ/Redis 三通道全废，4 个 topic 对应的「新访问/新短链」流式体验降级为手动刷新。`NotConfiguredMercureErrorHandler.php` 的源码注释写明「每次 shlink-web-client 打开都会触发一次」，然后只记 warning 并转成响应 ⇒ **未配置 Mercure 时界面照常可用**，复用 web-client 不会因此卡住。影响的是观感，不是数据正确性。
3. **热路径写模型不同**（shlink v4 是同步写、我们是 inbox+批量）。→ 我们的统计是**近实时**（秒到分钟），shlink 是即时。他的口径是「逐次准确」而非「即时可见」，这条要在验收时讲清楚，否则会被当成 bug。
4. **Bot 判定规则不可移植**（库在 vendor）。→ 前期打标精度会低于 shlink，验收样本要提前准备一批已知 UA。
5. **鉴权模型换轨**：shlink 的 API-key + Specification 贯穿全表过滤，我们是 Auth + RLS。RLS 策略一旦漏一张表，就是「接口层过滤有效、PostgREST 直连全裸」——探针期已实测过这种裸奔。
6. **地理定位与标题解析被出网卡住**：VPC 绑定后出站全进 VPC（§5.2.1 副作用），公网需 NAT 网关。→ M3 前必须确认是否接受这笔资源和配置成本。

---

## 9. 需要他拍的五个决策（文档里所有 ❓ 的来源）

| # | 决策 | 选项与推荐 |
|---|---|---|
| D1 | ~~是否对第三方程序开放 REST + API key~~ → **2026-11-09 结案：开放**。他选「复用 web-client + 全量兼容」，而 web-client 只认 `X-Api-Key`，所以 `api_key` + 角色作用域模型是复用的**必然后果**，不再是可选项。副作用：第三方程序同期获得这套 API | — |
| D2 | ~~跳转状态码是否允许按链配置~~ → **2026-11-09 结案：全局固定 302，不给配置项**。理由：301/308 会被浏览器自己缓存，统计必丢，与「逐次准确」冲突 |
| D3 | ~~多段 slug / extraPath 是否支持~~ → **2026-11-09 结案：不支持**。短码锁单段 `[a-z0-9_-]{1,64}`，快照 key 保持 `domain|code`，FC 的 path 解析不做二级切分 |
| D4 | ~~地理定位的出网成本~~ → **2026-11-09 结案：推迟**。本期 `visit` 的 `country/region/city` 留空，只存 `visitor_key`；要做时需要 NAT 出网 + License + mmdb 落盘 |
| D5 | ~~存量数据迁移~~ → **2026-11-09 结案：不搬**。历史短码大小写冲突与访问归属都对不齐，重开更干净 |

另一项附带决定（同日）：默认域名哨兵 `domain.id = 0` 的 `authority = example.com`、`scheme = http`（HTTPS 证书未挂，见 I6）。

---

## 10. 本期明确不做（对齐 `tech-framework.md` §9）

Slack / webhooks（shlink v4 已删，`UPGRADE.md:30`）、Matomo 对接、二维码（已挪到客户端）、Link-in-bio、A/B 落地页、密码保护短链、多 DB 方言、微信小程序端、多地域部署。
