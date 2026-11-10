-- 0012_geo_location.sql —— 地理富化第一步：原始 IP 落地 + 定位结果列 + 富化 RPC
--
-- 依据：docs/geo-enrichment.md §4（设计定稿 2026-11-10）
-- 覆盖任务：#41（schema + RPC）、#42 的库侧一半（drain 多写 remote_addr）、#44 的契约与兜底一半
-- 迁移文件是不可变历史：0001–0011 不改不删，本文件只做新增与覆盖（覆盖的函数在别处已注明）
--
-- 隐私口径：原始 IP 只在 visit.remote_addr 短暂留存
--   - 富化函数写完定位结果后立即清空（apply_visit_locations）
--   - 7 天硬上限由 retire_remote_addr() 兜底（pg_cron 每小时）
--   - remote_addr 不进契约（visit_json 不暴露）、不写日志、不进快照

-- ---------------------------------------------------------------------------
-- 1. 热路径入队表：加原始 IP
--    跳转函数每次访问带 x-forwarded-for 首元素进来，drain 时转写进 visit
-- ---------------------------------------------------------------------------
alter table visit_inbox add column if not exists remote_addr text;

-- ---------------------------------------------------------------------------
-- 2. 明细表：原始 IP + 定位结果列
--    country/region/city 是 D4 推迟期留下的三个空列（2026-11-10 实测 158 行全空），
--    这里正名为 *_name 并补齐国家码/经纬度/时区，与 geo-enrichment §4 一致。
-- ---------------------------------------------------------------------------
alter table visit add column if not exists remote_addr text;
alter table visit add column if not exists country_code text;
alter table visit add column if not exists lat double precision;
alter table visit add column if not exists lon double precision;
alter table visit add column if not exists timezone text;

-- 重命名在分区父表上执行，会传播到既有分区（visit_2026_11/2026_12/2027_01）。
-- 用 DO 块做存在性判断，保证脚本可重复执行不报错。
do $$
begin
  if exists (
    select 1 from pg_attribute
     where attrelid = 'public.visit'::regclass and attname = 'country' and not attisdropped
  ) then
    alter table visit rename column country to country_name;
  end if;
  if exists (
    select 1 from pg_attribute
     where attrelid = 'public.visit'::regclass and attname = 'region' and not attisdropped
  ) then
    alter table visit rename column region to region_name;
  end if;
  if exists (
    select 1 from pg_attribute
     where attrelid = 'public.visit'::regclass and attname = 'city' and not attisdropped
  ) then
    alter table visit rename column city to city_name;
  end if;
end;
$$;

-- 未富化批次的部分索引：只装 remote_addr 非空的行，避免富化函数每分钟扫全表。
-- 分区父表上的分区索引会传播到既有分区；ensure_visit_partition 新建的分区自动继承。
create index if not exists visit_pending_location_idx
  on visit (occurred_at) where remote_addr is not null;

-- ---------------------------------------------------------------------------
-- 3. 富化相关 RPC（三个，都只授 service_role）
-- ---------------------------------------------------------------------------

-- 拉未富化批次（7 天内；由 visit_pending_location_idx 承接）
create or replace function visits_pending_location(p_limit integer default 500)
returns table(id bigint, occurred_at timestamptz, remote_addr text)
language sql
stable
set search_path = public
as $$
  select v.id, v.occurred_at, v.remote_addr
    from visit v
   where v.remote_addr is not null
     and v.occurred_at > now() - interval '7 days'
   order by v.occurred_at
   limit greatest(1, p_limit);
$$;

