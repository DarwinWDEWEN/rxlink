# P0 可行性验证 runbook

目的：在写任何业务代码之前，用最小探针确认 AnalyticDB Supabase 能不能支撑我们定的架构（见 `docs/tech-framework.md`）。
判定标准只有一条：**项 2 不过，整套「Edge Function 承接跳转」的方案作废，回到「CDN/FC 承接跳转 + Supabase 只做数据面」。**

## 0. 准备（已完成，仅备查）

> 进度（2026-11-06）：**库侧 + 函数侧全部跑完并登记**（见 [p0-results.md](p0-results.md)）。函数用 `functions-cli` 以免 JWT 方式部署（第 1 节）。
> 结果：**项 2a PASS，项 2b FAIL** —— 网关会代替客户端跟随函数的 3xx + `Location`，所以「Edge Function 直接返回 302」的原方案不成立，跳转层要重新选型（`docs/tech-framework.md` §6.1）。
> 脚本还能测的只剩项 1（需要一个已备案测试域名 + CDN 重写规则）；其余（项 6、3c、跟随行为能否关闭）只能控制台/工单。

| 需要 | 从哪拿 |
|---|---|
| `SUPABASE_API_URL` / 项目网关域名 | 控制台 Supabase 列表 → **App Frameworks** 弹窗，或 `操作` → **登录 Dashboard** → **跳转** 后的 URL |
| anon key / service role key | Dashboard 左侧 **Authentication** 页；或 **API Docs > Introduction > Bash** 里选 `service_role(secret)` |
| PG 直连串 | 项目 `操作` → **修改白名单** 加本机公网 IP → `操作` → **重置数据库密码**；端口 `5432`（2025-08-27 后创建的项目才支持直连） |
| 阿里云 AccessKey（只有 CLI 部署函数 / 推送 migration 才需要） | RAM 控制台 → 填进 `.env` 的 `ALIYUN_ACCESS_KEY_ID` / `ALIYUN_ACCESS_KEY_SECRET` |

免费版限制记住：1C2G、云盘 1 GB 不可扩容 → **只验证，不压测量级数据**。

配置统一填在 **`supabase/functions/.env`**（已被 `.gitignore` 排除，别提交；模板见同目录 `.env.example`）：

```bash
SUPABASE_API_URL=https://sbp-xxx.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SUPABASE_DB_URL=postgresql://postgres:<密码>@<IP>:5432/postgres
PROBE_DOMAIN=            # 配好 CDN 测试域名后再填
```

### 工具链实测口径（省得再踩）

- 本机**没有 psql**，也不需要：直连走已装好的阿里云 Supabase CLI —— `supabase db query --db-url "$SUPABASE_DB_URL" -o table "<SQL>"`。
- `db query` 用 prepared statement，**一次只认一条语句**（`-f` 同样，多语句直接 `SQLSTATE 42601`）；整份 migration 要按语句切分逐条执行。
- `supabase db push` / `supabase functions deploy` 走阿里云 OpenAPI，**必须有 AK/SK**，只填 URL + key 不够。
- 输出渲染坑：`numeric` 在 `-o table` 下显示成 `{0 0 2 false none}` ⇒ 取数值要 `::text`；返回 `void` 的函数不能直接扫（`unknown oid 2278`）⇒ 写成 `select (pg_advisory_xact_lock(1) is null)`。

## 1. 部署两个探针函数（已完成：走 B 路，两个函数都 ACTIVE + verify_jwt=false）

**必须先关 JWT**，否则测不出「公开访问」这一关键事实。三条路按省事排序：

**A. 控制台粘贴（不需要任何额外凭据）**
Dashboard → **Edge Function > Functions > Deploy a new function > Via Editor**：函数名 `probe`，把 `supabase/functions/probe/index.ts` 粘进去部署；同样再来一个 `probe-db`。部署后在函数 **Settings** 里关掉 **VERIFY JWT**。

**B. `functions-cli`（本轮实际使用，AK/SK 拿不到时的唯一通道）**

```bash
set -a; source supabase/functions/.env; set +a
export SUPABASE_API_URL="${SUPABASE_API_URL:-$SUPABASE_URL}" SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY"
./functions-cli deploy probe    --no-verify-jwt
./functions-cli deploy probe-db --no-verify-jwt
./functions-cli list            # 必须确认 status==ACTIVE
```

