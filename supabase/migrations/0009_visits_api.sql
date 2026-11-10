-- 0009_visits_api.sql —— 访问统计读接口（I4 / B2）
--
-- 口径：
--   1) 明细来自 visit（分区表）；概览数字走计数表（short_url_visits_counts / orphan_visits_counts），
--      不在概览页扫全量明细。
--   2) 删除访问必须同步重算计数表 —— 否则控制台数字与明细会永久漂移。
--   3) visitLocation 恒为 null（M1/M2 不做定位）；孤儿访问带 type。
--   4) 标签访问按「当前标签关联」算，不做历史标签快照。
-- 权限：同 0005/0008，security invoker，只授 service_role。

-- ---------------------------------------------------------------------------
-- 1. 单条访问的对外 JSON（契约形状）
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
    'visitLocation', null,
    'visitedUrl',    v.visited_url,
    'redirectUrl',   v.redirect_url
  ) || case when v.orphan_type is not null
            then jsonb_build_object('type', v.orphan_type)
            else '{}'::jsonb
       end;
$$;

-- ---------------------------------------------------------------------------
-- 2. 概览：nonOrphanVisits / orphanVisits，各含 total/nonBots/bots
-- ---------------------------------------------------------------------------
create or replace function visits_overview()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'nonOrphanVisits', jsonb_build_object(
      'total',   coalesce((select sum(count) from short_url_visits_counts), 0),
      'nonBots', coalesce((select sum(count) from short_url_visits_counts where not potential_bot), 0),
      'bots',    coalesce((select sum(count) from short_url_visits_counts where potential_bot), 0)),
    'orphanVisits', jsonb_build_object(
      'total',   coalesce((select sum(count) from orphan_visits_counts), 0),
      'nonBots', coalesce((select sum(count) from orphan_visits_counts where not potential_bot), 0),
      'bots',    coalesce((select sum(count) from orphan_visits_counts where potential_bot), 0)));
$$;

