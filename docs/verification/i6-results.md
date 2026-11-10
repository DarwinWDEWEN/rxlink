# I6 生产硬化 —— 验证记录

> 执行日期：2026-11-10。通道：`supabase db query --db-url`（逐条）、`functions-cli`、`curl`、Node 24 压测脚本。
> 状态：**全部完成，I6 已验收**（2026-11-10）。探针退场 / prune 转真 / 压测 / 可观测 / runbook / HTTPS 复测均通过；仅剩云上可选清理（§7）。

## 1. 探针退场（已执行，他确认）

零引用证据：
- 正式跳转只调 `resolve_short` / `link_seq` / `snapshot_short_links`，不碰 probe。
- 库内无任何非 `probe_*` 函数引用 `probe_`（`pg_get_functiondef` 扫描 0 行）；无 probe 视图/物化视图；无跨表外键牵连。
- 残留 `probe_` 字样仅在历史迁移 0001/0002/0003、P0 文档与已删的 probe 代码里；迁移是已应用历史，保留。

删除清单与结果：

| 项 | 删前 | 删后 |
|---|---|---|
| 库表 | `probe_inbox` 710 / `probe_sink` 686 / `probe_unlogged` 621 / `probe_visits_counts` 100 / `probe_short_url` 2 / `probe_prune_report` 0 | `pg_tables like 'probe%'` = **0** |
| 库函数 | 8 个（drain_batch/env_report/link_seq/link_snapshot/prune_dead_links/resolve/time_writes/unlogged_write） | `pg_proc like 'probe%'` = **0** |
| cron | job 5 `probe-prune` | `cron.unschedule(5)` = true |
| 代码 | `supabase/functions/probe`、`probe-db`、`fc/redirect-probe`、`scripts/verify-p0.sh` | 目录/文件已删 |
| Edge 部署 | `probe`、`probe-db` ACTIVE | `functions-cli delete` 200；list 仅剩 compat/console/statictest(DELETING) |

回归：删后 `curl -i http://example.com/2b9yj` 仍 `302 Found`，正式链路不受影响。

## 2. prune 转真 + 闭环（他批准临时测试行）

- cron 由 dry-run 切真实：旧 job 7 撤销，重排为 **job 8 `rxlink-prune`**，`0 19 * * *`，命令 `select prune_dead_links(180, false)`，active=true。（`cron.job` 表无 UPDATE 权限，故用 unschedule+schedule 改名。）
- 180 天 dry-run 清单为空（唯一启用短链 `2b9yj` 仅 1 天）；`p_days=0` 能列出 `2b9yj`，证明查询可用。
- 闭环测试（临时链 `i6prune`，`created_at` 回填 200 天）：
  1. `prune_dead_links(180, false)` 返回 `i6prune / example.com / stale_days=200`；
  2. 回读 `enabled=false`，`prune_report` 落 `dry_run=false` 一行；
  3. `curl http://example.com/i6prune` → **404**；
  4. `update short_url set enabled=true` 回读 `enabled=true` ⇒ **可撤销**；
  5. 删除测试链与报告行，基线恢复（启用短链 1、报告行 0、测试链 0）。

## 3. 压测复核（他批准临时链 i6load + 压后清理）

- 目标：临时链 `i6load`（id 17），Node http keep-alive，**50 并发 × 1000 请求**，不跟随跳转。
- 结果：

| 指标 | 值 |
|---|---|
| 状态分布 | `302` × 1000 |
| 302 成功率 | **100%** |
| 耗时 | 3.1 s，322.8 rps |
| p50 / p95 / p99 / max | 83.0 / **416.0** / 801.7 / 1035.3 ms |

- 对标 §5.2.1 基线（50 并发 p95≈804ms）：缓存命中后 p95 降到 416ms。
- 清理：先 `drain_visit_inbox(5000)` 落库（pending 1001→0），再删 `visit`/`visit_inbox` 各 1001 行、删 `short_url` id 17（级联计数表）；复查 `i6load` 残留 visit/inbox/链均为 0。
- 注：本轮走 HTTP；HTTPS 下复测待 `example.com` 证书（任务 #13）。

## 4. 可观测（不引入新服务）

一条健康查询（积压 + drain 存活 + seq），实测返回 `inbox_pending=0 / inbox_oldest_sec=0 / drain_last_success_sec≈4 / link_seq=85`：

```sql
select
  (select count(*) from visit_inbox where processed_at is null)::text as inbox_pending,
  (select coalesce(max(extract(epoch from (now()-occurred_at)))::int,0)
     from visit_inbox where processed_at is null)::text as inbox_oldest_sec,
  (select coalesce(extract(epoch from (now()-max(start_time)))::int,-1)
     from cron.job_run_details where jobid=6 and status='succeeded')::text as drain_last_success_sec,
  (select seq from link_version where id=1)::text as link_seq;
```

阈值与 cron 历史查询、FC 日志检索口径已写入 `docs/runbook.md` §3/§7。

## 5. runbook

`docs/runbook.md` 已建：拓扑/凭据变量名、健康查询与阈值、加域名 SOP、四类部署与回滚（跳转/控制台/兼容层/迁移）、三类故障排查树、FC 日志口径。已核对 `drain_visit_inbox` 返回 integer、`npm run build` 脚本存在。

## 6. HTTPS 复测（2026-11-10，他配好证书后）

证书：`CN=example.com`，DigiCert `Encryption Everywhere DV TLS CA - G2`，有效期 2026-11-10 → 2027-02-07；curl 默认信任链通过（未加 `-k`）。

| 请求 | 结果 |
|---|---|
| `https://example.com/2b9yj` | `302`，`Location: https://example.com/a?x=1&y=2`，`Server-Timing: resolve;dur=0;cached=1`，`X-Link-Snapshot: 1\|85\|…` |
| `http://example.com/2b9yj` | `301` → `https://example.com/2b9yj`（强制 HTTPS 生效） |
| `https://example.com/no-such-code-i6` | `404` |
| `https://example.com/`（根路径） | `404`（兜底进跳转函数，预期） |

统计联动：HTTPS 请求先进 `visit_inbox`（pending=2），一个 cron 周期后 pending=0，`2b9yj` 的 `visit` 总数 14→15、`last_visit=2026-11-10 05:36:30+00` 与请求时间吻合 ⇒ HTTPS 链路统计不丢。

Domains 页健康检查 `https://example.com/functions/v1/compat/rest/v3/health` 现为 `404`（证书错误已消除，但路径被 `/*` 兜底进跳转函数）⇒ 红标依旧，属 I0 已接受的观察项，runbook §4/§6 口径已同步更新。

## 7. 已知缺口（均为可选清理，不阻塞验收）

| 项 | 现状 | 归属 |
|---|---|---|
| FC 账号探针残留 | Supabase 侧 probe 已删；用户 FC 账号若仍有探针 Web 函数/旧路由（如 `test-supabase`），由他删 | 他 |
| `console` Edge 函数 | 官方控制台已改挂用户 FC 函数，此 Edge 版本闲置 ACTIVE，可后续清理 | 观察项 |
| 跳转规则 POST | 固定 501 | M3 |

> `cdn.example.com` 已于 2026-11-10 定案放弃（他确认）：P0 阶段「CDN 回源 Edge Function」方案的测试域名，全仓库仅 docs 历史引用，控制台直连 Supabase 主机、跳转走 VPC 内网，均不经过它。不再列入缺口；云上 CDN 域名与解析可下线。