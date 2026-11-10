-- 0005_shorten_and_resolve.sql —— 写路径、跳转读路径、统计落库、死链清理（已执行 2026-11-09）
-- 注意：drain_visit_inbox 随后被 0006_ua_parse.sql 覆盖（多了 browser/os/device 三列），以 0006 为准。
--
-- 前提：0004_core_tables.sql 已执行。
-- 平台约束：函数一律 security invoker（平台禁 security definer），
--           所以只能由持 service_role 的调用方执行，并逐个 revoke execute from public。
-- 返回形状：写/读接口统一返回 jsonb，字段名与 docs/shlink-api-contract.md 完全一致，
--           兼容层只做透传，避免「同一字段在三个端点三种拼法」。

-- ---------------------------------------------------------------------------
-- 1. 单条短链的对外 JSON（契约形状）
-- ---------------------------------------------------------------------------
create or replace function short_url_json(p_id bigint)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'shortCode',  s.short_code,
    'domain',     case when s.domain_id = 0 then null::text else d.authority end,
    'shortUrl',   d.scheme || '://' || d.authority || '/' || s.short_code,
    'longUrl',    s.long_url,
    'dateCreated', s.created_at,
    'visitsSummary', jsonb_build_object(
      'total',   coalesce(c.total, 0),
      'nonBots', coalesce(c.nonbots, 0),
      'bots',    coalesce(c.bots, 0)
    ),
    'meta', jsonb_build_object(
      'validSince', s.valid_since,
      'validUntil', s.valid_until,
      'maxVisits',  s.max_visits
    ),
    'tags', coalesce((
      select jsonb_agg(t.name order by t.name)
        from short_url_tag st
        join tag t on t.id = st.tag_id
       where st.short_url_id = s.id
    ), '[]'::jsonb),
    'title',       s.title,
    'crawlable',   s.crawlable,
    'forwardQuery', s.forward_query,
    'hasRedirectRules', false
  )
  from short_url s
  join domain d on d.id = s.domain_id
  left join lateral (
    select sum(count) as total,
           sum(count) filter (where not potential_bot) as nonbots,
           sum(count) filter (where potential_bot)     as bots
      from short_url_visits_counts
     where short_url_id = s.id
  ) c on true
  where s.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- 2. 创建短链（含 find_if_exists / 自定义 slug / 随机码重试 / 标签）
