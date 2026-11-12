# I10 —— R10 标题自动解析（设计稿）

> 状态：设计已确认（2026-11-12），待用户审阅本文档 → 实施计划。
> 范围：shlink 的**标题自动解析**（auto-resolve titles）。建短链时自动抓目标页 `<title>` 填入 `short_url.title`；手填标题保持粘性，自动解析的标题才允许被刷新。
> 参考（vendored 源码）：`shlink/module/Core/src/ShortUrl/Helper/ShortUrlTitleResolutionHelper.php`、`UrlShortener.php`、`ShortUrlService.php`、`Model/ShortUrlCreation.php`、`Model/ShortUrlEdition.php`、`Entity/ShortUrl.php`、`config/entities-mappings/Shlinkio.Shlink.Core.ShortUrl.Entity.ShortUrl.php`。

---

## 1. 目标与非目标

### 1.1 目标

1. 建链时**未填标题** → 自动抓目标页 `<title>` 写入 `short_url.title`。
2. 抓来的标题**可识别来源**（新增 `title_was_auto_resolved` 列），编辑时只刷新自动解析的标题；**用户手填的标题不被自动覆盖**（对齐上游）。
3. 抓取全过程 **SSRF 防护**（fail-closed）—— `longUrl` 用户可控，服务端去 fetch 等价于内网探测器，这是硬要求。
4. 抓取失败 / 超时 / 被拦截 → **静默降级**，绝不阻断建链与编辑主流程。
5. 环境变量 `AUTO_RESOLVE_TITLES` 可一键关闭（**默认开**），出网异常时能立即止血。

### 1.2 非目标

1. **不做独立标题解析服务**，不新增 FC 函数、不新增调度 —— 采用 A 路径（兼容层 Edge Function 同步抓）。
2. **不做异步回填**（标题延迟到轮询后才出现）。
3. **不改 `longUrl` 的 URL 格式校验**（上游用 `#[LooseUriConverter]`，属跨切面改动，遗留）。
4. **不把 `title_was_auto_resolved` 暴露到 API 响应** —— 上游 REST 层与 JS SDK 均不暴露该字段，保持对外契约一致。
5. **不做 DNS rebinding 的彻底消除**（pinned transport），见 §7.4 残余风险。
6. 不改 `short_url_json()` 的输出形状。

---

## 2. 已确认的关键决策

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| D1 | 出网路径 | **A 路径：兼容层 Edge Function 同步抓** | 用户授权假定 Edge Function 可出公网；改动最小、与上游同步语义一致。FC 双网（`fc/geo-enrich` 已实测可行）作为退路 |
| D2 | 开关形态 | **环境变量 `AUTO_RESOLVE_TITLES`，默认开** | 既保留紧急关闭能力，又让功能默认可用；关闭后行为与今天完全一致 |
| D3 | 触发范围 | **对齐上游** | 建链仅在未填标题时抓；编辑仅刷新自动解析的标题 |
| D4 | 来源记录 | **新增 `short_url.title_was_auto_resolved boolean`** | 对齐上游实体映射的列名与语义 |
| D5 | 写标题的判定位置 | **放在 DB（`update_short_url` 内）** | 判定需要「旧标题 + 旧来源」的原子读取；DB 内判定可避免额外读 RPC，且与上游 `ShortUrl::update()` 的判定位置一致 |
| D6 | 是否暴露来源标志到 API | **不暴露** | 上游 REST DTO 与 `@shlinkio/shlink-js-sdk` 均无 `titleWasAutoResolved` |

---

## 3. 架构与数据流

### 3.1 建链

```
客户端 POST /rest/v3/short-urls
  └─ compat handler.ts  createShortUrl(body)
       ├─ 判定：body.title 是否为 undefined/null
       │    ├─ 是 → title-resolver.resolveTitle(body.longUrl)
       │    │        ├─ 成功 → { title, p_title_was_auto_resolved: true }
       │    │        └─ 失败/超时/SSRF 拦截 → { title: null, p_title_was_auto_resolved: false }
       │    └─ 否 → 用户手填 → { title: str(body.title), p_title_was_auto_resolved: false }
       └─ rpc create_short_url(..., p_title, p_title_was_auto_resolved)
```

### 3.2 编辑