- **认证变量名是 `SUPABASE_API_KEY`，值要放 service role key**；写成 `SUPABASE_SERVICE_ROLE_KEY` 会报「必须设置 API Key」。
- **部署必须在仓库根目录执行**（它按 `./supabase/functions/<name>/index.ts` 找代码）。
- 偶发 HTTP 500 `Failed to deploy Deno function`（FC control plane），函数会留在 `status FAILED` ⇒ **原样重试一次即可**，不用改代码。
- **新 bundle 上线后短时间内新旧代码混跑**（实测几秒内交替命中）。探针里放了 `build` 字段（当前 `r2`），判定前先 `curl ".../functions/v1/probe?echo=1" | grep build` 轮询到新版本，否则会把旧实例行为当成平台结论。

**C. 阿里云 Supabase CLI**（`--no-verify-jwt` flag 实测存在，但需要 AK/SK）

```bash
supabase functions deploy probe    --no-verify-jwt
supabase functions deploy probe-db --no-verify-jwt
```

- functions-cli 下载地址见 [adb-supabase/edge-functions.md](../reference/adb-supabase/edge-functions.md)（本机 Apple Silicon 取 `functions-cli-darwin-arm64-2026-03-17`，本轮存在 `/tmp/functions-cli`）。
- 报错 `At least one file is required` → 控制台项目 `操作` > `更多` > **升级版本** 后重试。

部署后的两条事实（已实测）：

- `--no-verify-jwt` **确实是 per-function 生效**：免 JWT 函数无 Authorization 返回 200，伪造 `Bearer garbage` 也 200；不存在的函数名仍然 401。⇒ 网关只做「这个函数要不要验签」，业务函数自己鉴权。
- **`302 + Location` 被网关跟随掉**（项 2b FAIL）；探针的 `mode=` 响应矩阵是定位这个行为的关键工具，见 `docs/verification/p0-results.md` 项 2b。

## 2. 跑数据库侧 migration（已完成：11 条语句 0 失败）

```bash
supabase db query --db-url "$SUPABASE_DB_URL" -o table "<单条语句>"   # 逐条；或整份粘进 Dashboard SQL Editor
```

`supabase/migrations/0001_p0_probe.sql` 本轮改过三处，都是被平台逼的：

- **`security definer` 被禁用**（`SQLSTATE 42501`）⇒ 所有函数改 `security invoker`。
- `CREATE OR REPLACE` **不能改返回列签名** ⇒ `probe_resolve` 前先 `drop function if exists`。
- 域名优先级不能靠 `rank() over (...) + limit 1`（取哪行不确定）⇒ 改 `order by (domain = p_domain) desc limit 1`。

复核口径（可重复执行）：

```sql
select jsonb_pretty(probe_env_report());              -- pg_cron 已装；pg_net 装不上
select * from probe_resolve('AbC123','s.probe.test'); -- 期望 from-domain
select * from probe_resolve('AbC123','');             -- 期望 from-global
select probe_drain_batch(100);                        -- skip locked 批量物化
select probe_time_writes(200);                        -- 服务端写吞吐（实测约 0.1ms/次）
```

pg_cron 的调度证据：`select cron.schedule('probe-drain','* * * * *','select probe_drain_batch(500)')` → jobid=4，`cron.job_run_details` 里 succeeded ×3（单次 5–6ms），验后已 `cron.unschedule('probe-drain')` 复原。

## 3. 跑验证脚本

```bash
bash scripts/verify-p0.sh
```

脚本会自动从 `supabase/functions/.env` 读 `SUPABASE_API_URL` 与 `PROBE_DOMAIN`，无需手动导出。

脚本覆盖项 1、2、3、7 的**函数侧**用例（部署完才有意义），输出 `[PASS]/[FAIL]/[SKIP]` 与延迟分位数。项 4/5/8/9/10 属库侧，已在第 2 节与 results 登记，不在脚本里；项 6（域名能挂几个）是控制台实操 + 工单，脚本测不了。

## 4. CDN 相关（项 1）——已完成（2026-11-06 `cdn.example.com`）

> **2026-11-06 已实测完成（`cdn.example.com`，CDN 回源项目域名）**，四个观察点结论如下，数字全文见 [p0-results.md](p0-results.md) 项 1a/1b 与硬约束 19/20。下面原始「重写规则候选」那套**没有执行**：跳转层定案为 FC 自定义域名后，「CDN 改写路径喂 Edge Function」不再是判定项。
>
> | 观察点 | 结论 |
> |---|---|
> | ① 302 能否原样回客户端 | ❌ 依旧被吞：`s302&loc=ext` 超时 000、`s302&loc=rel` 回 200 echo（被跟随）、裸 302 透传 ⇒ **短链域名绝不指向这条 CDN** |
> | ② `path_segments` 能否看到原始 `/AbC123` | ✅ 能，且 CDN **不改写路径**：`pathname=/AbC123`、`x-forwarded-path=/functions/v1/probe/AbC123` |
> | ③ `x-forwarded-host` 是否真实短链域名 | ✅ 是 `cdn.example.com`（但 `host` 仍是 FC 触发域名 ⇒ 多域名归属只认 `x-forwarded-host`） |
> | ④ `x-real-ip` 是否变成 CDN 节点 IP | ⚠️ **是**：`x-real-ip` 与 `x-forwarded-for` 首元素都是边缘节点 IP，真实客户端 IP 要改读 **`ali-cdn-real-ip`** |
>
> 附带结论：REST 经 CDN 可用（`/rest/v1/probe_short_url` + anon key → 200 / 0.22s），HTTPS 因未挂证书握手失败（`sslv3 alert handshake failure`），以及「探针 echo 分支会把 `x-edge-env-*` 与 `x-fc-access-key-*` 原样送回客户端」这条安全问题（硬约束 20）。