-- ---------------------------------------------------------------------------
create or replace function create_short_url(
  p_long_url            text,
  p_domain              text        default null,
  p_custom_slug         text        default null,
  p_title               text        default null,
  p_tags                text[]      default null,
  p_crawlable           boolean     default false,
  p_forward_query       boolean     default true,
  p_valid_since         timestamptz default null,
  p_valid_until         timestamptz default null,
  p_max_visits          integer     default null,
  p_short_code_length   integer     default 5,
  p_find_if_exists      boolean     default false,
  p_author_api_key_id   bigint      default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_domain    text;
  v_domain_id bigint;
  v_code      text;
  v_len       int;
  v_id        bigint;
  v_try       int;
  v_i         int;
  v_alphabet  constant text := 'abcdefghijklmnopqrstuvwxyz0123456789';
begin
  if p_long_url is null or btrim(p_long_url) = '' then
    raise exception using errcode = '22023', message = 'invalid_long_url';
  end if;
  if p_valid_since is not null and p_valid_until is not null and p_valid_until <= p_valid_since then
    raise exception using errcode = '22023', message = 'invalid_validity';
  end if;

  -- 域名：空 = 默认域名（domain_id 0）；未知域名按 shlink 的做法隐式创建
  if p_domain is null or btrim(p_domain) = '' then
    v_domain_id := 0;
  else
    v_domain := lower(btrim(p_domain));
    select id into v_domain_id from domain where authority = v_domain;
    if v_domain_id is null then
      insert into domain (authority) values (v_domain) on conflict (authority) do nothing;
      select id into v_domain_id from domain where authority = v_domain;
    end if;
  end if;

  -- 同链复用：比较所有会影响有效性的字段，命中即原样返回
  if p_find_if_exists then
    select id into v_id
      from short_url
     where domain_id = v_domain_id
       and long_url_hash = sha256(btrim(p_long_url)::bytea)
       and valid_since  is not distinct from p_valid_since
       and valid_until  is not distinct from p_valid_until
       and max_visits   is not distinct from p_max_visits
       and enabled
     order by id
     limit 1;
    if v_id is not null then
      return short_url_json(v_id);
    end if;
  end if;

  if p_custom_slug is not null and btrim(p_custom_slug) <> '' then
    v_code := lower(btrim(p_custom_slug));
    if v_code !~ '^[a-z0-9_-]{1,64}$' then
      raise exception using errcode = '22023', message = 'invalid_slug';
    end if;
    -- 并发下同一 (domain, code) 串行化，避免「先查后插」的竞态
    perform pg_advisory_xact_lock(hashtext(v_domain_id::text || ':' || v_code));
    if exists (select 1 from short_url where domain_id = v_domain_id and short_code = v_code) then
      raise exception using errcode = '23505', message = 'non_unique_slug';
    end if;

    insert into short_url (
      domain_id, short_code, long_url, title, crawlable, forward_query,
      valid_since, valid_until, max_visits, author_api_key_id
    ) values (
      v_domain_id, v_code, btrim(p_long_url), p_title, coalesce(p_crawlable, false),
      coalesce(p_forward_query, true), p_valid_since, p_valid_until, p_max_visits, p_author_api_key_id
    ) returning id into v_id;
  else
    -- 随机码：单行 insert 捕 23505（多值 insert 一行冲突会回滚整条语句，P0 已记）
    v_len := greatest(4, least(coalesce(p_short_code_length, 5), 32));
    for v_try in 1..20 loop
      v_code := '';
      for v_i in 1..v_len loop
        v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
      end loop;
      perform pg_advisory_xact_lock(hashtext(v_domain_id::text || ':' || v_code));
      begin
        insert into short_url (
          domain_id, short_code, long_url, title, crawlable, forward_query,
          valid_since, valid_until, max_visits, author_api_key_id
        ) values (
          v_domain_id, v_code, btrim(p_long_url), p_title, coalesce(p_crawlable, false),
          coalesce(p_forward_query, true), p_valid_since, p_valid_until, p_max_visits, p_author_api_key_id
        ) returning id into v_id;
        exit;
      exception when unique_violation then
        v_id := null;
      end;
    end loop;
    if v_id is null then
      raise exception using errcode = '23505', message = 'short_code_exhausted';
    end if;
  end if;

  -- 标签：整组替换语义在 update 里；创建时只做「补齐 + 关联」
  if p_tags is not null then
    insert into tag (name)
    select distinct lower(btrim(x))
      from unnest(p_tags) as x
     where btrim(x) <> ''
    on conflict (name) do nothing;

    insert into short_url_tag (short_url_id, tag_id)
    select distinct v_id, t.id
      from unnest(p_tags) as x
      join tag t on t.name = lower(btrim(x))
     where btrim(x) <> ''
    on conflict do nothing;
  end if;

  return short_url_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. 跳转读路径（缓存未就绪时的兜底查询）
-- ---------------------------------------------------------------------------
create or replace function resolve_short(p_code text, p_domain text default null)
returns table (short_url_id bigint, long_url text, forward_query boolean)
language plpgsql
stable
set search_path = public
as $$
declare
  v_domain_id bigint := 0;
begin
  if p_code is null or btrim(p_code) = '' then
    return;
  end if;
  if p_domain is not null and btrim(p_domain) <> '' then
    select id into v_domain_id from domain where authority = lower(btrim(p_domain));
    if v_domain_id is null then
      v_domain_id := 0;
    end if;
  end if;

  return query
  select s.id, s.long_url, s.forward_query
    from short_url s
   where s.short_code = lower(btrim(p_code))
     and s.domain_id in (v_domain_id, 0)          -- 域名专属优先，回落到默认域名
     and s.enabled
     and (s.valid_since is null or s.valid_since <= now())
     and (s.valid_until is null or s.valid_until > now())
     and (s.max_visits is null or s.visits_count < s.max_visits)
   order by (s.domain_id = v_domain_id) desc, s.id
   limit 1;
end;
$$;

-- 全量快照：只装 enabled 行。
-- 四个设计点：
--   1) 默认域名的 domain 必须是 NULL 而不是 ''——跳转函数按「domain 为真才进域名表，
--      否则进全局表」建索引，'' 会让默认域名短链永远查不到。
--   2) 有效期随行下发、由跳转函数按本机时钟判定：到期不会 bump seq，快照里的过期链会一直能跳。
--   3) 次数上限不下发 visits_count——它每分钟都在变，若为它 bump seq 就等于每分钟重拉全量；
--      改成下发布尔标记，命中限次链接时回落查库（resolve_short 里有精确判定）。
--   4) id 随行下发：热路径写 visit_inbox 要的是 short_url_id，不能再按 code 反查。
create or replace function snapshot_short_links()
returns table (
  id             bigint,
  domain         text,
  short_code     text,
  long_url       text,
  forward_query  boolean,
  valid_since    timestamptz,
  valid_until    timestamptz,
  visits_limited boolean
)
language sql
stable
set search_path = public
as $$
  select s.id,
         case when s.domain_id = 0 then null::text else d.authority end,
         s.short_code, s.long_url, s.forward_query,
         s.valid_since, s.valid_until, (s.max_visits is not null)
    from short_url s
    join domain d on d.id = s.domain_id
   where s.enabled;
