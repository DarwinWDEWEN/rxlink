-- 0013_geo_location_id_match.sql —— 修 apply_visit_locations 的回写失配
--
-- 缺陷：0012 的 apply_visit_locations 用 (id, occurred_at) 双条件定位行。
--   但 PostgREST 把 timestamptz 序列化成毫秒精度（'2026-11-11T01:19:19.755+00:00'），
--   微秒尾巴被截断；而 visit.occurred_at 是 timestamptz（微秒精度）。
--   于是凡 occurred_at 不是毫秒对齐的行（SQL 侧造的数据、手工数据）永远匹配不上：
--   实测 apply_visit_locations 返回 0 行、remote_addr 不被清空。
--
-- 修复：只按 id 匹配。visit.id 是父表上的 bigserial，序列跨分区共享 ⇒ 全局唯一
--   （2026-11-11 实测：173 行 / 173 个不同 id）。分区扫描仍走各分区 PK 索引的
--   前导列 id（PK 是 (id, occurred_at)），代价是每个分区一次索引探测，可接受。
--
-- 顺带：改成单条 set-based UPDATE（原来是一行一行的循环），一批 500 行从 500 次
--   Append 扫描降到 1 次。
--
-- 迁移文件是不可变历史：0012 不改不删，本文件只做覆盖。

create or replace function apply_visit_locations(p_rows jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  update visit v
     set country_code = nullif(r.country_code, ''),
         country_name = nullif(r.country_name, ''),
         region_name  = nullif(r.region_name, ''),
         city_name    = nullif(r.city_name, ''),
         lat          = nullif(r.lat, '')::double precision,
         lon          = nullif(r.lon, '')::double precision,
         timezone     = nullif(r.timezone, ''),
         remote_addr  = null
    from jsonb_to_recordset(p_rows) as r(
           id            bigint,
           country_code  text,
           country_name  text,
           region_name   text,
           city_name     text,
           lat           text,
           lon           text,
           timezone      text
         )
   where v.id = r.id
     and v.remote_addr is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

do $$
declare
  f text;
begin
  execute 'revoke execute on function apply_visit_locations(jsonb) from public, anon, authenticated';
  execute 'grant execute on function apply_visit_locations(jsonb) to service_role';
end;
$$;
