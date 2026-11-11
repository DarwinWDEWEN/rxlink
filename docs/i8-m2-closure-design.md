# I8 —— M2 收尾批次设计（R1–R8，2026-11-11）

> **来源**：`docs/shlink-feature-checklist.md`（差距清单）+ `docs/shlink-migration-analysis.md` §7 的 M2/M3 待办。
> **范围**：R1–R8 全部（用户 2026-11-11 批准）。R9 跳转规则、R10 标题解析另立迭代（I9/I10）。
> **批准记录**：设计已在对话中逐组呈现，用户选「批准，按推荐方案开始」。

---

## 1. 迭代结构

| 迭代 | 内容 | 状态 |
|---|---|---|
| **I8** | R1–R8（M2 收尾批次） | 本设计 |
| **I9** | R9 动态跳转规则（M3 最大单块） | 单独立项，先走 brainstorming |
| **I10** | R10 标题自动解析 | 需先定出网路径 |

---

## 2. 组 1：跳转函数（R1 / R2 / R3 / R8）

文件：`fc/redirect/index.js`（+ `fc/redirect/test/redirect.test.js`）。

### R1 默认 404 页 HTML

- **现状**：`replyNotFound()` 查回退配置；无配置时 `reply(res, 404, 'not found', headers)`（裸文本）。
- **改法**：无回退配置时返回内联 HTML，`Content-Type: text/html; charset=utf-8`：
  - `invalid_short_url` → 无效短码页（"This short URL doesn't seem to be valid."）；
  - `base_url` / `regular_404` → 404 页（"Page not found."）。
- **不变**：有回退配置仍 302（回退能力优先于页面）。
- **模板**：shlink `module/Core/templates/{404,invalid-short-code}.html` 的精简版，去掉 Shlink 品牌与 favicon。
- **注意**：shlink 的 HTML 模板是**静态**的（`{DOMAIN}`/`{ORIGINAL_PATH}` 占位符只用于回跳 URL，已由 0011 实现），所以这里不需要占位符替换。

### R2 追踪像素 `/{code}/track`

- **现状**：`/{code}/track` 被当成 code（含 `/`，被 `CODE_RE` 拒绝 → `regular_404`）。
- **改法**：路由层识别 `/{code}/track` 后缀，解析 code：
  - 命中 → `recordVisit`（同跳转 payload，`redirect_to = null`）+ 返回 1×1 gif；
  - 未命中 → **不记访问**，仍返回 gif（shlink `PixelAction::createErrorResp` 的口径）；
  - HEAD → 返回 gif，不记访问。
- **响应**：`Content-Type: image/gif`，body 为内联 base64 的 1×1 gif（43 字节）。
- **域名**：与跳转一致，按 `hostname(req)` 解析。

### R3 `robots.txt`

- **现状**：404。
- **改法**：路由层识别 `code === 'robots.txt'`，返回 `text/plain; charset=utf-8`：
  - 默认（`ROBOTS_ALLOW_ALL_SHORT_URLS` 未设/false）：`User-agent: *` + 每个 crawlable 短码一行 `Allow: /{code}` + `Disallow: /`；
  - 开关为 true：只 `Disallow: /rest/`。
- **新增 RPC**：`robots_crawlable_codes(p_authority text)` → 返回该域名下 `crawlable = true` 的短码数组（全局短码 `domain_id = 0` 归默认域名）。
- **出处**：`module/Core/src/Action/RobotsAction.php:32-57`、`RobotsOptions.php`（默认 `allowAllShortUrls = false`）。

### R8 追踪开关

- **现状**：无任何开关；HEAD 也会记访问（与 shlink 不一致）。
- **改法**：跳转函数读环境变量，命中即**不记访问**或置空字段：