```
客户端 PATCH /rest/v3/short-urls/{code}
  └─ compat handler.ts  updateShortUrl(code, domain, body)
       ├─ 判定：patch 里有 'title' 键？
       │    ├─ 有 → 用户手填优先 → 不抓 → p_auto_title = null（原 patch 透传）
       │    └─ 无 → patch 里有 'longUrl'？
       │         ├─ 有 → title-resolver.resolveTitle(patch.longUrl)
       │         │        ├─ 成功 → p_auto_title = 标题
       │         │        └─ 失败 → p_auto_title = null
       │         └─ 无 → 不抓 → p_auto_title = null
       └─ rpc update_short_url(p_code, p_domain, p_patch, p_auto_title)
            └─ DB 内按 §4.3 的规则决定是否写入 title / 来源标志
```

> **关键设计点**：自动抓来的标题**不放进 `p_patch`**，而是走独立参数 `p_auto_title`。
> 因为 `p_patch` 里有 `title` 键 = 「用户明确提供了标题」，两者必须可区分。

---

## 4. 数据模型（迁移 `0020_title_auto_resolve.sql`）

> `0001`–`0019` 是不可变历史，一行不改。所有变更落在新文件 `0020`。

### 4.1 新列

```sql
alter table short_url add column title_was_auto_resolved boolean not null default false;
```

列名对齐上游实体映射（`entities-mappings/...ShortUrl.php:127` → `columnName('title_was_auto_resolved')`）。

三态语义由 `title` 是否为 null 与新列组合表达，不引入枚举列：

| 状态 | 判定条件 |
|---|---|
| 压根没标题 | `title IS NULL` |
| 自动解析来的 | `title IS NOT NULL AND title_was_auto_resolved` |
| 用户手填的 | `title IS NOT NULL AND NOT title_was_auto_resolved` |

### 4.2 `create_short_url`：13 参 → 14 参

新增**尾部**参数 `p_title_was_auto_resolved boolean default false`，写入 insert 的新列。

Postgres 不允许 `CREATE OR REPLACE` 改变参数个数（会产生重载歧义），按仓库既有约定（0019 即如此）**先 DROP 旧签名再整体重建**：

```sql
drop function if exists create_short_url(
  text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint
);
```

函数体从 `0005_shorten_and_resolve.sql:61-189` **逐字复制**，仅两处 insert 语句增加 `title_was_auto_resolved` 列与取值。

插入值用兜底表达式，防止出现「无标题却被标记为自动解析」的非法状态（上游 `withResolvedTitle()` 保证标题与标志同时成立，我们同样守住）：

```sql
case when p_title is null then false else coalesce(p_title_was_auto_resolved, false) end
```

### 4.3 `update_short_url`：3 参 → 4 参

新增**尾部**参数 `p_auto_title text default null`（抓到的自动标题；`null` = 本次没有可写入的自动标题）。

```sql
drop function if exists update_short_url(text,text,jsonb);
```

函数体从 `0008_compat_api.sql:194-269` 逐字复制，`update` 语句的 `title` / `title_was_auto_resolved` 两列改为：

```sql
title = case
  when p_patch ? 'title' then nullif(btrim(p_patch->>'title'), '')
  when p_auto_title is not null
       and (s.title is null or s.title_was_auto_resolved)
    then btrim(p_auto_title)
  else s.title
end,
title_was_auto_resolved = case
  when p_patch ? 'title' then false
  when p_auto_title is not null
       and (s.title is null or s.title_was_auto_resolved)
    then true
  else s.title_was_auto_resolved
end
```

该规则与上游 `Entity/ShortUrl.php:167-178` **逐条等价**：

| 上游条件 | 本设计对应 |
|---|---|
| `$this->title === null`（原来没标题）→ 写 | `s.title is null` → 写 |
| `$shortUrlEdit->titleWasProvided`（用户给了）→ 写 | `p_patch ? 'title'` → 写，且来源置 `false` |
| `$this->titleWasAutoResolved && $edit->titleWasAutoResolved` → 写 | `s.title_was_auto_resolved` 且 `p_auto_title is not null` → 写，来源置 `true` |
| 都不满足 → 保留原标题**与原来源** | `else s.title` / `else s.title_was_auto_resolved` |

### 4.4 `short_url_json()` 不改

上游 REST DTO 与 `@shlinkio/shlink-js-sdk` 均不含 `titleWasAutoResolved`，对外契约保持不变。

### 4.5 权限收口必须重做（易漏点）

