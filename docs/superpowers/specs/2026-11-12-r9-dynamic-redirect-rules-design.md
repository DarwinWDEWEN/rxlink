# I9 —— R9 动态跳转规则（设计稿）

> 状态：设计已确认（2026-11-12），待用户审阅本文档 → 实施计划。
> 范围：shlink 的 **动态跳转规则**（Dynamic redirect rules）。兼容层 `POST /short-urls/{code}/redirect-rules` 从固定 501 变为真实现，控制台「跳转规则」页面可正常保存并生效。
> 参考：`shlink/module/Core/src/RedirectRule/**`、`shlink/module/Rest/src/Action/RedirectRule/**`（vendored 源码）。

---

## 1. 目标与非目标

### 1.1 目标

1. 兼容层实现 `GET` / `POST|PATCH /short-urls/{code}/redirect-rules`，形状与 shlink 一致。
2. 跳转函数在访问时**实际求值**规则：命中则跳规则里的 `longUrl`，不命中跳短链默认 `longUrl`。
3. 支持 shlink 全部 **11 种**条件类型。
4. geo 条件只覆盖**中国大陆 31 个省级**（`geolocation-country-code` 实际只匹配 `CN`；`geolocation-city-name` 承载省名）。
5. 控制台露出全部条件类型（版本旋钮提到 `5.1.0`），并补齐随之打开的「排除标签」筛选。

### 1.2 非目标

- 不改控制台构建产物（`shlink-web-client` 不重新 build）。
- 不引入 Redis / 新中间件 / 新外部服务。
- 不改 404 回退、robots.txt、追踪像素、追踪开关的既有行为。
- 不做 shlink Plus 付费版能力。
- 不支持全球国家码匹配、不支持海外城市匹配（geo 数据只含中国大陆网段）。

---

## 2. 已确认的关键决策

| 决策 | 取值 | 理由 |
|---|---|---|
| 条件类型范围 | 全 11 种 | 与 shlink 对齐 |
| 控制台版本旋钮 | `4.0.0` → `5.1.0` | 露出全部条件类型（含桌面设备类型扩展） |
| 排除标签筛选 | 补齐后端 `list_short_urls` | 版本旋钮会连带打开该 UI，不补就是静默错误 |
| geo 覆盖范围 | 仅中国 31 省级 | 热路径不引入 121MB mmdb；DB-IP mmdb 里 CN 有 120,141 个 IPv4 网段、31 个省名 |
| geo 数据落地 | 构建期抽取为紧凑表，随包发布（**实测 ~135KB**） | 不必再挂 Layer（52MB mmdb 才需要 Layer） |
| 求值位置 | 跳转函数（FC）求值 | UA / language / geo 无法在 SQL 里求值 |
| 规则下发方式 | 规则**不**进主快照，单独缓存通道 | 规则是高频写操作，共用 `link_version` 会让每次保存都触发全网实例重拉全量快照 |
| 失效机制 | 新表 `rules_version` + `bump_rules_version()`，与 `link_version` 平行 | 「改归改、bump 归 bump」：规则改动只让规则缓存失效，短链改动只让主快照失效 |

---

## 3. 架构与数据流

```
控制台（shlink web client v4.9.0）
  └─ POST /rest/v3/short-urls/{code}/redirect-rules
        │
兼容层（Supabase Edge Function `compat`）
  ├─ 校验 body（11 种 type + 各 type 的值域）
  └─ RPC set_short_url_redirect_rules(p_code, p_domain, p_rules)
        │  事务：删旧规则 → 按数组顺序插新规则（priority = 1..N）
        │  触发器 → bump_rules_version()（不动 link_version）
        ▼
ADB PostgreSQL
  ├─ short_url_redirect_rule / redirect_condition（新表）
  ├─ rules_version（单行 seq）+ rules_seq() / rules_snapshot() RPC
  └─ resolve_short() 增加 rules 列（回落路径用）
        │
        ▼
跳转函数（FC Web 函数 `example.com`）
  ├─ cache.js        主快照（短链 → longUrl）        ← link_version 驱动，**不变**
  ├─ rules-cache.js  规则快照（short_url_id → rules） ← rules_version 驱动，新增
  └─ rules.js        条件求值（纯函数）
      ↑ china-geo.js  IP → 省名（查 china-geo.bin，二分）
```

**一次保存的完整链路**

