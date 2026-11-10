# ADB Supabase 官方文档存档索引

存档日期：2026-10-28 ｜ 抓取方式：Qoder WebFetch 拉取 help.aliyun.com 渲染正文
用途：短链平台开发的平台事实依据（source of truth）。**判断「平台能不能做某事」先查这里，不要套用开源 Supabase 的经验。**

正文按主题拆分在同级目录：

| 文件 | 对应官方文档 | 我们为什么需要它 |
|---|---|---|
| [edge-functions.md](edge-functions.md) | [在AnalyticDB Supabase中使用边缘函数](https://help.aliyun.com/zh/analyticdb/analyticdb-for-postgresql/using-edge-functions-in-analyticdb-supabase) | 跳转热路径与所有写接口的运行时；JWT 开关、Secrets、functions-cli |
| [custom-domain.md](custom-domain.md) | [如何为AnalyticDB Supabase项目添加自定义域名](https://help.aliyun.com/zh/analyticdb/analyticdb-for-postgresql/support/how-to-add-a-custom-domain-name-for-an-analyticdb-supabase-project) | 多域名短链的域名/备案/CDN/证书路径 |
| [pg-cron.md](pg-cron.md) | [定时任务（pg_cron）](https://help.aliyun.com/en/analyticdb/analyticdb-for-postgresql/user-guide/use-the-pg-cron-extension-to-configure-scheduled-tasks) | 访问日志批量物化与计数的调度器 |
| [project-access.md](project-access.md) | [Supabase 使用指南](https://help.aliyun.com/zh/analyticdb/analyticdb-for-postgresql/supabase/) | 项目创建、API Keys 获取、REST/Auth 调用、PG 直连、白名单 |
| [commercialization.md](commercialization.md) | [【通知】AnalyticDB PostgreSQL版Supabase商业化](https://help.aliyun.com/zh/analyticdb/analyticdb-for-postgresql/product-overview/notice-analyticdb-postgresql-supabase-is-commercialized) | 免费版/付费版边界，规格与升配 |

## 一眼看完：对本项目有决定性影响的平台事实

1. **Edge Function 只能通过 `https://<项目域名>/functions/v1/{函数名}` 访问，文档中不存在自定义路由能力。** 短链根路径 `/{shortCode}` 必须靠 CDN 层重写实现 → 见 P0 验证项 1。实测补充：重写到 `/functions/v1/{函数名}/{短码}` 即可，函数能拿到多级 path（下面第 9 条）。
2. **部署时可以关 JWT 校验**：`functions-cli deploy hello --no-verify-jwt`，或 Dashboard 函数 Settings 里的 VERIFY JWT 开关 → 实测（2026-11-06）**免鉴权公开 GET 成立**；但**公开返回 302 不成立**，见下面实测补充第 8 条。
3. **自定义域名的前提是「已备案 + 已开通 CDN」**，做法是 CDN CNAME 回源到 Supabase 项目域名、回源 HOST 设为源站域名、HTTPS 证书配在 CDN 侧；且官方明确提示单域名可能还要同时配主域和 www 子域 → 多域名是每域一套备案+证书+CDN 的工作量。
4. **函数要访问公网 API 或导入第三方依赖，必须先给项目开通公网访问**；纯查库不依赖公网。⇒ 实测印证：跳转目标为外网绝对 URL 时函数响应直接挂住（未开公网出口）。
5. **pg_cron 默认安装且不可卸载，所有作业按 GMT 调度，作业存于 `postgres` 库**；`cron.schedule(name, schedule, command, database, user, active)` 支持指定目标库与执行账号；文档只提供 SQL 命令形态的作业，**没有提到 HTTP 调用能力** → 实测：纯 SQL 作业跑通（连续 succeeded），`pg_net` 装不上所以库内 HTTP 本来就没有。
6. **2025-12-11 起商业化**：免费版 1C2G 明确「仅用于开发测试，请勿在生产环境使用」，付费版才支持升降配、OSS 存储、imgproxy。
7. **默认 Secrets** 里同时有 `SUPABASE_URL`（公网网关）和 `SUPABASE_LOCAL_URL`（本地网关，不走公网、延迟更低）→ 实测：本项目 `Deno.env` **只有 `SUPABASE_URL`，没有 `SUPABASE_LOCAL_URL`**，文档这条承诺不成立，函数连 REST 只能走公网网关域名（实测延迟 p50≈15ms，可接受）。
8. **2025-08-27 之后创建的项目支持标准 PostgreSQL 直连**（psql/JDBC/DBeaver），默认端口 5432，需配白名单 → 实测本机走的是更省事的 `supabase db query --db-url "$SUPABASE_DB_URL"`（无需装 psql，但一次只认一条语句）。
9. **Auth 提供 `PATCH /auth/v1/modify/settings` 运行时改配置**，需 service role key 同时放在 `Authorization` 与 `apikey` 两个 header。

## 实测补充（2026-11-06 库侧 + 同日函数侧，来源：`docs/verification/p0-results.md`）

官方文档没写、但会直接改变设计的 12 条：

1. **平台禁止 `SECURITY DEFINER`**：建函数即 `SECURITY DEFINER functions are not allowed (42501)`，建函数时还会看到 `WARNING: Skipping Event Trigger`（平台用事件触发器做管控）。所有 RPC 只能以调用者身份跑。
2. **新表对 `anon`/`authenticated` 默认开放全部权限**（`alter default privileges` 造成，含 TRUNCATE），RLS 默认关闭 —— 实测 anon key 能直接往新表 INSERT。RLS + policy 经 PostgREST 生效也已实测成立，所以这不是坏消息，是必须做的收口。
3. **这个实例不是 MPP**：`version()` 报 PostgreSQL 17.5，但没有 Greenplum 目录表/专有函数，`with (appendonly=true)` 被拒。语法上还缺 PG15/16 特性（`unique ... nulls not distinct`、`returning old/new`、`hex()`），而 MERGE、分区表、生成列、`create index concurrently`、`for update skip locked`、advisory lock 都可用。
4. **`pg_net` 装不上**：available 清单里有 0.14.0，但 `create extension pg_net` 报「has no installation script nor update path」⇒ 库内发不了 HTTP，pg_cron 只能跑纯 SQL（对我们够用）。
5. **前置网关是 Kong，且 `--no-verify-jwt` 是 per-function 生效**：不存在的函数名无 Authorization 仍 401 `Missing authorization header`（鉴权在路由之前）；但部署成免 JWT 的函数后，**无 Authorization 和伪造 `Bearer garbage` 都返回 200** ⇒ 业务函数不能把鉴权托付给网关，写接口必须自己校验 token。
6. **pg_cron 实测可用且就在 `postgres` 库**：`cron.schedule(...)` 成功、`cron.job_run_details` 有 succeeded 记录；`TimeZone` 参数是 GMT，但 run_details 的时间戳按 CST 显示。
7. **工具链**：`supabase db query --db-url` 可直连跑 SQL（本机无需 psql），但**一次只认一条语句**（prepared statement）；`db push` / `supabase functions deploy` 需要阿里云 AK/SK；`-o table` 渲染 `numeric` 是乱码，要 `::text`。**拿不到 AK/SK 时，官方 `functions-cli` 只要 `SUPABASE_API_URL` + service role key 就能部署/列出/删除函数与 secrets** —— 本项目实际用的就是这条通道。
8. **⚠️ 网关会代替客户端跟随函数的 3xx 跳转**：只要响应是 3xx **且**带 `Location`，客户端就收不到跳转 —— 目标是相对/内部路径时，客户端拿到「被跟随之后的内容」（探针 echo 自己）；目标是公网 URL（连本项目自己的网关域名也算）时，连接一直挂着直到客户端超时（HTTP/1.1 与 HTTP/2 一致）。对照实验：302 不带 Location → 302 原样返回；200 带 Location → 200 + `location` 头原样透传；同一份函数代码在本机 Deno 2.9.7 下返回标准 `302 Found` + `Location`，说明代码无关。跟随者是平台组件：Location 指向 `http://edge-fc-*.cn-hangzhou-vpc.fcapp.run/...` 时，客户端收到的是 **FC 网关的 400** `Authorization header is expected but missing`（连状态码都是跟随结果）。**这条直接否掉了「Edge Function 直接返回 302」的短链热路径设计**，且官方文档全文没有提到 3xx/重定向相关的任何说明。
9. **`/functions/v1/{name}` 之后的多级 path 会交给函数**：`GET /functions/v1/probe/AbC123` ⇒ 函数侧 `pathname=/AbC123`、`path_segments=["AbC123"]`、`x-forwarded-path=/functions/v1/probe/AbC123`；query 完整透传。所以短码放 path 可行，不必退化成 `?c=`。
10. **secrets 以 `x-edge-env-*` 请求头注入函数**（`supabase_url` / `anon_key` / `service_role_key` / 带明文口令的 `supabase_db_url`）：客户端伪造同名头会被平台覆盖（注入不了），但**函数一旦回显或记录请求头就等于泄漏凭据**。另外文档承诺的默认密钥 `SUPABASE_LOCAL_URL` 在本项目不存在，函数只能走公网网关域名连 REST。
11. **函数并发是隐性瓶颈**：纯响应（不碰库）50 路并发失败 0，但 p50 从 36ms 涨到 405ms、p95 718ms ⇒ 单实例并发度很低，扩容跟不上；配额数值文档未给，需工单。
12. **部署两处不可靠**：`functions-cli deploy` 偶发 500 `Failed to deploy Deno function`（函数留 `status FAILED`，立即重试即成功）；新 bundle 上线后短时间内**新旧代码混跑**，验证脚本必须先轮询构建标记再判定，否则会把旧实例行为当成平台结论。

## 尚未从文档得到答案、必须实测的项

见 `docs/tech-framework.md` 第 6 节的 P0 清单。**库侧项（4/5/7/8/9/10）本轮已实测完**；仍缺的是函数侧与控制台侧：项 1（CDN 重写 + `x-forwarded-host`）、项 2（免 JWT 函数公开 GET + 302）、项 3（函数超时/内存/并发上限与计费口径）、项 6（单项目可挂几个自定义域名）。其中项 1/2/3 全部卡在「把 probe 函数以 `--no-verify-jwt` 部署上去」这一个动作上。