平台默认把 `EXECUTE` 授给 `PUBLIC`，仓库用 `do $$ ... foreach f in array [...] ... $$` 统一收口。
**DROP 函数会连带删除其 ACL**，新建的函数会重新落回 `PUBLIC` 可执行 —— 因此 0020 必须对**新签名**重新收口：

```sql
do $$
declare
  f text;
begin
  foreach f in array array[
    'create_short_url(text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint,boolean)',
    'update_short_url(text,text,jsonb,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
```

### 4.6 `link_version` 触发器不受影响

`0007_link_version_row_trigger.sql` 的触发器用 `update of` 列清单：
`short_code, domain_id, long_url, forward_query, enabled, valid_since, valid_until, max_visits` ——
**不含 `title`**。因此：

- 只改标题 → 不 bump `link_version`，跳转函数不会为此重拉快照 ✅
- 改长链（顺带刷新标题）→ `long_url` 在清单里 → 正常 bump ✅

### 4.7 迁移期间旧调用点继续可用

新参数都带默认值，因此**旧签名被 DROP、新签名建好后，已部署的兼容层不会中断**：

- 兼容层调 `create_short_url` 传 13 个命名参数 → Postgres 匹配新的 14 参函数 → 第 14 参取默认 `false`
- 兼容层调 `update_short_url` 传 3 个命名参数 → Postgres 匹配新的 4 参函数 → 第 4 参取默认 `null`

因此部署顺序上**迁移先行、兼容层后发**是安全的；反向（先发新代码后迁移）则会因函数不存在而报错。

> 若同时保留新旧两个签名则会出现重载歧义，故必须 `drop function if exists` 旧签名后再建新签名。

---

## 5. 触发契约（对齐上游）

### 5.1 建链

| 客户端 body | 是否抓取 | 写入 | 来源标志 |
|---|---|---|---|
| 无 `title` 键 / `title === null` | **抓** | 抓到则写标题；抓不到留空 | 抓到 → `true`；抓不到 → `false` |
| 有 `title` 键且非 null（含空串） | 不抓 | `str(body.title)`（既有口径：空串归一为 null） | `false` |

对齐依据：`ShortUrlCreation::hasTitle()` = `title !== null`（`ShortUrlCreation.php:145-147`）。

### 5.2 编辑

| patch 形态 | 是否抓取 | 写入规则 |
|---|---|---|
| 含 `title` 键 | **不抓** | 用户手填优先，写入并把来源置 `false` |
| 无 `title`，含 `longUrl` | **抓** | 抓到且（旧标题为 null 或旧来源为 auto）→ 写入并置 `true`；否则不写 |
| 无 `title`，无 `longUrl` | 不抓 | 完全不碰标题 |

对齐依据：`ShortUrlService.php:33-35`（**仅当 `longUrl !== null` 才触发解析**）、`ShortUrlEdition.php:145-147`（`hasTitle()` = `titleWasProvided`，显式发 `title: null` 也算「提供了」）。

> 注：`longUrl` 存在但值与原值相同时仍会抓取 —— 与上游一致（上游不比较新旧值）。

### 5.3 建链与编辑的共同降级原则

抓取的所有失败形态（网络错误、超时、DNS 失败、SSRF 拦截、非 `text/html`、charset 认不出、charset 不支持、解码异常、标题超长）**一律降级为「没有标题」**：
建链照常成功、编辑照常成功、**不返回任何错误**（对齐上游 `processTitle` 抓不到就原样返回）。

---

## 6. 抓取实现（`supabase/functions/compat/title-resolver.ts`）

### 6.1 模块与依赖注入

新增独立模块，`handler.ts` 只做编排。纯逻辑（标题提取 / charset 探测 / 转码 / 实体解码 / IP 判定）**零依赖**，便于 `deno test` 直接覆盖。

抓取相关的外部依赖**必须可注入**：

```ts
export type TitleResolverDeps = {
  fetchImpl?: typeof fetch;        // 默认 globalThis.fetch
  resolveDns?: (host: string) => Promise<string[]>;  // 默认 Deno.resolveDns
};
export async function resolveTitle(url: string, deps?: TitleResolverDeps): Promise<string | null>
```

> **原因**：`supabase/functions/compat/test/compat.test.ts:18-31` 把 `globalThis.fetch` **整个替换**成了 RPC mock。
> 若抓取直接用 `globalThis.fetch`，抓取请求会被现有 mock 当成 `/rpc/` 调用吞掉。
> 因此测试里的全局 mock 要改为**分流**：`/rpc/` 走 RPC mock，其他 URL 走独立的外部 fetch mock。

