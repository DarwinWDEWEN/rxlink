# rxlink 交接文档（2026-11-10）

> 给下一个接手的 AI。读完这份 + `docs/iteration-plan.md`（迭代总账）+ `docs/runbook.md`（运维）即可开工。
> 所有凭据**只写变量名**，值在 `supabase/functions/.env`（gitignore）与 FC 函数环境变量里，由用户本人填写。**永远不要索要、回显、记录任何密钥明文或请求头**（请求头里含 `x-edge-env-*` 明文库密码、`x-fc-access-key-*`、service role key）。

---

## 1. 项目是什么

shlink 兼容的短链平台，跑在阿里云 ADB PostgreSQL Supabase 上，自研跳转层 + 兼容层，控制台直接用 shlink-web-client v4.9.0。

- **热路径**：`https://example.com/{code}` → FC Web 函数（`fc/redirect/`），实例内存常驻全量快照，命中 `dur≈0`，未命中查库 ≤5s 传播失效。
- **数据面**：ADB Supabase（实例 `rxlink`，API host `https://your-project-ref.supabase.co`；FC 走 VPC 内网地址）。
- **兼容层**：Supabase Edge Function `compat`，前缀 `/rest/v3/*`，实现 shlink 契约 23 个方法，控制台当 shlink 服务器用。
- **控制台**：`https://console.example.com`（FC 函数 `console-prod`，shlink-web-client build 产物内联为单文件）。
- **落库**：访问先入 `visit_inbox`（UNLOGGED），cron 每分钟 `drain_visit_inbox(500)` 落 `visit`（按月分区）。

## 2. 当前线上状态（已验收）

迭代 I0–I6 **全部已验收**，证据在 `docs/verification/i1-results.md` … `i6-results.md` 与 `docs/verification/wrap-up-results.md`。

| 项 | 状态 |
|---|---|
| 正式表 + `resolve_short`/`create_short_url`/`snapshot_short_links`/`link_seq`/`drain`/`prune` | 已上线（0004/0005/0006/0007） |
| 跳转切正式表、两文件版、最小实例数=1、HTTPS 证书 | 已上线实测 |
| 兼容层 23 方法 + `api_key`（只存 sha256） | 已上线，控制台全通 |
| 控制台正式域名 `console.example.com`（证书/SW/深链/跨域） | 已上线 |
| 404 回退（域名级/全局/占位符/双斜杠折叠，`not_found_redirects` RPC） | 已上线（0011） |
| 死链清理 `prune_dead_links(180,false)` | 已转真实执行（cron job 8） |
| 探针退场、压测 50 并发 p95 416ms、runbook | 已完成 |
| **地理富化** | **已全部上线并验证**（数据面 0012/0013/0014 已上线、跳转带 IP、FC 富化函数已部署跑通 275/275、端到端探针闭环、DB-IP 署名已实现待重传 `console.zip`） |
| Supabase 付费版 | **未升级**（免费版禁生产，发布前置，用户云上动作） |

## 3. 仓库地图

```
rxlink/                    # 已纳入 git（基线提交 3c95212，2026-11-10）
├─ fc/
│  ├─ redirect/          # 跳转热路径（Web 函数）
│  │  ├─ index.js        # 入口：resolve/缓存命中/404 回退/入队（入队带 remote_addr）
│  │  ├─ cache.js        # 实例内存快照 + link_version seq 轮询失效
│  │  └─ test/redirect.test.js   # 15 例，真实子进程 + mock 网关
│  ├─ geo-enrich/        # 富化函数（事件函数）—— 已部署上线，每小时跑一次
│  │  ├─ index.js        # handler：解包 mmdb → 拉批 → 回写 → 清 IP
│  │  ├─ lib.js          # 纯逻辑（URL 拼装/记录映射/时效判断）
│  │  └─ test/geo-enrich.test.js  # 26 例
│  └─ console/           # 控制台 FC 函数（build 产物内联单文件）
│     ├─ index.js        # 静态托管 + 返回 HTML 时注入 DB-IP 署名页脚
│     └─ test/console.test.js     # 7 例（署名注入）
├─ supabase/
│  ├─ migrations/        # 0001–0014（已应用历史，不改不删；新变更写新编号）
│  ├─ functions/
│  │  ├─ compat/handler.ts # 兼容层逻辑（/rest/v3，23 方法 + R4/R7），导出 handleRequest
│  │  ├─ compat/index.ts # 本地入口（薄）；部署用 scripts/build-compat-function.mjs 生成单文件 dist/index.ts
│  │  ├─ console/        # Edge Function 形态的控制台（已被 FC 函数取代，闲置）
│  │  └─ .env            # gitignore，凭据只在这里
│  └─ config.toml
├─ scripts/
│  ├─ new-api-key.sh     # 本地生成明文、只把 sha256 入库（明文只打印一次）
│  ├─ build-console-fc.mjs
│  └─ build-console-function.mjs
├─ dist/                 # 部署产物：redirect.zip / console.zip
├─ docs/                 # 见 §4 文档索引
├─ shlink/               # shlink 上游源码（参考用，vendor）
└─ shlink-web-client/    # 控制台上游源码 v4.9.0（vendor）
```

