# rxlink · rxlink 短链系统

shlink 兼容的短链平台：**自研跳转层 + 兼容层**，让 shlink 官方控制台（shlink-web-client v4.9.0）直接当后台用。
不是把 shlink 原版搬上云，而是按 shlink 的 REST 契约（`/rest/v3/*`）自己实现数据面与跳转。

- 控制台：<https://console.example.com>
- 短链域名：<https://example.com/{code}>
- 兼容层：`https://your-project-ref.supabase.co/functions/v1/compat`
- 数据面：阿里云 ADB PostgreSQL Supabase（实例 `rxlink`）

> 完整操作手册（18 章 + 18 张线上截图）：[docs/manual/rxlink-manual.html](docs/manual/rxlink-manual.html)

> **项目状态**：功能已完整（shlink REST 24 个动作 23 ✅ / 1 ⚠️ / 0 ❌），但**尚未正式发布**——Supabase 免费版 1C2G 不能用于生产，需付费版。详见 [§9 功能对照与发布前置](#9-功能对照与发布前置)。

## 目录

- [1. 快速开始](#1-快速开始第一次使用)
- [2. 日常使用](#2-日常使用)
- [3. 自行部署（私有化）](#3-自行部署私有化)
- [4. 系统架构](#4-系统架构)
- [5. 本地开发](#5-本地开发)
- [6. 测试](#6-测试)
- [7. 部署](#7-部署)
- [8. 运维](#8-运维)
- [9. 功能对照与发布前置](#9-功能对照与发布前置)
- [10. 许可证与第三方致谢](#10-许可证与第三方致谢)
- [11. 安全红线](#11-安全红线)
- [12. 参与贡献](#12-参与贡献)
- [13. 文档索引](#13-文档索引)

---

## 1. 快速开始（第一次使用）

### 1. 生成 API 密钥

控制台用 `X-Api-Key` 向兼容层鉴权。密钥明文**只打印一次**，库里只存 sha256，不可恢复。

```bash
nvm use 24
bash scripts/new-api-key.sh <name>   # name: 字母/数字/_/-，1-40 字
# 可选过期时间：bash scripts/new-api-key.sh <name> --expires-at 2027-01-01T00:00:00Z
```

明文形如 `rxl_` + 48 位十六进制，请立刻保存到安全的地方。

### 2. 打开控制台，添加服务器

访问 <https://console.example.com> ，首次使用会看到「添加新服务器」表单，填三项：

| 字段 | 填什么 | 示例 |
|---|---|---|
| 名称 | 显示名，任意 | `rxlink 生产` |
| URL | 兼容层地址（结尾必须是 `/functions/v1/compat`） | `https://your-project-ref.supabase.co/functions/v1/compat` |
| API 密钥 | `rxl_` 开头的明文 | `rxl_…` |

点「创建服务器」进入总览页。「高级选项」一般不用展开。

### 3. 验证兼容层健康

浏览器直接访问 `…/functions/v1/compat/rest/v3/health`，应返回 `{"status":"pass","version":"5.1.0"}`。

---

## 2. 日常使用

### 创建短链

- **快捷方式**：总览页中部填「要缩短的 URL」→ 保存，直接建链。
- **完整方式**：创建短链页，可设自定义短码、标签、域名、生效时间窗口、最大访问次数、查询参数透传、爬虫抓取等。
- **标题自动抓取**：`Title` 留空时兼容层抓目标页 `<title>`（对私网/本机地址 fail-closed，抓不到就留空，不影响建链）；手填标题是粘性的，不会被覆盖。

### 跳转与生效

`https://example.com/{code}` → `302` 到长链；未知码 → `404`。
改短链**秒级生效**：写库时 `link_version.seq` 加一，跳转函数轮询刷新内存快照。

### 访问统计

入口：总览页顶部「访问 / 孤儿访问」卡片，或短链列表某条的「访问」列。四个子页签：

| 子页签 | 内容 |
|---|---|
| 按时间 | 访问曲线（可按天/周/月分组） |
| 按上下文 | 按浏览器 / 操作系统 / 来源聚合 |
| 按位置 | 按国家 / 城市聚合（地理富化结果） |
| 列表 | 逐条明细，可勾选导出 CSV |

「孤儿访问」= 访问了路径但没匹配到有效短链（死链、过期、超次、乱猜短码），不计入短链统计，但能帮你发现死链与扫描行为。

### 地理富化（国家 / 城市）

异步 pipeline，**不进热路径**：跳转带 IP → `visit_inbox` → cron 每分钟 `drain_visit_inbox(500)` 落 `visit` → FC 富化函数每小时查 DB-IP City Lite → 回写国家/地区/城市/经纬度并清空 IP。
原始 IP 只短暂留存（富化后立即清空，另有 `retire_remote_addr(7)` 每小时兜底，硬上限 7 天）。
数据源 DB-IP City Lite（CC BY 4.0，允许商用、免 key），控制台页脚已注入署名。

### 其他能力

- **标签**：给短链分组，列表页可按标签筛选。
- **域名管理**：多域名 + 三类 404 回跳（根路径 / 路径非法 / 短码无效），支持 `{DOMAIN}`、`{ORIGINAL_PATH}` 占位符，改动立即生效。
- **跳转规则**：11 种匹配条件（设备/浏览器/语言/查询参数/IP/地理位置/日期），保存后 ≤5s 生效。
- **二维码**：短链列表行内「选项」→ 二维码。
- **服务器管理**：顶栏「服务器」菜单切换/导入导出服务器配置（多套环境时用）。

> 以上每一项的界面细节、字段逐项说明与截图，见 [操作手册](docs/manual/rxlink-manual.html) §1.4–§1.16。

---

## 3. 自行部署（私有化）

平台绑定阿里云（ADB Supabase + 函数计算 FC），以下是跑起来需要的最小集合。

### 前置条件

| 依赖 | 说明 |
|---|---|
| ADB PostgreSQL Supabase 实例 | 需支持 Edge Functions、`pg_cron`、`pg_net`；**免费版 1C2G 不可用于生产** |
| 阿里云函数计算 FC | Web 函数（跳转 / 控制台）+ 事件函数（地理富化）+ 定时触发器（**cron 为 6 字段**） |
| Node.js ≥ 20 | 本机默认 16，用 `nvm use 24` |
| Deno 2.x | 兼容层类型检查与测试 |
| DB-IP City Lite mmdb | 脚本自动下载（CC BY 4.0）；压缩后 > 50MB，需走 FC Layer |
| 域名 | 短链域名 + 控制台域名，需解析/备案 |

### 部署步骤概览

1. **建库**：在空库上按顺序执行 `supabase/migrations/*.sql`（本地可用 `supabase db reset` 重放）。
2. **兼容层**：`node scripts/build-compat-function.mjs` → `functions-cli deploy compat`。
3. **跳转函数**：生成 `china-geo.bin` → 打 7 文件 zip → 上传 FC Web 函数。
4. **控制台**：`npm run build` → `node scripts/build-console-fc.mjs` → 上传 `dist/console.zip`。
5. **地理富化**：`build-geoip-bundle.mjs` + `build-geo-enrich-fc.mjs` → 上传 Layer 与代码包。
6. **定时任务**：创建 4 个 `pg_cron` job + 1 个 FC 每小时触发器。
7. **域名**：短链域名指向跳转函数，控制台域名指向控制台函数。

具体命令与配置项见 [§7 部署](#7-部署) 与 [docs/runbook.md](docs/runbook.md) §5。

---

## 4. 系统架构

| 组件 | 作用 | 地址 / 位置 | 代码 |
|---|---|---|---|
| 跳转热路径 | 接收短链请求，返回 302/404；访问写入队列 | FC Web 函数，域名 `example.com` | `fc/redirect/` |
| 数据面 | 短链、访问明细、鉴权 key | ADB PostgreSQL Supabase | `supabase/migrations/` |
| 兼容层 | 把 shlink REST 契约翻译成数据库操作 | Edge Function `compat`，`/rest/v3/*` | `supabase/functions/compat/` |
| 控制台 | shlink 官方网页客户端 | `console.example.com`（FC 函数 `console-prod`） | `shlink-web-client/` → `fc/console/` |
| 地理富化 | IP → 国家/城市 | FC 事件函数 `geo-enrich`（每小时） | `fc/geo-enrich/` |

一次跳转：

```
用户点击 https://example.com/abc123
   │
   ▼
FC 跳转函数（常驻内存快照）
   ├─ 命中快照 → 直接 302（dur≈0）
   └─ 未命中  → 查 ADB Supabase → 302 / 404
   │
   └─ 同时把「谁 / 何时 / 哪个 IP / 什么浏览器」写入 visit_inbox
   │
   ▼
cron 每分钟 drain_visit_inbox(500) → 落到 visit 表（按月分区）
   │
   ▼
FC 地理富化函数（每小时）→ 查 DB-IP → 回写国家/城市/经纬度
   │
   ▼
控制台读 visit 表 → 统计图表与明细
```

**为什么分层**：跳转是热路径，要毫秒级响应，所以做内存快照 + 队列入库；统计是冷路径，可以分钟级延迟。两者解耦后，跳转永远不会被统计拖慢。

---

## 5. 本地开发

环境：Node ≥ 20（本机默认 16，用 `nvm use 24`）；兼容层用 Deno 2.x。

```bash
nvm use 24
set -a; source supabase/functions/.env; set +a   # 导出 SUPABASE_URL / SUPABASE_DB_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_API_URL
```

- **控制台依赖**：`cd shlink-web-client && npm ci`
- **控制台构建**：`npm run build`（中文，默认）/ `npm run build:en`（英文）
- **质量门**：`npm run cs && npm run types && npm test`
- **控制台打包成 FC 函数**：`node scripts/build-console-fc.mjs` → `dist/console.zip`

### 中文化机制（I12）

构建期字面量替换，不是运行时：`scripts/i18n/vite-plugin-i18n.mjs`（`apply:'build'`）在 Vite `transform` 阶段按 `scripts/i18n/zh-CN.json` 替换上游 `@shlinkio/*` 产物与自身 `src/` 里的英文字面量；`buildEnd` 对照 `expected.json` + `expected.src.json` 校验出现次数，上游改文案则构建失败。
`I18N_LANG=en` 跳过替换。只翻界面文案，浏览器/OS 名等数据值保留英文；国家名中文、中国省份中文，外国省份与城市保留英文。

### 仓库结构

| 目录 | 内容 |
|---|---|
| `fc/redirect/`、`fc/geo-enrich/`、`fc/console/` | 自研 FC 函数 |
| `supabase/functions/compat/` | 自研兼容层（Deno） |
| `supabase/migrations/` | 数据库迁移 |
| `scripts/` | 构建 / 部署 / i18n / 运维脚本 |
| `shlink-web-client/` | **vendored 上游** shlink-web-client v4.9.0（MIT），含我们的中文化改动 |
| `shlink/` | **vendored 上游** shlink 服务端（MIT），仅作契约/参考，非运行依赖 |
| `docs/` | 手册、运维、设计文档 |

---

## 6. 测试

```bash
# Node 侧（真实子进程 + mock 网关）
node --test fc/console/test/console.test.js \
          fc/geo-enrich/test/geo-enrich.test.js \
          fc/redirect/test/*.test.js \
          scripts/i18n/test/*.test.mjs \
          scripts/test-production-baseline.mjs

# Deno 侧（兼容层）
deno test --allow-env supabase/functions/compat/test/compat.test.ts \
                      supabase/functions/compat/test/title-resolver.test.ts
deno check supabase/functions/compat/index.ts \
            supabase/functions/compat/handler.ts \
            supabase/functions/compat/title-resolver.ts
```

CI（`.github/workflows/ci.yml`）两个 job：

- **quality**：上面全部测试 + 前端质量门 + 中文/英文两种构建（断言 `<html lang="zh-CN">` / `lang="en"`）。
- **database**：`supabase start && supabase db reset` 从空库重放迁移，校验无 `probe_%` 残留、默认域名 `example.com|https`、4 个 cron job。

---

## 7. 部署

### 兼容层（Edge Function `compat`）

```bash
set -a; source supabase/functions/.env; set +a
node scripts/build-compat-function.mjs   # handler.ts → 单文件 dist/index.ts
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat \
  -d supabase/functions/compat/dist --no-verify-jwt
```

### 跳转函数（FC Web 函数）

```bash
ls -la fc/redirect/china-geo.bin || node scripts/build-china-geo.mjs   # 构建产物，gitignore
cd fc/redirect && zip -r ../../dist/redirect.zip \
  index.js cache.js ipmat.js rules.js rules-cache.js china-geo.js china-geo.bin
unzip -l ../../dist/redirect.zip   # 必须 7 个文件都在
```

上传 `dist/redirect.zip` 到 FC 跳转函数。环境变量：`SUPABASE_URL`（**VPC 内网地址**）、`SUPABASE_SERVICE_ROLE_KEY`；最小实例数 ≥ 1。

### 控制台（FC 函数 `console-prod`）

```bash
(cd shlink-web-client && npm run build)
node scripts/build-console-fc.mjs      # → dist/console.zip
```

上传 `dist/console.zip`。改 `fc/console/index.js`（DB-IP 署名注入）后必须重新打 zip。

### 地理富化（FC 事件函数 `geo-enrich`）

mmdb 走 Layer（DB-IP City Lite 压缩后 > 50MB，进不了 ZIP）：`node scripts/build-geoip-bundle.mjs` → `node scripts/build-geo-enrich-fc.mjs` → 上传 Layer 与代码包，挂每小时定时触发器（cron 6 字段）。详见 [docs/runbook.md](docs/runbook.md) §5。

---

## 8. 运维

**健康查询**（落库积压 + drain 存活）：

```sql
select
  (select count(*) from visit_inbox where processed_at is null)::text as inbox_pending,
  (select coalesce(max(extract(epoch from (now()-occurred_at)))::int,0)
     from visit_inbox where processed_at is null)::text as inbox_oldest_sec,
  (select coalesce(extract(epoch from (now()-max(start_time)))::int,-1)
     from cron.job_run_details where jobid=6 and status='succeeded')::text as drain_last_success_sec,
  (select seq from link_version where id=1)::text as link_seq;
```

阈值：`inbox_oldest_sec > 120` 或 `inbox_pending > 1000` ⇒ 落库积压；`drain_last_success_sec > 180` ⇒ drain 停摆。

**定时任务**：

| job | 名称 | 频率 | 作用 |
|---|---|---|---|
| 6 | `rxlink-drain` | 每分钟 | `drain_visit_inbox(500)` |
| 8 | `rxlink-prune` | 每天 19:00 | `prune_dead_links(180,false)`（软删长期无访问短链，可逆） |
| 9 | `rxlink-retire-ip` | 每小时 | `retire_remote_addr(7)`（清超 7 天 IP） |
| 10 | `rxlink-expired` | 每天 20:00 GMT | `delete_expired_short_urls(false)`（软删到期/超次短链） |
| — | `geo-enrich` 触发器 | 每小时 | FC 事件函数，地理富化 |

库操作通道：`supabase db query --db-url "$SUPABASE_DB_URL" -o table "<单条 SQL>"`（平台一次只认一条语句）。
故障排查树、加域名 SOP、回滚、FC 日志口径见 [docs/runbook.md](docs/runbook.md)。

---

## 9. 功能对照与发布前置

- **shlink REST 契约**：24 个动作中 **23 ✅ / 1 ⚠️**（`mercureInfo` 404 降级）/ **0 ❌**；服务端还有 `/{code}` 跳转、`/{code}/track` 追踪像素、`robots.txt`。详见 [docs/shlink-feature-checklist.md](docs/shlink-feature-checklist.md)。
- **发布阻塞项**：🔴 Supabase 升付费版（免费版 1C2G 禁生产，唯一真正阻塞项）；🟠 确认 FC 定时触发器 cron 是 6 字段；🟡 `cdn.example.com` 域名/解析下线。完整清单见 [docs/release-checklist.md](docs/release-checklist.md)。

---

## 10. 许可证与第三方致谢

**本项目自有代码以 [MIT](LICENSE) 开源。**

仓库内包含 vendored 上游源码与若干第三方依赖，各自的许可如下（使用/再分发时请一并保留其版权声明）：

| 组件 | 许可 | 版权 / 说明 |
|---|---|---|
| [shlink](https://github.com/shlinkio/shlink)（`shlink/`） | MIT | Copyright (c) 2016-2026 Alejandro Celaya |
| [shlink-web-client](https://github.com/shlinkio/shlink-web-client)（`shlink-web-client/`） | MIT | Copyright (c) 2018-2020 shlinkio；含本项目中文化改动 |
| `@shlinkio/*`（frontend-kit / web-component / js-sdk / data-manipulation） | MIT | shlinkio |
| `react-leaflet` / `@react-leaflet/core`（经 `@shlinkio/shlink-web-component` 传递引入） | **Hippocratic-2.1** | 非 OSI 认可许可，附使用限制；会打进控制台产物。若不接受该限制，需移除地图相关功能或替换组件 |
| Font Awesome Free | CC BY 4.0 + MIT（双许可） | 需署名 |
| DB-IP City Lite mmdb | CC BY 4.0 | 随地理富化 Layer 分发，控制台页脚已署名 |

注意事项：

- 控制台构建产物目前由 Vite 压缩，**未保留各 MIT 依赖的版权声明横幅**。若对外分发产物，建议补 `THIRD-PARTY-NOTICES` 或在构建中保留 banner。
- `Hippocratic-2.1` 不是 copyleft，不会「传染」自有代码；但它附加了使用限制，因此**分发产物不能声称是纯 MIT**，需按上表单独标注。
- 本项目未使用任何 GPL/AGPL/SSPL 等 copyleft 依赖。

---

## 11. 安全红线

- 凭据只写变量名，值在 `supabase/functions/.env`（gitignore）与 FC 函数环境变量里。
- API key 明文只本地生成、只打印一次，库里只存 sha256；丢了只能重新生成。
- **任何函数不回显、不记录请求头**（含明文库密码与各类 access key）；`Location` 只取库里 `long_url`，请求不参与拼接。
- 破坏性 / 共享库写入需明确批准。

---

## 12. 参与贡献

- 分支：从 `main` 拉特性分支，PR 合回 `main`；提交信息沿用 `feat/fix/docs/chore(scope): 中文描述` 风格。
- 合并前需通过 CI 两个 job（quality + database）。
- 改控制台文案：优先改 `scripts/i18n/zh-CN.json`，不要直接改上游 `node_modules`；上游升级后跑 `npm run build` 校验字面量计数。
- 平台相关的破坏性变更（迁移、cron、函数部署）请在 PR 描述里写明影响与回滚方式。

---

## 13. 文档索引

| 文档 | 作用 |
|---|---|
| [docs/manual/rxlink-manual.html](docs/manual/rxlink-manual.html) | **操作手册**（界面使用，18 章 + 线上截图） |
| [docs/runbook.md](docs/runbook.md) | 运维：拓扑、健康查询、部署回滚、加域名 SOP、故障树 |
| [docs/handover.md](docs/handover.md) | 交接文档：项目全貌、平台坑、待办 |
| [docs/iteration-plan.md](docs/iteration-plan.md) | 迭代总账（I0–I11 切法与验收清单） |
| [docs/shlink-feature-checklist.md](docs/shlink-feature-checklist.md) | 功能对照表 |
| [docs/release-checklist.md](docs/release-checklist.md) | 上线前置清单 |
| [docs/geo-enrichment.md](docs/geo-enrichment.md) | 地理富化设计定稿 |
| [docs/tech-framework.md](docs/tech-framework.md) | 技术框架（DDL、链路、平台事实） |