| env | 默认 | 行为 |
|---|---|---|
| `DISABLE_TRACK_PARAM` | 未设 | query 里出现该参数名 → 不记访问 |
| `DISABLE_TRACKING` | false | 全局不记访问 |
| `DISABLE_TRACKING_FROM` | 空 | IP / CIDR / 通配符列表 → 不记访问 |
| `DISABLE_REFERRER_TRACKING` | false | `referer` 置空 |
| `DISABLE_UA_TRACKING` | false | `ua` 置空（`potential_bot` 仍按原 UA 判定） |
| `DISABLE_IP_TRACKING` | false | `remote_addr` 置 null |

- **HEAD 不记访问**（对齐 shlink `RequestTracker::shouldTrackRequest`）。
- **CIDR 匹配**：`DISABLE_TRACKING_FROM` 支持 IPv4/IPv6 的单 IP、CIDR、通配符（`192.168.*`）。实现放 `fc/redirect/ipmat.js`（纯函数，可单测）。
- **不做**：`ANONYMIZE_REMOTE_ADDR`（我们的口径是富化后立即清空 + 7 天硬兜底，见 `geo-enrichment.md` §7）。

---

## 3. 组 2：兼容层（R4 / R6 / R7）

文件：`supabase/functions/compat/index.ts`（+ 新增测试）。

### R4 `GET /short-urls/shorten`

- **现状**：未实现（契约 §3 注：控制台不调它）。
- **改法**：compat 加 GET 路由：
  - `longUrl` 必填、`domain` 可选；
  - 鉴权：`X-Api-Key` 头 **或** `?apiKey=` query（shlink 唯一的 query 鉴权例外，`module/Rest/config/auth.config.php:16-18`）；
  - `?format=txt` 或 `Accept: text/plain` → 返回纯文本短链（`shortUrl` 字段）；否则 JSON（与 `createShortUrl` 同形状）；
  - 复用 `create_short_url` RPC（含 `author_api_key_id`）。
- **出处**：`module/Rest/src/Action/ShortUrl/SingleStepCreateShortUrlAction.php`、`CreateShortUrlContentNegotiationMiddleware.php`。

### R6 API key 过期

- **现状**：`api_key` 无 `expires_at` 列。
- **改法**：
  - 迁移 0015：`alter table api_key add column if not exists expires_at timestamptz;`
  - `compat_auth` RPC 的 key 查询加 `and (expires_at is null or expires_at > now())`；
  - `scripts/new-api-key.sh` 支持可选 `--expires-at <ISO8601>`。
- **出处**：`module/Rest/src/Entity/ApiKey.php`（`expirationDate` + `isExpired()`）。

### R7 访问明细 CSV 导出

- **现状**：无（shlink 只在 CLI 的 `--format=csv` 里有，REST 无导出端点）。
- **改法**：compat 加 **`GET /rest/v3/visits/export`（rxlink 扩展端点，不在 shlink 契约里）**：
  - 复用 `list_visits` RPC（同 `/visits` 的筛选：scope / code / tag / domain / 时间区间 / excludeBots / 分页）；
  - 返回 `text/csv`，列：`date, referer, userAgent, potentialBot, visitLocation, visitedUrl, redirectUrl, type`；
  - 需要 `itemsPerPage` 放大（导出场景）时由调用方传。
- **不做**：控制台 UI 导出按钮（不重编前端）；用 curl / 脚本调。
- **文档**：在 `docs/runbook.md` 或本文件末尾给一段调用示例。

---

## 4. 组 3：SQL / cron（R5）

### R5 过期短链清理

- **现状**：`prune_dead_links(180)` 只处理「180 天无访问」，不处理过期/超次。
- **改法**：迁移 0017 新增 `delete_expired_short_urls(p_dry_run boolean default true)`：
  - 条件：`enabled and ((valid_until is not null and valid_until < now()) or (max_visits is not null and visits_count >= max_visits))`；
  - 动作：**软删**（`enabled = false`），返回清单（`short_url_id, short_code, domain, reason`）；
  - pg_cron 每天 GMT 20:00（job 10）。
- **与 prune 的关系**：两条独立规则——「三元组到期」与「180 天无访问」，都要有。
- **出处**：`module/Core/src/ShortUrl/Repository/ExpiredShortUrlsRepository.php:50-69`（shlink 是物理删；我们软删，与 `prune_dead_links` 口径一致）。