### 6.2 请求流程

1. **URL 准入**：只允许 `http` / `https`；拒绝带 `user:pass@` 的 URL；host 不得为空。
2. **SSRF 校验**（§7）→ 不通过直接拒绝。
3. `GET` 请求，携带上游同款 Chrome UA：
   `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36`
   （上游 `ShortUrlTitleResolutionHelper.php:31`）
4. **总超时 3s**（`AbortSignal.timeout(3000)`，对齐上游 `TIMEOUT=3` / `CONNECT_TIMEOUT=3`）。
5. **手动跟随重定向**（`redirect: 'manual'`），最多 15 跳（对齐上游 `MAX_REDIRECTS=15`），**每一跳重新做完整校验**。
6. 只接受 `Content-Type` 以 `text/html` 开头（小写比较，对齐上游 `:67`）。
7. 流式读取响应体：读到 `</title>` 即停（对齐上游 `STREAM` 行为）；charset 若尚未探到则继续读；
   **额外加 256 KB 读取上限**（上游无上限，见 §9 偏差 #6）。
8. 标题提取 → charset 探测 → 转码 → 实体解码 → `trim` → 截断。

### 6.3 标题提取

上游正则原样：

```
/<title[^>]*>(.*?)<\/title>/i
```

（上游 `TITLE_TAG_VALUE`，`ShortUrlTitleResolutionHelper.php:34`。注意上游**没有** `s` 标志，`.` 不跨行 —— 本设计保持一致。）

### 6.4 charset 探测

严格按上游顺序（`resolvePageCharset()`，`:138-160`）：

1. `Content-Type` 头中的 `charset=xxx`（上游正则 `/charset=([^;]+)/i`）
2. `<meta ... charset=xxx>`（上游正则 `/<meta\b[^>]*\bcharset\s*=\s*(?:["\']?)([^"\'\s>;]+)/i`）
   —— 上游这**一个**正则同时覆盖 `<meta charset="x">` 与 `<meta http-equiv="Content-Type" content="text/html; charset=x">`
3. **都没有 → 丢弃标题**（上游 `:113-117` 明确注释「避免编码错误入库」）

### 6.5 转码

- Deno `TextDecoder` 支持 WHATWG 编码集，含 `gb18030` / `big5` / `shift_jis` / `euc-kr` / `windows-949` 等 decoder-only 编码 → 中文页面可解。
- charset 标签先按 WHATWG 标签表归一化（`utf8` → `utf-8`，`gb2312` / `gbk` → `gb18030`，`iso-8859-1` → `windows-1252` 等）。
- 标签无法识别 → **丢弃标题**（见 §9 偏差 #2）。
- 转码结果为空 → 丢弃。

### 6.6 实体解码

上游 `html_entity_decode(trim($title))`（`:72`）。PHP 8 默认 flags = `ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401`，`double_encode` 默认为 true。

JS 无内置等价物，本设计自实现：

- 命名实体：HTML401 集里的核心 4 个（`&amp; &lt; &gt; &quot;`）+ 常见标点/符号实体（`&nbsp; &copy; &reg; &hellip; &mdash; &ndash; &laquo; &raquo; &ldquo; &rdquo; &lsquo; &rsquo; &bull; &middot; &deg; &plusmn; &times; &divide; &euro; &pound; &yen; &cent; &sect; &para; &trade;` 等）
- 数字实体：`&#NN;` 与 `&#xHH;` —— **数字实体无条件解码**（与 PHP 一致，flags 只约束命名实体）
- `&apos;` **不解码** —— 它不属于 HTML401 实体集（上游同样不解码）
- `double_encode` 语义一致：`&amp;amp;` → `&amp;`（解码一次，不抑制二次编码）

覆盖绝大多数场景，非与 PHP HTML401 全集（252 条）逐条一致 → 见 §9 偏差 #5。

### 6.7 长度上限

自动解析出的标题**截断到 512 字符**（对齐上游 DB 列 `varchar(512)`，见 §9 偏差 #1）。

### 6.8 开关读取时机

`AUTO_RESOLVE_TITLES` **每次请求时读取**（不在模块加载时读成常量），
这样测试可以用 `Deno.env.set()` 动态切换，无需重新 import 模块。

判定：值为 `false` / `0` / `off` / `no`（大小写不敏感）→ 关闭；其他（含未设置）→ **开启**。

