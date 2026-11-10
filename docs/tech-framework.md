# 短链平台技术框架（v0.1）

后端底座：阿里云 AnalyticDB PostgreSQL 版 Supabase（下文简称 ADB Supabase）
参考实现：`shlink/`（PHP，已用 codegraph 索引分析，见文末能力映射表）

---

## 1. 本期已定的四个决策

| 决策点 | 结论 | 影响 |
|---|---|---|
| 跳转热路径由谁承接 | ~~Edge Function 直接承接 `/{shortCode}`~~ → **定案：跳转层 = 函数计算 FC 函数 + 自定义域名**（2026-11-06 实测：Supabase Edge Function 的 3xx 被网关跟随、FC 默认公网域名所有 3xx 一律 400 `ExternalRedirectForbidden`，只有绑自定义域名拿到真 302；证据见 `docs/verification/p0-results.md` 项 2b/2c） | Supabase 退为**纯数据面 + 控制台 API**；多一套运行时与发布链路，每个短链域名一套证书（备案主体已在阿里云，不构成等待期） |
| 访问日志 | 事件/队列 + 批量异步落库，跳转请求内不同步写明细 | 热路径只有一次读 + 一次入队 |
| 客户端形态 | ~~Web 控制台自研（React + Vite + supabase-js）~~ → **2026-11-09 改定：复用 shlink-web-client（v4.9.0，2026-10-31 发，MIT）**，后端建 shlink 兼容 REST 层（范围＝SDK 全部 **23 个**客户端方法 / 18 条路径） | 界面免费拿到，但代价三条：① 必须有 `api_key` 体系与函数内鉴权（它只认 `X-Api-Key`，不认 Supabase Auth）；② 兼容层用 `service_role` 直连库 ⇒ 这条路径上 **RLS 被绕过**，数据可见性要在函数里按 key 作用域重建；③ 我们独有能力（死链 dry-run 清单、域名云侧状态、缓存水位）在它的界面里没有位置，先用 SQL 看。**本机已实测**：源码拉到 `shlink-web-client/`，Node 24 下 `npm ci`（503 包 / 32s）+ `npm run build`（tsc + vite 422ms）通过，产物起静态服务后浏览器正常渲染 Welcome 页；`github.com` 不可达所以拿不到官方预打包 dist。契约原件与字段表见 `docs/shlink-api-contract.md` |
| 多域名 | 本期就要 | 见第 3 节（已验证）：每域名 = FC 自定义域名一条 + 证书，域名归属读 `Host` |

---

## 2. 分层与运行时

```
shlink-web-client 静态站（复用现成界面，v4.9.0 源码本地 build）
        │  它只说一种话：{baseUrl}/rest/v3/... + 请求头 X-Api-Key
     shlink 兼容 REST 层（Edge Function，--no-verify-jwt；实测自定义头可穿过网关）
        ├─ 验 X-Api-Key → sha256 查 api_key 表 → 解析作用域（Author / Domain / NoOrphan 三角色）
        ├─ 请求与响应逐字段照 @shlinkio/shlink-js-sdk 的 api-contract 类型对齐
        └─ 分派到 SQL / RPC；**用 service_role 直连，这条路径不经过 RLS**（见 §4.1 两套并存的口径）

短链域名 <domain>/{code}   ← 必须多域名
        │
     函数计算 FC 自定义域名（路由 /* 兜底；泛域名官方支持；每域名一套 HTTPS 证书）
        │                       ← 不再需要阿里云 CDN，也不再经过 Supabase 网关
     FC Web 函数「r」（Node.js，监听 9000）
        ├─ 单次 RPC 查长链目标（走 Supabase 公网网关 /rest/v1/rpc/…，service key 放 FC 环境变量/密钥）
        ├─ fire-and-forget 入队访问事件（同一次调用里异步写 inbox，失败不阻断跳转）
        └─ 返回 302 + Location   ← 实测：只有自定义域名这条路给得出真 302（项 2c-T2）
        │
     ADB Supabase（Postgres）＝ 纯数据面 + 控制台 API
        ├─ 业务表 + RPC（唯一真源，PL/pgSQL）
        ├─ visit_inbox 落地区
        └─ pg_cron 定时：批量物化明细 / 汇总计数 / 清理过期短链

旁路（本期不做，架构留口）：第三方推送、IP 地理定位富化
```

**核心取向：业务逻辑下沉到 SQL，函数层只做 I/O。**
原方案假设「ADB 是 MPP 数仓，长事务和多往返是短板」。实测修正（项 10）：当前实例是单节点 Postgres，不是 MPP。但「RPC 收口、少往返」照旧成立 —— 跳转每多一次 REST 往返就多一个几十毫秒的网络段（公网单跳实测 24ms），把创建短链的「查重 → 生成码 → 抢锁 → 落库」压进一个 RPC 仍是最快路径；而且真换到 MPP 规格时这套设计不用返工。

### 各层职责边界

| 层 | 负责 | 明确不负责 |
|---|---|---|
| 前端（复用 shlink-web-client，不改代码） | 表单、列表、图表、CSV 导出 | 短码生成、鉴权判定、统计口径；**我们的独有能力（dry-run 清单、域名云侧状态、缓存水位）没有落点，先走 SQL** |
| Edge Function（两种形态） | ① 兼容层：验 API key、解析作用域、按 SDK 契约收发载荷、转调 RPC；② 跳转侧：HTTP 出入口、载荷校验、跳转响应（形态见 §6.1）、事件入队、调用外部服务 | 业务规则实现（一律转调 RPC） |
| Postgres / RPC | 数据约束、唯一性、短码分配、有效性判定、计数与聚合 | — |
| pg_cron | 批量物化、汇总刷新、过期清理、归档 | 业务实时链路 |

---

## 3. 多域名的自定义域名与短路径（2026-11-06 已全部实测，结论见下）

平台侧的硬事实（文档确认）：

1. Edge Function 只能按 `https://<项目域名>/functions/v1/{函数名}` 访问，**平台内不支持自定义路由**（不存在把 `/api/xxx` 或根路径 `/AbC123` 映射到函数的配置项）。
2. 自定义域名的官方做法是 **CDN CNAME 回源到 Supabase 项目域名**，要求：域名已完成阿里云接入备案 + 已开通 CDN 服务；HTTPS 需在 CDN 侧配证书；回源 HOST 必须设为 Supabase 源站域名。
3. Edge Function 默认开启 JWT 校验，可在函数 Settings 或用 `--no-verify-jwt` 关闭。

由此推出我们的落地方式与风险：

- **短码放 path 后缀还是 query**：**已定案，短码留在 path**。跳转层走 FC 自定义域名（`/*` 兜底路由，实测 `pathname=/AbC123` 直达函数，见项 18），上面那条 CDN「重写访问 URL 是否支持正则捕获组」的未知量**不再是架构阻塞**；顺带实测「CDN → Supabase」这条链路也**不改写路径**（`x-forwarded-path=/functions/v1/probe/AbC123`、函数看到 `/AbC123`，项 19），所以控制台 API 想套 CDN 也不需要重写规则。
- **每个短链域名的成本结构变了**：跳转层不在 CDN 上 ⇒ 每个短链域名 = FC 自定义域名一条 + 该域名证书（泛域名 `*.example.com` 官方支持，可能一条顶 N 条），Supabase 侧完全不需要按域名配东西；CDN/备案那套只在「给 `supabase-js` 用的 API 域名」上配**一条**即可。仍需工单确认：单账号/单地域可绑域名数量上限、泛域名是否逐条备案。
- **公网访问**：函数若要访问公网第三方 API，需为项目单独开通公网访问；纯查库不依赖公网。
- **免 JWT 的跳转函数必须是只读 + 限流的**，任何人都能匿名调用它，这是设计前提而非漏洞；它只接受 shortCode、只返回 Location，绝不返回长链之外的敏感信息。

