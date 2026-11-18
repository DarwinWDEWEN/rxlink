# rxlink 短链系统

[English](README.md) · [中文](README.zh-CN.md)

rxlink 是一个**兼容 shlink REST 契约**（`/rest/v3/*`）的短链平台：在 serverless 设施上重新实现数据面与跳转层，并直接复用 shlink 官方网页控制台（[shlink-web-client v4.9.0](https://github.com/shlinkio/shlink-web-client)）作为后台。重点不是把上游 shlink 原版搬上云，而是按 shlink 的 API 契约自研实现，让官方控制台开箱即用。

- 控制台：自行部署的 shlink 网页控制台（见[自行部署](#自行部署私有化)）
- 短链域名：`https://<你的短链域名>/{code}`
- 兼容层：`https://<你的 Supabase 项目>/functions/v1/compat/rest/v3/*`

> **项目状态**：功能已完整覆盖 shlink 契约（24 个 REST 动作 23 ✅ / 1 ⚠️ 降级 / 0 ❌），但**尚未正式发布**——Supabase 免费版 1C2G 不能用于生产流量，需付费版。详见[状态与发布前置](#状态与发布前置)。

## 亮点

- **官方控制台开箱即用**：建链/改链、标签、域名、跳转规则、二维码、访问统计、多服务器管理，全部通过 shlink-web-client 完成，无需自研 UI。
- **毫秒级跳转热路径**：内存快照 + 队列入库，统计永远不会拖慢跳转。
- **秒级生效**：写库时 `link_version.seq` 加一，跳转函数轮询刷新内存快照。
- **完整访问统计**：时间曲线、浏览器/系统/来源聚合、地理富化（DB-IP City Lite）、逐条明细与 CSV 导出，另有「孤儿访问」帮你发现死链与扫描行为。
- **隐私友好**：原始 IP 在富化后立即清空，另有 7 天硬上限兜底。
- **11 种动态跳转条件**：设备 / 浏览器 / 语言 / 查询参数 / IP / 地理位置 / 日期。
- **双语控制台**：构建期 i18n 流水线产出中文（`zh-CN`）或英文（`en`）构建，并断言字面量替换计数。

## 系统架构

| 组件 | 作用 | 代码 |
|---|---|---|
| 跳转热路径 | `/code` → `302`/`404`，访问写入队列 | `fc/redirect/` |
| 数据面 | 短链、访问明细、鉴权 key | `supabase/migrations/`（21 个迁移） |
| 兼容层 | 把 shlink REST 契约翻译成数据库操作 | `supabase/functions/compat/`（Deno） |
| 控制台 | vendored shlink-web-client v4.9.0 + 中文化 | `shlink-web-client/` → `fc/console/` |
| 地理富化 | IP → 国家/城市（每小时） | `fc/geo-enrich/` |

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

分层的用意：跳转是热路径，要毫秒级响应，所以用内存快照 + 队列入库；统计是冷路径，可以容忍分钟级延迟。两者解耦后，跳转永远不会被统计拖慢。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `fc/redirect/`、`fc/geo-enrich/`、`fc/console/` | 自研 FC 函数 |
| `supabase/functions/compat/` | 自研兼容层（Deno） |
| `supabase/migrations/` | 数据库迁移（0001–0021） |
| `scripts/` | 构建 / 部署 / i18n / 运维脚本 |
| `shlink-web-client/` | **vendored 上游** shlink-web-client v4.9.0（MIT），含我们的中文化改动 |
| `docs/` | 运维、设计、验收文档 |

## 快速开始

1. 在你的部署上生成 API 密钥（明文只打印一次，库里只存 sha256）：

   ```bash
   nvm use 24
   bash scripts/new-api-key.sh <name>            # 可选过期时间：--expires-at 2027-01-01T00:00:00Z
   ```

2. 打开你的控制台，添加服务器：

   | 字段 | 填什么 |
   |---|---|
   | 名称 | 任意显示名 |
   | URL | `https://<你的 Supabase 项目>/functions/v1/compat` |
   | API 密钥 | 第 1 步得到的 `rxl_…` 明文 |

3. 验证兼容层健康：`…/functions/v1/compat/rest/v3/health` 应返回 `{"status":"pass","version":"5.1.0"}`。

## 自行部署（私有化）

平台绑定阿里云（ADB PostgreSQL Supabase + 函数计算 FC）。最小依赖：

| 依赖 | 说明 |
|---|---|
| ADB PostgreSQL Supabase 实例 | 需支持 Edge Functions、`pg_cron`、`pg_net`；**免费版不可用于生产** |
| 阿里云函数计算 FC | Web 函数（跳转 / 控制台）+ 事件函数（地理富化）+ 定时触发器（**cron 为 6 字段**） |
| Node.js ≥ 20 | 本机默认 16，用 `nvm use 24` |
| Deno 2.x | 兼容层类型检查与测试 |
| DB-IP City Lite mmdb | 脚本自动下载（CC BY 4.0）；压缩后 > 50MB，需走 FC Layer |
| 域名 | 短链域名 + 控制台域名，需解析/备案 |

部署步骤概览：

1. **建库**：在空库上按顺序执行 `supabase/migrations/*.sql`（本地可用 `supabase db reset` 重放）。
2. **兼容层**：`node scripts/build-compat-function.mjs` → `functions-cli deploy compat`。
3. **跳转函数**：生成 `china-geo.bin` → 打 7 文件 zip → 上传 FC Web 函数。
4. **控制台**：`npm run build` → `node scripts/build-console-fc.mjs` → 上传 `dist/console.zip`。
5. **地理富化**：`build-geoip-bundle.mjs` + `build-geo-enrich-fc.mjs` → 上传 Layer 与代码包。
6. **定时任务**：创建 4 个 `pg_cron` job + 1 个 FC 每小时触发器。
7. **域名**：短链域名指向跳转函数，控制台域名指向控制台函数。

具体命令与配置项见 [docs/runbook.md](docs/runbook.md)。

## 测试

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

## 状态与发布前置

- **shlink REST 契约**：24 个动作中 **23 ✅ / 1 ⚠️**（`mercureInfo` 404 降级）/ **0 ❌**；服务端还有 `/{code}` 跳转、`/{code}/track` 追踪像素、`robots.txt`。详见 [docs/shlink-feature-checklist.md](docs/shlink-feature-checklist.md)。
- **发布阻塞项**：🔴 生产使用需付费版 Supabase（唯一真正阻塞项）；🟠 确认 FC 定时触发器 cron 是 6 字段。完整清单见 [docs/release-checklist.md](docs/release-checklist.md)。

## 运维

健康查询（落库积压 + drain 存活）：

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

| job | 名称 | 频率 | 作用 |
|---|---|---|---|
| 6 | `rxlink-drain` | 每分钟 | `drain_visit_inbox(500)` |
| 8 | `rxlink-prune` | 每天 19:00 | `prune_dead_links(180,false)`（软删长期无访问短链，可逆） |
| 9 | `rxlink-retire-ip` | 每小时 | `retire_remote_addr(7)`（清超 7 天 IP） |
| 10 | `rxlink-expired` | 每天 20:00 GMT | `delete_expired_short_urls(false)`（软删到期/超次短链） |
| — | `geo-enrich` 触发器 | 每小时 | FC 事件函数，地理富化 |

故障排查树、加域名 SOP、回滚、FC 日志口径见 [docs/runbook.md](docs/runbook.md)。

## 参与贡献

- 分支：从 `main` 拉特性分支，PR 合回 `main`；提交信息沿用 `feat/fix/docs/chore(scope): 中文描述` 风格。
- 合并前需通过 CI 两个 job（quality + database）。
- 改控制台文案：优先改 `scripts/i18n/zh-CN.json`，不要直接改上游 `node_modules`；上游升级后跑 `npm run build` 校验字面量计数。
- 平台相关的破坏性变更（迁移、cron、函数部署）请在 PR 描述里写明影响与回滚方式。

## 许可证与第三方致谢

**本项目自有代码以 [MIT](LICENSE) 开源。**

仓库内包含 vendored 上游源码与若干第三方依赖，各自的许可如下（使用/再分发时请一并保留其版权声明）：

| 组件 | 许可 | 版权 / 说明 |
|---|---|---|
| [shlink-web-client](https://github.com/shlinkio/shlink-web-client)（`shlink-web-client/`） | MIT | Copyright (c) 2018-2020 shlinkio；含本项目中文化改动 |
| `@shlinkio/*`（frontend-kit / web-component / js-sdk / data-manipulation） | MIT | shlinkio |
| `react-leaflet` / `@react-leaflet/core`（经 `@shlinkio/shlink-web-component` 传递引入） | **Hippocratic-2.1** | 非 OSI 认可许可，附使用限制；会打进控制台产物。若不接受该限制，需移除地图相关功能或替换组件 |
| Font Awesome Free | CC BY 4.0 + MIT（双许可） | 需署名 |
| DB-IP City Lite mmdb | CC BY 4.0 | 随地理富化 Layer 分发，控制台页脚已署名 |
| [shlink](https://github.com/shlinkio/shlink) 服务端（契约参考） | MIT | Copyright (c) 2016-2026 Alejandro Celaya —— 开发期参考，本仓库不再 vendor 其源码 |

注意事项：

- 控制台构建产物目前由 Vite 压缩，**未保留各 MIT 依赖的版权声明横幅**。若对外分发产物，建议补 `THIRD-PARTY-NOTICES` 或在构建中保留 banner。
- `Hippocratic-2.1` 不是 copyleft，不会「传染」自有代码；但它附加了使用限制，因此**分发产物不能声称是纯 MIT**，需按上表单独标注。
- 本项目未使用任何 GPL/AGPL/SSPL 等 copyleft 依赖。

## 安全红线

- 凭据只写变量名；值在 `supabase/functions/.env`（gitignore）与 FC 函数环境变量里。
- API key 明文只本地生成、只打印一次，库里只存 sha256；丢了只能重新生成。
- 任何函数不回显、不记录请求头（含明文库密码与各类 access key）；`Location` 只取库里 `long_url`，请求不参与拼接。