1. 控制台发 `POST`（body：`{redirectRules:[{longUrl, conditions:[{type, matchKey, matchValue}]}]}`）。
2. 兼容层校验 → 调 `set_short_url_redirect_rules`。
3. RPC 在事务内删掉该短链的旧规则与条件、插入新规则（`priority` 按数组下标 +1）。
4. 行级触发器调 `bump_rules_version()`，`rules_version.seq` +1（`link_version.seq` **不变**）。
5. 各 FC 实例的 `rules-cache.js` 轮询发现 seq 变化 → 只重拉 `rules_snapshot()`（仅含**有规则**的短链，通常几十 KB）。
6. 访问该短链 → 主缓存拿默认 `longUrl` → 规则缓存按 `short_url_id` 拿规则 → `rules.js` 求值 → 最终 `location`。
7. 访问记录 `visit_inbox.redirect_to` 写**最终** location。

**规则生效时延**：≤ 一个轮询周期（默认 5s，`RULES_POLL_MS` 可调）。

**降级链**（任一环节失败都不报错，只回默认长链）：

| 环节 | 失败时行为 |
|---|---|
| 规则缓存未就绪 | 回落 `resolve_short`（带 `rules` 列）→ 仍无 → 默认 `longUrl` |
| 规则缓存拉取失败 | 保留旧快照（沿用 `cache.js` 的既有策略），打一行 warning |
| UA / IP 解析异常 | 该条件判为**不匹配**，不抛错 |
| `china-geo.bin` 缺失 | geo 条件判为不匹配 |
| `resolve_short` 失败 | 502（沿用现状） |

---

## 4. 数据模型

### 4.1 新表（迁移 `0018_redirect_rules.sql`）

```sql
create table short_url_redirect_rule (
  id           bigint generated always as identity primary key,
  short_url_id bigint not null references short_url(id) on delete cascade,
  priority     integer not null default 1,
  long_url     text not null
);

create table redirect_condition (
  id          bigint generated always as identity primary key,
  rule_id     bigint not null references short_url_redirect_rule(id) on delete cascade,
  type        text not null,
  match_key   text,
  match_value text
);

create index short_url_redirect_rule_su_idx on short_url_redirect_rule(short_url_id);
create index redirect_condition_rule_idx     on redirect_condition(rule_id);

create table rules_version (
  id  int     primary key default 1,
  seq bigint  not null default 0,
  check (id = 1)
);
insert into rules_version (id, seq) values (1, 0) on conflict (id) do nothing;
```

权限（对齐 0004 口径，逐表四行齐全）：

```sql
alter table short_url_redirect_rule enable row level security;
alter table short_url_redirect_rule force  row level security;
revoke all on table short_url_redirect_rule from anon, authenticated;
-- redirect_condition / rules_version 同样三条
```

序列：`revoke all on all sequences in schema public from anon, authenticated`（0004 已全局做，新表自动覆盖）。

### 4.2 失效触发器

```sql
create or replace function bump_rules_version()
returns trigger language plpgsql security invoker set search_path = public, pg_catalog
as $$ begin update rules_version set seq = seq + 1 where id = 1; return null; end; $$;

create trigger rules_version_after_write on short_url_redirect_rule
after insert or update or delete on short_url_redirect_rule
for each row execute function bump_rules_version();

create trigger conditions_version_after_write on redirect_condition
after insert or update or delete on redirect_condition
for each row execute function bump_rules_version();
```

> **行级触发器**（不是语句级）：语句级在 0 行时也会触发，删空操作会白 bump。沿用 0007 的结论。

### 4.3 SQL 函数改动（覆盖时注明原出处）

| 函数 | 动作 | 原出处 |
|---|---|---|
| `redirect_rules_json(p_short_url_id)` | **新增**：把规则 + 条件聚合成 API 形状 | — |
| `set_short_url_redirect_rules(p_code, p_domain, p_rules)` | **新增**：删旧 + 插新，返回规则数组 | — |
| `rules_seq()` | **新增**：返回 `rules_version.seq` | — |
| `rules_snapshot()` | **新增**：返回 `(short_url_id, rules jsonb)`，只含有规则的短链 | — |
| `bump_rules_version()` | **新增**：触发器函数 | — |
| `get_short_url_redirect_rules(p_code, p_domain)` | **覆盖**：改为真读 | 0010 |
| `resolve_short(p_code, p_domain)` | **覆盖**：返回值加 `rules jsonb` | 0005 |
| `short_url_json(p_id)` | **覆盖**：`hasRedirectRules` 由常量 `false` 改 `exists(...)` | 0005 |
| `list_short_urls(...)` | **覆盖**：加 `p_excluded_tags text[]` + `p_excluded_tags_mode` | 0008 |