> 本节原为「验证通过前不启动多域名相关编码」的阻塞项；2026-11-06 项 1a/1b/2c 全部实测完毕（含 CDN 域名 `cdn.example.com` 与 FC 自定义域名 `example.com`），多域名编码可以启动，剩余未知量收敛为「可绑域名数量 / 泛域名备案」两条工单问题与 HTTPS 证书复测。
> 平台事实的文档存档见 `docs/reference/adb-supabase/`；验证工程与步骤见 `docs/verification/p0-runbook.md`，结果登记在 `docs/verification/p0-results.md`。

---

## 4. 数据模型（Postgres，schema-first）

命名沿用 shlink 的语义，类型换成 PG 原生，主键用 `bigint`。

> 本节是**设计说明**，不是可执行脚本。正式表以 [supabase/migrations/0004_core_tables.sql](../supabase/migrations/0004_core_tables.sql)、[0005_shorten_and_resolve.sql](../supabase/migrations/0005_shorten_and_resolve.sql) 为准，与本节之间的 7 处字段差异和每条设计取舍见 [docs/ddl-review-0004-0005.md](ddl-review-0004-0005.md)。

实测修正（证据见 `docs/verification/p0-results.md` 项 10）：实例 `version()` 报 `PostgreSQL 17.5`，但**没有 Greenplum 目录表和专有函数**，`with (appendonly=true)` 被拒 ⇒ 它不是 MPP 引擎，而是单节点 Postgres 分支；语法能力还低于 PG15/16（缺 `unique ... nulls not distinct`、缺 `returning old/new`、缺 `hex()`）。**DDL 按 PG14 保守子集写，别赌新语法。**

```sql
-- 域名：多域名能力的根，备案状态是它的核心属性
-- identity 从 1 开始；业务上把 domain_id = 0 保留给「默认域名」哨兵（见 short_url 的说明）
create table domain (
  id            bigint generated always as identity primary key,
  authority     text        not null unique,          -- host[:port]，不含协议
  is_default    boolean     not null default false,
  icp_status    text        not null default 'unknown', -- pending/valid/invalid/unknown
  landing_url   text,                                  -- 域名级兜底跳转（shlink NotFoundRedirectHandler）
  created_at    timestamptz not null default now()
);
-- 预置哨兵行，让 domain_id=0 有实体可引用（实测 identity 列允许 overriding system value 写 0）
insert into domain (id, authority, is_default) overriding system value values (0, '__default__', true)
on conflict (id) do nothing;

-- 长链去重键：shlink 用 long_url_hash(BINARY) 索引做「同链复用」，我们换成 sha256 直接落 bytea 生成列
-- domain_id 用 0 哨兵而不是 null：本内核没有 `unique (...) nulls not distinct`（实测语法报错），
-- 若用 null，「默认域名下的短码」在唯一索引里互不相等 = 完全不去重，是静默的正确性坑。
create table short_url (
  id             bigint generated always as identity primary key,
  domain_id      bigint      not null default 0 references domain(id) on delete restrict, -- 0 = 默认域名（domain 里预置 id=0 的哨兵行）
  short_code     text        not null,                 -- 入库前统一小写（避开 shlink 自己标注的 LOWER() FIXME）
  long_url       text        not null,
  long_url_hash  bytea       generated always as (sha256(long_url::bytea)) stored,
  title          text,
  crawlable      boolean     not null default false,
  forward_query  boolean     not null default true,   -- 是否把 query 透传给长链
  valid_since    timestamptz,
  valid_until    timestamptz,
  max_visits     integer,
  visits_count   bigint      not null default 0,       -- 展示用汇总，非实时强一致
  created_at     timestamptz not null default now(),
  unique (domain_id, short_code)                       -- 多域名下的唯一性锚点
);
create index on short_url (long_url_hash);
-- 跳转热路径 (domain_id, short_code) 等值查询直接走上面的 unique 索引，不另建

-- 计数打散表：继承 shlink 的 slot 方案，把同一条短链的并发计数拆到 ≤100 行，
-- 规避单行热点更新互相等锁（实测 100 次随机 UPSERT 落在 72 个 slot，单 slot 最大 4 次）
create table short_url_visits_counts (
  id             bigserial primary key,
  short_url_id   bigint      not null references short_url(id) on delete cascade,
  potential_bot  boolean     not null default false,
  slot_id        smallint    not null,                 -- 1..100，随机落位
  count          bigint      not null default 1,
  unique (short_url_id, potential_bot, slot_id)
);

-- 映射版本号：跳转函数常驻快照的失效依据（详见 §5.2.2）。一行表 + 一个触发器，
-- 由 short_url 的 insert/update/delete 自动 +1，写入口不需要自觉；函数每 5s 只读这一行。
-- 触发方式（0007 实测修正）：short_url 上用**行级** `update of <跳转相关列>`，不是语句级——
-- 语句级 after 触发器在 UPDATE 命中 0 行时也会触发（prune dry-run 每天白 +1）；
-- 行级 + `update of` 才能同时满足「0 行不 bump」和「drain 只写计数不 bump」。
-- 实测（探针版 0002_link_cache_version.sql，语句级）：单条语句批量插 1 万行只 +1；
-- 正式表改为行级后，批量写 N 行会 +N——seq 只需「与上次不同」，不影响失效判定。
create table link_version (
  id    int     primary key default 1,
  seq   bigint  not null default 0,
  check (id = 1)
);

-- 访问事件落地区：热路径只写这一张，UNLOGGED 换吞吐，崩了丢的是统计不是业务
-- 实测：create unlogged table / 写入 / REST 读回都可用，服务端含 slot 计数 UPSERT 约 0.1ms/次
create unlogged table visit_inbox (
  id             bigserial primary key,
  short_url_id   bigint,                -- null = 孤儿访问
  not_found_type text,                  -- base_url/invalid_short_url/regular_not_found
  visitor_key    text,                  -- 可选：sha256(ip + salt)，不落明文 IP；未配 VISITOR_SALT 时为 null
  ua             text,
  referer        text,
  redirect_to    text,
  potential_bot  boolean,
  occurred_at    timestamptz not null default now(),
  processed_at   timestamptz
);
create index on visit_inbox (occurred_at) where processed_at is null;

-- 明细表：普通表 + 按月 range 分区。ADB 列存的 `with (appendonly=true)` 在本实例被拒
-- （实测 unrecognized parameter "appendonly"）；分区与子分区实测可用，
-- 保留期靠 drop 分区回收，比 delete 便宜得多，也回避了大表 vacuum
create table visit (
  id             bigserial,
  short_url_id   bigint      not null,
  visitor_key    text,
  country        text, region text, city text,
  browser        text, os text, device text,
  occurred_at    timestamptz not null,
  primary key (id, occurred_at)          -- 分区键必须进主键
) partition by range (occurred_at);
-- create table visit_2026_11 partition of visit for values from ('2026-11-01') to ('2026-12-01');
```

API Key / 用户与授权：优先复用 **Supabase Auth + RLS**（`auth.uid()` 做属主判定），不自建 key 体系；若要对外提供机器对机器的开放 API，再补一张 `api_key(hash bytea)` 表（`sha256(key)::bytea`，实测生成列可用），沿用 shlink 的 sha256 存储方式。

