-- 0019_list_exclude_tags.sql —— 短链列表的「排除标签」筛选（I9 / R9 的连带项）
--
-- 背景：兼容层 /health 的 version 旋钮提到 5.1.0 后，shlink 控制台会露出
--   shlink 4.6.0+ 的 excludeTags 筛选。后端不接这个参数的话，
--   用户在界面上勾了排除标签、结果却完全不变 —— 静默错误，比报错更糟。
--
-- 语义（与 SDK 的 excludeTagsMode 对齐）：
--   mode = 'any' → 命中**任一**排除标签的短链被排除
--   mode = 'all' → 同时拥有**全部**排除标签的短链被排除
--
-- 覆盖 0008 的同名函数（增加两个参数）。
--
-- ⚠️ 必须先 DROP：Postgres 的 CREATE OR REPLACE 在**参数个数不同**时不会替换，
--    而是新建一个重载（overload）。留着旧的 12 参数版本，PostgREST 按具名参数
--    调用时会出现「multiple functions with the same name」歧义错误。
--    旧签名：list_short_urls(integer, integer, text, text, text[], text, text, text, boolean, boolean, timestamptz, timestamptz)
drop function if exists list_short_urls(integer, integer, text, text, text[], text, text, text, boolean, boolean, timestamptz, timestamptz);

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
  p_end              timestamptz default null,
  p_excluded_tags    text[]  default null,
  p_excluded_tags_mode text  default 'all'
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
  v_xmode  text := lower(coalesce(p_excluded_tags_mode, 'all'));
  v_xtags  text[];
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

  if p_excluded_tags is not null then
    select array_agg(distinct lower(btrim(x)))
      into v_xtags
      from unnest(p_excluded_tags) x
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
         and ($11::text[] is null
              or ($12 = 'any' and not exists (
                    select 1
                      from short_url_tag st
                      join tag t on t.id = st.tag_id
                     where st.short_url_id = s.id
                       and t.name = any ($11)))
              or ($12 <> 'any' and (
                    select count(distinct t.name)
                      from short_url_tag st
                      join tag t on t.id = st.tag_id
                     where st.short_url_id = s.id
                       and t.name = any ($11)
                  ) < cardinality($11)))
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
               'currentPage', $13,
               'pagesCount', case when coalesce((select max(total) from counted), 0) = 0 then 0
                                  else ceil((select max(total) from counted)::numeric / $1)::int end,
               'totalItems', coalesce((select max(total) from counted), 0)))
  $q$, v_order, v_dir)
  using v_items, (v_page - 1) * v_items, v_domain, p_search, v_tags, v_mode,
        coalesce(p_exclude_max, false), coalesce(p_exclude_expired, false), p_start, p_end,
        v_xtags, v_xmode, v_page
  into v_result;

  return v_result;
end;
$$;

revoke execute on function list_short_urls(integer, integer, text, text, text[], text, text, text, boolean, boolean, timestamptz, timestamptz, text[], text)
  from public, anon, authenticated;
grant execute on function list_short_urls(integer, integer, text, text, text[], text, text, text, boolean, boolean, timestamptz, timestamptz, text[], text)
  to service_role;