### 4.4 `redirect_rules_json` 的输出形状

与 shlink `ShortUrlRedirectRule::jsonSerialize()` 一致：

```json
[
  {
    "longUrl": "https://example.com/mobile",
    "priority": 1,
    "conditions": [
      { "type": "device", "matchKey": null, "matchValue": "mobile" }
    ]
  }
]
```

`conditions` 数组按 `id` 升序（写入顺序）排列；规则数组按 `priority` 升序排列。

### 4.5 `set_short_url_redirect_rules` 的语义

- 短链解析：沿用 `get_short_url` 的域名口径（`p_domain` 空/`DEFAULT` → `domain_id = 0`，否则按 `authority` 查；查不到 → `short_url_not_found`）。
- 整组替换：先删该短链全部规则（`on delete cascade` 自动删条件），再按 `p_rules` 数组顺序插入，`priority = index + 1`。
- `p_rules` 为空数组 → 清空该短链的全部规则（合法，shlink 同语义）。
- 返回：`{defaultLongUrl, redirectRules}`（`defaultLongUrl` = 短链自身 `long_url`；`redirectRules` = 写入后的规则数组，含 `priority` 与 `conditions`）。

---

## 5. 兼容层 API

### 5.1 路由

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/short-urls/{code}/redirect-rules` | 透传 `get_short_url_redirect_rules` |
| POST / PATCH | `/short-urls/{code}/redirect-rules` | 校验 → `set_short_url_redirect_rules` → 透传 |

两者都接受 `?domain=` 查询参数（沿用现有 `rulesMatch` 分支的 `domain` 读取方式）。

### 5.2 请求体

```json
{
  "redirectRules": [
    {
      "longUrl": "https://example.com/mobile",
      "conditions": [
        { "type": "device", "matchKey": null, "matchValue": "mobile" }
      ]
    }
  ]
}
```

- 请求里**没有** `priority`；优先级由数组顺序决定（对齐 shlink `ShortUrlRedirectRuleService::setRulesForShortUrl`）。
- 响应：`{defaultLongUrl, redirectRules:[{longUrl, priority, conditions:[...]}]}`。

### 5.3 校验（对齐 shlink `RedirectConditionType::isValid`）

| type | 校验规则 | 不合法示例 |
|---|---|---|
| `device` | ∈ `android/ios/mobile/windows/macos/linux/chromeos/desktop` | `desktop2` |
| `browser` | ∈ `chrome/firefox/edge/safari/opera/android_browser` | `ie` |
| `ip-address` | 合法静态 IP / CIDR / 通配符（IPv4 + IPv6） | `999.1.1.1` |
| `geolocation-country-code` | 两个字母 | `CHN` |
| `query-param` | `matchValue` 非空 | `""` |
| `any-value-query-param` / `valueless-query-param` | 不校验值 | — |
| `language` / `before-date` / `after-date` / `geolocation-city-name` | 不校验值（shlink 同样不校验） | — |

其他校验：

- `type` 缺失或不在 11 种枚举内 → `400 invalid-data`。
- `longUrl` 缺失 / 非字符串 / 空 → `400 invalid-data`。
- `conditions` 必须是数组（空数组合法；shlink 里空条件规则永不命中）。
- 错误文案对齐 shlink：`"<value>" is not a valid value for the "<TYPE>" redirect condition`。
- 短链不存在 → `404 short-url-not-found`（沿用现有 RPC 的 `P0002` → 404 映射）。

### 5.4 版本旋钮与连带项

- `handler.ts` 的 `VERSION` 常量：`'4.0.0'` → `'5.1.0'`。
- 版本 ≥5.1.0 时控制台会额外显示 `desktopDeviceTypes` 扩展（设备下拉多出 Windows/macOS/Linux/ChromeOS/mobile）——我们后端 11 种 device 值都已支持，无需额外处理。
- 版本 ≥4.6.0 会打开「排除标签」筛选 → 由 `0019` 补齐 `list_short_urls` 的 `p_excluded_tags` / `p_excluded_tags_mode`，compat 路由传 `excludeTags[]` / `excludeTagsMode`。

### 5.5 `excludeTags` 筛选的实现口径

沿用现有 `p_tags` 的 `any`/`all` 语义取反：

- `mode = 'any'`：**存在任一**排除标签即排除（`exists`）。
- `mode = 'all'`：**同时具备全部**排除标签即排除（`count(distinct) = cardinality`）。

与 shlink 的 `excludeTagsMode` 语义一致（`all` = 拥有全部被排除标签的短链被排除）。

---

## 6. 跳转函数

### 6.1 新增文件

| 文件 | 职责 | 依赖 |
|---|---|---|
| `fc/redirect/rules.js` | 条件求值（纯函数） | 无 |
| `fc/redirect/china-geo.js` | IP → 省名（纯函数） | 无（读 `china-geo.bin`） |
| `fc/redirect/rules-cache.js` | 规则快照缓存（独立 seq 通道） | 无 |
| `fc/redirect/china-geo.bin` | 中国网段数据（构建产物，实测 ~135KB） | — |
| `scripts/build-china-geo.mjs` | 从 DB-IP mmdb 抽取中国网段 → `china-geo.bin` | `fc/geo-enrich/node_modules/mmdb-lib` |

### 6.2 `rules.js` 求值口径（对齐 shlink `RedirectCondition::matchesRequest`）

| 条件类型 | 求值规则 |
|---|---|
| `device` | UA → 平台。iPhone/iPad → `[ios, mobile]`；Android → `[android, mobile]`；Linux → `[linux, desktop]`；Windows → `[windows, desktop]`；Macintosh → `[macos, desktop]`；Chrome OS → `[chromeos, desktop]`。命中集合含 `matchValue` 即真 |
| `browser` | UA → 浏览器名（chrome/firefox/edge/safari/opera/android_browser），严格相等 |
| `language` | 解析 `Accept-Language`，只取 q ≥ 0.9 的语言；与 `matchValue`（可 `zh-CN` 或 `zh`）比对：语言必须相同，`matchValue` 带国家码时国家码也必须相同 |
| `query-param` | query 中 `matchKey` 的值**严格等于** `matchValue` |
| `any-value-query-param` | query 中**存在** `matchKey`（不论值） |
| `valueless-query-param` | query 中存在 `matchKey` 且值为空 |
| `ip-address` | 复用现有 `ipmat.ipMatchesGroups`（静态 IP / CIDR / 通配符） |
| `geolocation-country-code` | IP 解析出的国家码 == `matchValue`（我们只出 `CN`；非中国 IP 不命中） |
| `geolocation-city-name` | IP 解析出的**省名** == `matchValue`（英文名或中文名，忽略大小写与空格） |
| `before-date` | `now < matchValue` |
| `after-date` | `now > matchValue` |

规则级语义：

- 一条规则的**所有**条件都满足才算命中（AND）。
- **空条件规则永不命中**（对齐 shlink `matchesRequest` 的 `conditions->count() > 0` 判断）。
- 规则按 `priority` 升序遍历，**第一条命中即用其 `longUrl` 并停止**；都不命中 → 短链默认 `longUrl`。
- 单条条件求值抛错 → 该条件判为**不匹配**（不中断整条规则链）。

### 6.3 `china-geo.js` 与数据文件

**数据来源与实测规模**（2026-11-12 在本机用 DB-IP mmdb 实测，非估算）：

| 阶段 | 数量 |
|---|---|
| mmdb 里 CN 的前缀（`country.iso_code = 'CN'`） | 120,141 条 |
| 前缀边界点 | 125,327 个 |
| **归并后的扁平不重叠区间** | **22,337 个** |
| 省名 | 31 个（DB-IP 的 subdivision **只有英文名**，无 `zh-CN`） |
| 二进制文件体积 | **约 135KB**（区间 6 字节 × 22,337 + 省名表） |

**为什么必须做最长前缀归并**：MMDB 树里同一个数据指针会被多个前缀共享（同一省份既有 /16 也有 /24 的条目），且前缀之间存在嵌套。直接按 start 排序取「最后一条 start ≤ v」会错配约 **0.66%** 的 IP。必须按 **最长前缀优先（LPM）** 解析，与 `reader.get()` 语义一致。

**归并算法**（构建期，O(n log n)）：
1. 遍历 mmdb 树，收集所有 CN 叶子的 `(prefixStart, prefixLen, provinceName)`。
2. 收集所有边界点并排序去重 → 得到基本区间。
3. 扫基本区间，用**按 prefixLen 排序的最大堆**维护活动前缀，当前堆顶（最长前缀）即该区间的归属省。
4. 相邻同省的基本区间合并 → 扁平不重叠区间表。

**正确性验证**：本机以 200,000 个随机 IPv4 与 `reader.get()` 对拍，**mismatch = 0**；单次查表约 13µs。

**`china-geo.bin` 格式**（运行时只读）：

```
头部 16 字节：
  magic       6 字节 "CNGEO1"
  provCount   uint16 LE   省名数量
  nameBytes   uint32 LE   省名表字节数
  intervalCount uint32 LE 区间数量