### 4.1 权限收口：这个平台的默认状态是「裸奔」，每张表必须自带四行

实测结论（结果登记项 8、9），两条都推翻了「上了 Supabase 就有 RLS」的直觉：

1. **平台禁止 `security definer`** —— 建函数直接 `SECURITY DEFINER functions are not allowed (42501)`。所有 RPC 只能以调用者身份执行，所以「函数里跑特权逻辑」这条路只剩 `service_role` key（实测 `rolbypassrls = true`）一条。
2. **public schema 新建的表，`anon` / `authenticated` 会自动拿到全部权限**（含 INSERT/UPDATE/DELETE/TRUNCATE），而 RLS 默认关闭 —— 已实测 anon key 能直接往新表写一行、能直接调新 RPC。

因此每张业务表的迁移脚本必须成组出现，缺一条就是越权面：

```sql
alter table short_url enable row level security;
alter table short_url force  row level security;
revoke all on table short_url from anon, authenticated;   -- 不给直连 CRUD，只留 RPC 入口
revoke execute on function resolve_short from anon;       -- 内部 RPC 按需再授给 authenticated
```

- **shlink 兼容 REST 层（2026-11-09 起 = 控制台入口）**：函数持 `service_role`，**这条路径不经过 RLS**，数据可见性只能在函数内按 API key 的角色作用域过滤（对应 shlink 的 Specification 语义）。⇒ 「表建好 + RLS 打开」在这条路上**不构成防线**，别把它当收口手段。
- **Auth + RLS（留给小程序/多用户直连）**：`auth.uid()` 判属主的 policy 只在 PostgREST 直连时生效，实测有效。两套并存期间，**新增一张表必须同时写清两边口径**：兼容层怎么过滤、RLS policy 怎么写，漏一边就是越权面。
- **跳转/创建函数**：服务端持 `service_role`，走 RPC，不直接拼表查询。
- 迁移脚本按语句逐条执行：`supabase db query` 走 prepared statement，一次只认一条语句（项 11）。

---

## 5. 核心链路

### 5.1 创建短链
`POST /functions/v1/short-urls` → 函数校验载荷 → 调 `rpc('shorten', payload)` → PL/pgSQL 单事务内：
1. `find_if_exists` 为真时按 `long_url_hash`（+ domain/有效期/max_visits）查复用，命中直接返回；
2. 生成短码：字母表按模式取（strict = 62 字符大小写+数字，loose = 36 字符小写），长度可配；
3. 撞库时**重试重新生成**，自定义 slug 撞库**直接报 409**；并发防重用 `pg_advisory_xact_lock(hashtext(domain_id || code))` 而非 shlink 的 `SELECT FOR UPDATE`（实测可用）。注意重试必须是**单行 insert 捕 23505**：实测多值 insert 里一行冲突会整条语句回滚，没法只跳过一行；
4. 返回短链对象。

**写路径的缓存义务**（§5.2.2）：以上任何一步落到 `short_url` 的写入都由 `link_version` 触发器自动 bump，`shorten` 函数里不需要额外语句；只有绕过 SQL 直接改表的风险已被触发器覆盖。删除/停用/改长链同理。触发器是**行级 + `update of` 跳转相关列**（0007），0 行语句与只改计数的 drain 都不会 bump。

### 5.2 跳转（热路径，目标 P99 < 150ms）
`GET https://<短链域名>/{code}` → FC 自定义域名路由 → FC Web 函数 `r`（项 2c 已定案，见 §6.1）：
1. 短码 = 原始 path（`pathname`，实测 `/AbC123` 直达函数、多级也在）；**所属域名直接读 `Host`**（实测就是 `example.com`，`x-forwarded-host` 依赖作废）；客户端真实 IP 取 **`x-forwarded-for` 首元素**（`x-real-ip` 这条链路没有、`x-fc-client-ip` 为空）。**先查实例内存的常驻映射快照**（§5.2.2，命中与确认不存在都不打库）；快照未就绪才 `select ... from rpc('resolve', ...)` 一次拿到 `long_url / forward_query / is_enabled / 有效期判定`；**解析优先级用一条 SQL 完成**：域名专属短码 > `domain_id = 0` 的默认域名短码（继承 shlink 的 `findOneWithDomainFallback`，`order by (domain_id = :d) desc limit 1`，实测三种输入都命中预期行）；大小写不敏感改成**入库时统一小写**，避开 shlink 自己标注的 `LOWER()` FIXME 性能坑；
2. 拼 query 透传 → **返回 `302 + Location`**（自定义域名实测客户端能收到，见项 2c-T2；`forward_query` 时把原 query 合进长链）。**注意**：这条只在 FC 自定义域名上成立；同样的代码跑在 Supabase Edge Function（被网关跟随）或 FC 默认公网域名（一律 400 `ExternalRedirectForbidden`）都拿不到 302；
3. **不等统计**：`await` 一个 fire-and-forget 的 inbox 写入，或在返回响应后由平台异步阶段入队；短链已失效/不存在 → 写一条孤儿访问，再走 `domain.landing_url` 兜底或 404。

**已落地：[fc/redirect/index.js](../fc/redirect/index.js)**（零依赖 Node http，运行时 ≥18，监听 `${FC_SERVER_PORT:-9000}`）。本机对着线上库跑过的用例：命中域名专属短码 → `302 + Location: .../from-domain`；陌生域名 → 回落全局短码 `.../from-global`；未命中 → 404 且写 `hit:false` 孤儿访问；多级 path / 根路径 → 404（不进 DB）；POST → 405；首次调用 319ms（TLS 握手），之后 `resolve` 内部耗时 **18～31ms**，响应用 `Server-Timing: resolve;dur=` 自报，方便区分「函数排队」与「查库」。安全面：`Location` 只取库里的 `long_url`，请求不参与拼接（无开放重定向）；短码白名单 `[A-Za-z0-9_-]{1,64}`；**不回显也不记录任何请求头**（项 20 的教训）；响应一律 `Cache-Control: no-store`。
数据面暂时还指向探针表：`/rest/v1/rpc/probe_resolve` + `/rest/v1/probe_inbox`，加上缓存层的 `/rest/v1/rpc/probe_link_seq` + `/rest/v1/rpc/probe_link_snapshot`（ migration `0002_link_cache_version.sql`，已在线上）；**0004 正式表落地后只改这几行常量**。

上线操作（FC 控制台）：① 函数管理 > 创建函数 > **Web 函数**，地域 cn-hangzhou，运行环境 Node.js 20，启动命令 `node index.js`，监听端口 9000，代码 `fc/redirect/`（现在是 `index.js` + `cache.js` 两个文件，控制台粘贴单文件已经不够，要打包上传）；② 环境变量两条：`SUPABASE_URL`（**用 VPC 内网连接地址**）、`SUPABASE_SERVICE_ROLE_KEY`（值他自己填，别贴进聊天/文档）；③ 触发器**认证方式 = 无需认证**；④ 域名管理 > `example.com` > 路由，把 **`/*` 指向新函数**（探针函数 `test-supabase` 保留不删，工单复现还要用）；⑤ 「允许访问 VPC」保持开启（同 VPC + 交换机网段已加进 Supabase 白名单）；⑥ 弹性配置 > **最小实例数 ≥ 1**，否则新实例的首个请求走查库路径，且要重付 VPC 挂载 + 全量拉取两段成本。

### 5.2.1 首测数字（2026-11-06，`http://example.com` 上的正式跳转函数）

