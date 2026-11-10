# 0004 / 0005 DDL 评审稿说明

> 状态：**已于 2026-11-09 全部执行完毕**（决策由他当日拍定，见 `shlink-migration-analysis.md` §9）。执行与验证记录在 [docs/verification/i1-results.md](verification/i1-results.md)；本文保留当时的取舍与预判，供后续改动时对照。
> 两份 SQL 在 [supabase/migrations/0004_core_tables.sql](../supabase/migrations/0004_core_tables.sql) 与 [0005_shorten_and_resolve.sql](../supabase/migrations/0005_shorten_and_resolve.sql)；UA 解析按 §8-1 的设计落成 [0006_ua_parse.sql](../supabase/migrations/0006_ua_parse.sql)。
> 校验口径：本机没有 `psql`/`pg_dump`（`psql not found`），所以这两份**没有做过本地语法校验**；所有语法可用性以 `docs/verification/p0-results.md` 的实测结论为准，未实测的逐条列在 §4，执行时边跑边验。

---

## 1. 两份文件各管什么

| 文件 | 建什么 | 数量 |
|---|---|---|
| 0004 | 13 张表：`domain`（含 id=0 哨兵）、`short_url`、`tag`、`short_url_tag`、`short_url_visits_counts`、`orphan_visits_counts`、`visit_inbox`、`visit`（按月分区 + `ensure_visit_partition`）、`link_version`、`bot_pattern`、`api_key`、`api_key_role`、`prune_report`；外加 `bump_link_version` 触发器与权限收口 | 13 表 / 1 函数 / 1 触发器 |
| 0005 | 7 个 RPC：`short_url_json`、`create_short_url`、`resolve_short`、`snapshot_short_links`、`link_seq`、`drain_visit_inbox`、`prune_dead_links` + 逐个 revoke execute | 7 函数 |

**不在这两份里**（按迭代计划后置）：`edit_short_url` / `list_short_urls` / `delete_short_url` / 标签 CRUD / 域名 CRUD / 访问统计查询 —— 它们属于 I3–I5 的兼容层 B1–B4，先落 DDL 反而会锁死形状。

---

## 2. 与旧 `tech-framework.md` §4 DDL 的差异（7 处）

| # | 差异 | 谁需要 | 结论 |
|---|---|---|---|
| 1 | `short_url.enabled` | 快照 `where enabled`、软删、prune 都靠它 | 新增，`not null default true` |
| 2 | `short_url.last_visit_at` + `visits_count` | 死链判定唯一依据；`max_visits` 判定 | 新增 |
| 3 | `short_url.author_api_key_id` | 作用域 `AUTHORED_SHORT_URLS`（兼容层 I3）；**契约文档里没有这一列**，是本轮新发现 | 新增 + 后挂 FK |
| 4 | `visit` 六个契约字段：`referer`/`ua`/`visited_url`/`redirect_url`/`potential_bot`/`orphan_type` | `ShlinkVisit` 类型定义 | 新增 |
| 5 | `domain.scheme` + 三个 404 回退列 | `shortUrl` 要拼协议；`editDomainRedirects` 三列 | 新增；旧的 `landing_url` 语义被三列覆盖，不再保留 |
| 6 | `api_key` + `api_key_role` | 控制台只认 `X-Api-Key`，复用 web-client 就必须有 | 新增（本轮建表不用） |
| 7 | `visit_inbox.visited_url` / `visitor_key` / `orphan_type` | 孤儿访问明细、去重口径 | 新增；`redirect_to` 保留 |

---

## 3. 关键设计决策

**D1｜默认域名用 `domain_id = 0` 哨兵行。**
平台缺 `unique nulls not distinct`（P0 项 10），不能让 `domain_id` 为 null 参与唯一性；`unique (domain_id, short_code)` 必须对默认域名也生效。于是插一条 `id = 0` 的哨兵，`overriding system value` 绕过 identity。代价：`authority` 得由人改成真域名，否则所有默认域名短链的 `shortUrl` 会拼成 `http://__default__/xxx`。这一步写成 0004 末尾的**注释态 UPDATE**，由你确认值后手动跑（见 §6 第 4 步）。

**D2｜`link_version` 触发器只挂在「影响跳转结果」的列上。**
这是这两份 DDL 里最容易踩的坑：`visits_count` / `last_visit_at` 每分钟被 drain 更新，若触发器不限定列，seq 每分钟 +1，函数就会每分钟重拉一次全量快照（2 万行 ≈0.58s，P0 已测）。所以用语句级 `update of short_code, domain_id, long_url, forward_query, enabled, valid_since, valid_until, max_visits`，不在这张清单里的列变化不 bump。

**D3｜快照下发「有效期」，不下发「计数」。**
- 有效期是**固定时刻**，随行下发、由函数按本机时钟判定即可；如果只靠 seq，链接到期不会 bump，过期链会一直能跳。
- `max_visits` 的计数是**分钟级变化的值**，下发必然是陈旧的 ⇒ 下发一个 `visits_limited` 布尔标记，命中限次链接时回落查库（`resolve_short` 里有精确判定）。限次链接是少数，这样既不牺牲正确性也不把快照变成每分钟重拉。