省名表（provCount 条）：
  enLen uint8, en bytes(UTF-8), zhLen uint8, zh bytes(UTF-8)
区间表（intervalCount 条，按 start 升序，每条 6 字节）：
  start  uint32 BE
  end    uint32 BE
  provId uint8
```

**中文省名来源**：DB-IP 的 subdivision 只有英文名，所以构建脚本内置一份 **31 条 EN→中文映射表**（`Beijing→北京` … `Inner Mongolia→内蒙古`、`Tibet→西藏`），中英文都写进二进制文件。

**运行时查表**：一次性读入 `Buffer`（约 135KB），二分查找最后一个 `start ≤ v` 的区间 → 检查 `v ≤ end` → 返回 `{province, provinceZh}`。命中即返回，约 15 次比较。

**匹配归一**：省名比较时两侧都做「小写 + 去空格」处理，`Guangdong` 与 `广东` 都能匹配同一省。

**特例**：mmdb 里有 3 条 CN 记录没有 subdivision（省名缺失）→ 归并时省名记为空串 `''`，**不匹配任何省名条件**（与非中国 IP 的行为不同：它们仍算「中国」但不匹配具体省）。

### 6.4 `rules-cache.js`

- 结构与 `cache.js` 同构（`Map` + `seq` 轮询 + 全量替换引用），但：
  - 独立 `seq` 源：`rules_seq()`。
  - 独立数据源：`rules_snapshot()` → `Map<short_url_id, rules>`。
  - 只装**有规则**的短链；无规则的短链在 Map 里不存在 → 求值阶段直接跳过（热路径开销 = 一次 Map 查找 + 一次 `has` 判断）。
  - 拉取失败保留旧快照（沿用 `cache.js` 策略）。
  - 轮询间隔：默认 5s，环境变量 `RULES_POLL_MS` 可覆盖（与 `CACHE_POLL_MS` 同量级）。

### 6.5 `index.js` 主流程改动

```
命中条目 entry（entry 只有 id / longUrl / forwardQuery / 有效期 / 限次标记，不带规则）
  └─ rulesCache.get(entry.id)
       ├─ null（该短链无规则 / 规则缓存未就绪）→ 最终 location = entry.longUrl
       └─ rules[] → rules.evaluate(rules, ctx)
            ├─ 命中某条 → 最终 location = 该规则的 longUrl
            └─ 全不命中   → 最终 location = entry.longUrl