---

## 7. SSRF 防护（硬要求）

### 7.1 判定算法（fail-closed）

把目标 host 解析成 IP 集合：

- host 是 IP 字面量 → 单元素集合
- 否则 DNS 同时解析 A + AAAA

**集合中只要有任一 IP 落在禁止网段，整个请求直接拒绝**（不是「有一个公网 IP 就放行」）。
DNS 解析失败 → **拒绝**。

### 7.2 禁止网段

| 类别 | 网段 |
|---|---|
| IPv4 私有 / 环回 / 链路本地 | `10/8`、`127/8`、`169.254/16`（含云元数据 `169.254.169.254`）、`172.16/12`、`192.168/16` |
| IPv4 特殊用途 | `0/8`、`100.64/10`（CGNAT）、`192.0.0/24`、`198.18/15`、224/4、240/4 |
| IPv6 | `::/128`、`::1/128`、`fc00::/7`（ULA）、`fe80::/10`（链路本地）、`ff00::/8` |
| IPv4 映射 / 隧道 | `::ffff:0:0/96`、`64:ff9b::/96`（NAT64）、`2002::/16`（6to4）、`2001::/32`（Teredo）—— **抽出内嵌的 IPv4 再按 IPv4 规则判** |

### 7.3 重定向

手动跟随（`redirect: 'manual'`），**每一跳**重新执行 URL 准入 + DNS 解析 + 网段判定，
最多 15 跳；超过上限即放弃。**不允许**用 `fetch` 的自动重定向（无法插入每跳校验）。

### 7.4 残余风险（如实记录）

**DNS rebinding**：我们校验时解析到的 IP 与 `fetch` 实际连接时解析到的 IP 可能不同
（Deno `fetch` 内部会二次解析，且无法指定已解析 IP）。

彻底消除需要手写 pinned transport（`Deno.connect` 到已校验 IP + `Deno.startTls` 带原 hostname 做 SNI 与证书校验 + 手写 HTTP/1.1、chunked、gzip/deflate/br 解码），约 300 行且易出微妙 bug —— **本次不做**。

缓解手段：校验紧贴请求发出（时间窗极小）、解析结果**全查**而非挑一个、每跳重校验。

验收文档中如实标注该残余风险。

---

## 8. 开关、降级与日志

### 8.1 开关

`AUTO_RESOLVE_TITLES`（Edge Function 环境变量），默认**开**。关闭时行为与今天完全一致（不发起任何外部请求）。

### 8.2 降级

所有抓取失败 → 返回 `null` 标题 → 建链/编辑照常成功，**不返回错误**。

### 8.3 日志

只记 **原因码 + host**：

- **不记完整 URL** —— 长链 query 里可能带 token，不能落日志
- 不记响应体
- 不记请求头（含凭据）

---

## 9. 有意偏差清单（对齐上游但我们不同）

| # | 偏差 | 理由 |
|---|---|---|
| 1 | 自动解析标题**截断到 512** | 上游 `withResolvedTitle()` 直接 `new`，绕过 `#[SubstringConverter(512)]`，自动标题**不截断**；而上游 DB 列是 `varchar(512)` → 长标题会撞列长度（上游潜在 bug）。我们列是 `text` 无限制，主动截断到 512 与上游存储上限一致 |
| 2 | charset 标签不认识 → **丢弃标题** | 上游此时兜底存乱码原串（`mb_convert_encoding` 失败 → `iconv` 失败 → 原串）。我们丢弃，与上游「防乱码入库」的意图一致 |
| 3 | `findIfExists` 命中时**白抓一次** | 上游 `UrlShortener::shorten()` 先查复用、命中就返回，根本不抓；我们抓在 RPC 之前。为一个低频分支新增 RPC 不划算 |
| 4 | 显式空标题归一为 `null` | 上游存 `''`，rxlink 现状 `str()` 就把 `''` 变 `null`（既有行为，R10 不动）。副作用：清空标题后再改长链会重新自动抓一次（上游不会） |
| 5 | 实体解码用**自实现近似表** | PHP 默认 HTML401 全集（252 条）+ 数字实体；我们实现核心 + 常见标点 + 数字实体，覆盖绝大多数场景，非 100% 逐条一致 |
| 6 | 响应体 **256 KB 上限** | 上游无上限，是它的短板 |
| 7 | **DNS rebinding 残余风险** | 见 §7.4，验收文档如实标注 |