$$;

create or replace function link_seq()
returns bigint
language sql
stable
set search_path = public
as $$
  select seq from link_version where id = 1;
$$;

-- ---------------------------------------------------------------------------
-- 4. 统计落库：inbox → 明细 + 计数 + 汇总
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
      visited_url, redirect_url, potential_bot
    )
    select occurred_at, short_url_id, orphan_type, visitor_key, ua, referer,
           visited_url, redirect_to, potential_bot
      from scored
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
-- 5. 死链清理（默认 180 天；dry-run 只写报告不动数据）
-- ---------------------------------------------------------------------------
create or replace function prune_dead_links(p_days integer default 180, p_dry_run boolean default true)
returns table (short_url_id bigint, short_code text, domain text, last_visit_at timestamptz, stale_days integer)
language plpgsql
set search_path = public
as $$
begin
  return query
  with stale as (
    select s.id,
           s.short_code,
           d.authority as domain,
           s.last_visit_at,
           floor(extract(epoch from (now() - coalesce(s.last_visit_at, s.created_at))) / 86400)::int as stale_days
      from short_url s
      join domain d on d.id = s.domain_id
     where s.enabled
       and coalesce(s.last_visit_at, s.created_at) < now() - make_interval(days => p_days)
     for update of s skip locked
  ), rep as (
    insert into prune_report (dry_run, short_url_id, short_code, domain, last_visit_at, stale_days)
    select p_dry_run, st.id, st.short_code, st.domain, st.last_visit_at, st.stale_days from stale st
    returning 1
  ), dis as (
    update short_url s
       set enabled = false
      from stale st
     where s.id = st.id
       and not p_dry_run
    returning 1
  )
  -- 必须带 st. 前缀：RETURNS TABLE 的输出列名是 plpgsql 变量，
  -- 裸 short_code/domain/stale_days 会被判为 ambiguous
  select st.id, st.short_code, st.domain, st.last_visit_at, st.stale_days from stale st;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. 函数权限收口
--     平台默认把 EXECUTE 授给 PUBLIC，必须显式收回，否则 anon 能直接调 RPC。
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'short_url_json(bigint)',
    'create_short_url(text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint)',
    'resolve_short(text,text)',
    'snapshot_short_links()',
    'link_seq()',
    'drain_visit_inbox(integer)',
    'prune_dead_links(integer,boolean)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
