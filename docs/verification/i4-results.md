# I4 验证记录：访问统计（B2）

日期：2026-11-09。环境：线上 ADB Supabase（`rxlink`）+ FC `compat` 函数。

## 1. 本轮落地

| 件 | 内容 |
|---|---|
| `supabase/migrations/0009_visits_api.sql` | `visit_json` / `visits_overview` / `list_visits`（short·tag·domain·non-orphan·orphan 五类 scope）/ `delete_short_url_visits` / `delete_orphan_visits`；权限仍只授 service_role |
| `supabase/functions/compat/index.ts` | 新增 8 个方法对应路由；`visits` 包装、孤儿带 `type`、两个删除统一返回 `{deletedVisits:n}` |
| 计数一致性 | 两个删除函数删完明细后重建计数表并回写 `short_url.visits_count`，概览与详情不会各说各话 |

`0009` 共 6 条语句，逐条执行 6/6 OK。上线后修过两处并重放对应语句：

- 控制台图表请求 `itemsPerPage=5000`，原先把上限钳到 100 会静默截断 ⇒ 上限放宽到 5000（语句 3 重放）。
- ADB 禁止无 `WHERE` 的 `DELETE`（`21000 DELETE requires a WHERE clause`），`DELETE /visits/orphan` 起初 500 ⇒ 改为 `delete from orphan_visits_counts where true`（语句 5 重放）。

## 2. curl 矩阵（线上网关）

基址：`https://your-project-ref.supabase.co/functions/v1/compat/rest/v3`

### 概览

| 时点 | `nonOrphanVisits` | `orphanVisits` |
|---|---|---|
| 测试前 | total 16 / nonBots 4 / bots 12 | total 11 / nonBots 1 / bots 10 |
| 造 3 条短链访问 + 1 条孤儿后 | total 19 / nonBots 6 / bots 13 | total 12 / nonBots 1 / bots 11 |
| 删除短链访问后 | total 16 / nonBots 4 / bots 12 | — |
| 删除孤儿访问后 | — | total 0 / nonBots 0 / bots 0 |

与 SQL 同口径对账通过；`total = nonBots + bots`。

### 列表与筛选

| 请求 | 结果 |
|---|---|
| `GET /short-urls/i4v/visits` | 3 条，字段为 `date` / `referer` / `userAgent` / `potentialBot` / `visitedUrl` / `redirectUrl` / `visitLocation:null`；`pagesCount:1 totalItems:3` |
| 上述 3 条来源 | 2 条非 Bot：iPhone/Safari、`referer=https://ref.example/page`；1 条 Bot：`curl/8.7.1`、无 referer |
| `GET /short-urls/2b9yj/visits?itemsPerPage=2` | 每页 2 条，`pagesCount:7 totalItems:13`，按 `date` 倒序 |
| `…&excludeBots=true` | 只返回 2 条，均为 `potentialBot:false` |
| `…&startDate=2026-11-09T08:50:00Z&endDate=2026-11-09T08:51:00Z` | 3 条，边界内命中 |
| `GET /tags/i4/visits` | 3 条（1 Bot + 2 非 Bot），与短链明细一致 |
| `GET /domains/example.com/visits?itemsPerPage=2` | `pagesCount:8 totalItems:16` |
| `GET /short-urls/nope123/visits` | `404` `short-url-not-found` |
| `GET /visits/orphan?type=regular_404` | 只返回 `type=regular_404`（当时 10/11 条），三类过滤器可用 |
| `DELETE /short-urls/i4v/visits` | `200 {"deletedVisits":3}` |
| `DELETE /visits/orphan` | 修复后 `200 {"deletedVisits":12}`；再造 3 条后复验 `200 {"deletedVisits":3}` |

### 孤儿三类

造 `http://example.com/`、`/NOPE!!`、`/nope999` 后 drain，列表返回：

| `type` | `visitedUrl` |
|---|---|
| `base_url` | `http://example.com/` |
| `invalid_short_url` | `http://example.com/NOPE!!` |
| `regular_404` | `http://example.com/nope999` |

## 3. 控制台实测

仍用 `shlink-web-client/` v4.9.0 的 build 产物起静态服务，Playwright 无头跑：

1. Overview 的 VISITS / ORPHAN VISITS 数字与上表一致；Short URLs 列表的 `visitsSummary` 同步。
2. `i4v` 详情页（短线访问列表）显示 3 条，Bot 标记、UA、Referer 与库一致。
3. 详情页删除访问 → 确认弹层 → 请求 `DELETE …/visits` 200；Overview 从 19 回到 16，`i4v` 列表变 0 条。
4. Orphan visits 页删除 → 弹层二次确认 → 12 条清零；概览孤儿数字归 0。
5. Network 面板中 `/rest/v3/health` 等请求均为 2xx，无 JSON 解析报错。

删除前后 SQL 对账：`short_url.visits_count`、`short_url_visits_counts`、`orphan_visits_counts` 与明细行数一致。

## 4. 已知缺口（按批次预期）

| 项 | 现状 | 归属 |
|---|---|---|
| `visitLocation` | 恒 `null`（无地理库） | M3 |
| `visitor_key` / UV | 恒 `null`（他决定不配 `VISITOR_SALT`） | 不做 |
| `GET /tags/stats`、`GET /domains`、`GET /mercure-info` | 仍 404，界面降级 | B3/B4 ⇒ I5 |
| 图表一次拉 5000 条 | 当前数据量无压力；量大后需改聚合端点 | 观察项 |

## 5. 收尾

- 临时验证 key `i4-test` 已删；库里只剩他本地的 `console` key。
- 测试短链 `i4v` 软删（`enabled=false`）；`2b9yj` 保持启用（13 条访问）。
- 孤儿明细与计数清零；另外清掉 1 条 I2 遗留的悬空访问行（指向已删除短链、不计入计数表）。
- 当前对账：`visit` 明细 16 行 = `short_url_visits_counts` 合计 16；孤儿 0。
- 本地静态服务（:8787）已停。
