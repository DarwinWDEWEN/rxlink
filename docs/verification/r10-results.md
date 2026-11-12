# I10 / R10 标题自动解析 —— 验收记录

> 日期：2026-11-12
> 范围：建链自动抓标题、编辑刷新自动解析的标题、手填标题粘性、SSRF 拦截、开关降级、失败降级与延迟。
> 设计稿：`docs/superpowers/specs/2026-11-12-r10-title-auto-resolve-design.md`（`bf8a7b8` / `3c39d16`）
> 实施计划：`docs/superpowers/plans/2026-11-12-r10-title-auto-resolve.md`（`91b6571`）

---

## 1. 迁移 0020（`supabase/migrations/0020_title_auto_resolve.sql`）

切分成 **6 条**语句逐条执行，全部 `rc=0`：

| # | 语句 | 结果 |
|---|---|---|
| 1 | `alter table short_url add column if not exists title_was_auto_resolved ...` | ALTER TABLE |
| 2 | `drop function if exists create_short_url(13 参)` | DROP FUNCTION |
| 3 | `create or replace function create_short_url(14 参)` | CREATE FUNCTION |
| 4 | `drop function if exists update_short_url(text,text,jsonb)` | DROP FUNCTION |
| 5 | `create or replace function update_short_url(text,text,jsonb,text)` | CREATE FUNCTION |
| 6 | `do $$ ... $$`（权限收口） | DO |

**结构与权限断言**：

- 列：`title_was_auto_resolved | boolean | NOT NULL | default false` ✅
- 签名：`create_short_url(..., p_title_was_auto_resolved boolean)` / `update_short_url(p_code, p_domain, p_patch, p_auto_title text)` ✅
- 权限：`anon` 对两个 RPC 的 `execute` 均为 **false**；`service_role` 为 **true** ✅

**迁移期兼容性（设计稿 §4.7 的主张，线上实测）**：
用旧签名（13 个位置参数）调用 `create_short_url` 成功 → `r10legacy | Legacy Title | false` ✅
→ 旧版兼容层在迁移后照常工作，**「迁移先行、代码后发」安全**。
实测：迁移应用后，**未重新部署的旧版 compat 建链仍返回 200** ✅

**写标题规则（真实数据，5 条编辑规则逐条命中）**：

| 场景 | 结果 |
|---|---|
| 建链 + `p_title_was_auto_resolved => true` | `Auto Title \| t` |
| 建链 + 手填标题 | `Manual Title \| f` |
| 建链 + 无标题 | `null \| f` |
| 编辑：手填标题 | `Manual Now \| f`（来源置 false） |
| 编辑：改长链 + `p_auto_title`，原标题是**手填** | 标题保留 `Manual Now`（**手填粘性**） |
| 编辑：改长链 + `p_auto_title`，原标题为 **null** | 写入 `Filled Title \| t` |
| 编辑：改长链 + `p_auto_title`，原标题是**自动解析** | 刷新为 `Refreshed Title \| t` |
| 编辑：改长链 + `p_auto_title = null` | 保留原标题 `Refreshed Title \| t`（**抓不到不清空**） |

**`link_version` 的真实行为（修正了设计稿 §4.6 的错误断言）**：
Postgres 的 `UPDATE OF col` 触发器按 **SET 列表**判定，**不看值是否真的变化**。
`update_short_url` 的 SET 列表永远包含 `forward_query` / `valid_since` / `valid_until` / `max_visits`
（用 CASE 保留旧值），这些列都在触发器清单里 → **任何一次 `update_short_url` 调用都会 bump `link_version`**。
实测：只改标题时 seq 117 → 118。
对照实验：手写 `update short_url set title = title where ...` → seq **不前进**（触发器清单不含 title）。
这是 **0008 起的既有行为**，R10 只多加一列，不改变触发与否。无正确性问题。

---

## 2. 本机测试

| 套件 | 用例数 | 结果 |
|---|---|---|
| `supabase/functions/compat/test/title-resolver.test.ts`（新建） | 73 | 全绿 |
| `supabase/functions/compat/test/compat.test.ts`（既有 35 + R10 9） | 44 | 全绿 |
| **合计** | **117** | **0 失败** |

`deno check`（5 个文件）干净。

### 覆盖要点

- **标题提取**：普通 / 多属性 / 大小写 / 无 title / 跨行不匹配（对齐上游无 `s` 标志）/ 取第一个
- **charset**：Content-Type 头 / `<meta charset>` / `<meta http-equiv>` / 三者皆无 → 丢弃标题
- **转码**：utf-8 / gb2312 / gbk / latin1 / 不认识的标签 → 丢弃
- **实体解码**：命名 / 数字 / 双重编码 / `&apos;` 不解码 / 未知实体保留
- **SSRF 拒绝表（22 条）**：`0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.0.0/24`、`192.168/16`、`198.18/15`、224/4、240/4、`::`、`::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`、`::ffff:127.0.0.1`、`::ffff:10.0.0.1`、`64:ff9b::127.0.0.1`、`2002:7f00:1::1`
- **SSRF 放行表（7 条）**：`1.1.1.1`、`8.8.8.8`、`93.184.216.34`、`100.128.0.1`、`172.32.0.1`、`2606:4700:4700::1111`、`2001:4860:4860::8888`
- **主机校验**：任一解析结果落内网 → 整体拒绝（不挑一个）；解析为空 → 拒绝；IP 字面量不查 DNS
- **抓取**：Chrome UA + `redirect=manual` / 跟随重定向 / 跳内网被拒 / 超 15 跳放弃 / 非 text/html / charset 认不出 / 超时 / 截断 512
- **日志**：只出现「原因码 + host」，**不出现完整 URL**（断言 `!logs[0].includes('token=secret')`）

