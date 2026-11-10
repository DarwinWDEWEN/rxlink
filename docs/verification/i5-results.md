# I5 验证记录：控制台补全（B3/B4）+ 静态托管

日期：2026-11-09。环境：线上 ADB Supabase（`rxlink`）+ FC `compat` / `console` 函数。

## 1. 本轮落地

| 件 | 内容 |
|---|---|
| `supabase/migrations/0010_console_api.sql` | 7 个 RPC：`list_tags` / `tag_stats` / `delete_tags` / `edit_tag` / `list_domains` / `update_domain_redirects` / `get_short_url_redirect_rules`；权限仍只授 `service_role` |
| `supabase/functions/compat/index.ts` | 新增 9 条路由：`GET/DELETE/PUT /tags`、`GET /tags/stats`、`GET /domains`、`PATCH /domains/redirects`、`GET /mercure-info`（404）、`GET/POST /short-urls/{code}/redirect-rules`（POST 501）；错误标题补齐 409/501 |
| `scripts/console-function.template.ts` + `scripts/build-console-function.mjs` | 把 `shlink-web-client/build` 全部产物 base64 内联成单文件 Edge Function（`functions-cli` 只上传入口文件，不打包静态资源） |
| `supabase/functions/console/index.ts` | 生成文件，37 个资源、2.10 MB；已部署为 ACTIVE（Supabase 托管侧，仅网关路径可访问） |
| `fc/console/index.js` + `fc/console/package.json` + `scripts/build-console-fc.mjs` | 正式地址用的 FC Web 函数（Node、零依赖）：`node index.js` 监听 `FC_SERVER_PORT`，带 SPA 回退与静态缓存头；`package.json` 让 FC 现成的 `npm run start` 可用 |
| `dist/console.zip` | FC 上传包：`index.js` + `package.json` + `build/` 37 个资源，42 个文件 / 519 KB |

`0010` 共 8 条语句，逐条执行 8/8 OK。版本旋钮保持 `4.0.0`（D 系列未实现前不上报更高版本，契约 §5）。

## 2. curl 矩阵（线上网关）

基址：`https://your-project-ref.supabase.co/functions/v1/compat/rest/v3`

联调中修过一处：原先所有 P0002 都映射成 `short-url-not-found`，导致标签/域名 404 的 `type` 语义错误；改为按底层 message 分别映射 `tag-not-found` / `domain-not-found` / `short-url-not-found`，重新部署后三种均复测通过。

### B3 标签

| 请求 | 结果 |
|---|---|
| `GET /tags` | `200 {"tags":{"data":["i3","i4","i5mode-a","i5mode-b","x","测试"]}}`（按名排序） |
| `GET /tags/stats` | `200`；`i5mode-a` → `shortUrlsCount:2`、`i5mode-b` → `shortUrlsCount:1`，`visitsSummary` 三项齐全 |
| `PUT /tags`（`{"oldName":"i5ui","newName":"i5ui2"}`） | `204`；库中标签改名，短链关联保留 |
| `PUT /tags`（重名） | `409 non-unique-tag`（`Tag "…" already exists`） |
| `PUT /tags`（缺字段） | `400 invalid-data` |
| `PUT /tags`（旧名不存在） | `404 tag-not-found`（修复后语义正确） |
| `DELETE /tags?tags[]=i5ui2` | `204`；标签删除，短链本身不动 |
| `GET /short-urls?tags[]=i5mode-a&tags[]=i5mode-b&tagsMode=all` | `totalItems:1` → `["i5mode1"]`（同时含两个标签） |
| 同上 `tagsMode=any` | `totalItems:2` → `["i5mode2","i5mode1"]`（含任一标签） |

### B4 域名 / Mercure / 跳转规则

| 请求 | 结果 |
|---|---|
| `GET /domains` | `200`；`data:[{domain:"example.com",isDefault:true,redirects:{…null}}]`，`defaultRedirects` 同样三项 |
| `PATCH /domains/redirects`（`baseUrlRedirect`） | `200` 返回裸 `{baseUrlRedirect,regular404Redirect,invalidShortUrlRedirect}`；回读一致，再置 `null` 复原 |
| `PATCH /domains/redirects`（未知域名） | `404 domain-not-found` |
| `GET /mercure-info` | `404 MERCURE_NOT_CONFIGURED`（界面按未配置降级） |
| `GET /short-urls/i5ui/redirect-rules` | `200 {"defaultLongUrl":"…","redirectRules":[]}` |
| `POST /short-urls/i5ui/redirect-rules` | `501 not-implemented`（`Redirect rules are not supported until M3`） |
| 不存在的短码取规则 | `404 short-url-not-found` |