---

## 10. 兼容层 API 编排（`handler.ts`）

### 10.1 `createShortUrl(body, keyId)`

```
const userProvided = body.title !== undefined && body.title !== null;
let title: string | null = null;
let autoResolved = false;
if (!userProvided && autoResolveEnabled()) {
  const resolved = await resolveTitle(str(body.longUrl)!);
  if (resolved) { title = resolved; autoResolved = true; }
} else if (userProvided) {
  title = str(body.title);            // 既有口径：'' → null
}
rpc('create_short_url', { ..., p_title: title, p_title_was_auto_resolved: autoResolved })
```

抓取抛出的任何异常一律吞掉并降级为「无标题」。

### 10.2 `updateShortUrl(code, domain, body)`

```
const patch = { ...body };
let autoTitle: string | null = null;
const userProvided = 'title' in patch;          // 对齐上游 titleWasProvided
const hasLongUrl = 'longUrl' in patch && typeof patch.longUrl === 'string';
if (!userProvided && hasLongUrl && autoResolveEnabled()) {
  const resolved = await resolveTitle(patch.longUrl);
  if (resolved) autoTitle = resolved;
}
rpc('update_short_url', { p_code: code, p_domain: domain, p_patch: patch, p_auto_title: autoTitle })
```

**注意**：`autoTitle` 走独立参数，**绝不能塞进 `patch`** —— `patch` 里有 `title` 键即代表「用户手填」。

---

## 11. 测试

### 11.1 单元：`supabase/functions/compat/test/title-resolver.test.ts`（新增）

- **标题提取**：正常 / `<title lang="zh">` 多属性 / 大小写 / 无 title / 嵌套标签 / 跨行（不匹配，对齐上游）
- **charset**：Content-Type 头 / `<meta charset>` / `<meta http-equiv>` / 三者皆无 → 丢弃
- **转码**：utf-8 / gbk / big5 / latin1 / 不认识的标签 → 丢弃
- **实体解码**：`&amp;` `&lt;` `&#39;` `&#x4e2d;` / 双重编码 `&amp;amp;`
- **截断**：>512 → 截断到 512
- **SSRF 拒绝表**：`127.0.0.1` / `10.x` / `172.16.x` / `192.168.x` / `169.254.169.254` / `0.0.0.0` / `100.64.x` / `::1` / `fc00::` / `fe80::` / `[::ffff:127.0.0.1]` / `2002:7f00:1::` → 全部拒绝
- **重定向**：跳内网 → 拒绝；>15 跳 → 拒绝
- **非 `text/html`** → 无标题；**超时** → 无标题

### 11.2 集成：`supabase/functions/compat/test/compat.test.ts`（扩展）

先改全局 fetch mock 为**分流**（`/rpc/` vs 外部 URL），再补：

**handler 层断言**（RPC 被 mock，只验参数与编排）：

- 建链带 `title` → 不抓、`p_title_was_auto_resolved = false`
- 建链不带 `title` + 抓成功 → `p_title` 为抓到的标题、`p_title_was_auto_resolved = true`
- 建链抓失败 → 建链仍成功、`p_title = null`、`p_title_was_auto_resolved = false`
- 编辑带 `title` → 不抓、`p_auto_title = null`
- 编辑改 `longUrl` + 抓成功 → `p_auto_title` 为抓到的标题、且**不在 `p_patch` 里**
- 编辑抓失败 → `p_auto_title = null`
- `AUTO_RESOLVE_TITLES=false` → 完全不抓（不产生外部请求）

**DB 规则断言**（不在 handler 层，由 T1 库级验证 + §11.3 线上验收覆盖）：

- 编辑改 `longUrl` + 原 auto → 刷新
- 编辑改 `longUrl` + 原手填 → 不动
- 编辑抓失败 → 保留原标题与原来源

### 11.3 线上验收

1. 建链指向 `https://example.com` → 标题落库
2. 建链指向 `http://169.254.169.254/` → **建链成功、标题为空**（SSRF 拦截实证）
3. 编辑改长链 → 标题刷新
4. 编辑手填标题 → 改长链 → 标题不被覆盖
5. `AUTO_RESOLVE_TITLES=false` → 不抓
6. 建链接口延迟实测（p50 / p95）

---

## 12. 改动清单

### 12.1 新增

- `supabase/migrations/0020_title_auto_resolve.sql`
- `supabase/functions/compat/title-resolver.ts`
- `supabase/functions/compat/test/title-resolver.test.ts`
- `docs/verification/r10-results.md`

