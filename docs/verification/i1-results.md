# I1 验证记录：0004 / 0005 / 0006 正式表与 RPC

> 执行日期：2026-11-09。执行通道：`supabase db query --db-url "$SUPABASE_DB_URL"`（`postgres@public`，逐条执行，平台一次只认一条语句）。
> 连接串只在本地 `.env` 里，未出现在本文档、日志或命令回显中。

## 1. 应用结果

| 文件 | 语句数 | 结果 | 备注 |
|---|---|---|---|
| `0004_core_tables.sql` | 32 | 全部 OK | 13 张表 + `ensure_visit_partition` + 3 个分区 + 触发器 + 权限收口 DO 块 |
| 一次性 UPDATE | 1 | `UPDATE 1` | `domain.id=0` → `example.com` / `http` |
| `0005_shorten_and_resolve.sql` | 8 | 全部 OK | 7 个 RPC + 逐函数收权 |
| `0006_ua_parse.sql` | 7 | 全部 OK | `ua_rule`（36 条规则）+ `ua_match` / `ua_parse` + 重写 drain |

分区：`visit_2026_11`、`visit_2026_12`、`visit_2027_01`。

## 2. 应用过程中修掉的两个真问题

| 问题 | 现象 | 修法 |
|---|---|---|
| drain 的「标记已处理」被静默跳过 | 首次验证时 `visit` 落了 2 行、计数也对，但 `visit_inbox.processed_at` 仍为 null（`pending=2`）⇒ 下一轮会重复入账 | 同一语句里对同一行做第二次 UPDATE 会被 Postgres 跳过。把 `processed_at = now()` 合进打分的那一次 UPDATE，删掉独立的 `done` CTE |
| `prune_dead_links` 会报 ambiguous | 静态审读发现（未到运行期） | `RETURNS TABLE` 的输出列名即 plpgsql 变量，末段 SELECT 的裸列名必须加 `st.` 前缀 |

## 3. 功能验证（全部为真实输出）

### 3.1 建链 / 解析 / 快照

```
create_short_url('https://example.com/a?x=1&y=2')
→ {"shortCode":"2b9yj","domain":null,"shortUrl":"http://example.com/2b9yj",
   "longUrl":"https://example.com/a?x=1&y=2","visitsSummary":{"total":0,"nonBots":0,"bots":0},
   "meta":{"validSince":null,"validUntil":null,"maxVisits":null},"tags":[],
   "title":null,"crawlable":false,"forwardQuery":true,"hasRedirectRules":false}

resolve_short('2b9yj','example.com') → 1 | https://example.com/a?x=1&y=2 | t
resolve_short('2b9yj','nope.test')      → 1 | https://example.com/a?x=1&y=2 | t   （回落 domain_id=0）
snapshot_short_links()                  → rows=1, domain 全为 NULL（默认域名）
```

### 3.2 三道跳转闸门

| 用例 | 结果 |
|---|---|
| `valid_until = now() - 1s` | `resolve_short` 返回 0 行 |
| `max_visits = 1`（此时 `visits_count = 2`） | 返回 0 行 |
| `enabled = false` | 返回 0 行，快照行数同时变 0 |

### 3.3 seq 触发器的列范围（关键设计）

| 操作 | seq |
|---|---|
| 基线 | 26 |
| `visits_count + 5, last_visit_at = now()` | **26（不变，符合预期）** |
| `title = 't'` | **26（不变，标题不影响跳转）** |
| `forward_query = false` | **27** |
| 停用 / 删除 | 37 → 38 |

即：drain 每分钟写计数不会引起快照重拉。

### 3.4 统计落库（drain）

造 3 条：1 条普通 Chrome 命中、1 条 Googlebot 命中、1 条 `curl` 孤儿 404。

```
drain_visit_inbox(100) → 3
visit 明细 3 行；potential_bot: true=2 / false=1
short_url.visits_count = 2（只数命中，不含孤儿）
short_url_visits_counts 合计 = 2；orphan_visits_counts 合计 = 1
visit_inbox 未处理 = 0
```

### 3.5 UA 解析（0006）

| UA 摘要 | browser | os | device |
|---|---|---|---|
| Chrome / macOS | Chrome | Mac OS X | desktop |
| Edg / Windows NT 10 | Edge | Windows 10/11 | desktop |
| iPhone Safari | Safari | iOS | smartphone |
| Android Pixel Chrome | Chrome | Android | smartphone |
| iPad Safari | Safari | iPadOS | tablet |
| Firefox / Linux | Firefox | Linux | desktop |
| Googlebot | Other | Other | desktop |
| curl | curl | Other | desktop |

drain 实测一条 Edge UA → `visit` 三列落成 `Edge / Windows 10/11 / desktop`。

### 3.6 错误路径

| 用例 | 结果 |
|---|---|
| 自定义 slug 重复（SQL 直调） | `ERROR: non_unique_slug (SQLSTATE 23505)` |
| 同上走 PostgREST | `409 {"code":"23505","message":"non_unique_slug"}` |
| 自定义 slug `MiXeD` | 入库为 `mixed`（大小写统一在函数里做） |

### 3.7 权限矩阵

```
anon:          short_url SELECT=false, visit SELECT=false, create_short_url EXECUTE=false
authenticated: short_url INSERT=false
service_role:  short_url SELECT=true, create_short_url EXECUTE=true
分区:          visit_2026_11/12、visit_2027_01 均 rls=true force=true anon=false
```

### 3.8 PostgREST 可见性

`POST /rest/v1/rpc/link_seq` → **200**（无需等 schema cache 重载）
`POST /rest/v1/rpc/snapshot_short_links` → **200**，返回契约形状的数组
`POST /rest/v1/rpc/resolve_short` → `[{"short_url_id":1,"long_url":"...","forward_query":true}]`
`POST /rest/v1/visit_inbox`（带 `Prefer: return=minimal`）→ **201**

### 3.9 prune

`prune_dead_links(180, true)` → 0 行（新建链接未过期），`prune_report` 0 行。

## 4. 遗留

1. **cron 尚未挂**（属 I2）：`drain_visit_inbox` 每分钟、`prune_dead_links` 每天 GMT 19:00 先 dry-run。
2. 库里留了一条测试链 `2b9yj → https://example.com/a?x=1&y=2`（`example.com` 默认域名），I2 联调直接可用。
3. `visits_count` 已含测试造的 3 次访问，I2 压测前可 `truncate` 重来。
4. 0006 的 `ua_parse` 是粗粒度映射，不追求 ua-parser 全量字典；新增 UA 只 INSERT `ua_rule` 即可生效。