**D4｜快照下发 `id`，默认域名的 `domain` 返回 `null`。**
- 热路径写 `visit_inbox` 要的是 `short_url_id`，不能再按 code 反查一次库。
- 现有 `cache.js` 的索引规则是「`row.domain` 为真 → 域名表，否则 → 全局表」。若快照把默认域名写成 `''`，key 会变成 `'|code'`，而 lookup 传的是真实 hostname ⇒ **默认域名短链永远查不到**。所以这里必须返回 `null`（I2 同步改 `cache.js` 的建索引分支）。

**D5｜`visit_inbox` 不建外键。**
热路径写入必须永不因约束失败；代价是「链接被 prune 后迟到访问」会插进 `visit` 但更新 0 行 `short_url`，也不进孤儿计数。这是已知取舍，不影响主账。

**D6｜分区不继承父表的权限与 RLS。**
`visit` 的子分区是独立表，`enable/force RLS` 与 `revoke` **不会**从父表继承。所以 `ensure_visit_partition()` 里每建一个分区就把三行权限收口一起做掉——否则未来每个月的分区都是对 anon 全裸。

**D7｜所有函数 `security invoker` + 逐个 revoke EXECUTE。**
平台禁 `SECURITY DEFINER`（P0 项 8），函数只能以调用者身份跑；而平台默认把 EXECUTE 授给 `PUBLIC` ⇒ 不显式 revoke，anon 拿到 key 就能直接调 `create_short_url`。0005 末尾用 DO 块按签名逐个 revoke 并 grant 给 `service_role`。

**D8｜错误码走 SQLSTATE 而不是自定义字符串。**
自定义 slug 非法 → `22023`（`invalid_slug`），冲突 → `23505`（`non_unique_slug`），随机码耗尽 → `23505`（`short_code_exhausted`）。兼容层按 message 映射成 shlink 的 RFC7807 错误体，**不依赖 PostgREST 的错误码翻译**。

**D9｜长链去重键 = `sha256(long_url::bytea)` 生成列。**
平台没有 PG17 的 `hex()`，也不支持 `nulls not distinct`（P0 项 10）；生成列 + `sha256` 已实测可用。`find_if_exists` 命中条件是 `long_url_hash` 相等 **且** 三个有效期/限次字段 `is not distinct from`。

**D10｜自定义 slug 与随机码都先拿 `pg_advisory_xact_lock`。**
`(domain_id, code)` 先查后插有竞态；advisory lock 已实测可用（P0 项 10）。随机码用单行 insert 捕 `unique_violation` 重试 20 次（多值 insert 一行冲突会回滚整条语句，P0 已记）。

---

### 3.1 静态审读时改掉的三处（原稿会出问题）

| 位置 | 问题 | 改法 |
|---|---|---|
| `prune_dead_links` 末尾 SELECT | `RETURNS TABLE` 的输出列名在 plpgsql 里是变量，裸写 `short_code/domain/stale_days` 会被判 `column reference is ambiguous`（默认 `variable_conflict = error`） | 全部加 `st.` 前缀 |
| `snapshot_short_links` | 原稿把默认域名写成 `''`，`cache.js` 的 key 会变成 `'|code'`，而 lookup 传的是真实 hostname ⇒ 默认域名短链永远查不到 | 返回 `null`（D4） |
| `ensure_visit_partition` | 分区不继承父表 ACL/RLS，原稿建完分区不设防 | 每个新分区补 `enable/force RLS + revoke anon,authenticated`（D6） |
| `drain_visit_inbox` 的 `done` CTE | **执行期发现的真 bug**：同一语句里对同一行做第二次 UPDATE 会被 Postgres 静默跳过 ⇒ `processed_at` 永远为空，同一批访问每轮重复入账 | 把 `processed_at = now()` 合进打分那次 UPDATE，删掉 `done` |

---

## 4. 必须在线上先验的假设（执行时逐条验）

| # | 假设 | 怎么验 | 不成立怎么办 |
|---|---|---|---|
| 1 | 语句级 `update of <列>` 触发器按「赋值了这些列」判定 | 建表后：`update short_url set visits_count = 1` → `link_seq()` 不变；`update short_url set long_url = ...` → +1 | **已证伪（2026-11-09）**：UPDATE 命中 0 行时语句级触发器仍触发，`prune_dead_links(180,true)` 每天白 +1。transition table 也被平台拒绝（`0A000 cannot be specified ... with column lists`）。已按兜底改成**行级 + `update of`**（`0007_link_version_row_trigger.sql`），复测：0 行不变、只改计数不变、真改跳转列 +1、dry-run 不变 |
| 2 | `insert ... overriding system value` 能写 identity 列 | 执行 0004 第 2 条，看哨兵行是否 `id = 0` | 把 `domain.id` 改成普通 `bigint`（不推荐）或序列从 1 起、用 -1 当哨兵 |
| 3 | plpgsql 里 `to_regclass` + 动态 DDL 可建分区 | 调 `ensure_visit_partition` 三次，查 `pg_class` | 改成建表时静态写 3 个分区、cron 用静态 SQL |
| 4 | `pg_advisory_xact_lock(hashtext(text))` 的 int4 实参能隐式转 int8 | 建链函数跑通即证 | 显式 `::bigint` 或换成两参版本 |
| 5 | 建完表/函数后 PostgREST 能立刻解析 `/rest/v1/rpc/<name>` | 0005 执行完立刻 `curl` 一次 `link_seq`；报 404 就要等/触发 schema cache 重载 | 兼容层与跳转函数都受影响；I2 前必须解决 |
| 6 | `force row level security` 不会挡住 `service_role` | P0 已实测 `service_role.rolbypassrls = true`（`p0-results.md` 顺带验证段） | 若被挡，去掉 `force` 只留 `enable` |
| 7 | 平台一次只执行一条语句 | P0 项 11 已实测 | 已按逐条执行设计，无退路需求 |
| 8 | 逐条执行失败会留下半成品 | 语句全部写成幂等（`if not exists` / `create or replace` / `on conflict do nothing` / `drop constraint if exists`），失败后修完重跑即可 | 无法跨语句包事务（一条一调用），所以只能靠幂等重跑 |