## 3. 控制台实测（Playwright，v4.9.0 build）

1. Tags 页：标签由短链编辑时新建；列表、统计数字与库一致；重命名发 `204 PUT /rest/v3/tags`，行内立即变更；删除发 `204 DELETE /rest/v3/tags?tags%5B%5D=…`，行消失。
2. Domains 页：列出 `example.com`；编辑 Base URL 回退后发 `200 PATCH /rest/v3/domains/redirects`，界面显示 `https://example.com/fallback`，随后通过 API 置回 `null`。
3. 短链详情 → Redirect rules：打开发 `200 GET …/redirect-rules`，页面显示 “This short URL has no dynamic redirect rules”；保存发 `501 POST`，界面显示明确错误 “Redirect rules are not supported until M3”，未白屏。
4. Service Worker：`navigator.serviceWorker.getRegistrations()` → **1 条 active**；Network 面板中 `/rest/v3/*` 均为直连，无 API 响应被缓存。
5. Mercure：v4.9.0 控制台代码没有调用 `mercureInfo` 的路径（`src/` 内无匹配），页面加载不依赖该端点；端点本身按契约返回 404。

## 4. 静态托管

### 4.1 网关里的 Edge Function（可跑通，但不能挂自定义域名）

`functions-cli` 只上传入口文件，不做依赖/资源打包（`site/hello.txt`、顶层 `hello.txt`、Deno 文本 import 三种方式均失败）。因此 `bash scripts/build-console-function.mjs` 把 `shlink-web-client/build`（37 个文件、1.7 MB）base64 内联进 `supabase/functions/console/index.ts`（2.10 MB），再 `functions-cli deploy console --no-verify-jwt`。

- 行为：只接受 GET/HEAD；`/` → `index.html`；带扩展名且不存在 → 404；其余深链回 `index.html`；`/assets/*` immutable，其余 `no-cache`。
- 线上探测（Supabase 网关路径，非正式域名）：

| 路径 | 结果 |
|---|---|
| `GET /functions/v1/console/` | `200 text/html` 6238 B |
| `GET /functions/v1/console/assets/index-XmYP89Qr.js` | `200` 1,462,669 B，immutable |
| `GET /functions/v1/console/assets/index-C0JAzzK4.css` | `200` 69,674 B，immutable |
| `GET …/manifest.json` / `…/service-worker.js` | `200`，`no-cache` |
| `GET …/some/deep/route` | `200` 回 `index.html` |
| `GET …/nope.txt` | `404` |
| `HEAD …/` | `200`，无 body |

**限制**：这个函数在 Supabase 托管侧的 FC 实例里，不会出现在用户自己 FC 账号的「函数名称」下拉中；`console.example.com` 的路由只能选用户账号里的函数。实测绑到示例函数 `console-prod` 时，所有路径都返回 `Hello World!`（12 B）。

### 4.2 正式地址：用户 FC 账号里的 Web 函数

1. `node scripts/build-console-fc.mjs` 把 `fc/console/index.js`（Node、零依赖）、`package.json` 与 `build/` 打进 `dist/console.zip`（42 个文件、519 KB）。
2. FC 控制台 → 函数 `console-prod` → 代码上传 → 选 `dist/console.zip` → 部署。函数现有启动命令是 `npm run start`，包内 `package.json` 已把它指向 `node index.js`，监听 `0.0.0.0:${FC_SERVER_PORT:-9000}`。
3. 首次上传只带 `index.js` 时函数起不来：`412 CAExited`，日志 `npm error path /code/package.json`。补 `package.json` 后本机用 `npm run start` 复测通过（根页 200 / JS 200）。
4. 自定义域名 `console.example.com` 的路由 `/*` → `console-prod`（LATEST），再配好证书并启用强制 HTTPS。
5. 回滚 = 回退 `shlink-web-client/` 源码 → 重新 build → 重新打 zip → 重新上传；`build/` 与 zip 都不手改。

