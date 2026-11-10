# I3 验证记录：控制台连通（B1）

日期：2026-11-09。环境：线上 ADB Supabase（`rxlink`）+ FC `compat` 函数。

## 1. 本轮落地

| 件 | 内容 |
|---|---|
| `supabase/migrations/0008_compat_api.sql` | `compat_auth` / `list_short_urls` / `get_short_url` / `update_short_url` / `delete_short_url`，全部 security invoker，只授 service_role |
| `supabase/functions/compat/index.ts` | `/rest/v3` 路由；`OPTIONS` 204；`X-Api-Key` 只在函数内算 sha256；`/health` 免鉴权；错误体 RFC7807 |
| `scripts/new-api-key.sh` | 本地生成 `rxl_<48hex>`，只把 sha256 入库，明文只打印一次 |

`0008` 共 6 条语句，逐条执行 6/6 OK。`compat` 部署第 1 次 500（`Failed to deploy Deno function`，已知控制面偶发），原样重试即 ACTIVE，`verify_jwt=false`。

## 2. curl 矩阵（线上网管）

基址：`https://your-project-ref.supabase.co/functions/v1/compat/rest/v3`

| 请求 | 结果 |
|---|---|
| `GET /health`（无 key） | `200 {"status":"pass","version":"4.0.0"}` |
| `GET /short-urls`（正确 key） | `200`，`{shortUrls:{data:[...],pagination:{...}}}`，每行含 `meta` 三键 / `visitsSummary` / `tags` / `hasRedirectRules` |
| `GET /short-urls/compat1` | `200`，`domain:null`（默认域名序列化正确） |
| `GET /short-urls/nope123` | `404` `short-url-not-found` |
| 无 `X-Api-Key` | `401` `missing-authentication` |
| 伪造 key | `401` `invalid-api-key` |
| `POST /short-urls`（自动短码 + 标签 + crawlable/forwardQuery） | `200`，返回完整短链 JSON，`shortUrl=http://example.com/9e6h3` |
| `POST /short-urls`（重复 customSlug） | `409` `non-unique-slug`，`detail` 为 `Custom slug "xxx" is already in use` |
| `PATCH /short-urls/{code}` | `200`，标题/标签整组替换生效 |
| `DELETE /short-urls/{code}` | `204` 空体；再 `GET` → `404` |
| `GET /short-urls?itemsPerPage=2&page=2` | `200`，第二页 2 条，`pagesCount:2 totalItems:4` |
| `OPTIONS /short-urls`（带 Origin） | `204` + `Allow-Headers: X-Api-Key, Content-Type`；网关会再补一条 `Access-Control-Allow-Origin: *` |

## 3. 控制台实测

用 `shlink-web-client/` v4.9.0 的 build 产物起静态服务（`python3 -m http.server 8787`），Playwright 无头浏览器跑完整流程：

1. Add server：URL 填 `https://<api-host>/functions/v1/compat`，API key 用本轮临时 key ⇒ 不报「不可达」，Overview 页底部显示 `Server: v4.0.0`。
2. Overview 自动拉到已有短链（`compat1`、`2b9yj`），列表字段完整。
3. Create short URL：`https://example.com/i3-ui-created` + custom slug `i3ui` ⇒ 提示 `Great! The short URL is http://example.com/i3ui`（`POST 200`）。
4. 行内 Options → Edit short URL → 改标题 → Save ⇒ `PATCH 200`，提示 `Short URL properly edited.`。
5. 行内 Options → Delete short URL → 输入 `delete` 确认 ⇒ `DELETE 204`，列表剩 2 条。
6. 重复 slug：再次提交 `dui3` ⇒ 表单下方显示 `Custom slug "dui3" is already in use`（不再是 `non_unique_slug` 裸错误码）。
7. 错误 key：加服务器能过（`/health` 免鉴权），列表请求 `401 invalid-api-key` ⇒ 界面显示 `Something went wrong while loading short URLs :(`，无 JSON 解析报错。

跳转联动（与 I2 缓存一并验）：

| 动作 | 6s 后 `http://example.com/dui3` |
|---|---|
| 创建（`target-a`） | `302 Location: https://example.com/target-a` |
| 编辑 longUrl → `target-b` | `302 Location: https://example.com/target-b` |
| 删除 | `404` |

截图：[overview](assets/i3-overview.png) / [list](assets/i3-list.png) / [after delete](assets/i3-after-delete.png)。

## 4. 已知缺口（按批次预期）

控制台每次进 Overview 会请求 B2/B3/B4 的端点，现在都是 404，页面降级显示 0，不阻塞 B1：

| 请求 | 现状 | 归属 |
|---|---|---|
| `GET /visits` | 404 ⇒ VISITS/ORPHAN VISITS 显示 0 | B2 |
| `GET /tags/stats` | 404 ⇒ TAGS 显示 0 | B3 |
| `GET /domains` | 404 ⇒ 创建页 Domain 下拉为空 | B4 |
| `GET /mercure-info` | 404（预期就是故意失败） | B4 |

另外 `GET /rest/v3/health?domain=...`（域名健康检查）会按 SDK 规则换成 `example.com` 的 authority，FC 上还没有这条路径路由，B4/HTTPS 阶段一起做。

## 5. 收尾

- 临时验证 key `i3-test` / `i3-test2` 已从 `api_key` 删除；库里当前 0 条 key，正式 key 由 `scripts/new-api-key.sh` 生成。
- 测试短链 `compat1` / `9e6h3` / `i3ui` / `dui3` / `pga1..3` 已软删（`enabled=false`），线上仅保留 `2b9yj`。
- 控制台服务器地址暂用 API 网关域名；HTTPS 与 `example.com` 路径路由到位后换成正式域名。
