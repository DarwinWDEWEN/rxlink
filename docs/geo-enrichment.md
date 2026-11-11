# 地理富化设计（2026-11-10 定案，2026-11-11 换源修订）

> 状态：**全部已实现并验证**（§4 数据面 + §5 富化函数 + §6 契约 + §7 兜底）。
> 唯一未完成的是 **FC 富化函数的部署**（控制台建函数 + 挂定时触发器，用户动作）。
>
> - §4 = 迁移 `0012_geo_location.sql`（15 条语句，2026-11-10 应用）+ `0013_geo_location_id_match.sql`（修回写失配，2 条）
> - §5 = `fc/geo-enrich/`（20 例单测全绿 + 真实 mmdb 端到端跑通 15/15 行）
> - §6 = `visit_json` 契约改读列（同在 0012）
> - §7 = `retire_remote_addr` 兜底（cron jobid 9，每小时）
> - 迭代记录见 `docs/iteration-plan.md` I7 / B7

---

## 0. 修订：数据源从 MaxMind 换成 DB-IP（2026-11-11）

原设计用 **MaxMind GeoLite2 + License key**。实施前复核许可口径时发现问题：

> MaxMind 账号页原文：*"Lightweight geolocation data ... **Free for personal use**. A commercial license is available for basic commercial use cases."*

rxlink 的定位是**对外提供服务、可能收费**（2026-11-11 用户确认），免费 GeoLite2 的「仅个人使用」口径不适用；付费 GeoLite2 另计成本，且要管一个密钥。

**换成 DB-IP "IP to City Lite"**（实测 2026-11-11 可下载，HTTP 200，57MB）：

| | MaxMind GeoLite2 City | DB-IP City Lite |
|---|---|---|
| 下载 | 需账号 + key（实测假 key → 401） | **免注册免 key**，文件名带年月可拼 URL |
| 格式 | MMDB | MMDB（**同一个 `maxmind` npm 包读，代码零改动**） |
| 许可 | 免费版仅个人使用 | CC BY 4.0，**明确允许商用** |
| 更新 | 每周二/五 | 每月 |
| 署名义务 | 需要 | 需要（"IP Geolocation by DB-IP"） |
| 附加义务 | 新版发布 30 天内删旧副本 | 无 |

**取舍**：

1. **省掉一个密钥** —— 不再有 `MAXMIND_LICENSE_KEY` 要进 FC 环境变量，也少一处泄露面。`GEO_MMDB_URL` 环境变量保留，换源不用改代码。
2. **更新频率降到月更** → `GEO_MMDB_MAX_AGE_DAYS` 设 **14 天**（不是原设计的 30 天：DB-IP 月更，14 天能保证拿到当期版本；30 天是 MaxMind EULA「新版发布 30 天内删旧副本」的上限边界，不是最佳值）。
3. **DB-IP 没有 `time_zone` 字段** → `visit.timezone` 恒为 NULL。
   - 契约 `ShlinkVisitLocation.timezone` 类型是 `string | null`，**允许 null**；
   - 控制台只渲染 country/region/city/latitude/longitude，**不渲染 timezone**（已从构建产物核实）；
   - 要时区就把 `GEO_MMDB_URL` 指向带 time_zone 的库（IP2Location LITE / GeoLite2）。
4. **署名义务**：DB-IP 要求在展示/使用结果的页面标注 "IP Geolocation by DB-IP"。控制台若展示地理位置，需在页脚或说明里加一行 —— **待定，用户决定**。

---

## 1. 结论与出处

### 1.1 NAT 出网：不需要 NAT 网关

FC 官方《配置网络》列出「允许函数既能访问公网，也能访问 VPC」这一组合：

- 允许访问 VPC = **是**
- 允许函数访问公网 = **是**