-- ---------------------------------------------------------------------------
-- 3. 列表：五种范围共用一个函数
--    scope = short | tag | domain | non-orphan | orphan
--    key   = 短码 / 标签名 / 域名（scope=short 时配 p_domain）
--    未知域名返回空页；未知短码报 P0002（与详情接口一致）。
-- ---------------------------------------------------------------------------
create or replace function list_visits(
  p_scope        text,
  p_key          text        default null,
  p_domain       text        default null,
  p_page         integer     default 1,
  p_items        integer     default 20,
  p_start        timestamptz default null,
  p_end          timestamptz default null,
  p_exclude_bots boolean     default false,
  p_orphan_type  text        default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_page      int  := greatest(1, coalesce(p_page, 1));
  v_items     int  := greatest(1, least(coalesce(p_items, 20), 5000));
  v_scope     text := lower(btrim(coalesce(p_scope, '')));
  v_domain    bigint;
  v_short_id  bigint;
  v_tag       text;
  v_orphan    text := nullif(btrim(coalesce(p_orphan_type, '')), '');
  v_empty     jsonb;
begin
  if v_scope not in ('short', 'tag', 'domain', 'non-orphan', 'orphan') then
    raise exception using errcode = '22023', message = 'invalid_scope';
  end if;
  if v_orphan is not null and v_orphan not in ('base_url', 'invalid_short_url', 'regular_404') then
    raise exception using errcode = '22023', message = 'invalid_orphan_type';
  end if;

  v_empty := jsonb_build_object(
    'data', '[]'::jsonb,
    'pagination', jsonb_build_object('currentPage', v_page, 'pagesCount', 0, 'totalItems', 0));

  if p_domain is not null and btrim(p_domain) <> '' and upper(btrim(p_domain)) <> 'DEFAULT' then
    select id into v_domain from domain where authority = lower(btrim(p_domain));
    if v_domain is null then
      return v_empty;
    end if;
  elsif p_domain is not null and (btrim(p_domain) = '' or upper(btrim(p_domain)) = 'DEFAULT') then
    v_domain := 0;
  end if;

  if v_scope = 'short' then
    select id into v_short_id
      from short_url
     where short_code = lower(btrim(coalesce(p_key, '')))
       and domain_id = coalesce(v_domain, 0)
       and enabled;
    if v_short_id is null then
      raise exception using errcode = 'P0002', message = 'short_url_not_found';
    end if;
  elsif v_scope = 'tag' then
    v_tag := lower(btrim(coalesce(p_key, '')));
    if not exists (select 1 from tag where name = v_tag) then
      return v_empty;
    end if;
  elsif v_scope = 'domain' then
    select id into v_domain from domain where authority = lower(btrim(coalesce(p_key, '')));
    if v_domain is null then
      return v_empty;
    end if;
  end if;

  return (
    with filtered as (
      select v.id, v.occurred_at
        from visit v
       where (v_scope <> 'short'      or v.short_url_id = v_short_id)
         and (v_scope <> 'tag'        or v.short_url_id in (
               select st.short_url_id
                 from short_url_tag st
                 join tag t on t.id = st.tag_id
                where t.name = v_tag))
         and (v_scope <> 'domain'     or v.short_url_id in (
               select s.id from short_url s where s.domain_id = v_domain))
         and (v_scope <> 'non-orphan' or v.short_url_id is not null)
         and (v_scope <> 'orphan'     or v.short_url_id is null)
         and (v_scope not in ('tag', 'non-orphan') or v_domain is null
              or v.short_url_id in (select s.id from short_url s where s.domain_id = v_domain))
         and (v_scope <> 'orphan'     or v_orphan is null or v.orphan_type = v_orphan)
         and (not coalesce(p_exclude_bots, false) or not v.potential_bot)
         and (p_start is null or v.occurred_at >= p_start)
         and (p_end   is null or v.occurred_at <= p_end)
    ), counted as (
      select f.id, f.occurred_at, count(*) over() as total from filtered f
    ), page_rows as (
      select id, occurred_at
        from counted
       order by occurred_at desc, id desc
       limit v_items offset (v_page - 1) * v_items
    )
    select jsonb_build_object(
      'data', coalesce((
        select jsonb_agg(visit_json(v) order by v.occurred_at desc, v.id desc)
          from page_rows p
          join visit v on v.id = p.id and v.occurred_at = p.occurred_at
      ), '[]'::jsonb),
      'pagination', jsonb_build_object(
        'currentPage', v_page,
        'pagesCount', case when coalesce((select max(total) from counted), 0) = 0 then 0
                           else ceil((select max(total) from counted)::numeric / v_items)::int end,
        'totalItems', coalesce((select max(total) from counted), 0)))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. 删除短链的全部访问：明细 + 计数表 + short_url.visits_count 一起重算
-- ---------------------------------------------------------------------------
create or replace function delete_short_url_visits(p_code text, p_domain text default null)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_domain bigint;
  v_id     bigint;
  v_n      int;
begin
  if p_code is null or btrim(p_code) = '' then
    raise exception using errcode = '22023', message = 'invalid_short_code';
  end if;

  if p_domain is null or btrim(p_domain) = '' or upper(btrim(p_domain)) = 'DEFAULT' then
    v_domain := 0;
  else
    select id into v_domain from domain where authority = lower(btrim(p_domain));
    if v_domain is null then
      raise exception using errcode = 'P0002', message = 'short_url_not_found';
    end if;
  end if;

  select id into v_id
    from short_url
   where short_code = lower(btrim(p_code))
     and domain_id = v_domain
     and enabled;
  if v_id is null then
    raise exception using errcode = 'P0002', message = 'short_url_not_found';
  end if;

  delete from visit where short_url_id = v_id;
  get diagnostics v_n = row_count;

  delete from short_url_visits_counts where short_url_id = v_id;
  insert into short_url_visits_counts (short_url_id, potential_bot, slot_id, count)
  select v_id, potential_bot, 1, count(*)
    from visit
   where short_url_id = v_id
   group by potential_bot;

  update short_url s
     set visits_count = coalesce((
           select sum(c.count) from short_url_visits_counts c where c.short_url_id = v_id), 0)
   where s.id = v_id;

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. 删除孤儿访问
-- ---------------------------------------------------------------------------
create or replace function delete_orphan_visits()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_n int;
begin
  delete from visit where short_url_id is null;
  get diagnostics v_n = row_count;

  delete from orphan_visits_counts where true;
  insert into orphan_visits_counts (potential_bot, slot_id, count)
  select potential_bot, 1, count(*)
    from visit
   where short_url_id is null
   group by potential_bot;

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. 权限收口
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'visit_json(visit)',
    'visits_overview()',
    'list_visits(text,text,text,integer,integer,timestamptz,timestamptz,boolean,text)',
    'delete_short_url_visits(text,text)',
    'delete_orphan_visits()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
