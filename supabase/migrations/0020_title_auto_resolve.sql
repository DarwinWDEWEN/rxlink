-- 0020：R10 标题自动解析
--
-- 目标：
--   1. 新增 short_url.title_was_auto_resolved，记录标题来源
--      （列名对齐上游 ShortUrl 实体映射 entities-mappings/...ShortUrl.php:127）
--   2. 重建 create_short_url：新增尾部参数 p_title_was_auto_resolved boolean default false
--   3. 重建 update_short_url：新增尾部参数 p_auto_title text default null
--   4. 权限收口：平台默认把 EXECUTE 授给 PUBLIC，DROP 函数会连带删掉 ACL
--      → 重建后必须对新签名重新 revoke/grant
--
-- 覆盖 0005 的 create_short_url、0008 的 update_short_url
-- （同名函数，改参数个数必须先 DROP 旧签名，否则会出现重载歧义）。
--
-- 兼容性：新参数都带默认值 → 迁移后旧调用点（13 参 / 3 参）仍能解析到新函数，
--         所以「迁移先行、兼容层后发」是安全的；反过来会因函数不存在而报错。

-- ---------------------------------------------------------------------------
-- 1. 新列
-- ---------------------------------------------------------------------------
alter table short_url add column if not exists title_was_auto_resolved boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. create_short_url
--    覆盖 0005 的同名函数：新增尾部参数 p_title_was_auto_resolved
-- ---------------------------------------------------------------------------
drop function if exists create_short_url(text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint);

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
  p_author_api_key_id   bigint      default null,
  p_title_was_auto_resolved boolean default false
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
      valid_since, valid_until, max_visits, author_api_key_id,
      title_was_auto_resolved
    ) values (
      v_domain_id, v_code, btrim(p_long_url), p_title, coalesce(p_crawlable, false),
      coalesce(p_forward_query, true), p_valid_since, p_valid_until, p_max_visits, p_author_api_key_id,
      case when p_title is null then false else coalesce(p_title_was_auto_resolved, false) end
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
          valid_since, valid_until, max_visits, author_api_key_id,
          title_was_auto_resolved
        ) values (
          v_domain_id, v_code, btrim(p_long_url), p_title, coalesce(p_crawlable, false),
          coalesce(p_forward_query, true), p_valid_since, p_valid_until, p_max_visits, p_author_api_key_id,
          case when p_title is null then false else coalesce(p_title_was_auto_resolved, false) end
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
-- 3. update_short_url
--    覆盖 0008 的同名函数：新增尾部参数 p_auto_title
--
--    写标题的判定放在 DB 内（与上游 Entity/ShortUrl.php:167-178 逐条等价）：
--      p_patch 里有 title 键   → 用户手填，优先写入，来源置 false
--      p_auto_title 非空 且
--        (旧标题为 null 或 旧来源是自动解析) → 写入，来源置 true
--      都不满足                → 保留原标题与原来源
-- ---------------------------------------------------------------------------
drop function if exists update_short_url(text,text,jsonb);

create or replace function update_short_url(p_code text, p_domain text default null, p_patch jsonb default '{}'::jsonb, p_auto_title text default null)
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
         title         = case
                           when p_patch ? 'title' then nullif(btrim(p_patch->>'title'), '')
                           when p_auto_title is not null
                                and (s.title is null or s.title_was_auto_resolved)
                             then btrim(p_auto_title)
                           else s.title
                         end,
         title_was_auto_resolved = case
                           when p_patch ? 'title' then false
                           when p_auto_title is not null
                                and (s.title is null or s.title_was_auto_resolved)
                             then true
                           else s.title_was_auto_resolved
                         end,
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
-- 4. 权限收口（DROP 函数会连带删掉 ACL → 必须对新签名重新收口）
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'create_short_url(text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint,boolean)',
    'update_short_url(text,text,jsonb,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