非 GPU 函数：公网走「函数网络」，内网走用户 VPC（支持 PrivateZone），两条路独立；**NAT 网关只在需要固定公网出口 IP 时才用**。
出处：[配置网络](https://help.aliyun.com/document_detail/161919.html)（2026-10-15）。

配置级别：**函数级**（旧文档写服务级，控制台核实）。对我们的影响：

- 富化函数单独建、开双网；
- 跳转函数**保持现状不动**（它不需要公网，少一个暴露面）。

### 1.2 为什么不在热路径定位

`tech-framework.md` §5.3 已定：跳转热路径只做一次读 + 一次入队。定位要查 60MB mmdb，且 mmdb 必须出公网下载 —— 热路径函数不该有公网出口。

## 2. 架构

```
跳转函数（Web 函数，VPC only，不动）
  └─ inbox payload + remote_addr
        │
  drain_visit_inbox（cron 每分钟）
        └─ visit.remote_addr
              │
  富化函数（事件函数，双网络，定时触发器每分钟）
    ├─ 下载/刷新 GeoLite2-City mmdb → /tmp（冷启动或满 30 天）
    ├─ RPC visits_pending_location(500)
    ├─ 本地 mmdb 逐条查 IP
    └─ RPC apply_visit_locations(jsonb) → 写 location + 清空 remote_addr
              │
  契约：visit_json 的 visitLocation 从恒 null 改为读这些列
```

- 富化函数是**事件函数**（`exports.handler`），不是 Web 函数：定时触发器挂在事件函数上（事件函数支持除 HTTP 触发器外的所有触发器，[函数类型选型](https://help.aliyun.com/document_detail/61009.html)）。
- 定时触发器是**异步调用**；超时设 ≥60s（要容纳 mmdb 下载），内存 ≥512MB。
- 触发器 cron（6 字段，UTC）：`CRON_TZ=Asia/Shanghai 0 * * * * *`（每分钟）。

## 3. 数据流

| 步 | 位置 | 动作 |
|---|---|---|
| 1 | `fc/redirect/index.js` | inbox payload 加 `remote_addr`（复用已有 `clientIp()`，取 x-forwarded-for 首元素） |
| 2 | `drain_visit_inbox` | insert 多写一列 `remote_addr` |
| 3 | 富化函数 | 拉批 → 查 → 回写 → 清空 |
| 4 | `visit_json` | `visitLocation` 由恒 null 改为读列（见 §6） |

## 4. Schema（migration `0012_geo_location.sql`）

```sql
-- 热路径入队表：加原始 IP
alter table visit_inbox add column remote_addr text;

-- 明细表：原始 IP + 定位结果（country/region/city 两列当前全空，D4 推迟期留下，这里正名）
alter table visit add column remote_addr text;
alter table visit rename column country to country_name;
alter table visit rename column region  to region_name;
alter table visit rename column city   to city_name;
alter table visit add column country_code text;
alter table visit add column lat double precision;
alter table visit add column lon double precision;
alter table visit add column timezone text;

-- 未富化批次的部分索引（只装 remote_addr 非空的行，避免每分钟扫全表）
create index visit_pending_location_idx on visit (occurred_at) where remote_addr is not null;
```

> 重命名在分区父表上执行，会传播到既有分区；三列当前无数据，无迁移风险。

> **实现差异（2026-11-10 落地）**：
> - 三次重命名包在 `DO` 块里做存在性判断（`pg_attribute` 查 `attname`），脚本可重复执行不报错。
> - `apply_visit_locations` 的返回值改为**实际更新行数**（`GET DIAGNOSTICS row_count` 累加），而不是「处理了几条」——调用方据此知道真正落了几条。
> - 迁移同时覆盖了 `drain_visit_inbox`（加 `remote_addr` 一列）与 `visit_json`（§6）——原函数所在文件 0006/0009 是已应用历史，不改，只在新文件里覆盖。
>
> **修订（2026-11-11，`0013_geo_location_id_match.sql`）**：0012 的 `apply_visit_locations` 用 `(id, occurred_at)` 双条件定位行，但 **PostgREST 把 timestamptz 序列化成毫秒精度**，微秒尾巴被截断；而 `visit.occurred_at` 是微秒精度。⇒ 凡是 `occurred_at` 不是毫秒对齐的行（SQL 侧造的数据、手工数据）永远匹配不上：实测 `apply_visit_locations` 返回 0 行、`remote_addr` 不被清空。
> 生产流量走 JS `toISOString()`（毫秒精度）恰好对齐才侥幸没暴露。**修复：只按 `id` 匹配** —— `visit.id` 是父表上的 bigserial，序列跨分区共享 ⇒ 全局唯一（实测 173 行 / 173 个不同 id）；分区扫描仍走各分区 PK 索引的前导列 id，代价可接受。同时把逐行循环 UPDATE 改成单条 set-based UPDATE（一批 500 行从 500 次扫描降到 1 次）。

### 4.1 RPC

```sql
-- 拉未富化批次（7 天内；由部分索引承接）
create or replace function visits_pending_location(p_limit int default 500)
returns table(id bigint, occurred_at timestamptz, remote_addr text)
language sql stable set search_path = public as $$
  select v.id, v.occurred_at, v.remote_addr
  from visit v
  where v.remote_addr is not null
    and v.occurred_at > now() - interval '7 days'
  order by v.occurred_at
  limit greatest(1, p_limit);
$$;

-- 批量回写：写 location + 清空 remote_addr（按 (id, occurred_at) 命中单一分区）
create or replace function apply_visit_locations(p_rows jsonb)
returns int language plpgsql set search_path = public as $$
declare v_row jsonb; v_count int := 0;
begin
  for v_row in select * from jsonb_array_elements(p_rows) loop
    update visit v
       set country_code = nullif(v_row->>'country_code', ''),
           country_name = nullif(v_row->>'country_name', ''),
           region_name  = nullif(v_row->>'region_name', ''),
           city_name    = nullif(v_row->>'city_name', ''),
           lat          = nullif(v_row->>'lat', '')::double precision,
           lon          = nullif(v_row->>'lon', '')::double precision,
           timezone     = nullif(v_row->>'timezone', ''),
           remote_addr  = null
     where v.id = (v_row->>'id')::bigint
       and v.occurred_at = (v_row->>'occurred_at')::timestamptz
       and v.remote_addr is not null;
    v_count := v_count + 1;
  end loop;
  return v_count;
end; $$;

-- 兜底：清掉超期仍留存的原始 IP（纯 SQL，pg_cron 每小时跑一次）
create or replace function retire_remote_addr(p_days int default 7)
returns int language plpgsql set search_path = public as $$
declare v_count int;
begin
  update visit v set remote_addr = null
   where v.remote_addr is not null
     and v.occurred_at < now() - (p_days || ' days')::interval;
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

revoke execute on function visits_pending_location(int), apply_visit_locations(jsonb), retire_remote_addr(int)
  from public, anon, authenticated;
grant execute on function visits_pending_location(int), apply_visit_locations(jsonb), retire_remote_addr(int)
  to service_role;
```

## 5. 富化函数（`fc/geo-enrich/`）—— 已实现

- 形态：事件函数，`exports.handler = async (event, context) => { ... }`；FC 控制台的**请求处理程序填 `index.handler`**（官方按「文件名.方法名」加载，运行时 bootstrap 调用，代码不需要自己起 HTTP 服务）。
- 依赖：`maxmind`（mmdb 读取），无其他依赖。DB-IP 是单个 `.mmdb.gz`，用 Node 内置 `zlib` 解压即可，**不需要 tar**。部署时连同 `node_modules` 一起打 zip。
- **mmdb 来源：优先用代码包内自带的**（`fc/geo-enrich/geoip/dbip-city-lite.mmdb.br`），解压到 `/tmp` 后读；**包内没有才回退到运行时下载**（`GEO_MMDB_URL`）。
  - 好处：运行时不联网 → **不需要「允许函数访问公网」**、不依赖 DB-IP 站点可用性、冷启动零下载（解压 0.7 秒）。
  - 包内是原始 `.mmdb` 时直接从 `/code` 读，零解压、零 `/tmp` 占用。
- 环境变量：`SUPABASE_URL`（FC 侧是 VPC 内网地址）、`SUPABASE_SERVICE_ROLE_KEY`、`GEO_MMDB_PATH`（默认 `/tmp/dbip-city-lite.mmdb`）、`GEO_MMDB_BUNDLE`（默认 `<代码包>/geoip/dbip-city-lite.mmdb.br`，置空串禁用）、`GEO_MMDB_URL`、`GEO_MMDB_BASE`、`GEO_MMDB_MAX_AGE_DAYS`（默认 14）、`GEO_BATCH_LIMIT`（默认 500）、`GEO_MAX_BATCHES`（默认 20）、`GEO_TIME_BUDGET_MS`（默认 45000）、`GEO_DOWNLOAD_BACKOFF_MS`（默认 3600000）。**不需要任何密钥。**
- 代码结构：`lib.js`（纯逻辑，可单测）+ `index.js`（IO 与 handler，依赖注入便于测）。

流程：

1. `ensureReader()`：`/tmp` 里有新鲜文件 → 直接用；否则 → 解压包内 bundle → 再否则才从 `GEO_MMDB_URL` 下载（失败写 `<path>.last_fail`，**1 小时内不重试**）。
2. `visits_pending_location(GEO_BATCH_LIMIT)` 拉批。
3. 逐条 `reader.get(ip)`：**先 `maxmind.validate(ip)` 再查**（`reader.get` 不校验，`'1.2.3'` 也会给出国家），异常与查不到一律当空。
4. `apply_visit_locations(rows)` 回写。
5. 日志：只有计数（batches/pulled/updated/耗时）；**不打印 IP**。下载 URL 在错误日志里会被抹掉。

> 未命中（私有 IP / 库中查不到）也要回写清空，否则会每轮重复捞；靠 7 天兜底防长期堆积。
>
> 一轮最多 `GEO_MAX_BATCHES` 批；某批返回行数 < limit 即认为拉干净，提前退出；累计超过 `GEO_TIME_BUDGET_MS` 也提前退出（不硬撑到平台超时）。

**触发频率：每小时一次**（`CRON_TZ=Asia/Shanghai 0 * * * *`）。按当前流量（每分钟个位数新增）绰绰有余；代价是控制台位置信息延迟 0–60 分钟，换来的是调用量和 IP 留存时间都更低。批处理上限已相应放大到 20 批 × 500 行 = 10000 行/轮。

**实测（2026-11-11，本机 + 真实库）**：

- 24 例单测全绿（`node --test fc/geo-enrich/test/`）
- 真实 mmdb 下载 → 解压（121MB）→ `maxmind.open` → 记录结构与 `locationOf` 预期一致
- 端到端：拉批 15 行 / 回写 15 行 / 369ms；落库结果 `US·Virginia·Ashburn`、`HK·Central and Western·Sheung Wan`、`MA·Rabat`、`PL·Warsaw`；`remote_addr` 回写后全为 NULL

**月更流程**（DB-IP 每月初发布新版）：

```bash
node scripts/build-geoip-bundle.mjs          # 下载 + brotli 压缩 → fc/geo-enrich/geoip/
node scripts/build-geo-enrich-fc.mjs         # 重新打 dist/geo-enrich.zip
```

> bundle 是构建产物（不进 git，`.gitignore` 已排除），靠上面两条命令可复现。


## 6. 契约（`visit_json`）

```sql
'visitLocation', case when v.country_code is null then null else jsonb_build_object(
  'countryCode', v.country_code,
  'countryName', v.country_name,
  'regionName', v.region_name,
  'cityName',   v.city_name,
  'latitude',   v.lat,
  'longitude',  v.lon,
  'timezone',   v.timezone,
  'isEmpty',    false
) end,
```

- 有定位数据 → 返回对象；无 → `null`（SDK 类型 `ShlinkVisitLocation | null` 允许）。
- 与 shlink 的差异：shlink 对定位失败返回 `isEmpty=true` 的对象，我们返回 `null`。控制台展示等价（都不显示地区）。
- `visit_json` 不暴露 `remote_addr`。

## 7. 兜底与隐私

- `remote_addr` 最长留 7 天：`retire_remote_addr()` 由 pg_cron 每小时清一次（纯 SQL）。
- 富化函数下载失败 → 不清空、下轮再试；超期由兜底清掉。
- 原始 IP 不写日志、不进契约、不进快照；inbox 是 UNLOGGED 且 1 天内物理删。

## 8. 前置

- ~~MaxMind 账号 + License key~~ —— **已不需要**（换源为 DB-IP，见 §0）。
- **FC 富化函数部署**（用户动作）：
  - 函数计算 > 创建函数 > **事件函数**，运行时 Node.js 18/20，**请求处理程序填 `index.handler`**；
  - 上传 `dist/geo-enrich.zip`；
  - 环境变量：`SUPABASE_URL`（**VPC 内网地址**）、`SUPABASE_SERVICE_ROLE_KEY`；
  - 网络：允许访问 VPC = **是**；**允许函数访问公网 = 否**（包内自带 mmdb，运行时不联网）；
  - 规格：超时 ≥60s、内存 ≥512MB；
  - 触发器 > 定时触发器，**每小时**：`CRON_TZ=Asia/Shanghai 0 * * * *`。
- **代码包体积**：FC ZIP 直传上限 50MB、OSS 上传上限 250MB。
  - DB-IP City Lite 原始 121MB / gzip 58MB / brotli q11 ≈ 49–50MB —— **取决于 brotli 结果**；
  - 若 bundle 压不进 50MB：改用 **OSS 上传**（控制台代码页选「OSS 上传」，上限 250MB），或降级到 DB-IP Country Lite（4.2MB，只有国家级）。
- 付费版（已有阻塞项）。
- 署名：DB-IP 要求展示结果处标注 "IP Geolocation by DB-IP"（**待用户决定加在哪里**）。

## 9. 测试

- **SQL**（2026-11-10 已跑通）：造带 `remote_addr` 的 visit → `visits_pending_location` 命中；`apply_visit_locations` 写列并清空；`retire_remote_addr` 清旧；权限矩阵（anon 401 / service_role 200）。
- **跳转函数**（已跑通）：单测断言 inbox payload 含 `remote_addr`，15/15。
- **富化函数**（已跑通）：20 例单测（mock reader + mock RPC，覆盖命中 / 未命中 / 非法 IP / mmdb 缺失 / 下载失败退避 / 日志无 IP）；集成用真实 mmdb 跑一遍。
- **契约**（已跑通）：`visit_json` 有位置 / 无位置两态；`remote_addr` 不出现在契约里。
- **端到端**（2026-11-11 已跑通，本机 + 真实库）：15 行拉取 → 15 行回写 → 369ms；库内 location 落、`remote_addr` 清零。
- **线上闭环**（待部署后）：FC 富化函数挂上定时触发器 → 等一轮 → 查库确认 location 落、`remote_addr` 清。

## 10. 不做

- 不在热路径定位。
- 不长期存 IP。
- 不抄 shlink 的 `geolocation_db_updates` 表（`shlink-migration-analysis.md` 已列 ❌）。
- 不做固定公网 IP（NAT + EIP）—— 除非以后有 API 白名单需求。
- 不接付费 GeoIP2 / GeoLite2 商用许可（除非将来精度或合规要求变）。
- 不做时区（DB-IP 无 `time_zone` 字段；契约允许 null，控制台不渲染）。