行为全对：`GET /AbC123` → **`302 Found` + `Location: https://example.com/from-global`**（`Host=example.com` 没有该域名的专属短码，正确地回落到全局短码）；`/zzzzzz9` → 404；`/a/b/c`、`/` → 404 **且不打库**（没有 `Server-Timing` 头即是证据）；`/abc123`（小写）→ 404 但**查了库**（`dur=10`）⇒ 短码是精确匹配，印证「入库时统一小写」必须做；POST → 405；响应头干净：没有 `Content-Disposition`（自定义域名不强制下载，与默认域名的实测差异），只多了平台的 `X-Fc-Request-Id`。

延迟（客户端在本机，走公网到 cn-hangzhou）：

| 口径 | 数字 | 解读 |
|---|---|---|
| 函数内部 `resolve` | 冷启动首call 89ms，稳态 **8–11ms** | 首次那 80ms 是 FC→Supabase 的 TLS 握手，实例复用后就没了 |
| 端到端（**复用连接**）ttfb | **28 / 30 / 32ms** | 这才是服务端真实成本，远低于 P99<150ms 目标 |
| 端到端（每次新建连接） | 62～340ms，多数 220～250ms | 大头是 DNS+TCP+FC 网关排队，**不是我们的代码**；浏览器复用连接时体验接近 30ms |
| **50 并发** | p50=539ms、p95=804ms、max=925ms，**50/50 全成功** | 与「Supabase 侧 50 并发 p50=405ms」同形 ⇒ 瓶颈是**单实例并发度**，不是查库；必须靠工单拿到实例并发/最大实例数才能估 QPS 上限 |
| 统计链路 | inbox 落库**零丢失**：50 并发写满 50 行，未命中各写 1 行 `hit:false`，`payload.domain=example.com` 全部正确 | fire-and-forget 在 FC 上确实能在响应之后把写入做完；`Host` 作为域名归属依据成立 |

**⚠️ 一处待改**：`Content-Type: application/octet-stream` 是平台补的，跳转发空 body 无害，但 404 页要返回 HTML 时得显式设置，别被它覆盖。

**内网地址实验（2026-11-06，已通，定案：生产用 VPC 内网地址）**：

| 阶段 | 现象/数字 |
|---|---|
| 只换 `SUPABASE_URL` 为内网地址（未开 FC 的「允许访问 VPC」） | 全部 `502 / upstream error`，**耗时稳定 10.62–10.83s**；https 与 http 一样 ⇒ 与协议无关。DNS 失败会毫秒级报错，固定 ~10.7s = TCP SYN 无人应 ⇒ **卡在路由**。官方口径坐实原因：「函数计算中创建的函数，默认可以访问公网，而无法访问 VPC 内的资源」 |
| 打开「允许访问 VPC」（同 VPC + 交换机）并把交换机网段加进 Supabase 白名单 | **8/8 `302`**；`resolve` 首呼 70ms、次呼 21ms、稳态 **5–6ms**（公网口径是首呼 89ms、稳态 8–11ms）；端到端新建连接 113–239ms（此前公网 220–250ms）；404 未命中用例正常；inbox 落库**零丢失**，14 次请求 14 行、`payload.domain=example.com` 全对 |

**打开 VPC 访问的三个连带影响**（官方原文，决定了后续怎么配）：① 「使用 VPC 功能会降低函数计算的冷启动效率，建议非必要勿配置该功能」——所以我们把冷启动代价从热路径上摘掉的唯一办法是**最小实例数 ≥ 1**；② 每个实例占一个交换机 IP，网段太小会直接 `ResourceExhausted 429「交换机的网段内可用 IP 不足，函数计算无法创建更多的 ENI」`，官方建议 **/24 或 /16**；③ 绑定 VPC 后函数出流量全进 VPC，**访问公网需另配 NAT 网关**——跳转函数只读库+写 inbox 不需要出网，但以后做「死链探测」必须留出网口。白名单要填的是**交换机所属网段**（官方口径），不是函数公网 IP。

**这条实验同时量化了缓存的真实收益**：内网稳态 `resolve` 5–6ms 仍是每次请求的固定开销，且实例重建连接那一下还是要 70/21ms——全量常驻命中时这两个数字都归零。

### 5.2.2 映射缓存层（2026-11-06 定案并实现，代码在 [fc/redirect/cache.js](../fc/redirect/cache.js)）

**先回答「有没有必要」**：映射是**低频改、高频读**，且基数很小（1 万条 838KB，见下面的数字）。PG 的 `shared_buffers` 早就把这张小表钉在内存里了——表扫描不是成本，**每次跳转那一次跨服务 HTTP 调用才是**（内网稳态 5–6ms、实例新连接那一下 70ms）。所以缓存只有一处该加：**FC 实例内存**。另建 Redis/Tair 是给一个能装进内存的 Map 再套一层网络往返，方向反了。

| 设计点 | 定案 | 依据 |
|---|---|---|
| 缓存层 | 跳转函数进程内的两个 `Map`（域名专属 key = `domain\|code`，全局 key = `code`），**全量常驻**，不做 LRU | 1 万条 838KB JSON、装好 0.58s，实例内存完全够；半缓存会把失效问题复杂化 |
| 失效依据 | 库里单行 `link_version.seq`；探针表 `probe_short_url` 上是 `after insert/update/delete for each statement`，**正式表 `short_url` 已改为行级 + `update of` 跳转列**（0007：语句级在 0 行更新时也会触发）；函数每 5s 轮询这一行，**只有 seq 变了才重拉全量** | 变更驱动，不是定时过期：正确性与 QPS 无关，1 QPS 和 10k QPS 的库压力都是「每实例每 5s 一次单行读」；实测传播延迟 4.46s（≤ 一个轮询周期） |
| 谁负责 bump | **触发器**，不依赖任何写入口自觉 | 控制台、REST、手工 SQL、以后的批量导入都自动生效；写入口漏 bump 就等于永久旧数据，这个风险不能留给人 |
| 命中后的库调用 | `resolve` 归零，只剩一次 inbox 写入 | 统计**不豁免**：他已定「统计必须逐次准确」，所以缓存命中仍然逐次入队（实测 inbox 每请求一行、`payload.cached=true`） |
| 未命中语义 | 快照就绪时「快照里没有」= **确实不存在**，直接 404 也不打库 | 快照是 `where enabled` 的全量；实测停用整个短码后 ≤5s 内变 404 且 `dur=0;cached=1` |
| 超阈值 | `CACHE_SNAPSHOT_LIMIT`（默认 2 万）只当**护栏**：超过就打一条日志、整体退回查库，不换模式 | 避免「悄悄退化成半缓存」；实测限到 1 时降级为 `cached=0` 的查库路径，跳转功能不受影响 |
| 拉取失败 | 保留旧快照继续服务，**绝不因为缓存抖动打 502**；未就绪时走查库路径 | 宁跳旧链不 5xx；服务先 `listen` 再异步首拉，首拉挂了不影响起进程 |

**明确否掉的失效方案**：LISTEN/NOTIFY（要长连接，实例冻结/回收就丢，FC 上不可靠）；写路径回调通知函数（多耦合，且 FC 实例可能已经没了）；每条带 `updated_at` 回库校验（等于没缓存）；Redis/Tair（独立计费产品，多一次往返）；CDN 缓存 302（命中即绕过函数，统计直接丢，与他「逐次准确」的要求冲突）。

