# 地理富化设计（2026-11-10 定案）

> 状态：**设计定稿，待实现**。存储方案 A（mmdb 放 FC 实例 /tmp）；IP 口径「短暂留存」已拍板。
> 前置：MaxMind License key（用户申请，填 FC 环境变量）；生产需先升付费版（已有阻塞项）。

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

## 5. 富化函数（`fc/geo-enrich/`）

- 形态：事件函数，`exports.handler = async (event, context) => { ... }`。
- 依赖：`maxmind`（mmdb 读取）、`tar`（解压 .tar.gz）。部署时连同 `node_modules` 一起打 zip 上传。
- 环境变量：`SUPABASE_URL`（内网）、`SUPABASE_SERVICE_ROLE_KEY`、`MAXMIND_LICENSE_KEY`（用户填）、可选 `GEO_MMDB_URL`（覆盖下载源，为方案 B 留口子）、`GEO_BATCH_LIMIT`（默认 500）、`GEO_MMDB_MAX_AGE_DAYS`（默认 30）。

流程：

1. `ensureMmdb()`：`/tmp/GeoLite2-City.mmdb` 不存在或 mtime 超过 30 天 → 下载
   `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=…&suffix=tar.gz`
   → 解压 → 用 `maxmind.open` 校验；失败写 `/tmp/.mmdb_last_fail`，**1 小时内不重试**（避免打 MaxMind）。
2. `visits_pending_location(GEO_BATCH_LIMIT)` 拉批。
3. 逐条 `reader.get(ip)`，组装 `[{id, occurred_at, country_code, country_name, region_name, city_name, lat, lon, timezone}]`。
4. `apply_visit_locations(rows)` 回写。
5. 日志：本批条数、命中数、mmdb 年龄；**不打印 IP**。

> 未命中（私有 IP / 库中查不到）也要回写清空，否则会每轮重复捞；靠 7 天兜底防长期堆积。

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

- **MaxMind 账号 + License key**（用户申请，填 FC 环境变量；仓库只留变量名）。
- FC 富化函数：事件函数 + 定时触发器 + 双网络 + 超时 ≥60s + 内存 ≥512MB。
- 付费版（已有阻塞项；方案 A 本身免费版可跑通）。

## 9. 测试

- **SQL**：造带 `remote_addr` 的 visit → `visits_pending_location` 命中；`apply_visit_locations` 写列并清空；`retire_remote_addr` 清旧；权限矩阵（anon 不可调）。
- **跳转函数**：单测断言 inbox payload 含 `remote_addr`。
- **富化函数**：单测（mock reader + mock RPC）覆盖命中 / 未命中 / mmdb 缺失；集成用真实 mmdb 跑一遍。
- **契约**：`visit_json` 有位置 / 无位置两态。
- **线上闭环**：造一条带 `remote_addr` 的 visit → 等定时 → 查库确认 location 落、`remote_addr` 清。

## 10. 不做

- 不在热路径定位。
- 不长期存 IP。
- 不抄 shlink 的 `geolocation_db_updates` 表（`shlink-migration-analysis.md` 已列 ❌）。
- 不做固定公网 IP（NAT + EIP）—— 除非以后有 API 白名单需求。
