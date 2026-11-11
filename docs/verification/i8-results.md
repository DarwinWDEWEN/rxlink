# I8 —— M2 收尾批次（R1–R8）验证记录

> 执行日期：2026-11-11。通道：`supabase db query --db-url`（逐条）、`functions-cli`、FC 控制台、`curl`、Node 24 / Deno 2.9.7 测试。
> 状态：**全部完成，I8 已验收**（2026-11-11）。迁移 0015–0017、跳转函数 R1/R2/R3/R8、兼容层 R4/R6/R7、cron R5 均已上线并线上实测。
> 设计：`docs/i8-m2-closure-design.md`；差距清单：`docs/shlink-feature-checklist.md`。

## 1. 迁移 0015–0017（已应用）

**备份**（应用前建，均 `enable/force RLS` + `revoke` 收口）：

| 表 | 内容 |
|---|---|
| `api_key_bak_20261111` | `api_key` 快照（2 行，与线上一致） |
| `funcdef_bak_20261111` | `compat_auth(text)` 的 `pg_get_functiondef` |

| 迁移 | 语句数 | 内容 | 断言 |
|---|---|---|---|
| `0015_api_key_expires_at.sql` | 4 | `api_key.expires_at timestamptz`；覆盖 `compat_auth`（加 `expires_at is null or expires_at > now()`，原出处 0008）；revoke/grant | DO 块：插入过期 key → `compat_auth` 返回 null；改为未来时间 → 返回非 null；测试行已删 |
| `0016_robots_crawlable_codes.sql` | 3 | `robots_crawlable_codes(p_authority)`（join `domain` 按域名过滤） | `example.com` → `{9e6h3}`，与直接查询一致；不存在域名 → 空数组 |
| `0017_delete_expired_short_urls.sql` | 3 | `delete_expired_short_urls(p_dry_run)`（软删 `enabled=false`） | 插入临时「已过期」「已超次」两行：dry-run 只列不改（reason=`valid_until`/`max_visits`）→ 真跑后 `enabled=false` → 临时行已删 |

## 2. cron R5

- `cron.schedule('rxlink-expired', '0 20 * * *', 'select delete_expired_short_urls(false)')` → **jobid 10**，active。
- DB timezone=GMT ⇒ 每日 GMT 20:00（= 北京时间次日 04:00）。
- 现有 job：1/2/3（平台自带）、6 drain、8 prune、9 retire-ip、10 expired。

## 3. 跳转函数（R1/R2/R3/R8）

**代码**：`fc/redirect/index.js` + 新增 `fc/redirect/ipmat.js`；产物 `dist/redirect.zip`（`index.js` / `cache.js` / `ipmat.js`，与源码逐字节一致）已由用户上传 FC。

**单测**：`ipmat.test.js` 8/8、`redirect.test.js` 32/32（原 15 例 + 新 17 例）= **40/40**。

**线上实测**（`https://example.com`，2026-11-11）：

| 项 | 请求 | 结果 |
|---|---|---|
| R1 无效码 | `GET /nosuch` | 404 `text/html; charset=utf-8`，含「This short URL doesn't seem to be valid」「Make sure you included all the characters」 |
| R1 非法路径 | `GET /a/b` | 404 HTML「Page not found」 |
| R1 根路径 | `GET /` | 404 HTML「Page not found」 |
| R1 孤儿分类 | 同上三例 | `invalid_short_url` / `regular_404` / `base_url`（与 shlink NotFoundType 一致） |
| R2 像素命中 | `GET /2b9yj/track` | 200 `image/gif` 43B（`GIF89a`）；落库 1 条 `redirect_url=NULL`、`orphan_type=NULL` |
| R2 像素未命中 | `GET /nosuch/track` | 200 gif 43B；**无访问行** |
| R2/HEAD | `HEAD /2b9yj/track` | 200 gif；无访问行 |
| R3 robots | `GET /robots.txt` | 200 `text/plain; charset=utf-8`：`User-agent: *` + `Allow: /9e6h3` + `Disallow: /` |
| R8 HEAD 不记 | `HEAD /2b9yj` | 302；访问数不变 |
| R8 追踪开启 | `GET /2b9yj/track` | 正常入队（默认开关全关 = shlink 默认口径） |

**计数对账**：`2b9yj` `visits_count` 21 → 22，唯一新增行是像素那条（`redirect_url IS NULL`），HEAD 请求零新增。

**管道健康**（验收时）：`inbox_pending=0`、`inbox_oldest_sec=0`、`drain_last_success_sec=2`。

## 4. 兼容层（R4/R6/R7）

**代码**：`supabase/functions/compat/handler.ts`（全部逻辑，导出 `handleRequest`）+ `index.ts`（薄入口）+ `test/compat.test.ts`。

**部署方式修订**（实施中发现，见设计 §9）：`functions-cli` 的部署包以入口文件为准，多文件支持证据冲突（I5 实测 `.txt` 资源不可用 vs 官方文档写 `index.ts + foo.ts` 可用）。为消除歧义，新增 `scripts/build-compat-function.mjs` 生成单文件部署包 `compat/dist/index.ts`（gitignored），部署命令带 `-d`。构建产物与 `handler.ts` 的差异经 diff 验证为纯机械变换。

**单测**：`deno test --allow-env` **15/15**；`deno check` 对入口/逻辑/测试/构建产物全绿。

**线上实测**（`…/functions/v1/compat/rest/v3`，2026-11-11）：

| 项 | 请求 | 结果 |
|---|---|---|
| 健康 | `GET /health` | 200 `{"status":"pass","version":"4.0.0"}` |
| R4 JSON | `GET /short-urls/shorten?longUrl=…`（`X-Api-Key`） | 200 JSON，含 `shortUrl` / `shortCode` / `dateCreated` 等 |
| R4 纯文本 | 同上 + `format=txt` | 200 `text/plain`，body = 短链 |
| R4 query 鉴权 | `GET /short-urls/shorten?…&apiKey=…` | 200 JSON |
| R7 CSV | `GET /visits/export?itemsPerPage=3` | 200 `text/csv; charset=utf-8`，8 列表头；`visitLocation` → `CN / Shanghai / Changning` |
| R6 过期 key | 生成的 `--expires-at 2020-01-01` key 打受保护路由 | 401「Provided API key does not exist, is disabled or has expired」 |

**清理**：测试 key、3 条测试短链已删；库里恢复 2 把 key、9 条短链。

**顺带修复**：`/visits/export` 路由原写成 `return exportVisits(...)` 缺 `await`，rejection 会绕过 `try/catch` —— 单测先红后绿发现并修复。

## 5. 测试汇总

| 套件 | 数字 |
|---|---|
| `fc/redirect/test/ipmat.test.js` | 8/8 |
| `fc/redirect/test/redirect.test.js` | 32/32 |
| `supabase/functions/compat/test/compat.test.ts` | 15/15 |
| 合计 | **55/55** |

## 6. 遗留与口径

- **备份表**：`api_key_bak_20261111` / `funcdef_bak_20261111` 保留用于回滚（已 RLS + revoke）；确认稳定后可删。
- **追踪开关**：`DISABLE_*` / `ROBOTS_ALLOW_ALL_SHORT_URLS` 未配 env（默认即 shlink 默认口径）；需要时在 FC 跳转函数环境变量里加。
- **不做**（沿清单 D 组）：实时统计 / Matomo、CLI、存量导入、多段 slug、中文界面、API key 角色、时区。
- **后续迭代**：I9 = R9 动态跳转规则（先 brainstorming）；I10 = R10 标题自动解析（先定出网路径）。