---

## 3. 部署

```bash
node scripts/build-compat-function.mjs
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat \
  -d supabase/functions/compat/dist --no-verify-jwt
```

→ `status: ACTIVE`；`/health` → `{"status":"pass","version":"5.1.0"}`。

**部署前踩到一个会直接炸掉的坑（已修）**：`scripts/build-compat-function.mjs` 原来只做「复制 handler.ts」，
不处理依赖。R10 之前 `handler.ts` 完全没有 import（自包含），这个前提成立；
新增 `title-resolver.ts` 后，产物里保留了 `import ... from './title-resolver.ts'`，
而该文件**不在部署包里** → 运行时加载失败。
修法：构建脚本按依赖顺序**内联**本地相对 import，并加两层保护（顶层重名硬失败 / 非相对 import 硬失败）。
验证：产物 `import` 行数 **0**、`deno check` 干净、起真实进程冒烟（`/rest/v3/health` 200、无 key 401）。

---

## 4. 线上验收

### 4.1 建链自动抓标题（**Edge Function 出公网可行**）

```bash
curl -X POST .../rest/v3/short-urls -H "X-Api-Key: $KEY" \
  -d '{"longUrl":"https://example.com/"}'
```

响应：`title: "Example Domain"`，`HTTP 200` ✅
落库：`5cd4y | https://example.com/ | Example Domain | true` ✅

> 这是本轮最大的未知项（用户授权时按「假定可出公网」推进）—— **实测确认 ADB Supabase Edge Function 可以出公网**。

### 4.2 SSRF 拦截

| 目标 | 响应 | 落库 |
|---|---|---|
| `http://169.254.169.254/latest/meta-data/`（云元数据） | `HTTP 200`（建链成功） | `eek8o \| NULL \| false` ✅ |
| `http://localhost:5432/` | `HTTP 200`（建链成功） | `8kjgh \| NULL \| false` ✅ |

**建链成功但没有标题** = 被拦截的预期表现（不报错、不阻断主流程）。

### 4.3 编辑刷新 / 手填粘性

| 操作 | 落库结果 |
|---|---|
| 改长链 → `https://www.iana.org/domains/reserved` | `IANA-managed Reserved Domains \| true` ✅ 标题已刷新 |
| 手填 `{"title":"手填的标题"}` | `手填的标题 \| false` ✅ 来源置 false |
| 再改长链 → `https://example.org/` | `手填的标题 \| false` ✅ **手填标题未被覆盖** |

### 4.4 开关 `AUTO_RESOLVE_TITLES`

| 状态 | 建链结果 |
|---|---|
| 未设置（默认开） | `title: "Example Domain"` ✅ |
| `AUTO_RESOLVE_TITLES=false` | `title: None` ✅ |
| 取消 secret + 重新部署（还原） | `title: "Example Domain"` ✅ |

> **重要运维事实**：Edge Function 的 secret **必须重新部署才会注入**。
> 只 `secrets set` 不部署，开关不生效（实测确认）。
> 语法是 `NAME=VALUE`：`functions-cli secrets set AUTO_RESOLVE_TITLES=false`。

### 4.5 延迟实测（建链总耗时，含抓取）

5 次连续建链：`0.658s / 0.335s / 1.266s / 0.354s / 0.448s`

- p50 ≈ **0.45s**，最大 **1.27s**，全部远低于抓取超时上限 3s ✅

---

## 5. 清理

- 验收产生的 14 条短链已删（库恢复：**1 条启用短链 `2b9yj`**）
- 临时 `api_key`（`r10-verify`）已删（库恢复：**2 个 key `console` / `console-2`**）
- `AUTO_RESOLVE_TITLES` secret 已取消（`secrets list` 中出现次数 0）
- 明文 key 文件 `/tmp/rxl-api-key.txt` 已删除
- I9 数据未受影响：`short_url_redirect_rule` 0 行 / `redirect_condition` 0 行

---

## 6. 已知限制与遗留

1. **DNS rebinding 残余风险**：校验用的解析结果与 `fetch` 实际连接用的解析结果可能不同（Deno `fetch` 内部二次解析，无法指定已解析 IP）。彻底消除需手写 pinned transport（`Deno.connect` + `Deno.startTls` + 手写 HTTP/1.1 与 chunked/gzip/br 解码），约 300 行，本次不做。
2. `findIfExists` 命中时会白抓一次（上游先查复用再决定抓不抓）。
3. 显式空标题归一为 `null`（上游存 `''`）；副作用：清空标题后再改长链会重新自动抓一次（上游不会）。
4. 实体解码是 HTML401 核心集的近似实现（核心 4 个 + 常见标点 + 数字实体），非与 PHP 逐条一致。
5. 自动解析标题截断到 512 字符（上游不截断，但上游列是 `varchar(512)`，长标题会撞列长度）。
6. `longUrl` 不做 URL 格式校验 —— rxlink 全局口径（上游用 `LooseUriConverter`），跨切面改动，不在 R10 范围。
7. 抓取在请求内同步执行 —— 建链接口延迟 +0~1.3s（实测）。