**实测数字**（本机 → 线上库，10002 条时）：快照 RPC **838KB / 0.37–0.41s**；冷启动到快照就绪 **0.58s**；命中请求 `Server-Timing: resolve;dur=0;cached=1`（对比查库路径 5–6ms，新实例那一下 34ms）；探针表上一条 `insert ... select generate_series(1,10000)` 只让 seq +1（当时是语句级触发器；0007 改为行级后正式表批量写 N 行会 +N，不影响失效语义）。

**还没做**：① 正式表落地时把 `link_version` 的触发器挂到真表并改 `resolve` 走 `forward_query / 有效期` 判定；② 上线要配**最小实例数 ≥ 1**，否则新实例首个请求仍是查库 + 建连。部署方式已定：**手动打包上传 FC 代码**，自动化部署往后放（他 2026-11-06 明确不急）。

### 5.3 统计（近实时，秒级到分钟级延迟）
- `pg_cron` 每 1 分钟：从 `visit_inbox` 拉一批未处理行 → 批量插入 `visit` 明细 → 按 `(short_url_id, potential_bot)` 聚合成 ≤100 个 slot 的 UPSERT → 回写 `short_url.visits_count` → 标记 `processed_at`。**已实测**：cron 跑纯 SQL 函数即可（`select probe_drain_batch(500)` 连续 3 次 succeeded，单次 5–6ms），`for update skip locked` 可用，所以不需要 `pg_net`（本实例装不上）也能闭环。
- Bot 判定：UA 正则字典（存 `bot_pattern` 表），落库前打标，与 shlink 的 `potentialBot` 一致，展示时可切换是否含 Bot。
- 地理定位：**不在热路径**。IP 只存 `visitor_key`（加盐哈希；按他 2026-11-09 决定暂不配 salt，该列为 null），明细富化交给离线任务或后续 Edge Function，规避隐私和性能双坑。
- **客户端 IP 取法按入口分派**（实测，见项 18/19）：FC 自定义域名（短链跳转热路径）取 `x-forwarded-for` 首元素——这条链路没有 `x-real-ip`，`x-fc-client-ip` 为空；CDN→Supabase（控制台/数据面）取 `ali-cdn-real-ip`——那里 `x-real-ip` 与 `x-forwarded-for` 首元素都是 CDN 边缘节点 IP，用错口径会把成千访问聚合成几个节点。落库前统一在一处判定，别在每个函数里各写一套。
- 孤儿访问：与 shlink 同样保留 `base_url / invalid_short_url / regular_not_found` 三分类，用于后续接入新域名时回填历史。
- **落库任务顺带维护 `last_visit_at`**（死链判定的唯一依据，见 §5.4）：只有 `hit=true` 的访问才刷，且必须挑 `resolve` 会命中的那一行（域名专属优先、回落全局）——否则一条域名专属访问会把同码的全局行也刷脏，导致该清理的行永远清不掉。探针版已实装进 `probe_drain_batch`。

### 5.4 死链清理（2026-11-06 定案 B，探针版已上线并实测）

他的原话是给快照「设置一个阈值，定期将一些死链接进行清理」，定案走 **B：按「长期无访问」判定**，而不是去探测目标 URL 是否已 404 —— 后者需要函数出公网（现在绑了 VPC，还得配 NAT），且把跳转层和外部站点可用性耦合起来。三个参数由他拍：**180 天**无访问、清理后**回 404**、cron **自动跑但先 dry-run 出清单**。

| 环节 | 做法 | 为什么这样 |
|---|---|---|
| 判定依据 | `coalesce(last_visit_at, created_at) < now() - 180 days` | 不扫 `visit` 分区大表；`last_visit_at` 由已经在跑的落库任务顺手写，成本已付 |
| 清理动作 | `enabled = false` 软删，**不物理删** | 物理删牵住 `visit` 明细外键和历史趋势；软删可从清单里撤销，且快照只取 `enabled` 行 ⇒ 立刻瘦身 |
| 生效路径 | 那次 `update` 自动触发 `link_version` bump ⇒ 跳转侧 ≤5s 内变 404 | 完全复用 §5.2.2 的失效链路，清理不需要任何「通知函数」的代码 |
| 访问语义 | 已禁用短码 → **404 且不打库** | 与「快照里没有=确实不存在」同一条分支；他选了最诚实的一种 |
| 清单 | 每次运行（含 dry-run）写 `probe_prune_report`，`stale_days` 一并存 | 他能先看清「哪些会被清」再决定是否把 `p_dry_run` 改成 false |
| 调度 | `cron.schedule('probe-prune', '0 19 * * *', 'select probe_prune_dead_links(180, true)')` | **GMT 口径**，19:00 GMT = 次日 03:00 CST；jobid=5 已注册 |
| 并发安全 | 真禁用用 `for update skip locked` | cron 与人工编辑撞上时不互相等死 |

一处**语义细节**（实测出来的，不是 bug）：同一个短码在不同域名上是独立行，所以允许「域名专属那行还活着、全局那行因长期无访问被禁」。`/PriProbe1` 在 `s.probe.test` 上继续 302、在别的域名上 404 —— 这正是按行独立统计应有的结果，正式表落地后不要把它「修」成按短码全局清理。

实测数字（探针版，本机直连线上库）：dry-run 清单精确到「只列出 200 天那两行」，且**不动数据也不 bump seq**（seq 停在 18）；真禁用后 seq 19、快照 `rows 4→3`、目标码 **5.17s** 内变 404，同批未过期的码不受影响。代码与 DDL 见 [supabase/migrations/0003_dead_link_prune.sql](../supabase/migrations/0003_dead_link_prune.sql)。

### 5.5 地理富化（2026-11-10 定案，设计见 [geo-enrichment.md](geo-enrichment.md)）