### 文档索引

| 文档 | 作用 |
|---|---|
| `iteration-plan.md` | **迭代总账**：I0–I11 切法、B0–B10 验收清单、C 进度表、变更记录 |
| `tech-framework.md` | 技术框架（做成什么样）：§4 DDL、§5 链路（含 §5.4 死链、§5.5 地理富化）、§6 P0 平台事实 |
| `shlink-migration-analysis.md` | shlink 有什么（功能全景 + §9 决策 D1–D5） |
| `shlink-api-contract.md` | 控制台要什么字段（23 方法 / 18 路径契约） |
| `shlink-feature-checklist.md` | **功能对照表**：REST 24 动作 + 服务端能力 + UI 页面逐条 ✅/⚠/❌（2026-11-12 订正过） |
| `geo-enrichment.md` | **地理富化设计定稿**（0012 schema + 富化函数 + 契约改动） |
| `release-checklist.md` | **上线前置清单**：发布阻塞项 + 云侧清理 + 发布后动作 + 最后自检脚本 |
| `runbook.md` | 运维：拓扑、健康查询、加域名 SOP、回滚、故障树、FC 日志 |
| `verification/` | 每轮验收证据（i1–i6、i8、i9、i10、p0-results、wrap-up-results） |
| `reference/` | ADB Supabase 官方文档 + shlink SDK 3.2.1 类型原件 |

## 4. 怎么跑 / 怎么验证

### 环境与命令

```bash
nvm use 24                       # 本机默认 Node 16，CLI/测试需 ≥20
set -a; source supabase/functions/.env; set +a   # 导出 SUPABASE_URL / SUPABASE_DB_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_API_URL
```

- **库操作**：`supabase db query --db-url "$SUPABASE_DB_URL" -o table "<单条 SQL>"`。平台**一次只认一条语句**；`numeric`/`void` 结果要 `::text` 或包一层；`-o table` 里 `numeric` 会乱码。
- **迁移**：迁移文件是已应用历史，**不改不删**；新变更写新编号文件（如 `0013_xxx.sql`），逐条 `supabase db query` 执行。注意 `$$` dollar-quote 会破坏 naive 按分号切分的脚本——切分脚本要处理 dollar-quote。
- **兼容层部署**：`SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat --no-verify-jwt`（平台无 AK/SK，走 functions-cli）。
- **跳转函数部署**：`cd fc/redirect && zip -r ../../dist/redirect.zip index.js cache.js` → FC 控制台上传部署。改源码后必须重新打包。
- **控制台部署**：`(cd shlink-web-client && npm run build)` → `node scripts/build-console-fc.mjs` → 上传 `dist/console.zip` 到 `console-prod`。
- **测试**：`node --test fc/redirect/test/redirect.test.js`（要显式文件路径；真实子进程 + mock 网关，15 例）。

### 健康查询 / 冒烟

```bash
curl -i https://example.com/<真码>     # 期望 302 + Location，Server-Timing 含 dur/cached
curl …/functions/v1/compat/rest/v3/health # 期望 {"status":"pass","version":"4.0.0"}
```
健康查询 SQL 见 `runbook.md` §3.1（inbox 积压 / drain 存活 / link_seq）。

## 5. 平台事实与坑（血泪，别重踩）

