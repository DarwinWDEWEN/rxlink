-- 0010_console_api.sql —— 控制台补全（B3 标签 + B4 域名/跳转规则）
--
-- 鉴权口径与 0008/0009 一致：函数只授 service_role，security invoker + set search_path。
-- 所有返回结构按 docs/shlink-api-contract.md §4.4 的 SDK 形状：
--   listTags   → { data: string[] }                    （SDK 解包 tags）
--   tagsStats  → { data: [{tag,shortUrlsCount,visitsSummary}] }
--   listDomains→ { data: [{domain,isDefault,redirects}], defaultRedirects }
--   editDomainRedirects → 裸 ShlinkDomainRedirects
--   redirect rules → { defaultLongUrl, redirectRules: [] }

-- ---------------------------------------------------------------------------
-- 1. 标签：列表
-- ---------------------------------------------------------------------------
create or replace function list_tags()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'data', coalesce((select jsonb_agg(t.name order by t.name) from tag t), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- 2. 标签：统计（每个标签带短链数与访问摘要）
-- ---------------------------------------------------------------------------
create or replace function tag_stats()
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'data', coalesce(jsonb_agg(jsonb_build_object(
      'tag', t.name,
      'shortUrlsCount', coalesce(x.links, 0),
      'visitsSummary', jsonb_build_object(
        'total',   coalesce(x.total, 0),
        'nonBots', coalesce(x.nonbots, 0),
        'bots',    coalesce(x.bots, 0)))
      order by t.name), '[]'::jsonb))
  from tag t
  left join lateral (
    select count(distinct st.short_url_id)::int as links,
           sum(c.count)::bigint as total,
           sum(c.count) filter (where not c.potential_bot)::bigint as nonbots,
           sum(c.count) filter (where c.potential_bot)::bigint as bots
      from short_url_tag st
      left join short_url_visits_counts c on c.short_url_id = st.short_url_id
     where st.tag_id = t.id
  ) x on true;
$$;

-- ---------------------------------------------------------------------------
-- 3. 标签：删除（cascade 清掉 short_url_tag，短链本身不动）
-- ---------------------------------------------------------------------------
create or replace function delete_tags(p_tags text[])
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_names text[];
  v_count integer;
begin
  select array_agg(distinct lower(btrim(x)))
    into v_names
    from unnest(coalesce(p_tags, '{}'::text[])) x
   where btrim(x) <> '';

  if v_names is null then
    return 0;
  end if;

  delete from tag where name = any (v_names);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. 标签：重命名（新名字重复时 23505 → 函数侧映射 409）
-- ---------------------------------------------------------------------------
create or replace function edit_tag(p_old_name text, p_new_name text)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_old text := lower(btrim(coalesce(p_old_name, '')));
  v_new text := lower(btrim(coalesce(p_new_name, '')));
begin
  if v_old = '' or v_new = '' then
    raise exception using errcode = '22023', message = 'invalid_tag_name';
  end if;

  update tag set name = v_new where name = v_old;
  if not found then
    raise exception using errcode = 'P0002', message = 'tag_not_found';
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. 域名：列表（含每个域名的三条回退地址）
-- ---------------------------------------------------------------------------
create or replace function list_domains()
returns jsonb
language sql
stable
set search_path = public
as $$
  with d as (
    select id, authority, is_default,
           base_url_redirect, regular404_redirect, invalid_short_url_redirect
      from domain
     order by is_default desc, authority
  )
  select jsonb_build_object(
    'data', coalesce((
      select jsonb_agg(jsonb_build_object(
        'domain', dd.authority,
        'isDefault', dd.is_default,
        'redirects', jsonb_build_object(
          'baseUrlRedirect', dd.base_url_redirect,
          'regular404Redirect', dd.regular404_redirect,
          'invalidShortUrlRedirect', dd.invalid_short_url_redirect))
        order by dd.is_default desc, dd.authority)
        from d dd), '[]'::jsonb),
    'defaultRedirects', coalesce((
      select jsonb_build_object(
        'baseUrlRedirect', dd.base_url_redirect,
        'regular404Redirect', dd.regular404_redirect,
        'invalidShortUrlRedirect', dd.invalid_short_url_redirect)
        from d dd where dd.is_default limit 1),
      jsonb_build_object(
        'baseUrlRedirect', null,
        'regular404Redirect', null,
        'invalidShortUrlRedirect', null)));
$$;

-- ---------------------------------------------------------------------------
-- 6. 域名：改回退地址（PATCH 语义，出现的键才改，显式 null 清空）
-- ---------------------------------------------------------------------------
create or replace function update_domain_redirects(p_domain text, p_patch jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_domain text := lower(btrim(coalesce(p_domain, '')));
  v_id     bigint;
  v_base   text;
  v_r404   text;
  v_inv    text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_payload';
  end if;

  if v_domain = '' then
    select id into v_id from domain where is_default limit 1;
  else
    select id into v_id from domain where authority = v_domain;
  end if;

  if v_id is null then
    raise exception using errcode = 'P0002', message = 'domain_not_found';
  end if;

  update domain d
     set base_url_redirect = case when p_patch ? 'baseUrlRedirect'
                                  then nullif(btrim(p_patch->>'baseUrlRedirect'), '')
                                  else d.base_url_redirect end,
         regular404_redirect = case when p_patch ? 'regular404Redirect'
                                    then nullif(btrim(p_patch->>'regular404Redirect'), '')
                                    else d.regular404_redirect end,
         invalid_short_url_redirect = case when p_patch ? 'invalidShortUrlRedirect'
                                           then nullif(btrim(p_patch->>'invalidShortUrlRedirect'), '')
                                           else d.invalid_short_url_redirect end
   where d.id = v_id
  returning base_url_redirect, regular404_redirect, invalid_short_url_redirect
       into v_base, v_r404, v_inv;

  return jsonb_build_object(
    'baseUrlRedirect', v_base,
    'regular404Redirect', v_r404,
    'invalidShortUrlRedirect', v_inv);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. 短链：跳转规则（M3 前恒空列表，供详情页打开时不崩）
-- ---------------------------------------------------------------------------
create or replace function get_short_url_redirect_rules(p_code text, p_domain text default null)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_domain bigint;
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

  select long_url into v_long
    from short_url
   where short_code = lower(btrim(p_code))
     and domain_id = v_domain
     and enabled;

  if v_long is null then
    raise exception using errcode = 'P0002', message = 'short_url_not_found';
  end if;

  return jsonb_build_object('defaultLongUrl', v_long, 'redirectRules', '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. 权限收口
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'list_tags()',
    'tag_stats()',
    'delete_tags(text[])',
    'edit_tag(text,text)',
    'list_domains()',
    'update_domain_redirects(text,jsonb)',
    'get_short_url_redirect_rules(text,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