不在热路径定位（§5.3）。跳转函数只把原始 IP 放进 inbox（`remote_addr`），drain 落库；**独立的事件函数**（双网络：VPC 连库 + 公网下 mmdb）由定时触发器每分钟驱动，拉未富化批次、用本机 GeoLite2 mmdb 查国家/省/市，回写 `visit` 后**清空 `remote_addr`**；7 天兜底清点由纯 SQL cron 负责。**不需要 NAT 网关**——FC 官方支持「允许访问 VPC=是 + 允许函数访问公网=是」双网（[配置网络](https://help.aliyun.com/document_detail/161919.html)），富化函数单独开双网，跳转函数保持现状不动。

---

## 6. 开工前必须验证的平台事实（P0，未过不启动编码）

| # | 验证项 | 方法 | 不通过时的退路 | 状态（2026-11-06） |
|---|---|---|---|---|
| 1 | CDN「重写访问 URL」是否支持正则捕获组透传短码 | 建一个测试域名 + 一个 echo 函数，curl 观察函数收到的 `req.url` | 短码放 query 由 CDN 固定映射；或改用 ESA / API 网关自定义路由 | ✅ **不再需要该能力**：跳转层换成 FC 自定义域名（路由 `/*` 兜底，短码留在 path）；CDN 侧实测也不改写路径（`cdn.example.com/functions/v1/probe/AbC123` → 函数看到 `pathname=/AbC123`，项 19） |
| 2 | 免 JWT 的 Edge Function 能否匿名 GET 返回 302 | 部署 `r` 函数，关 VERIFY JWT，curl -I | 跳转层改走函数计算 FC，Supabase 只做数据面（回到方案 B） | ❌ **半过**：免 JWT 公开 GET 成立（200，伪造 token 也放行）；**但 302 + `Location` 会被网关代替客户端跟随**，客户端收到跟随结果或超时（外部目标且未开公网出口）。→ 跳转层必须换方案，见 §6.1 |
| 2b | 平台对函数 3xx 的跟随行为能否关闭 | 提工单 | — | ⏳ 待工单（文档未提及该行为） |
| 3 | 跳转函数的超时/内存/并发上限与计费口径 | 压测 + 控制台观测 | 引入 301 边缘缓存，降低函数调用量 | 🟡 数值仍缺；FC 自定义域名上正式函数实测：复用连接 ttfb **28–32ms**、内部 `resolve` 8–11ms、50 并发 0 失败但 p50=539ms ⇒ **排队在单实例并发度**，配额要问工单 |
| 4 | `pg_cron` 能否调度批量物化 | 建一条 cron 跑 RPC 观察 | 批量物化改由纯 SQL 完成，不需要回调函数 | ✅ 过：连续 3 次 succeeded；本实例无需 `pg_net`（也装不上） |
| 5 | UNLOGGED 表支持与丢数据边界 | 建表实测 | 改普通表 + 定期分区清理 | ✅ 过：建表/写入/读回可用，约 0.1ms/次 |
| 6 | 单个项目能挂几个自定义域名、备案是否可用阿里云接入备案 | 控制台实操 + 提工单 | 收缩为「单域名 + 多路径前缀」，本期砍掉多域名 | 🟡 备案面已解除（主体在阿里云，`example.com` 与 `cdn.example.com` 同主域两条子域都能用）；**单项目/单账号可挂几个短链域名、泛域名是否逐条备案**仍待工单 |
| 7 | Edge Function 连库是走连接池还是每次新建（决定能否扛跳转 QPS） | 压测观察连接数 | 显式走 PgBouncer 模式 | ⏳ 函数侧未测；公网 RPC 侧 p50=24ms、20 并发 0 失败 |
| 8 | RPC 能否用 `security definer` 跑特权逻辑 | 建函数实测 | — | ❌ 平台禁用，已改为 invoker + GRANT/RLS 收口（见 4.1） |
| 9 | 新表对 `anon` 是否默认开放 | 权限字典 + anon key 实测写 | — | ❌ 默认给全套权限且 RLS 关闭，迁移脚本必须成带 RLS/REVOKE |
| 10 | 引擎是否为 MPP、DDL 能用哪些语法 | gp 目录表 + 特性标记逐个试 | — | ❌ 非 MPP；缺 `appendonly` / `nulls not distinct` / `returning old,new`；分区、生成列、MERGE、skip locked 可用 |

2026-11-06 复测结论：库侧与函数侧都跑完了，`functions-cli`（service role key 即可，不需要 AK/SK）负责部署。
**生死线已断在项 2 的后半段**：免鉴权公开 GET 可以，但 302 出不来——跳转层方案必须重选（§6.1）。

### 6.1 跳转层选型（2026-11-06 已把官方口径查实，方案排序随之改动）

**先记住一条官方原文**：函数计算的公告写着「如果您需要继续使用重定向跳转能力，请为函数绑定自定义域名」——即**「函数返回 3xx 做跳转」在阿里云是被支持的能力，只是禁止走 FC 默认公网域名 `*.<region>.fcapp.run`**（2025-04-01 起新建函数用默认域名触发外部 3xx 会被阻断，返回 400 `ExternalRedirectForbidden`：[公告](https://help.aliyun.com/zh/functioncompute/fc-3-0/product-overview/forbidden-to-use-the-default-public-network-domain-name-of-function-compute-to-redirect-to-the-outside-of-the-station)）。

**2026-11-06 项 2c-T1 已把这条从推测变成实测**：在同账号、同地域（cn-hangzhou）裸建一个 Web 函数（[fc/redirect-probe/index.js](../fc/redirect-probe/index.js)）、触发器改「无需认证」后，默认公网域名上 **302 的四种写法全部返回 `400 ExternalRedirectForbidden`**（含不带 Location 的裸 302 和相对 Location，比公告字面更宽），只有 `200 + Location` 能通但被强加 `Content-Disposition: attachment`。⇒ **C 方案的官方前提成立**；ADB Supabase 的 Edge Function 就跑在同一种运行时上，其「被跟随」症状与之同源（差异在跟随 vs 400，仍待工单定性）。

| 方案 | 做法 | 官方口径核实结果 | 结论 |
|---|---|---|---|
| ~~A. CDN 改写响应状态码~~ | 函数回 `200 + Location`，CDN 把状态改成 302 | ❌ **不成立**：CDN「重写访问 URL」只处理**请求** URL，文档全篇没有「改写源站响应状态码」的能力（[规则文档](https://help.aliyun.com/zh/cdn/user-guide/create-an-access-url-rewrite-rule)） | 出局 |
| ~~A'. 边缘函数自己造 302~~ | ESA/边缘函数返回 `Response.redirect(url,302)` | ❌ **同样被跟随**：ESA 原文「当边缘函数生成 302 重定向响应时，边缘节点自动代理客户端请求目标地址并返回最终内容」，且**未提供关闭开关**（[document_detail/2879081](https://help.aliyun.com/document_detail/2879081.html)） | 出局（可作工单对照：说明这是阿里云边缘的一贯设计，不是 ADB Supabase 独有 bug） |
| **C. 跳转层用「FC 函数 + 自定义域名」** | 新建一个 FC 函数（Node/Python 均可）做跳转，绑定短链自定义域名，内部调 Supabase 的 RPC/REST；Supabase 继续承担数据面 + 控制台 API | ✅ **2026-11-06 实测通过**：`example.com` 绑到同一个探针函数后，`http://…/r/AbC123` 返回**真 `302 + Location`**（无 400、无跟随、无 attachment），`host` 即短链域名、`pathname` 保留短码、`x-forwarded-for` 给真实客户端 IP；对照：同函数在默认公网域名上所有 3xx 一律 400 `ExternalRedirectForbidden` | **定案（待 HTTPS 证书复测）** |
| **D. 自建轻边缘** | 一台小 ECS 上 Nginx/Caddy（`return 302 $upstream_http_x_target`）或 Go，直连 Supabase REST | nginx 需显式配置才跟随，默认原样透传 | C 的备选（可控性最高，运维最重） |
| **B. 软跳转** | 函数回 `200 + HTML`（meta refresh / `location.replace`） | 传输链路已实测可透传 | 只在 C/D 都不批时的兜底，SEO 有可见损伤 |

顺带确认的两条：① CDN「回源 301/302 跟随」是**默认关闭**的开关（开启后节点代客户端请求 Location），所以配了 CDN 也不会额外吞掉跳转（[配置回源301/302跟随](https://help.aliyun.com/document_detail/281143.html)）；② CDN「重写访问 URL」有 **`Redirect`（默认，客户端可见 302）** 与 **`break`（内部改写回源路径，客户端 URL 不变）** 两种执行模式，项 1a 要用的是 `break`，而捕获组 `$1` 文档只在 `Redirect` 语境下写明支持 ⇒ `break` 是否支持捕获组仍须实测。

推荐动作顺序：**① T1 裸 FC 默认域名发 302**（10 分钟、免域名，定性归因）→ **② T2 同函数绑自定义域名复测**（备案主体已在阿里云，无等待期）→ **③ 提工单**（引用公告原文问 ADB Supabase 的 Edge Function 是否受同一策略约束、有无开关 + 函数配额计费 + 泛域名备案口径 + 可绑域名数量）；B 只作为演示兜底。步骤与判读表见 `docs/verification/p0-runbook.md` 第 5 节，探针代码 `fc/redirect-probe/index.js`。

### 6.2 域名备案：工信部已有备案号 ≠ 可直接用于阿里云（2026-11-06 官方口径）

结论：把短链域名绑到阿里云（ADB Supabase 的 CDN 回源、FC 自定义域名同理），要求的是**该域名在阿里云有备案/接入记录**，不是「工信部里查得到备案号」。若备案只挂在别的服务商名下，办的是**「新增接入」**——增加一个接入商，不是重新备案，也不影响原服务商的数据。

> **本项目现状（用户 2026-11-06 确认）**：短链域名的**备案主体就在阿里云**，域名可直接使用 ⇒ C/D 方案的**备案阻塞解除**，只剩证书、DNS 解析和管局记录里「这个域名本身是否在阿里云列内」的核对（缺这一步会在绑定时被校验拦住）。

| 事实 | 官方原文/口径 | 出处 |
|---|---|---|
| ADB Supabase / FC 绑自定义域名的前置条件就是「已在阿里云接入备案」 | 「准备一个已在阿里云接入网站备案的自定义域名」 | [配置自定义域名](https://help.aliyun.com/zh/functioncompute/configure-custom-domain-names)、本地存档 [custom-domain.md](../reference/adb-supabase/custom-domain.md) |
| 域名不在阿里云备案 ⇒ 必须在阿里云接入备案 | 「如果您的域名不是在阿里云备案，需要在阿里云接入备案」 | 同上 |
| 已在工信部备案也不豁免 | 「即使您的网站/App 已在工信部完成备案，仍然需要在阿里云按照流程完成新增接入的备案」 | [ICP备案流程](https://help.aliyun.com/document_detail/61819.html) |
| 是「增加一个接入商」，不是转出 | 「接入备案只是增加一个服务商，不会影响您上家服务商处的备案数据，可同时使用两家服务商的服务器」 | [接入备案FAQ](https://help.aliyun.com/zh/icp-filing/basic-icp-service/support/access-for-the-record-the-faq) |
| 只走 CDN 绕不开 | CDN 本身「备案信息可不接入阿里云」，但**警告**：「如果源站部署在阿里云，用于回源访问的域名需在阿里云完成新增接入，否则您的域名将会被阻断访问」——我们的源站（Supabase / FC）就在阿里云内地 ⇒ 仍需接入 | [备案服务器检查](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-server-access-information-check) |
| 备案要有一台「可备案服务器」拿服务码 | 「接入备案需要使用阿里云服务器吗？需要使用。」可备案清单含 ECS/轻量/云虚拟主机（均要求中国内地 + 包年包月且累计购买时长 ≥3 个月，ECS 还需公网带宽）；**函数计算套餐包也在内**：「订单金额100元及以上」「包月3个月及以上」= 1 个免费服务码 | [备案服务器及接入信息确认排查](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-server-access-information-check?#1a453ea1210z7)、[接入备案FAQ](https://help.aliyun.com/zh/icp-filing/basic-icp-service/support/access-for-the-record-the-faq) |
| SLB/ALB/ACK 不能直接备案 | 「负载均衡（SLB/NLB/ALB）、容器服务 ACK、容器计算服务 ACS 等不属于可备案的云产品，不能直接申请备案服务码」 ⇒ §6.1 里「FC + ALB 前置」的变体备案时要挂靠别的 ECS 服务码 | 同上 |
| 免备案的唯一出路是换地域 | 「中国香港和海外地域的函数绑定的自定义域名不需要备案」 | [配置自定义域名](https://help.aliyun.com/zh/functioncompute/configure-custom-domain-names) |
| 解析切换时机 | 「接入备案期间建议保持域名解析指向原接入商服务器，待管局审核通过、备案信息成功接入阿里云后再将域名解析切换」；提前切会被阻断 | [接入备案FAQ](https://help.aliyun.com/zh/icp-filing/basic-icp-service/support/access-for-the-record-the-faq) |

**周期（工单排期用）**：阿里云初审 **1～2 个工作日** →（提交管局再 1～2 个工作日）→ 工信部短信核验（收到验证码 **24 小时内**在工信部系统提交）→ 管局审核 **1～20 个工作日**、官方明确「管局审核阶段无法加急」。付费的「备案智能助理」只把初审压到 2 小时内，管局时长不变（[步骤二：阿里云初审](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/the-icp-record-review)、[ICP备案流程](https://help.aliyun.com/document_detail/61819.html)）。另：工信部备案成功后需在**开通之日起 30 日内**补**公安联网备案**（[ICP备案流程](https://help.aliyun.com/document_detail/61819.html)）。

**对选型的影响**：C 方案（FC 函数 + 自定义域名）在备案上不比「Supabase + CDN」更贵——两边都要求域名在阿里云有接入记录；而且 FC 资源包直接送服务码（官方原话：「单次购买函数计算资源包订单金额100元及以上，即可获得免费的ICP备案服务码」），不用为一台 ECS 单独掏钱。真正的成本是**日历时间**：管局审核 1～20 个工作日且「管局审核阶段无法加急」，多域名基本等于多次接入登记（**泛域名 `*.example.com` 能否只备主域一条尚未查实**，见 §6.3）。若想立刻跳过备案，只有「中国香港/海外地域的函数 + 自定义域名不需要备案」这一条路，代价是内地用户首字节延迟。

### 6.3 C 方案顺带解掉的三处旧阻塞（2026-11-06 查实，[配置自定义域名](https://help.aliyun.com/zh/functioncompute/configure-custom-domain-names)）

| 旧阻塞 | FC 自定义域名的官方能力 | 结果 |
|---|---|---|
| Edge Function 只能按 `/functions/v1/{name}` 访问、**平台不支持自定义路由**，短码必须靠 CDN 重写塞进 query | 「路由设置页面以表格形式管理路由规则，每条规则包含**路径**、**函数名称**、**版本或别名**和**重写策略**字段」，示例给了 `/test1` 映射函数 + **`/*` 作为兜底路径** | **§3 的 CDN 重写依赖整段消失**：`https://s.example.com/AbC123` 直接进函数，短码留在 path 上，项 1a 不再是架构阻塞 |
| 每个短链域名都要一套 CDN 域名 + 回源 HOST + CNAME | 「支持**单域名**或**通配符域名**（例如 `*.aliyun.com`）」；且 CDN 可选项写明「**自定义域名和加速域名不能使用同一个域名**」⇒ 跳转层直出，不需要 CDN | 多域名的运维面可能从「N 套 CDN 配置」降到「一条泛域名配置」——但**泛域名是否需要逐条备案未查实**（备案与互联网信息服务是按域名登记的），要问工单 |
| 函数内部看不到真实域名，依赖 CDN 传 `x-forwarded-host` | 域名直达函数，`Host` 头本身就是短链域名 | 项 1b 的多域名归属判定难点被绕开——**已实测**：FC 自定义域名上 `host=example.com`；反过来若走「CDN→Supabase」，函数看到的 `host` 仍是 FC 触发域名，只有 `x-forwarded-host` 是真实短链域名（项 19） |

**已实测（2026-11-06，同一函数 [fc/redirect-probe/index.js](../fc/redirect-probe/index.js)）**：T1 裸 FC 默认公网域名 → **四种 3xx 全部 400 `ExternalRedirectForbidden`**，200 带 `Location` 能过但被强加 `content-disposition: attachment`（项 16/17）；T2 绑自定义域名 `example.com` → **客户端收到真 `302 Found` + `Location`**，`host` 与 `pathname` 都是短链自己的值（项 18）。⇒ 方案 C 的三个环节全部闭合，跳转层定案。跑法与判读表在 [p0-runbook.md 第 5 节](verification/p0-runbook.md)。

### 6.4 域名配置分工（控制台入口，2026-11-06 定案后）

**ADB Supabase 控制台里没有「自定义域名」这个表单** —— 官方唯一的配置方式是在 **CDN 控制台**加加速域名回源到 Supabase 项目域名（[如何为AnalyticDB Supabase项目添加自定义域名](https://help.aliyun.com/zh/analyticdb/analyticdb-for-postgresql/support/how-to-add-a-custom-domain-name-for-an-analyticdb-supabase-project)，本地存档 [custom-domain.md](../reference/adb-supabase/custom-domain.md)）。所以按用途分三处配，别配错地方：

| 域名用途 | 配在哪 | 关键配置 | 现状 |
|---|---|---|---|
| **短链跳转域名**（`/{code}`，本期主战场） | **函数计算控制台 > 函数管理 > 域名管理** | 路由 `/*` 兜底 → 跳转函数；同地域；泛域名官方支持 | `example.com` 已配好并实测出真 302 |
| **Supabase 数据面/控制台 API 域名**（给 `supabase-js`、OAuth 回调、Storage 外链用） | **CDN 控制台 > 域名管理 > 添加域名**（AnalyticDB 侧无入口） | 源站=Supabase 项目域名、端口 443、**回源 HOST 选「源站域名」**、首次要 DNS TXT 归属验证、DNS 加 CNAME | ✅ `cdn.example.com` 已配好并实测：HTTP 回源 200、路径不改写、`x-forwarded-host` 为真实域名、REST 经 CDN 0.22s（项 19）。⚠️ CDN 侧未挂证书 ⇒ HTTPS 握手失败；⚠️ 该链路 3xx 照样被吞 |
| 前端页面自己的域名 | 任意静态托管（与本选型无关） | — | 未定 |

**判断要不要配第二行**：只要用到 Web OAuth 回调（微信/支付宝）或想让前端不写死 `spb-xxxx.supabase.co`，就该配一条给 API 用（建议单独子域，如 `api.example.com`）。**但短链域名绝对不要指向这条 CDN**——项 2b 已实测「CDN → Supabase Edge Function」这条路 3xx 照样被吞，配了 CDN 只会多一层 `x-forwarded-host`/真实 IP 覆盖的坑。两条链路的分工就是：**跳转走 FC，读写走 Supabase（可套 CDN）**。

---

## 7. 从 shlink 迁移的能力清单

> 本节只留结论。功能全景（含每项的 shlink 证据 `文件:行`）、终端清单、26 个 REST 路由与 31 个 CLI 命令的逐条归属、12 张表的取舍、68 个 env 的去向、分期准备清单与待拍决策，在 [docs/shlink-migration-analysis.md](shlink-migration-analysis.md)。**按什么顺序做、每轮验收标准、整体进度**在 [docs/iteration-plan.md](iteration-plan.md)（I0–I6）。

| shlink 做法 | 我们 | 理由 |
|---|---|---|
| slot 打散的 `short_url_visits_counts` UPSERT | ✅ 照搬 | 消除计数单行热点；实测 100 次写散到 72 个 slot |
| `long_url_hash` 索引做同链查重 | ✅ 照搬 | 一次索引查代替全表扫，`find_if_exists` 的性价比来源 |
| 自定义 slug 撞库报 409、随机码撞库重试 | ✅ 照搬 | 语义正确且用户可预期 |
| 有效性三元组 `valid_since/valid_until/max_visits` + `isEnabled()` | ✅ 照搬 | 短链生命周期的最小完备集 |
| 孤儿访问三分类 | ✅ 照搬 | 多域名场景回填历史的关键 |
| 域名专属短码 > 全局短码的单查询优先级 | ✅ 照搬 | 多域名语义的核心 |
| `SELECT FOR UPDATE` 防并发重码 | 🔁 换成 advisory xact lock | 锁按短码分桶、不随行扫描，实测 `pg_advisory_xact_lock` 可用 |
| `LOWER(shortCode)` 大小写不敏感匹配 | 🔁 换成入库统一小写 | shlink 自己标注为性能坑（repository:39 FIXME） |
| 多 DB 方言分支（PG/MySQL/SQLite/SQLServer） | ❌ 全砍 | 只有 PG 一个目标 |
| RoadRunner / RabbitMQ / Redis pub-sub / Mercure | ❌ 全砍 | 事件通道用 pg_cron + inbox 表替代 |
| 每次跳转同步 INSERT visit | ❌ 不做 | 与「批量异步落库」决策冲突：同步写会把 24ms 的往返翻倍，且崩一次就丢一次跳转 |
| Mezzio 三层模块（Core/Rest/CLI） | ❌ 不照搬 | 那是 PHP 的组织方式；我们的对应物是 SQL/RPC 层 + 函数层 |
| 自研 API Key + Specification 数据可见性 | ~~🔁 换成 Auth + RLS~~ → **⚠️ 两套并存（2026-11-09 因复用 web-client 改定）**：兼容层照 shlink 建 `api_key` + 角色作用域（函数内过滤），Auth + RLS 留给将来小程序/直连 | 界面只认 `X-Api-Key`；兼容层持 `service_role` 直连 ⇒ 这条路上 RLS 不构成防线，作用域过滤必须在函数内重做一遍 |

---

## 8. 仓库结构（草案）

```
rxlink/
├── shlink/                      # 参考实现，只读，已建 codegraph 索引
├── fc/
│   └── redirect/                # 跳转层（FC Web 函数，零依赖）
│       ├── index.js             # 热路径：path→短码、Host→域名、302、统计入队
│       └── cache.js             # 映射快照 + seq 轮询失效（§5.2.2）
├── supabase/
│   ├── migrations/
│   │   ├── 0001_p0_probe.sql    # P0 验证用（probe_ 前缀，验完删除）
│   │   ├── 0002_link_cache_version.sql  # link_version + bump 触发器 + 快照/seq 函数（已上线）
│   │   └── 0003_dead_link_prune.sql     # last_visit_at + 软删清理 + 清单表 + cron（已上线）
│   ├── functions/
│   │   ├── probe/               # P0 探针：公开 GET / 302 / 路径与头部回显（验完删除）
│   │   ├── probe-db/            # P0 探针：延迟分位 / 并发 / 扩展可用性（验完删除）
│   │   ├── r/                   # 跳转（免 JWT，只读）
│   │   ├── short-urls/          # 创建/编辑/删除
│   │   ├── visits/              # 统计查询
│   │   └── _shared/             # cors、载荷校验、错误码
│   └── tests/
├── scripts/
│   └── verify-p0.sh             # 一键跑 P0 判定，输出 PASS/FAIL/SKIP
├── web/                         # React + Vite + supabase-js 控制台
└── docs/
    ├── tech-framework.md        # 本文件
    ├── shlink-migration-analysis.md  # shlink 功能/终端/接口全景 + 迁移准备清单（§7 的展开）
    ├── reference/adb-supabase/  # 官方文档存档（平台事实依据）
    └── verification/            # P0 runbook + 结果登记
```

约定：schema 变更只走 `supabase/migrations/` 编号文件，用阿里云 Supabase CLI 管理项目与部署函数；不在 Dashboard 里手改线上结构。

---

## 9. 本期不做（明确出界）

- 二维码、Link-in-bio、A/B 落地页、密码保护短链
- 微信小程序端（复用同一套 API，后续接入）
- 实时推送（Realtime）与第三方分析对接（Matomo 类）
- 多地域部署