-- 批量回写：写定位结果 + 清空原始 IP
--   按 (id, occurred_at) 命中单一分区；remote_addr is not null 保证不重复处理已富化的行。
--   返回值是实际更新行数（未命中 IP 的行也会回写空串并清空 IP，所以计入）。
create or replace function apply_visit_locations(p_rows jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_row jsonb;
  v_count integer := 0;
  v_hit  integer := 0;
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
    get diagnostics v_hit = row_count;
    v_count := v_count + v_hit;
  end loop;
  return v_count;
end;
$$;

-- 兜底：清掉超期仍留存的原始 IP（纯 SQL，pg_cron 每小时跑一次）
create or replace function retire_remote_addr(p_days integer default 7)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  update visit v set remote_addr = null
   where v.remote_addr is not null
     and v.occurred_at < now() - (p_days || ' days')::interval;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. drain 覆盖：insert 多写 remote_addr 一列
--    覆盖 0006_ua_parse.sql 的同名函数（其余逻辑完全一致，仅 ins 段多一列）。
--    0006 是已应用历史，不改；这是可追溯的覆盖。
-- ---------------------------------------------------------------------------
create or replace function drain_visit_inbox(p_limit integer default 500)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count int;
begin
  with batch as (
    select id
      from visit_inbox
     where processed_at is null
     order by id
     limit greatest(1, p_limit)
     for update skip locked
  ), scored as (
    -- Bot 判定 + 标记已处理必须是同一次 UPDATE：同一语句里对同一行做第二次 UPDATE
    -- 会被 Postgres 静默跳过（第二次看不到本命令刚写的版本），processing 会永远留着。
    update visit_inbox i
       set potential_bot = coalesce(i.potential_bot, exists (
             select 1 from bot_pattern b
              where b.enabled
                and position(b.pattern in lower(coalesce(i.ua, ''))) > 0
           )),
           processed_at = now()
     where i.id in (select id from batch)
     returning i.*
  ), ins as (
    insert into visit (
      occurred_at, short_url_id, orphan_type, visitor_key, ua, referer,
      visited_url, redirect_url, potential_bot, browser, os, device, remote_addr
    )
    select sc.occurred_at, sc.short_url_id, sc.orphan_type, sc.visitor_key, sc.ua, sc.referer,
           sc.visited_url, sc.redirect_to, sc.potential_bot, u.browser, u.os, u.device, sc.remote_addr
      from scored sc
      cross join lateral ua_parse(sc.ua) u
    returning 1
  ), upd as (
    update short_url s
       set visits_count  = s.visits_count + g.n,
           last_visit_at = greatest(coalesce(s.last_visit_at, s.created_at), g.last_at)
      from (
        select short_url_id, count(*) as n, max(occurred_at) as last_at
          from scored
         where short_url_id is not null
         group by short_url_id
      ) g
     where s.id = g.short_url_id
    returning 1
  ), cnt as (
    insert into short_url_visits_counts (short_url_id, potential_bot, slot_id, count)
    select short_url_id, potential_bot, (1 + (id % 100))::smallint, count(*)
      from scored
     where short_url_id is not null
     group by short_url_id, potential_bot, (1 + (id % 100))::smallint
    on conflict (short_url_id, potential_bot, slot_id)
    do update set count = short_url_visits_counts.count + excluded.count
    returning 1
  ), ocnt as (
    insert into orphan_visits_counts (potential_bot, slot_id, count)
    select potential_bot, (1 + (id % 100))::smallint, count(*)
      from scored
     where short_url_id is null
     group by potential_bot, (1 + (id % 100))::smallint
    on conflict (potential_bot, slot_id)
    do update set count = orphan_visits_counts.count + excluded.count
    returning 1
  )
  select count(*)::int into v_count from scored;

  -- 已处理的入队行留一天便于排查，之后物理删除（UNLOGGED 表本身不参与备份）
  delete from visit_inbox where processed_at < now() - interval '1 day';

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. 契约覆盖：visit_json 的 visitLocation 由恒 null 改为读列
--    覆盖 0009_visits_api.sql 的同名函数。
--    有定位数据 → 返回对象；无 → JSON null（SDK 类型 ShlinkVisitLocation | null 允许）。
--    remote_addr 不出现在契约里。
-- ---------------------------------------------------------------------------
create or replace function visit_json(v visit)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'date',          v.occurred_at,
    'referer',       coalesce(v.referer, ''),
    'userAgent',     coalesce(v.ua, ''),
    'potentialBot',  v.potential_bot,
    'visitLocation', case when v.country_code is null then null else jsonb_build_object(
                           'countryCode', v.country_code,
                           'countryName', v.country_name,
                           'regionName',  v.region_name,
                           'cityName',    v.city_name,
                           'latitude',    v.lat,
                           'longitude',   v.lon,
                           'timezone',    v.timezone,
                           'isEmpty',     false
                         ) end,
    'visitedUrl',    v.visited_url,
    'redirectUrl',   v.redirect_url
  ) || case when v.orphan_type is not null
            then jsonb_build_object('type', v.orphan_type)
            else '{}'::jsonb
       end;
$$;

-- ---------------------------------------------------------------------------
-- 6. 权限收口：三个新 RPC 只给 service_role
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'visits_pending_location(integer)',
    'apply_visit_locations(jsonb)',
    'retire_remote_addr(integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. 兜底 cron：每小时清一次超期原始 IP（7 天硬上限）
--    幂等：同名作业先取消再挂，避免重复执行。
-- ---------------------------------------------------------------------------
do $$
declare
  jid integer;
begin
  select jobid into jid from cron.job where jobname = 'rxlink-retire-ip';
  if jid is not null then
    perform cron.unschedule(jid);
  end if;
  perform cron.schedule('rxlink-retire-ip', '0 * * * *', 'select retire_remote_addr(7)');
end;
$$;