**本机实测**（`CONSOLE_ROOT=shlink-web-client/build FC_SERVER_PORT=8793 node fc/console/index.js`）：

| 请求 | 结果 |
|---|---|
| `GET /` | `200 text/html` 6238 B，`no-cache`，开头 `<!DOCTYPE html>` |
| `GET /assets/index-XmYP89Qr.js` | `200` 1,462,669 B，immutable |
| `GET /assets/index-C0JAzzK4.css` | `200` 69,674 B，immutable |
| `GET /some/deep/route` | `200` 回 `index.html` |
| `GET /nope.txt` | `404` |
| `HEAD /` | `200`，无 body |

**正式地址实测**（`https://console.example.com`，证书由他已配好，无 `-k`）：

- 证书：`CN=console.example.com`（SAN 含该域名），DigiCert `Encryption Everywhere DV TLS CA - G2` 签发，有效期 2026-11-10 → 2027-02-07。

| 请求 | 结果 |
|---|---|
| `GET /` | `200 text/html` 6238 B，`no-cache`，开头 `<!DOCTYPE html>` |
| `GET /assets/index-XmYP89Qr.js` | `200` 1,462,669 B，immutable |
| `GET /assets/index-C0JAzzK4.css` | `200` 69,674 B，immutable |
| `GET /some/deep/route` | `200` 回 `index.html` |
| `GET /nope.txt` | `404` |
| `GET http://console.example.com/` | `301` → `https://console.example.com/`；深链同样 301 并保留路径（强制 HTTPS 已开） |

浏览器 E2E（Playwright，临时 key `i5-final`，正常校验证书）：

| 页面 | 结果 |
|---|---|
| `/server/i5final/overview` | 200，真实数据：VISITS 16 / ORPHAN 14 / SHORT URLS 1 / TAGS 4；最近短链 `http://example.com/2b9yj` |
| `/server/i5final/list-short-urls/1` | 200，列表含 `2b9yj`，深链 reload 仍正常渲染 |
| `/server/i5final/manage-tags` | 200，`i3` / `i4` / `x` / `测试` |
| `/server/i5final/manage-domains` | 200，`example.com` |
| `/server/i5final/short-code/2b9yj/visits` | 200，Visits 13，曲线与明细正常 |

- 31 次 `/rest/v3/` 跨域调用：除 `mercure-info` 按预期 `404` 外全部 `200`；页面错误 0 ⇒ 兼容层 CORS 在正式域名下可用。
- 前端路由实际路径是 `/list-short-urls/1`、`/manage-tags`、`/manage-domains`（不是 `/list`、`/tags`）。
- **Service Worker 已注册**：`active` 1 条，scope `https://console.example.com/`，`navigator.serviceWorker.controller` 为 true，无注册错误。
- 唯一的失败请求是 `https://example.com/functions/v1/compat/rest/v3/health`（`ERR_CERT_COMMON_NAME_INVALID`）：Domains 页会按短链域名做健康检查，而 `example.com` 尚未配证书 —— 即已知的 Domains 红标来源，归 I6。

## 5. 已知缺口（按批次预期）

| 项 | 现状 | 归属 |
|---|---|---|
| 控制台正式地址 | **已完成**：`https://console.example.com` 证书有效，页面/资源/深链/SW/跨域 API 全通 | — |
| `POST /short-urls/{code}/redirect-rules` | 固定 `501` | M3 |
| Mercure 实时推送 | 端点 404；控制台不依赖 | 不做（或 M3 再评估） |
| Domains 页红标 | 健康检查走短链域名 `example.com`，该域名尚无证书；按 I0 接受 | I6 配证书后复查 |
| 内联函数体积 | 2.10 MB；控制台再增资源需关注 FC 包大小上限 | 观察项 |

## 6. 收尾

- 临时验证 key `i5-ui-test`、`i5-mode-test`、`i5-e2e`、`i5-final` 已删；库里只剩他本地的 `console` key。
- 测试短链 `i5ui` 及其 1 条访问已物理删除；`i5mode1` / `i5mode2` 及标签 `i5mode-a/b` 已删。
- 当前对账：`visit` 明细 16 行、孤儿 0；`short_url` 9 行；标签 `i3` / `i4` / `x` / `测试` 保留。
- 本地静态服务（:8787）与临时 Playwright 脚本已清理；`statictest` 函数平台侧仍为 `DELETING`，无需再操作。