---

## 5. 迁移编号

| 文件 | 内容 | 对应 |
|---|---|---|
| `0015_api_key_expires_at.sql` | `api_key.expires_at` 列 + `compat_auth` 检查 | R6 |
| `0016_robots_crawlable_codes.sql` | `robots_crawlable_codes(p_authority)` RPC | R3 |
| `0017_delete_expired_short_urls.sql` | `delete_expired_short_urls(p_dry_run)` 函数 | R5 |

按编号顺序逐条应用到线上库（先备份，`supabase db query` 单语句执行）。

---

## 6. 测试策略

- **跳转函数**（`node --test fc/redirect/test/redirect.test.js`，真实子进程 + mock 网关）：
  - 现有 15 例保持绿；
  - R1：三类 404 各返回 HTML + content-type（3 例）；有回退配置仍 302（1 例）；
  - R2：命中记访问 + gif、未命中不记 + gif、HEAD 不记、带 query（4 例）；
  - R3：`robots.txt` 200 + 内容（2 例，含 allow-all 开关）；
  - R8：每个开关 1 例 + CIDR 匹配（6+ 例）。
- **兼容层**：新增最小 `Deno.test`（mock `fetch` + `Deno.env`），覆盖 R4（JSON/txt/apiKey）、R6（过期 key 拒绝）、R7（CSV 行）。部署后 curl 验收。
- **SQL**：R5 用 DO 块断言 + 线上 dry-run 出清单；R3 RPC 用 SQL 断言。

---

## 7. 实施顺序

1. 迁移 0015 → 0016 → 0017（写文件 → 逐条应用 → 断言）；
2. 跳转函数（组 1：R1/R2/R3/R8）→ 单测 → 部署 → curl 验收；
3. 兼容层（组 2：R4/R6/R7）→ 单测 → 部署 → curl 验收；
4. cron（R5）→ dry-run 清单 → 转真实；
5. 统一验收，更新 `docs/iteration-plan.md` 的 I8 与验收清单。

---

## 8. 验收标准（I8 出口）

- [ ] 三类 404 返回 HTML（有回退配置仍 302）
- [ ] `/{code}/track` 命中记访问、未命中不记，都返回 gif
- [ ] `/robots.txt` 列出 crawlable 短码 + `Disallow: /`；开关打开后只 `Disallow: /rest/`
- [ ] `/short-urls/shorten` 支持 JSON / `format=txt` / `?apiKey=`
- [ ] 过期 API key 被拒（401）
- [ ] `/rest/v3/visits/export` 返回 CSV，列与筛选正确
- [ ] 过期短链清理 dry-run 清单只含预期行，转真后 `enabled=false`
- [ ] 追踪开关全部生效；HEAD 不记访问
- [ ] 测试：跳转函数 15 → 30+ 例全绿；compat 新增测试全绿

---

## 9. 实施修订（2026-11-11，部署前发现）

**兼容层部署包改为构建产物，不用多文件源码。**

- 发现：`functions-cli` 的部署包以入口文件为准。I5 曾实测 `.txt` 静态资源进不了部署包并推断「只上传入口文件」；但官方文档（`docs/reference/adb-supabase/edge-functions.md:25,34,70-75`）明示 `index.ts + foo.ts` 多文件可用，且 CLI 二进制含 `no deployable files (.ts, .js, .json) found` / `entrypoint_path` 字样 —— 两条证据冲突，无法在不动共享设施的前提下判定。
- 处理：新增 `scripts/build-compat-function.mjs`，把 `handler.ts` 打成单文件 `supabase/functions/compat/dist/index.ts`（gitignored），部署命令改带 `-d supabase/functions/compat/dist`。
- 结果：部署包与现网单文件形态一致，消除歧义；`handler.ts` 仍是唯一逻辑改动点，单测直接导入它。构建产物与 `handler.ts` 的差异已用 diff 验证为纯机械变换（去 `export` + 追加 `Deno.serve`）。
- 运行手册同步：`docs/runbook.md` §5.3。