- **ADB Supabase 无 `SECURITY DEFINER`**；新表默认「裸奔」——每张表必须 `enable/force RLS + revoke` 四行齐全，RPC 只授 `service_role`，`anon` 一律 revoke。
- **FC 定时触发器的 cron 是 6 字段**（秒 分 时 日 月 周），不是 5 字段：每整点 = `0 0 * * * *`；每分钟 = `0 * * * * *`。漏写秒字段会解析失败。（2026-11-11 核实）
- **`pg_cron` 只能 SQL 驱动**（无 pg_net/webhook）；cron 是 UTC 口径，用 `CRON_TZ=Asia/Shanghai` 前缀改时区；定时触发器是异步调用。
- **FC 自定义域名会改写 Host 头**——用 `curl -H 'Host: 其他域名'` 打线上不生效，验证域名级配置只能配真实域名。
- **默认公网域名 `*.fcapp.run` 发 302 会 `400 ExternalRedirectForbidden`**——必须走自定义域名，平台策略不是 bug。
- **FC 函数类型**：定时触发器挂**事件函数**（`exports.handler`），Web/HTTP 函数挂 HTTP 触发器。跳转函数是 Web 函数，富化函数必须是事件函数。
- **双网络**：FC 支持「既能访问公网也能访问 VPC」（允许访问 VPC=是 + 允许函数访问公网=是），函数级配置；**不需要 NAT 网关**（NAT 只在要固定公网出口 IP 时用）。出处 `help.aliyun.com/document_detail/161919.html`。
- **mmdb 不能进镜像**（ license 绑定 + 体积），放实例 `/tmp`，冷启动或满 30 天重下。
- **ADB 免费版 1C2G 禁生产、磁盘 1GB 不可扩**——发布前必须升付费版（用户云上动作）。
- **`visit_inbox` 是 UNLOGGED**：实例崩溃会丢未落库统计（设计取舍，丢统计不丢业务）。
- **`visit` 按月分区**：跨月查不到先确认 `ensure_visit_partition()` 已建分区。
- **HEAD 请求、`max_visits`、`valid_until`、query 透传**都有行为用例，改动跳转函数先跑测试。
- **不配 `VISITOR_SALT`**（用户决定）：`visitor_key` 恒 null，无 UV 口径；PV/明细/计数不受影响。
- **Domains 页红标是已知现象**：健康检查走短链域名 `…/health`，被跳转函数兜底返回 404，非故障。
- 本机 macOS 27：`cd path && cmd` 会被 gvm hook 打断（写 /tmp 脚本或用工具 `dir_path`）；`/dev/tcp` 探端口假阴性，一律用 curl。

## 6. 凭据与安全红线

