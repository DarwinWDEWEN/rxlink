-- 0018_redirect_rules.sql —— 动态跳转规则（I9 / R9）
--
-- 设计稿：docs/superpowers/specs/2026-11-12-r9-dynamic-redirect-rules-design.md
-- shlink 对照：module/Core/src/RedirectRule/**（RedirectConditionType / RedirectCondition / ShortUrlRedirectRule）
--             module/Core/migrations/Version20240224115725.php（三张表的结构参考）
--
-- 关键设计：规则写操作**不**碰 link_version。
--   link_version  → 短链映射变更 → 跳转函数重拉全量快照（重）
--   rules_version → 规则变更     → 跳转函数只重拉规则快照（轻）
--   共用一个 seq 的话，用户每存一次规则就要让全网实例重拉全量短链快照，代价不对等。
--
-- 平台约束：函数一律 security invoker（平台禁 security definer），逐个 revoke execute from public。

-- ---------------------------------------------------------------------------
-- 1. 表
-- ---------------------------------------------------------------------------
create table if not exists short_url_redirect_rule (
  id           bigint generated always as identity primary key,
  short_url_id bigint not null references short_url(id) on delete cascade,
  priority     integer not null default 1,
  long_url     text not null
);

create table if not exists redirect_condition (
  id          bigint generated always as identity primary key,
  rule_id     bigint not null references short_url_redirect_rule(id) on delete cascade,
  type        text not null,
  match_key   text,
  match_value text
);

create index if not exists short_url_redirect_rule_su_idx on short_url_redirect_rule(short_url_id);
create index if not exists redirect_condition_rule_idx on redirect_condition(rule_id);

create table if not exists rules_version (
  id  int     primary key default 1,
  seq bigint  not null default 0,
  check (id = 1)
);

insert into rules_version (id, seq) values (1, 0) on conflict (id) do nothing;

alter table short_url_redirect_rule enable row level security;
alter table short_url_redirect_rule force  row level security;
revoke all on table short_url_redirect_rule from anon, authenticated;

alter table redirect_condition enable row level security;
alter table redirect_condition force  row level security;
revoke all on table redirect_condition from anon, authenticated;

alter table rules_version enable row level security;
alter table rules_version force  row level security;
revoke all on table rules_version from anon, authenticated;
grant select, update on rules_version to service_role;

-- ---------------------------------------------------------------------------
-- 2. 失效触发器：规则写 → rules_version.seq + 1（不动 link_version）
--    行级触发器：语句级在 0 行时也会触发，删空操作会白 bump（0007 已有结论）
-- ---------------------------------------------------------------------------
create or replace function bump_rules_version()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  update rules_version set seq = seq + 1 where id = 1;
  return null;
end;
$$;

drop trigger if exists rules_version_after_rule_write on short_url_redirect_rule;
create trigger rules_version_after_rule_write
after insert or update or delete on short_url_redirect_rule
for each row
execute function bump_rules_version();

drop trigger if exists rules_version_after_condition_write on redirect_condition;
create trigger rules_version_after_condition_write
after insert or update or delete on redirect_condition
for each row
execute function bump_rules_version();

-- ---------------------------------------------------------------------------
-- 3. 规则 → API 形状（对齐 shlink ShortUrlRedirectRule::jsonSerialize）
--    {longUrl, priority, conditions:[{type, matchKey, matchValue}]}
-- ---------------------------------------------------------------------------
create or replace function redirect_rules_json(p_short_url_id bigint)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'longUrl',      r.long_url,
             'priority',     r.priority,
             'conditions',   coalesce((
                                  select jsonb_agg(
                                    jsonb_build_object(
                                      'type',       c.type,
                                      'matchKey',   c.match_key,
                                      'matchValue', c.match_value
                                    )
                                    order by c.id
                                  )
                                  from redirect_condition c
                                  where c.rule_id = r.id
                                ), '[]'::jsonb)
           )
           order by r.priority, r.id
         ), '[]'::jsonb)
    from short_url_redirect_rule r
   where r.short_url_id = p_short_url_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. 读写规则
-- ---------------------------------------------------------------------------

-- 覆盖 0010 的同名函数：从「恒返回空规则」改成真读
create or replace function get_short_url_redirect_rules(p_code text, p_domain text default null)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_domain bigint;
  v_id     bigint;
  v_long   text;
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

  select s.id, s.long_url into v_id, v_long
    from short_url s
   where s.short_code = lower(btrim(p_code))
     and s.domain_id = v_domain
     and s.enabled;

  if v_id is null then
    raise exception using errcode = 'P0002', message = 'short_url_not_found';
  end if;

  return jsonb_build_object('defaultLongUrl', v_long, 'redirectRules', redirect_rules_json(v_id));
end;
$$;

-- 整组替换：先删旧规则（条件靠 on delete cascade 一起删），再按数组顺序插新的
create or replace function set_short_url_redirect_rules(p_code text, p_domain text default null, p_rules jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_domain bigint;
  v_id     bigint;
  v_long   text;
  v_rule   jsonb;
  v_cond   jsonb;
  v_new_id bigint;
  v_idx    int := 0;
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

  select s.id, s.long_url into v_id, v_long
    from short_url s
   where s.short_code = lower(btrim(p_code))
     and s.domain_id = v_domain
     and s.enabled;

  if v_id is null then
    raise exception using errcode = 'P0002', message = 'short_url_not_found';
  end if;

  if p_rules is null or jsonb_typeof(p_rules) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_redirect_rules';
  end if;

  -- 删旧
  delete from short_url_redirect_rule where short_url_id = v_id;

  -- 插新：priority 按数组下标 +1
  for v_rule in select jsonb_array_elements(p_rules)
  loop
    v_idx := v_idx + 1;

    -- 服务端也要挡住空 longUrl：兼容层已校验，但 RPC 可能被直接调用
    if v_rule ->> 'longUrl' is null or btrim(v_rule ->> 'longUrl') = '' then
      raise exception using errcode = '22023', message = 'invalid_redirect_rule_long_url';
    end if;

    insert into short_url_redirect_rule (short_url_id, priority, long_url)
    values (v_id, v_idx, v_rule ->> 'longUrl')
    returning id into v_new_id;

    -- conditions 缺省 = 空数组（空条件规则永不命中，与 shlink 一致）
    for v_cond in select jsonb_array_elements(coalesce(v_rule -> 'conditions', '[]'::jsonb))
    loop
      insert into redirect_condition (rule_id, type, match_key, match_value)
      values (v_new_id,
              v_cond ->> 'type',
              v_cond ->> 'matchKey',
              v_cond ->> 'matchValue');
    end loop;
  end loop;

  return jsonb_build_object('defaultLongUrl', v_long, 'redirectRules', redirect_rules_json(v_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. 跳转函数用的两个入口
-- ---------------------------------------------------------------------------

-- 规则缓存的 seq：与 link_version 平行
create or replace function rules_seq()
returns bigint
language sql
stable
set search_path = public
as $$
  select seq from rules_version where id = 1;
$$;

-- 规则快照：只含有规则的短链（数据量很小）
create or replace function rules_snapshot()
returns table (short_url_id bigint, rules jsonb)
language sql
stable
set search_path = public
as $$
  select r.short_url_id, redirect_rules_json(r.short_url_id)
    from (select distinct short_url_id from short_url_redirect_rule) r;
$$;

-- 覆盖 0005 的同名函数：返回值加 rules 列（回落路径用；快照通道不靠它）
--
-- ⚠️ 必须先 DROP：Postgres 的 CREATE OR REPLACE **不允许改返回类型**
--    （改了报 42P13 cannot change return type of existing function）。
--    resolve_short 的 OUT 列从 3 个变成 4 个（多了 rules），属于改返回类型。
--    旧签名：resolve_short(text, text)
drop function if exists resolve_short(text, text);

create or replace function resolve_short(p_code text, p_domain text default null)
returns table (short_url_id bigint, long_url text, forward_query boolean, rules jsonb)
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
  select s.id, s.long_url, s.forward_query, redirect_rules_json(s.id)
    from short_url s
   where s.short_code = lower(btrim(p_code))
     and s.domain_id in (v_domain_id, 0)
     and s.enabled
     and (s.valid_since is null or s.valid_since <= now())
     and (s.valid_until is null or s.valid_until > now())
     and (s.max_visits is null or s.visits_count < s.max_visits)
   order by (s.domain_id = v_domain_id) desc, s.id
   limit 1;
end;
$$;

-- 覆盖 0005 的同名函数：hasRedirectRules 由常量 false 改为动态判断
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
      'validUntil',  s.valid_until,
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
    'hasRedirectRules', exists (
      select 1 from short_url_redirect_rule r where r.short_url_id = s.id
    )
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
-- 6. 权限收口
-- ---------------------------------------------------------------------------
revoke execute on function redirect_rules_json(bigint) from public, anon, authenticated;
grant execute on function redirect_rules_json(bigint) to service_role;

revoke execute on function set_short_url_redirect_rules(text, text, jsonb) from public, anon, authenticated;
grant execute on function set_short_url_redirect_rules(text, text, jsonb) to service_role;

revoke execute on function get_short_url_redirect_rules(text, text) from public, anon, authenticated;
grant execute on function get_short_url_redirect_rules(text, text) to service_role;

revoke execute on function rules_seq() from public, anon, authenticated;
grant execute on function rules_seq() to service_role;

revoke execute on function rules_snapshot() from public, anon, authenticated;
grant execute on function rules_snapshot() to service_role;

revoke execute on function resolve_short(text, text) from public, anon, authenticated;
grant execute on function resolve_short(text, text) to service_role;

revoke execute on function short_url_json(bigint) from public, anon, authenticated;
grant execute on function short_url_json(bigint) to service_role;

revoke execute on function bump_rules_version() from public, anon, authenticated;
grant execute on function bump_rules_version() to service_role;