## 5. 项 2c：FC 侧对照实验（定性归因，免备案就能做）

> **2026-11-06 已完成 T1 + T2（HTTP）**：T1 在默认公网域名上四种 3xx 全回 `400 ExternalRedirectForbidden / please use custom domain endpoint`；T2 绑 `example.com` 后 `http://example.com/r/AbC123` 拿到**真 302 + Location** ⇒ 方案 C 成立。唯一剩余复测项是 HTTPS（证书还没挂，当前回 `*.fc.aliyuncs.com` 默认证书）。数字与判读见 `p0-results.md` 项 2c-T1/T2 与硬约束 17/18，下面步骤保留备查。

目的：把「Supabase 网关自己代客户端跟随」与「函数计算的默认公网域名跳转策略」这两条不同的机制分开。方案 C（FC 函数 + 自定义域名）成立与否全押在这上面，所以**先花 10 分钟做 T1，再决定要不要为一个域名等 1～3 周的管局审核**。

### T1：裸 FC 函数 + 默认公网域名（不需要域名、不需要备案、不需要 CDN）

1. 函数计算控制台 → **函数管理 > 函数列表 > 创建函数** → 选 **Web 函数**，地域**与 Supabase 项目同区（cn-hangzhou）**；运行环境选内置 **Node.js**，启动命令 `node index.js`，**监听端口 9000**（Web 函数不填「请求处理程序」；官方口径见 [Web 函数](https://help.aliyun.com/zh/functioncompute/fc-3-0/user-guide/web-functions)：HTTP 服务必须监听 `0.0.0.0` 与配置的端口）。
2. 代码直接用仓库里的探针（无第三方依赖，控制台 WebIDE 粘贴即可）：[fc/redirect-probe/index.js](../../fc/redirect-probe/index.js)。它同时覆盖四件事：`/r/{code}` → 真 302、`?mode=sNNN&loc=ext|rel` → 响应矩阵、默认路径 → **回显全部请求头**（用来看 `host` / `x-forwarded-*` / 真实客户端 IP / `x-fc-request-id`），并带 `build` 标记。`Location` 只取自固定的 `TARGETS` 表，探针本身不会变成开放重定向。
3. 部署后在函数详情 > **触发器/域名** 里复制**默认公网域名**（`*.cn-hangzhou.fcapp.run` 形态），逐条复测（**全部不要加 `-L`**）：
   ```bash
   D=https://<fc默认公网域名>
   curl -i --max-time 20 "$D/r/AbC123"                    # 生死线：默认域名能不能出 302
   curl -i --max-time 20 "$D/?mode=s302&loc=rel"          # 站内相对目标
   curl -i --max-time 20 "$D/?mode=s302"                  # 302 不带 Location（Supabase 侧这条是通的）
   curl -i --max-time 20 "$D/?mode=s200&loc=ext"          # 200 带 Location
   curl -s  --max-time 20 "$D/xyz?mode=echo" | head -40   # 头与 path 透传情况
   ```
4. 三选一记录结果：

| 观察到的响应 | 说明 | 对选型的影响 |
|---|---|---|
| **400 + `ExternalRedirectForbidden`** | 公告策略确实在该区生效，且官方解法（绑定自定义域名）就是对症的 | C 方案可信度↑，值得为它启动接入备案；再补 T2 闭环 |
| **302 + `Location` 原样返回** | 默认公网域名并没有拦我们这种写法 ⇒ Supabase 那层的「跟随」是另一套机制（Kong 之后的代理），跟 FC 公告无关 | C 方案的核心依据（公告解法）**被削弱**，转向 D（自建边缘，`return 302` 完全可控） |
| **200 + 目标站点内容 / 超时** | 与 Supabase 观测同形 ⇒ 跟随发生在阿里云更上游的统一代理层，自定义域名大概率不解决 | 同上，主推 D；B 作为演示兜底 |

> 注意：公告原文范围是「**新创建的函数** + HTTP 触发器**默认公网域名** + 站外 3xx」，没提 VPC 内网域名。我们在 Supabase 侧看到的是 `edge-fc-*.cn-hangzhou-vpc.fcapp.run`（内网域名），所以 T1 无论结果如何都只是**强相关证据**，不是等价复现；等价复现要靠工单。

### T2：同一个函数绑自定义域名（只有当域名已在阿里云「接入备案」才有效）

前提自查（这一步决定能不能立刻做）：登录 [阿里云 ICP 代备案管理系统](https://bsn.console.aliyun.com/) 看**这个具体域名**在阿里云有没有备案/接入记录。2026-11-06 用户确认**备案主体就在阿里云** ⇒ 一般可直接绑定，但仍要点开确认域名本身在列（口径区别：「主体在阿里云备案过」和「这个域名的互联网信息服务在阿里云备案过」不是一回事，缺哪个都会在校验时被拦），且官方要求「配置的自定义域名区分大小写，请按实际备案的域名填写」。若域名只在腾讯云备案过 ⇒ 要先办「新增接入」（1～2 工作日初审 + 管局 1～20 工作日，不可加急），期间**解析保持指向腾讯云**。

配置顺序（[官方步骤](https://help.aliyun.com/zh/functioncompute/configure-custom-domain-names)）：

1. **函数计算控制台 > 函数管理 > 域名管理 > 添加自定义域名**（地域必须与函数同区）。
2. **域名名称**：填单域名或**通配符域名**（`*.example.com` 官方支持，中文域名不支持），大小写按备案填写。
3. **路由配置**：`/` 或 `/*` 映射到 T1 那个函数（官方支持路径→函数的多行映射与 `/*` 兜底），这样 `https://s.example.com/AbC123` 的短码能直接进函数 —— 这正是 Supabase 侧唯一拿不到的东西（`/functions/v1/{name}` 固定前缀）。
4. **HTTPS 设置**：启用并按「手动上传 PEM」或选阿里云 SSL 证书；勾**强制 HTTPS**。
5. 拿到页面给出的**公网 CNAME**（`<uid>.<region>.fc.aliyuncs.com` 形态），到云解析 DNS 加 **CNAME** 记录（根域主机记录填 `@`）。文档未要求 TXT 归属验证。
6. 复测（仍不加 `-L`）：
   ```bash
   curl -i --max-time 20 'https://<自定义域名>/AbC123'
   ```
   出 **302 + Location** ⇒ C 方案闭环，跳转层可以按 §6.1 落地；仍被跟随 ⇒ 落 D。

顺带记下的三条官方口径（都利好 C）：① 备案服务码官方直给路径——「单次购买函数计算资源包订单金额100元及以上，即可获得免费的ICP备案服务码」；② FC 自定义域名的「CDN 加速」可选项明确写着「**自定义域名和加速域名不能使用同一个域名**」⇒ 跳转层用 FC 自定义域名直出，**根本不需要 CDN**；③ 「强制 HTTPS」会把 HTTP 请求重定向到 HTTPS（官方原话），说明自定义域名这条链路本身要发 3xx——**这条是推测**（HTTP→HTTPS 与函数自己发的站外 3xx 可能走不同判定），仍以 T2 实测为准。仍未查实：单账号/单地域可绑定域名数量上限（工单问）。

## 6. 结果登记

把每条结论填进 [p0-results.md](p0-results.md)。任何 `FAIL` 都要写清「现象 + 是否已提工单 + 退路」，因为退路会直接改变架构分层。

## 7. 验证完清理

```bash
supabase functions delete probe          # 或 Dashboard 里删
supabase functions delete probe-db
supabase db query --db-url "$SUPABASE_DB_URL" -o table "drop function if exists probe_time_writes(integer)"
supabase db query --db-url "$SUPABASE_DB_URL" -o table "drop function if exists probe_env_report()"
supabase db query --db-url "$SUPABASE_DB_URL" -o table "drop function if exists probe_unlogged_write(text)"
supabase db query --db-url "$SUPABASE_DB_URL" -o table "drop function if exists probe_drain_batch(integer)"
supabase db query --db-url "$SUPABASE_DB_URL" -o table "drop function if exists probe_resolve(text,text)"
supabase db query --db-url "$SUPABASE_DB_URL" -o table "drop table if exists probe_visits_counts, probe_unlogged, probe_inbox, probe_sink, probe_short_url"
```

多语句要拆成单条（见第 0 节）。然后删除 `supabase/functions/probe*` 与 `0001_p0_probe.sql`，正式 migration 从 `0002_` 开始编号。
