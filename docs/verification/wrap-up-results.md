# 收尾批次（404 回退 + scheme https）—— 验证记录

> 执行日期：2026-11-10。TDD（先写失败测试再实现）；线上闭环在真实默认域名配置后清理。
> 状态：**已完成**。回归测试 11/11，线上三类回跳 + 命中回归全通，临时配置已清。

## 1. 改了什么

| 项 | 内容 |
|---|---|
| 迁移 | `supabase/migrations/0011_fallback_and_scheme.sql`：新增 `not_found_redirects(text)` RPC（域名级优先、逐列回落 id=0 全局；只授 service_role）；纠正 0004 三列注释（原注释 regular404/invalid_short_url 写反）；默认域名 scheme `http`→`https` |
| 跳转函数 | `fc/redirect/index.js`：404 分支统一走 `replyNotFound`——按需查 RPC（不进快照、无需失效），配了就 302 回跳，支持 `{DOMAIN}`/`{ORIGINAL_PATH}`（path 原样+折叠双斜杠、query 编码），查询失败/未配置降级裸 404；孤儿分类对齐 shlink（根=base_url、形状不合法=regular_404、码不存在=invalid_short_url） |
| 测试 | `fc/redirect/test/redirect.test.js`（node:test，真实子进程 + 进程内 mock 网关，断言响应与 inbox 落库） |

## 2. RED→GREEN 证据

- RED：首跑 10 例中 7 例失败（回退缺失），失败原因均为 `404 !== 302`。
- 双斜杠 bug：线上闭环发现 `/fb/{ORIGINAL_PATH}` → `/fb//nosuch`；补「折叠双斜杠」用例先看它失败（`actual: 'https://example.com/fb//nosuch'`），再照 shlink `NotFoundRedirectResolver.php:72-75` 修。
- 修复中的一次回归：在整串上折叠把 `https://` 也折了（7 例失败）⇒ 改为按 URL 组件处理（`u.pathname`/`u.search`）。
- GREEN：**11/11 通过**（`node --test fc/redirect/test/redirect.test.js`）。

## 3. 线上闭环（example.com，配置后已清理）

| 请求 | 结果 |
|---|---|
| 临时给 id=0 配三类回退后 `GET /nosuch-i6` | `302` → `https://example.com/fb/nosuch-i6`（无当字符斜杠） |
| `GET /a/b` | `302` → `https://example.com/404/a/b` |
| `GET /` | `302` → `https://example.com/home/example.com` |
| `GET /2b9yj`（命中回归） | `302` → 原长链，`Server-Timing: resolve;dur=0;cached=1` |
| 清理配置后 `GET /nosuch-i6` | `404`（恢复裸 404） |

- 孤儿分类落库：闭环期间 `visit_inbox` 新增 `base_url` 23 / `invalid_short_url` 7 / `regular_404` 5，时间戳与测试窗口吻合。
- 清理：`update domain set 三列=null where id=0`；`delete from domain where authority='fbtest.example'`（临时行 id=1 已删）。

## 4. 库侧核验

- `select * from not_found_redirects('example.com')` → 三 NULL（未配回退）。
- `domain id=0`：`scheme=https`。
- 权限：`service_role` 可执行、`anon` 不可。

## 5. 平台事实（新增，实测）

- **FC 自定义域名会改写 Host 头**：`curl -H 'Host: fbtest.example' https://example.com/...` 不生效（函数侧看到的是真实域名）⇒ 验证域名级配置只能配真实域名。
- 应用迁移逐条执行时 **`$$` 函数体不能被 `;` 拆分**——拆分器需识别 dollar-quote，否则函数体被腰斩。

## 6. 遗留

- 云上三件清理（他）：cdndev 域名/解析下线、FC 账号探针残留、闲置 `console` Edge 函数。
- 发布前置：Supabase 升付费版（免费版禁生产）。
- 地理富化方案（IP 短暂留存已拍板）待设计。
