# I7 地理富化 —— 验证记录

> 执行日期：2026-11-10 ～ 2026-11-11。通道：`supabase db query --db-url`（逐条）、FC 控制台、`curl`、Node 24 测试。
> 状态：**全部完成，I7 已验收**（2026-11-11）。数据面 0012/0013/0014、跳转带 IP、富化函数、契约与兜底均已上线；定时触发器自动运行与手动执行双向通过。

## 1. 数据面迁移（已应用）

| 迁移 | 语句数 | 内容 |
|---|---|---|
| `0012_geo_location.sql` | 15 | `visit_inbox.remote_addr`；`visit` 加 `remote_addr` + `country/region/city` 正名为 `country_name/region_name/city_name` + 加 `country_code/lat/lon/timezone`；部分索引 `visit_pending_location_idx`；三个 RPC（只授 `service_role`）；覆盖 `drain_visit_inbox` 与 `visit_json` |
| `0013_geo_location_id_match.sql` | 2 | 修回写失配：PostgREST timestamptz 只到毫秒，改为只按 `id` 匹配 + 单条 set-based UPDATE |
| `0014_drain_clear_remote_addr.sql` | 1 | 覆盖 `drain_visit_inbox`：落库后立即清空 `visit_inbox.remote_addr`，入队侧 IP 留存从「最长 1 天」压到「分钟级」 |

## 2. 跳转函数带 remote_addr（#42）

- `fc/redirect/index.js`：取 `x-forwarded-for` 首元素，截断 64，无值写 null。
- 单测 11 → 15 例全绿。
- 产物 `dist/redirect.zip`（6KB，`index.js` 9072 字节）已上传到 `example.com` 绑定的跳转函数。

## 3. 富化函数（#43）

- `fc/geo-enrich/`：`lib.js` + `index.js` + 26 例单测；mmdb 走 FC Layer（`/opt/geoip/`）。
- 数据源 **DB-IP City Lite**（CC BY 4.0，免 key，允许商用）；brotli q6 压到 52.35MB。
- 产物 `dist/geo-enrich.zip`（55KB）+ `dist/geoip-layer.zip`（52.2MB）→ FC 富化函数 + Layer。
- 手动执行返回 `{"ok":true,"batches":1,"pulled":4,"updated":4}`。

## 4. 契约与兜底（#44）

- `visit_json` 读列；`retire_remote_addr(7)` 由 pg_cron 每小时（jobid 9 `rxlink-retire-ip`）做 7 天硬留存。
- 健康查询 cron 现状：jobid 6/8/9 均 active。

## 5. 端到端验收（2026-11-11）

### 5.1 定时触发器自动运行

- 探针 1488（`8.8.4.4`）在 **04:00 UTC 整点被自动富化** → `US / United States / California / Mountain View`。
- 富化后水位：`ip_pending=0`、`enriched=296`。

### 5.2 手动执行

- 返回 `{"ok":true,"batches":1,"pulled":4,"updated":4}`。
- 探针 1484（`1.1.1.1`）→ `AU / New South Wales / Sydney`（-33.8688, 151.209）。
- 3 条真实流量 → `CN / Changning`。

### 5.3 线上水位

```
visit_total=456  enriched=296  ip_pending=0  inbox_holding_ip=0  inbox_rows=424
```

### 5.4 跳转热路径

- `example.com/2b9yj` → 302；未知码 → 404；真实流量已恢复。

### 5.5 控制台 DB-IP 署名

- `console.example.com` → 200 / **6753 字节**（注入后），含 `rxlink-attribution`、`IP Geolocation by`、`href="https://db-ip.com"`。
- 深链 `/visits/42` → 200 且带署名；静态资源 200；缺失资源 404。
- 产物 `dist/console.zip`（531KB）已重建并上传到 `console-prod`。

### 5.6 权限复核

- `visit` / `visit_inbox` / `visit_bak_0012` 均 `force RLS` + 0 policy；`anon`/`authenticated` 表级与列级授权均为空。

### 5.7 测试

- console 7/7、geo-enrich 26/26、redirect 15/15，共 **48 例全绿**。

## 6. 事故与修复：console.zip 误传

用户把 `dist/console.zip` 传到了 `example.com` 绑定的跳转函数上，导致跳转热路径被 SPA 覆盖。

- **修复**：把 `dist/redirect.zip` 传回跳转函数、`dist/console.zip` 传到 `console-prod`。
- **修复后复测**：两个域名均正常（跳转 302/404、控制台 200 + 署名）。
- **教训**：两个函数的产物同名不同内容，上传前核对目标函数名与产物对应关系。

## 7. 遗留

- **DB-IP 无 `time_zone` 字段** → `visit.timezone` 恒 NULL（契约允许 null，控制台不渲染）。要时区需把 `GEO_MMDB_URL` 指向带 time_zone 的库。
- **月更**：DB-IP 每月初发布新版；`node scripts/build-geoip-bundle.mjs` → `node scripts/build-geo-enrich-fc.mjs` → 重新上传 Layer。
- **备份表 `visit_bak_0012`**（158 行，RLS 已收口）保留到 #40 发布完成后再 drop。
- **付费版暂不处理**：用户明确先验收，之后再决定是否升付费版。