---

## 5. 连带影响的代码改动（写回 `docs/iteration-plan.md` §I2）

原计划写的是「I2 只改常量」，**这是错的**。0004/0005 落地后，跳转函数有四处必须改：

1. `cache.js` 存对象而不是字符串：`{id, long_url, forward_query, valid_since, valid_until, visits_limited}`；建索引时 `row.domain` 为真进域名表、否则进全局表（D4）。
2. 缓存命中路径补三项判定：有效期（本机时钟）；`visits_limited` 为真 → 回落 `resolve_short`；`forward_query` 为真 → 把原请求 query 原样拼到 `Location` 后面（**当前代码完全没实现，任何带参短链都会丢参**）。
3. 写 inbox 的 body 换成正式表列形状：命中写 `short_url_id`，未命中写 `orphan_type = 'regular_404'`；两者都带 `visitor_key = sha256(ip + VISITOR_SALT)`（新环境变量）、`ua`、`referer`、`visited_url`、`redirect_to`。
4. `recordVisit` 的 `{payload: {...}}` 包装去掉。

---

## 6. 应用顺序（他确认后我来跑）

1. **确认没有同名对象**：`select to_regclass('public.domain'), to_regclass('public.short_url'), ...`（探针表都带 `probe_` 前缀，正常不冲突；冲突就停）。
2. **不备份**：库里只有探针对象，没有业务数据；回滚 = `drop`，且 0004/0005 全部是新对象，不动 `probe_*`。
3. **0004 逐条执行**（约 20 条，含 3 条 `select ensure_visit_partition(...)`），每条后跑 §4 对应的验证 SQL；任一条失败即停，修完从该条续跑（幂等）。
4. **一次性 UPDATE 默认域名**（需你给值）：
   ```sql
   update domain set authority = '<主域名>', scheme = 'http' where id = 0;
   ```
   不跑这一步，默认域名短链的 `shortUrl` 全是 `http://__default__/xxx`。初期只有 `example.com`（无证书），也可以把哨兵指向它先跑通；上线正式域名时再改。
5. **0005 逐条执行**（7 个函数 + 1 个收权 DO 块），然后：
   - `curl` 打一次 `link_seq` 验证 PostgREST 已识别（§4-5）；
   - 用 service_role 手工跑一遍：建链 → `resolve_short`（域名优先 / 回落默认）→ 快照行数 → 改 `long_url` 后 seq +1 → `enabled = false` 后快照少一行；
   - anon key 直连 13 张表必须 **0 行或 42501**，直调 7 个 RPC 必须 42501。
6. **验证记录写进** `docs/verification/i1-results.md`（这是 I1 的出口判据）。

---

## 7. 需要你拍的

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 哨兵行 `authority` 填什么 | 先填 `example.com` + `http`，正式域名定了再 UPDATE 一行即可 |
| 2 | D2 状态码是否固定 302 | 固定 302（DDL 不涉及，确认即可） |
| 3 | D3 是否确认不做多段 slug | 不做；`short_code` 的 CHECK 已按单段 `[a-z0-9_-]{1,64}` 写死 |
| 4 | D5 存量数据不迁 | 不迁；本轮无迁移脚本 |

---

## 8. 已知缺口（明确不在本轮修）

1. ~~**`visit` 的 `browser`/`os`/`device` 没人填**~~ → **已解决（2026-11-09）**：`0006_ua_parse.sql` 用规则表 `ua_rule`（36 条）+ `ua_match`/`ua_parse`，在 drain 时解析，热路径仍零成本。新增 UA 只 INSERT 规则即可生效。
2. **`country`/`region`/`city` 全空**：D4 推迟地理定位，字段先留着。
3. **`max_visits` 生效延迟**：计数要等 drain 落库（延迟 ≤1 分钟），打满后最多多放行 1 分钟的访问。
4. **prune 掉的链接的迟到访问**：见 D5，进不了孤儿计数。
5. **快照里 `visits_limited` 的链接每条都要查库**：数量大时需要另想（当前假设极少）。