### 12.2 修改

- `supabase/functions/compat/handler.ts` —— `createShortUrl` / `updateShortUrl` 编排
- `supabase/functions/compat/test/compat.test.ts` —— fetch mock 分流 + R10 集成用例
- `docs/runbook.md` —— 标题自动解析操作段 + 迁移清单
- `docs/iteration-plan.md` —— I10 章节 + B10 清单 + C 表
- `docs/shlink-feature-checklist.md` —— `autoResolveTitles` 项

---

## 13. 实施拆分（TDD，先红后绿）

| Task | 内容 | 完成判据 |
|---|---|---|
| T1 | 迁移 0020：加列 + 重建两个 RPC + 权限收口 | 库级验证：建链/编辑/来源标记/权限（`anon` 调不到 RPC） |
| T2 | 纯逻辑：标题提取 / charset / 转码 / 实体解码 / 截断 | `title-resolver.test.ts` 全绿 |
| T3 | 抓取与 SSRF：IP 判定 / 重定向 / 超时 | SSRF 拒绝表逐条覆盖 |
| T4 | 编排：handler 接线 + 集成测试 | `compat.test.ts` 全绿（既有 35 例不得回归） |
| T5 | 部署 compat + 线上验收 + 文档归档 | `docs/verification/r10-results.md` |

---

## 14. 部署顺序与回滚

### 14.1 顺序

1. 应用迁移 0020（**逐条 SQL 执行，看退出码**）
2. 本机 `functions-cli deploy compat`（首次可能 500，重试即成功）
3. 配置 `AUTO_RESOLVE_TITLES`（默认开即无需配置；如需关闭用 `functions-cli secrets set`）
4. 线上验收（§11.3）

### 14.2 回滚

- 兼容层回滚：重新部署上一个版本的 compat（代码回滚即可，DB 侧列可保留）
- DB 回滚：`short_url.title_was_auto_resolved` 列保留无害（旧 RPC 签名若已 DROP 需重新部署兼容层）

---

## 15. 已知限制与遗留

1. **DNS rebinding 残余风险**（§7.4）—— 未做 pinned transport
2. **`findIfExists` 白抓一次**（§9 偏差 #3）
3. **显式空标题归一为 null**（§9 偏差 #4）
4. **实体解码非 HTML401 全集**（§9 偏差 #5）
5. **`longUrl` 不做 URL 格式校验** —— rxlink 全局口径（上游用 `LooseUriConverter`），跨切面改动，不在 R10 范围
6. **抓取在请求内同步执行** —— 建链接口延迟 +0~3s
7. 若 Edge Function 实测无法出公网 → 退路是把抓取逻辑整体挪到 FC 函数（`fc/geo-enrich` 的 FC 双网已实测可行），**DB 侧设计完全不受影响**

---

## 16. 参考

| 用途 | 位置 |
|---|---|
| 上游抓取实现 | `shlink/module/Core/src/ShortUrl/Helper/ShortUrlTitleResolutionHelper.php` |
| 上游建链入口 | `shlink/module/Core/src/ShortUrl/UrlShortener.php:42` |
| 上游编辑入口 | `shlink/module/Core/src/ShortUrl/ShortUrlService.php:33-35` |
| 上游建链 DTO | `shlink/module/Core/src/ShortUrl/Model/ShortUrlCreation.php` |
| 上游编辑 DTO | `shlink/module/Core/src/ShortUrl/Model/ShortUrlEdition.php` |
| 上游写入规则 | `shlink/module/Core/src/ShortUrl/Entity/ShortUrl.php:167-178` |
| 上游列定义 | `shlink/module/Core/config/entities-mappings/Shlinkio.Shlink.Core.ShortUrl.Entity.ShortUrl.php:120-130` |
| rxlink 建链 RPC | `supabase/migrations/0005_shorten_and_resolve.sql:61-189` |
| rxlink 编辑 RPC | `supabase/migrations/0008_compat_api.sql:194-269` |
| rxlink 权限收口范式 | `supabase/migrations/0008_compat_api.sql:313-330` |
| rxlink 触发器 | `supabase/migrations/0007_link_version_row_trigger.sql` |
| rxlink 兼容层 | `supabase/functions/compat/handler.ts` |
| FC 双网先例 | `docs/geo-enrichment.md` §1.1 |