- 凭据只写变量名：`SUPABASE_URL`（FC 侧是 **VPC 内网地址**）、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_API_KEY`、`X-Api-Key`（控制台）、`MAXMIND_LICENSE_KEY`（待加）。
- API key：明文由用户本地 `scripts/new-api-key.sh` 生成，库里只存 sha256；**临时验证 key 用完即删**。
- **任何函数不回显/不记录请求头**（含明文库密码与各类 access key）；`Location` 只取库里 `long_url`，请求不参与拼接。
- 文档断言要有出处；查不到出处的计划挂账别编。
- 破坏性 / 共享库写入需用户明确批准。
- **0012 迁移前的备份表 `visit_bak_0012`（158 行，RLS 已 enable+force+revoke，anon 直连 401）暂留线上库**，作为列改名的回滚依据；确认新包上线后可 `drop table visit_bak_0012;` 清掉。

## 7. 待办（下一个 AI 的起点）

### 7.1 地理富化（已全部上线并验证）

按 `docs/geo-enrichment.md` 实现，四步 —— **四步都已落地**：

1. ✅ **#41 迁移 `0012_geo_location.sql`**（2026-11-10 应用，15 条语句）+ **`0013_geo_location_id_match.sql`**（2026-11-11，2 条，修回写失配）：`visit_inbox.remote_addr`；`visit` 加 `remote_addr` + `country/region/city` 正名为 `country_name/region_name/city_name` + 加 `country_code/lat/lon/timezone`；部分索引 `visit_pending_location_idx`；三个 RPC `visits_pending_location` / `apply_visit_locations` / `retire_remote_addr`（只授 service_role）。
2. ✅ **#42 跳转函数与 drain 带上 `remote_addr`**：库侧与函数侧都已上线（**跳转包 2026-11-11 已上传**，线上已有带 IP 的真实流量行）；单测 15/15。**`0014_drain_clear_remote_addr.sql`（2026-11-11，1 条）** 覆盖 `drain_visit_inbox`：落库后立即清空入队侧的原始 IP（留存从最长 1 天压到分钟级）。
3. ✅ **#43 富化函数 `fc/geo-enrich/`**：26 例单测全绿，真实 mmdb 端到端跑通；**已由用户在 FC 上部署**（Layer + 代码包 + 环境变量 + 每小时定时触发器），手动执行返回 `{"ok":true,"batches":1,"pulled":275,"updated":275}`。**数据源是 DB-IP City Lite**（免注册免 key，CC BY 4.0 允许商用）—— 原设计的 MaxMind 免费版只允许个人使用，与「对外提供服务」冲突，故换源（详见 `geo-enrichment.md` §0）。
4. ✅ **#44 契约 + 兜底**：`visit_json` 的 `visitLocation` 由恒 null 改为读列；`retire_remote_addr(7)` 由 pg_cron 每小时跑（jobid 9，`rxlink-retire-ip`）做 7 天硬留存。

**FC 部署步骤（他操作）—— 富化函数已按此完成**

1. 函数计算 > 创建函数 > **事件函数**，运行时 Node.js 18/20，**请求处理程序填 `index.handler`**（FC 按「文件名.方法名」加载，不需要自己起 HTTP 服务）；
2. **建 Layer**：左侧「层」> 创建层 > 上传 `dist/geoip-layer.zip`（52MB，含 DB-IP mmdb）→ 名字随意（如 `geoip`）；
3. 函数「编辑」> 层 > 添加刚建的层（挂载后 mmdb 在 `/opt/geoip/`）；
4. 代码 > 上传 ZIP：`dist/geo-enrich.zip`（55KB，代码 + node_modules）；
5. 环境变量：`SUPABASE_URL`（**VPC 内网地址**）、`SUPABASE_SERVICE_ROLE_KEY`；
6. 网络：允许访问 VPC = **是**；**允许函数访问公网 = 否**（mmdb 随 Layer，运行时不联网）；
7. 规格：超时 ≥60s、内存 ≥512MB；
8. 触发器 > 定时触发器，**每小时**：`CRON_TZ=Asia/Shanghai 0 0 * * * *`（⚠️ **FC 的 cron 是 6 字段**「秒 分 时 日 月 周」，漏秒字段会解析失败）。

**为什么 mmdb 走 Layer 而不是打进代码包**：FC 的 ZIP 直传上限 50MB，而 DB-IP City Lite 压缩后 52.35MB，压不进去；OSS 上传（250MB）也行，但要跨到 OSS 控制台开桶传文件。Layer 与函数都在 FC 控制台内，mmdb 还能独立于代码更新。

**部署后复核 —— 已做，结果如下**（2026-11-11）：`visit` 451 行 / 已富化 291 / `ip_pending=0`；`visit_inbox` 持 IP 行数 0（0014 上线后由每分钟 drain 清空）；真实流量探针闭环：跳转带 IP → 入队 → drain（写 visit、清 inbox）→ 富化写 `US / California / Mountain View / 37.422,-122.085` 并清空 `visit.remote_addr`。

**已知限制**：DB-IP 无 `time_zone` 字段 → `visit.timezone` 恒 NULL（契约允许 null，控制台不渲染）。要时区就把 `GEO_MMDB_URL` 指向带 time_zone 的库。

**署名义务**：DB-IP 要求展示结果处标注 "IP Geolocation by DB-IP"（并链接 db-ip.com）—— **已实现**：`fc/console/index.js` 在返回 HTML 时注入固定页脚 + `<style>`，不重编 Angular（7 例单测全绿）。**待他重传 `dist/console.zip` 后线上生效**（`node scripts/build-console-fc.mjs` 已重新打包）。

**月更**（DB-IP 每月初发布新版）：`node scripts/build-geoip-bundle.mjs` → `node scripts/build-geo-enrich-fc.mjs` → 重新上传 Layer。

### 7.2 发布前置 / 云上清理（用户动作，#40）

> **完整清单见 `docs/release-checklist.md`**（每项带现状/动作/验证方式/是否阻塞发布）。下面只留摘要。

- 🔴 **Supabase 升付费版**（免费版禁生产）—— 唯一真正阻塞发布的项。
- 🟠 **确认 FC 定时触发器 cron 是 6 字段** `CRON_TZ=Asia/Shanghai 0 0 * * * *`（本机无法验证；5 字段写法在 FC 里是 UTC，会差 8 小时）。
- 🟡 **云上待清理**：`cdn.example.com` 域名/解析下线（**DNS 仍解析到 203.0.113.10**）；Edge 函数 `statictest` 处于 `DELETING`（等删完）。
- 🟢 **备份表 `visit_bak_0012`**（158 行、授权已收口）保留到 #40 发布完成后再 drop。
- Domains 红标处置已定：先接受（方案 a）。

**已核实不需要做的**（2026-11-12 复核，避免重复查）：

- ~~重传 `dist/console.zip`（DB-IP 署名页脚）~~ → **已上线**，线上 HTML 已含 `IP Geolocation by DB-IP`。
- ~~FC 账号探针残留~~ → I6 已全退场。
- ~~闲置 `console` Edge 函数~~ → `console` 是 `console.example.com` 的静态包宿主，**要保留**；闲置的是 `statictest`。

### 7.3 明确不做（YAGNI）

- 多段 slug（D3 本期不支持）、存量数据搬迁（D5）、UV 口径（无 salt）、Mercure 实时推送、跳转规则（M3 前 501）、地理富化不进热路径。

## 8. 工作约定（用户要求）

- 有序任务先给方案 + 推荐，等用户点头再动手；探索性问题给 2–3 句推荐 + 取舍。
- 实现走 TDD；设计类任务先走 brainstorming。
- 汇报固定四段：**改了什么 / 测试数字 / 真实证据 / 遗留问题**；简洁，别造一次性工具。
- 密钥相关：只给本地生成 + 哈希入库的脚本，不索要 / 不回显 / 不代填明文。