```

- `forward_query` 作用于**最终** location（先求值、再拼 query，与 shlink 一致）。
- `visit_inbox.redirect_to` 写最终 location（现状已如此，无需改动）。
- 追踪像素 `/{code}/track` **不套用规则**（像素没有跳转目标），仍写 `redirect_to = null`。
- 请求上下文 `{query, ua, ip, now}` **每请求构造一次**，所有规则共享；UA 只解析一次（device / browser 结果缓存在上下文里）。
- **规则缓存未就绪时的回落**：若 `rules-cache` 整体未就绪（首次拉取失败），走查库路径 `resolve()`，用其返回的 `rules` 列求值；该列也为空则用默认 `longUrl`。已就绪但某个短链不在 Map 里 = 该短链确实无规则，直接用默认 `longUrl`。

### 6.6 效率要点

| 项 | 做法 |
|---|---|
| UA 解析 | 每请求 1 次（device + browser 一次算完），不按条件重复解析 |
| 规则遍历 | 命中即停；规则内条件短路（任一不满足立即进入下一条规则） |
| geo 查找 | 二分 `O(log n)`，数据全内存，无磁盘 IO |
| 无规则短链 | 主缓存命中即返回，求值路径完全不进入（与现状开销相同） |
| 快照体积 | 规则快照只含有规则的短链，与总短链数无关 |

### 6.7 部署包

`dist/redirect.zip` 需包含：`index.js`、`cache.js`、`ipmat.js`、`rules.js`、`china-geo.js`、`china-geo.bin`（`rules-cache.js` 亦需包含）。

> 历史坑：functions-cli 部署包以入口文件为准（I8 证据）。FC 控制台手工上传 zip 不受此限，但为免歧义，规则相关文件全部放在同一 zip 内、顶层目录。

---

## 7. 测试

### 7.1 `fc/redirect/test/rules.test.js`（新增）

- 11 种条件类型各 ≥ 2 例（命中 / 不命中）。
- 组合：多条件 AND、规则内任一不满足即跳过、空条件规则永不命中。
- 优先级：多条规则按 `priority` 升序，第一条命中即停。
- 降级：非法 UA、空 UA、非法 IP、缺 `matchKey` → 不抛错，判为不匹配。
- `language`：q 值过滤、`*` 不匹配、`zh` vs `zh-CN` 区分。
- `query-param` 三态：精确值 / 任意值 / 无值。

### 7.2 `fc/redirect/test/china-geo.test.js`（新增）

- 已知 IP → 正确省名（英文 + 中文）。
- 网段边界 IP（start / end）→ 命中同一省。
- 非中国 IP、IPv6 → `null`。
- 数据文件缺失 / 损坏 → `null`，不抛错。
- 二分查找正确性（随机抽样与全表扫描对照）。

### 7.3 `fc/redirect/test/redirect.test.js`（扩展）

- 规则命中 → 302 到规则 `longUrl`。
- 规则不命中 → 302 到默认 `longUrl`。
- `forward_query` 与规则组合 → query 拼在最终目标上。
- 像素路由不套用规则。

### 7.4 `supabase/functions/compat/test/compat.test.ts`（扩展）

- `GET` 返回真规则（形状 `{defaultLongUrl, redirectRules}`）。
- `POST` 保存成功 → 响应含 `priority` 与 `conditions`。
- 11 种非法值各自 → 400。
- 缺 `longUrl` / 未知 `type` → 400。
- `VERSION === '5.1.0'`。
- `excludeTags` 筛选生效（含 `any` / `all` 两态）。

### 7.5 线上 SQL 断言（迁移应用后）

- 保存规则 → `get_short_url_redirect_rules` 形状正确、`priority` 连续。
- `rules_seq` +1 而 `link_seq` **不变**。
- `hasRedirectRules` 由 `false` 变 `true`。
- `resolve_short` 的 `rules` 列返回规则数组，无规则时为 `null`。

---

## 8. 部署顺序与回滚

### 8.1 顺序

1. **备份**：把 `resolve_short` / `short_url_json` / `get_short_url_redirect_rules` / `list_short_urls` 的定义存入备份表（沿用 I8 的 `funcdef_bak_*` 做法）。
2. **迁移**：`0018_redirect_rules.sql`（新表 + `rules_version` + 触发器 + 新 RPC + 覆盖 3 个旧函数）、`0019_list_exclude_tags.sql`（`list_short_urls` 覆盖）。逐条 `supabase db query` 执行 + 断言。
3. **兼容层**：改 `handler.ts` → `node scripts/build-compat-function.mjs` → `functions-cli deploy compat -d …/dist --no-verify-jwt` → 线上验收。
4. **跳转函数**：`node scripts/build-china-geo.mjs` → `node --test fc/redirect/test/` → 重打 `dist/redirect.zip` → **用户上传 FC 控制台** → 线上验收。
5. **文档**：runbook 新增 §5.4、`docs/verification/i9-results.md`、迭代计划 I9 章节与 B9 清单、`docs/shlink-feature-checklist.md` 更新（`setShortUrlRedirectRules` 501 → ✅）。

### 8.2 回滚

- 迁移是**纯新增 + 覆盖函数**，不改旧表数据。
- 功能级回滚：FC 侧移除规则求值调用 → 全部回到默认 `longUrl`；兼容层回滚到旧包。
- 结构级回滚：用备份表里的函数定义覆盖还原；新表与 `rules_version` 可保留（不影响旧路径）。

---

## 9. 验收清单

- [ ] 控制台「跳转规则」页能新增 / 保存 / 删除规则；保存不再报 501。
- [ ] 规则列表显示条件（人可读文案由控制台渲染）。
- [ ] `GET` 返回的规则与保存内容一致（`priority` 连续、条件完整）。
- [ ] 线上行为：`?src=x` 按 `query-param` 规则跳不同目标。
- [ ] 线上行为：手机 UA 命中 `device=mobile` 规则。
- [ ] 线上行为：国内 IP 命中对应省份的 `geolocation-city-name` 规则。
- [ ] 线上行为：都不匹配 → 回默认长链。
- [ ] 规则保存后 ≤5s 全网生效（不改主快照 seq）。
- [ ] 回归：旧 55 例单测仍全绿；`/robots.txt`、像素、404 页行为不变。
- [ ] 性能：带规则短链 P95 相对默认短链增量 < 5ms。
- [ ] `/health` 返回 `version: 5.1.0`，控制台无版本相关报错。

---

## 10. 已知限制与遗留

1. **UA 解析自己实现**：shlink 用 PHP 库 `donatj/UserAgent`；我们用自写的轻量解析，口径对齐 shlink 的 `DeviceType` / `Browser` 枚举，但**边缘 UA 的判定可能与 shlink 略有差异**（尤其 `android_browser` 与 `mobile` 的组合）。已在 §7.1 覆盖主流 UA。
2. **geo 只覆盖中国大陆**：`geolocation-country-code` 实际只匹配 `CN`；海外 IP 不命中 geo 条件（规则静默不生效，需在文档说明）。
3. **geo 数据是构建期快照**：DB-IP 每月更新；我们只在手动跑 `build-china-geo.mjs` 时更新，不做自动月更（与 `build-geoip-bundle.mjs` 的人工流程一致）。
4. **IPv6 不做 geo 匹配**：数据文件只含 IPv4 网段；IPv6 客户端的 geo 条件不命中。
5. **geo 精度受 DB-IP 限制**：省级精度，不是市级；DB-IP 对少量 CN IP 无 subdivision（3 条前缀），这些 IP 算「中国」但不匹配任何省名条件。
6. **省名只有中英两种**：DB-IP subdivision 只有英文名，中文名来自构建脚本内置的 31 条映射表；若 DB-IP 改用别的省名写法，映射表需要同步更新（否则该省只能用英文名匹配）。
7. **`language` 只取 q ≥ 0.9**：与 shlink `acceptLanguageToLocales(minQuality: 0.9)` 一致，但 Accept-Language 解析是自己实现的，与 shlink 的完整实现可能有细微差别。
8. **版本旋钮提到 5.1.0 的连带影响**：控制台会打开 `filterShortUrlsByDomain`（4.3.0）、`filterVisitsByDomain`（4.6.0）、`filterShortUrlsByExcludedTags`（4.6.0）等更高版本功能。已核对：`filterShortUrlsByDomain` 走 `p_domain`（我们已支持）；`filterVisitsByDomain` 在控制台侧按域名分组、不新增后端参数；**唯一确实缺失的是 `excludeTags`，已由 0019 补齐**。这条结论基于对 `shlink-web-client/node_modules/@shlinkio/shlink-web-component/dist/index.js` 的版本门控点核对，属于「已核对但需上线后逐页复验」，上线后若发现新的 4xx 再补。
9. **geo 数据构建耗时约 70 秒**：遍历 mmdb 全树（1428 万节点）才能抽出 CN 区间。构建期一次性成本，不影响运行时（运行时只读 135KB 二进制）。

---

## 11. 参考

- shlink 规则模型：`shlink/module/Core/src/RedirectRule/Model/RedirectConditionType.php`、`Entity/RedirectCondition.php`、`Entity/ShortUrlRedirectRule.php`
- shlink 规则服务：`shlink/module/Core/src/RedirectRule/ShortUrlRedirectRuleService.php`、`ShortUrlRedirectionResolver.php`
- shlink REST 动作：`shlink/module/Rest/src/Action/RedirectRule/{List,Set}RedirectRulesAction.php`
- shlink 迁移参考：`shlink/module/Core/migrations/Version20240224115725.php`
- SDK 契约：`docs/reference/shlink-sdk-3.2.1/types.d.ts`（`ShlinkRedirectRule*`）
- 现有 geo 富化：`docs/geo-enrichment.md`、`fc/geo-enrich/`
- 现有兼容层：`supabase/functions/compat/handler.ts`
- 现有迁移：`supabase/migrations/0004`–`0017`
