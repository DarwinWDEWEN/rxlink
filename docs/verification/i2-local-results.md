# I2 验证记录：本机 + 线上

> 日期：2026-11-09。范围：`fc/redirect/index.js` + `cache.js` 改写后，先在本机用 Node 24 起临时 HTTP 服务、连**线上库**跑通行为用例；上传 FC 后再对真域名复测。
> 连接串与 `VISITOR_SALT` 只在本地 `.env`，未出现在本文档、日志或命令回显中。

## 1. 改了什么

| 文件 | 变更 |
|---|---|
| `fc/redirect/cache.js` | 值从 `long_url` 字符串改为 `{id,longUrl,forwardQuery,validSince,validUntil,visitsLimited}`；快照 `domain=null` 的行进全局表，其余按 `domain|code` 进域名表；poll 失败只 `console.warn` 一次 |
| `fc/redirect/index.js` | 四个路径常量切正式 RPC/表：`resolve_short` / `visit_inbox` / `link_seq` / `snapshot_short_links`；命中路径补有效期（本机时钟）、`visits_limited` 回落查库、`forward_query` 拼接原 query；404/命中都写 `visitor_key`、`ua`、`referer`、`visited_url`、`redirect_to`，404 带 `orphan_type`；`recordVisit` body 改正式列形状；无效 Location 兜底 502；`Server-Timing` 与 `X-Link-Snapshot` |

`visitor_key = sha256(x-forwarded-for 首段 + VISITOR_SALT)`；无 `x-forwarded-for` 或未配 salt 时为 `null`，不落明文 IP。ua/referer/url 分别截断 512/1024/2048。

## 2. 快照与 seq（连线上库）

```
snapshot ready {"cached":true,"rows":1,"seq":38}
```

快照 1 行 = 库内 `enabled` 短链数（默认域名，`domain=null`）。

## 3. 行为用例（真实响应）

| 用例 | 结果 |
|---|---|
| 命中已缓存短链 | `HTTP/1.1 302 Found`，`Location: https://example.com/a?x=1&y=2`，`Server-Timing: resolve;dur=0;cached=1` |
| `?a=1&b=2` 透传 | `Location` 末段变为 `...&a=1&b=2`（原串已有 `?x=1`，用 `&` 拼接） |
| 未知短码 | `404`，`dur=0`（未打库） |
| 非法短码（含 `%` 等） | `404`，inbox 记 `orphan_type=invalid_short_url` |
| `valid_until` 已过 | `404`，命中缓存但本机时钟判过期，无 DB 往返 |
| `max_visits` 打满 | 回落查库后 `404`（该次 `dur=27`，证明走了 DB） |
| 停用（seq +1） | ≤5s 内 `404`，快照行数同步减少 |
| HEAD | `302`，无 body |
| 无 `x-forwarded-for` | `visitor_key` 为 `null`；带该头时有值，库内无明文 IP |

## 4. inbox 与 drain

本机请求产生的行全部落 `visit_inbox`：命中行带 `short_url_id`，未命中行带 `orphan_type`（`regular_404` / `invalid_short_url`），列形状与 0006 重写后的 drain 对齐。

挂了两条 cron（已生效）：

| jobid | 名称 | 计划 | 命令 |
|---|---|---|---|
| 6 | `rxlink-drain` | `* * * * *` | `select drain_visit_inbox(500)` |
| 7 | `rxlink-prune-dry` | `0 19 * * *` | `select prune_dead_links(180, true)` |

等待 75s 后核对：`cron.job_run_details` 中 jobid=6 连续 3 次 `succeeded`，且 UA 列已填充（`Edge / Windows 10/11 / desktop`、`curl / Other / desktop`）。

## 5. 当前库内数字（2026-11-09 复查）

```
links=1  visits=14  ua_null=3  pending=0  slots=8  orphan_slots=6
```

`ua_null=3` 是 0006 之前写入的旧行，drain 不回填；新行均有 UA。`pending=0` 说明 drain 没有积压。

## 6. 线上真域名复测（上传后）

| 用例 | 结果 |
|---|---|
| 命中 + 透传 query | `HTTP/1.1 302 Found`，`Location: https://example.com/a?x=1&y=2&a=1&b=2`，`Server-Timing: resolve;dur=0;cached=1`，`X-Link-Snapshot: 1|44|…` |
| 新建短链传播 | `create_short_url(... 'i2seq')` 后轮询：**0.31s** 即 302（≤ 一个 5s 轮询周期） |
| 停用传播 | `enabled=false` 后轮询：**0.28s** 即 404，`dur=0;cached=1`（未打库） |
| 未命中 | 未知码 404、`dur=0`，inbox 记 `orphan_type=regular_404` |
| 统计闭环 | 下一次 cron 后 `visit_inbox.processed_at` 全部非空；`visit` 出现对应行（`browser=curl / os=Other / device=desktop / potential_bot=true`）；`short_url_visits_counts` 合计与该链 `visits_count` 一致（i2seq 1=1） |
| 快照失效 | 停用/删除后 header 的 seq 从 44→46→50，行数始终等于 `enabled` 行数 |

决策（2026-11-09）：**不配 `VISITOR_SALT`**——他明确不在意该安全项、优先省资源。因此 `visitor_key` 恒为 `null`，不做 UV（独立访客）口径；PV、明细、bot 判定、计数表都不受影响。代码保留支持，以后要 UV 时配一个值并重启即可，但历史访问无法回填。

最终复查（08:53）：`visits=24, pending=0, slots=13, seq=50`；插入/删除/统计更新均未让 seq 在无跳转列变更时变化。

## 7. 追加修复：link_version 触发器改为行级（0007）

线上复测发现 `prune_dead_links(180, true)` **0 行也会把 seq +1**（47→48）——语句级 AFTER 触发器对 0 行语句同样触发。先试 transition table，被平台拒绝：

```
ERROR 0A000: transition tables cannot be specified for triggers with column lists
```

按评审稿兜底改成行级（`0007_link_version_row_trigger.sql`，`after insert or delete or update of <跳转列> ... for each row`）。复测：

| 操作 | seq |
|---|---|
| 基线 | 48 |
| `update ... where short_code='nope'`（0 行） | 48 |
| `update set visits_count = visits_count`（1 行，非跳转列） | 48 |
| `update set long_url = long_url`（1 行，跳转列） | 49 |
| `prune_dead_links(180, true)`（0 行） | 49 |
| `delete ... i2seq`（1 行） | 50 |

代价：批量写 N 行会 +N（原语句级只 +1）。seq 只需「与上次不同」，FC 仍是「变了才重拉一次」，不影响语义。
