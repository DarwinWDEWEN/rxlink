# 定时任务（pg_cron）

> 来源：https://help.aliyun.com/en/analyticdb/analyticdb-for-postgresql/user-guide/use-the-pg-cron-extension-to-configure-scheduled-tasks
> 存档日期：2026-10-28 ｜ 该文档为英文版，中文版内容一致（`/zh/` 路径同 slug）

AnalyticDB PostgreSQL 版的定时任务：在指定时间点执行批处理（定时更新数据、备份、清理过期数据等）。pg_cron 是基于 cron 的作业调度插件，语法与常规 cron 相同，但**可以直接从数据库执行 PostgreSQL 命令**。

## 支持版本

| 形态 | 最低版本 |
|---|---|
| AnalyticDB PostgreSQL V6.0 | v6.3.6.0 |
| AnalyticDB PostgreSQL V7.0 | v7.0.3.0 |
| Serverless 模式 | v2.0.0.1 |

低于上述版本需升级内核小版本才能使用全部特性。

## 安装 / 卸载

- **默认安装**：创建实例后自动安装，无需手动 `CREATE EXTENSION` 前置操作。
- **不可卸载**：存在内核功能依赖，目前无法删除。

## 两个必须记住的约束

1. **所有作业按 GMT（=UTC）调度**，写 cron 表达式前要把本地时间换算成 GMT。北京 09:00 = `0 1 * * *`。
2. **作业存于默认的 `postgres` 库，也必须从 `postgres` 库查询**（`cron.job` / `cron.job_run_details`），无论作业目标是哪个库。

> 注：本文档没有独立的 `cron.database_name` GUC 配置项；目标库直接作为 `cron.schedule()` 的参数传入（需 pg_cron >= 1.4）。

## cron.schedule 参数

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<job_name>` | 是 | — | 作业标签 |
| `<schedule>` | 是 | — | cron 表达式 |
| `<command>` | 是 | — | SQL 语句或函数调用 |
| `<database>` | 否 | `postgres` | 作业运行的目标库 |
| `<username>` | 否 | 当前账号 | 执行作业数据库账号 |
| `<active>` | 否 | `true` | 是否启用 |

cron 表达式字段：分钟 0-59 ｜ 小时 0-23 ｜ 日 1-31 ｜ 月 1-12 ｜ 周几 0-6（0=周日）；`*` 任意、`,` 分隔、`-` 范围。

## SQL 语法与示例

```sql
-- 基础形式
SELECT cron.schedule('<schedule>', '<command>');
-- 每周六 GMT 03:30 清理一周前的数据
SELECT cron.schedule('30 3 * * 6', $$DELETE FROM events WHERE event_time < now() - interval '1 week'$$);

-- 带作业名（推荐，便于管理）
SELECT cron.schedule('<job_name>', '<schedule>', '<command>');
SELECT cron.schedule('Delete Expired Data', '30 3 * * 6', $$DELETE FROM events WHERE event_time < now() - interval '1 week'$$);

-- 指定数据库 / 账号 / 启用状态
SELECT cron.schedule('<job_name>', '<schedule>', '<command>', '<database>', '<username>', '<active>');
SELECT cron.schedule('Do Vacuum', '0 23 * * *', 'VACUUM FULL', 'dw');
SELECT cron.schedule('DO Function', '0 10 * * *', 'select test()', 'dw', 'user1', true);

-- 查看作业
SELECT * FROM cron.job;

-- 修改作业
SELECT cron.alter_job(<job_id>, '<schedule>', '<command>', '<database>', '<username>', '<active>');
SELECT cron.alter_job(3, '0 11 * * *');

-- 删除作业
SELECT cron.unschedule('<job_name>');   -- 同名多作业时只删 job id 最小的那个，有歧义
SELECT cron.unschedule(<job_id>);       -- 精确删除

-- 查看执行历史 / 失败作业
SELECT * FROM cron.job_run_details WHERE status = 'failed';
SELECT * FROM cron.job_run_details WHERE jobid = '1';
```

## 限制与注意事项

- **允许同名作业**，因此 `unschedule(name)` 存在歧义，管理时用 job id。
- **`cron.job_run_details` 会持续增长**，建议自行安排定期清理作业，或提工单关闭日志（`cron.log_run = false`）。
- 无需外部调度器，作业在数据库内部运行。

## 能力边界：存储过程 vs HTTP

- **支持调用存储函数**：文档明确列出「Call stored functions periodically」这一用例，示例 `SELECT cron.schedule('0 10 * * *', 'select test()');`。
- **不支持发起 HTTP 请求**：文档中的作业命令全部是 SQL 语句（`DELETE` / `VACUUM` / `SELECT func()`），**没有提到任何 `curl` / `http_request` / 外部网络调用能力**。标准 pg_cron 不做 HTTP，除非额外装 `pg_net` 之类扩展 —— 而 `pg_net` 是否在 AnalyticDB PostgreSQL 的可用扩展列表内，本次文档调研**未找到官方依据**。

## 对本项目的含义（分析，非文档原文）

1. 统计链路的批量物化（`visit_inbox` → `visit` 明细 → slot 计数 UPSERT → `visits_count` 回写）**可以直接用 pg_cron 跑一个 SQL 函数完成**，不需要回调 Edge Function。这正好落在文档已确认支持的「定时调函数」能力上，方案稳。
2. 时区坑：所有表达式是 GMT，我们文档与代码注释里写调度频率时要标 UTC 并附北京时间对照，否则会出现「以为每分钟跑、实际差 8 小时」这类问题。
3. 作业查询要去 `postgres` 库，和 Supabase 业务库不是同一个连接目标 —— 排障时别在业务库里 `SELECT * FROM cron.job` 查不到就以为没生效。
4. **P0 验证项 4** 的结论已经不影响主链路（我们不需要 cron 调函数），但如果后续要做「定时推送/对接第三方」，就需要先确认 `pg_net` 可用性，否则改由 Edge Function 侧自己带定时器或外部触发。
