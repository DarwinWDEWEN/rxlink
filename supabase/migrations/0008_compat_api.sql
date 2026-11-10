-- 0008_compat_api.sql —— 兼容层（/rest/v3）的服务端 RPC（I3）
--
-- 鉴权：函数侧算 X-Api-Key 的 sha256（hex），只把哈希传进来；库里比对 api_key.key_hash。
-- 明文 key 不落库、不出现在 SQL 参数之外的任何地方。
-- 所有函数 security invoker + set search_path，与 0005 的权限口径一致：只授 service_role。

-- ---------------------------------------------------------------------------
-- 1. 鉴权：返回 key 的 id/name/roles；无效或停用返回 null
-- ---------------------------------------------------------------------------
create or replace function compat_auth(p_hash_hex text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', k.id,
    'name', k.name,
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('role', r.role, 'domainId', r.domain_id)
                       order by r.role, r.domain_id)
        from api_key_role r
       where r.api_key_id = k.id
    ), '[]'::jsonb)
  )
  from api_key k
  where k.enabled
    and k.key_hash = decode(lower(btrim(p_hash_hex)), 'hex');
$$;

-- ---------------------------------------------------------------------------
-- 2. 列表：筛选/排序/分页；返回 {data, pagination}，兼容层再包一层 shortUrls
--    排序字段只接受白名单，避免动态 SQL 注入。
-- ---------------------------------------------------------------------------
create or replace function list_short_urls(
  p_page             integer default 1,
  p_items            integer default 20,
  p_search           text    default null,
  p_domain           text    default null,
  p_tags             text[]  default null,
  p_tags_mode        text    default 'all',
  p_order_field      text    default 'dateCreated',
  p_order_dir        text    default 'DESC',
  p_exclude_max      boolean default false,
  p_exclude_expired  boolean default false,
  p_start            timestamptz default null,
  p_end              timestamptz default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_page   int  := greatest(1, coalesce(p_page, 1));
  v_items  int  := greatest(1, least(coalesce(p_items, 20), 100));
  v_domain bigint;
  v_tags   text[];
  v_mode   text := lower(coalesce(p_tags_mode, 'all'));
  v_order  text;
  v_dir    text := case when upper(coalesce(p_order_dir, 'DESC')) = 'ASC' then 'asc' else 'desc' end;
  v_result jsonb;
begin
  if p_domain is not null and btrim(p_domain) <> '' then
    if upper(btrim(p_domain)) = 'DEFAULT' then
      v_domain := 0;
    else
      select id into v_domain from domain where authority = lower(btrim(p_domain));
      if v_domain is null then
        return jsonb_build_object(
          'data', '[]'::jsonb,
          'pagination', jsonb_build_object('currentPage', v_page, 'pagesCount', 0, 'totalItems', 0));
      end if;
    end if;
  end if;

  if p_tags is not null then
    select array_agg(distinct lower(btrim(x)))
      into v_tags
      from unnest(p_tags) x
     where btrim(x) <> '';
  end if;

  v_order := case lower(coalesce(p_order_field, 'dateCreated'))
               when 'shortcode'    then 's.short_code'
               when 'longurl'      then 's.long_url'
               when 'title'        then 'coalesce(s.title, '''')'
               when 'visits'       then 's.visits_count'
               when 'nonbotvisits' then 'coalesce(nb.nonbots, 0)'
               else 's.created_at'
             end;

  execute format($q$
    with filtered as (
      select s.id, %1$s as ord
        from short_url s
        left join lateral (
          select sum(c.count) filter (where not c.potential_bot) as nonbots
            from short_url_visits_counts c
           where c.short_url_id = s.id
        ) nb on true
       where s.enabled
         and ($3::bigint is null or s.domain_id = $3)
         and ($4::text is null or btrim($4) = ''
              or s.short_code ilike '%%' || btrim($4) || '%%'
              or s.long_url  ilike '%%' || btrim($4) || '%%'
              or coalesce(s.title, '') ilike '%%' || btrim($4) || '%%')
         and ($5::text[] is null
              or ($6 = 'any' and exists (
                    select 1
                      from short_url_tag st
                      join tag t on t.id = st.tag_id
                     where st.short_url_id = s.id
                       and t.name = any ($5)))
              or ($6 <> 'any' and (
                    select count(distinct t.name)
                      from short_url_tag st
                      join tag t on t.id = st.tag_id
                     where st.short_url_id = s.id
                       and t.name = any ($5)
                  ) = cardinality($5)))
         and (not $7::boolean or s.max_visits is null or s.visits_count < s.max_visits)
         and (not $8::boolean or s.valid_until is null or s.valid_until > now())
         and ($9::timestamptz is null or s.created_at >= $9)
         and ($10::timestamptz is null or s.created_at <= $10)
    ), counted as (
      select f.id, f.ord, count(*) over() as total from filtered f
    ), page_rows as (
      select id from counted order by ord %2$s nulls last, id %2$s
      limit $1 offset $2
    )
    select jsonb_build_object(
             'data', coalesce((
               select jsonb_agg(short_url_json(p.id) order by c.ord %2$s nulls last, p.id %2$s)
                 from page_rows p join counted c on c.id = p.id
             ), '[]'::jsonb),
             'pagination', jsonb_build_object(
               'currentPage', $11,
               'pagesCount', case when coalesce((select max(total) from counted), 0) = 0 then 0
                                  else ceil((select max(total) from counted)::numeric / $1)::int end,
               'totalItems', coalesce((select max(total) from counted), 0)))
  $q$, v_order, v_dir)
  using v_items, (v_page - 1) * v_items, v_domain, p_search, v_tags, v_mode,
        coalesce(p_exclude_max, false), coalesce(p_exclude_expired, false), p_start, p_end, v_page
  into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. 详情：domain 空/DEFAULT = 默认域名（domain_id 0）；未命中返回 null
-- ---------------------------------------------------------------------------
create or replace function get_short_url(p_code text, p_domain text default null)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_id     bigint;
  v_domain bigint;
begin
  if p_code is null or btrim(p_code) = '' then
    return null;
  end if;

  if p_domain is null or btrim(p_domain) = '' or upper(btrim(p_domain)) = 'DEFAULT' then
    v_domain := 0;
  else
    select id into v_domain from domain where authority = lower(btrim(p_domain));
    if v_domain is null then
      return null;
    end if;
  end if;

  select id into v_id
    from short_url
   where short_code = lower(btrim(p_code))
     and domain_id = v_domain
     and enabled;

  if v_id is null then
    return null;
  end if;
  return short_url_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. 编辑：PATCH 语义——JSON 里出现的键才改；显式 null 用于清空。
--    标签是整组替换（出现 tags 键即先删后插，空数组=清空）。
-- ---------------------------------------------------------------------------
create or replace function update_short_url(p_code text, p_domain text default null, p_patch jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_id     bigint;
  v_domain bigint;
begin
  if p_code is null or btrim(p_code) = '' then
    raise exception using errcode = '22023', message = 'invalid_short_code';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_payload';
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

  if p_patch ? 'longUrl' and btrim(coalesce(p_patch->>'longUrl', '')) = '' then
    raise exception using errcode = '22023', message = 'invalid_long_url';
  end if;

  update short_url s
     set long_url      = case when p_patch ? 'longUrl'      then btrim(p_patch->>'longUrl')
                              else s.long_url end,
         title         = case when p_patch ? 'title'        then nullif(btrim(p_patch->>'title'), '')
                              else s.title end,
         crawlable     = case when p_patch ? 'crawlable'    then coalesce((p_patch->>'crawlable')::boolean, s.crawlable)
                              else s.crawlable end,
         forward_query = case when p_patch ? 'forwardQuery' then coalesce((p_patch->>'forwardQuery')::boolean, s.forward_query)
                              else s.forward_query end,
         valid_since   = case when p_patch ? 'validSince'   then (p_patch->>'validSince')::timestamptz
                              else s.valid_since end,
         valid_until   = case when p_patch ? 'validUntil'   then (p_patch->>'validUntil')::timestamptz
                              else s.valid_until end,
         max_visits    = case when p_patch ? 'maxVisits'    then (p_patch->>'maxVisits')::integer
                              else s.max_visits end
   where s.id = v_id;

  if p_patch ? 'tags' then
    delete from short_url_tag where short_url_id = v_id;
    if jsonb_typeof(p_patch->'tags') = 'array' then
      insert into tag (name)
      select distinct lower(btrim(x))
        from jsonb_array_elements_text(p_patch->'tags') x
       where btrim(x) <> ''
      on conflict (name) do nothing;

      insert into short_url_tag (short_url_id, tag_id)
      select distinct v_id, t.id
        from jsonb_array_elements_text(p_patch->'tags') x
        join tag t on t.name = lower(btrim(x))
       where btrim(x) <> ''
      on conflict do nothing;
    end if;
  end if;

  return short_url_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. 删除：软删（enabled=false），保留访问统计；未命中报 P0002
-- ---------------------------------------------------------------------------
create or replace function delete_short_url(p_code text, p_domain text default null)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_id     bigint;
  v_domain bigint;
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

  update short_url set enabled = false where id = v_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. 权限收口：默认 PUBLIC 有 EXECUTE，必须显式收回
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'compat_auth(text)',
    'list_short_urls(integer,integer,text,text,text[],text,text,text,boolean,boolean,timestamptz,timestamptz)',
    'get_short_url(text,text)',
    'update_short_url(text,text,jsonb)',
    'delete_short_url(text,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
