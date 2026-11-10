-- 0006_ua_parse.sql —— 访问明细的 browser / os / device 解析
--
-- 为什么放在 drain 而不是跳转函数：
--   热路径只该做「查表 + 302 + 入队」，多一次解析就多一次每请求成本；而且规则变更不该要求重新上传函数。
--   口径代价：解析只在落库时做，历史行不回填（需要时单独 update）。
-- 为什么用规则表而不是一条大 CASE：
--   UA 规则会持续增补（新 App 内置浏览器、新爬虫），规则表可以纯 INSERT 扩、不用改函数。
-- 精度定位：粗粒度分类（desktop/smartphone/tablet + 常见浏览器/系统），不追求还原 ua-parser 的完整字典。

-- ---------------------------------------------------------------------------
-- 1. 规则表
-- ---------------------------------------------------------------------------
create table if not exists ua_rule (
  id       bigint generated always as identity primary key,
  kind     text    not null,          -- browser / os / device
  pattern  text    not null,          -- 小写子串，对 lower(ua) 做 position 匹配
  label    text    not null,
  priority int     not null,          -- 越小越先匹配
  enabled  boolean not null default true,
  constraint ua_rule_kind_chk check (kind in ('browser', 'os', 'device')),
  constraint ua_rule_pattern_chk check (btrim(pattern) <> '' and pattern = lower(pattern)),
  unique (kind, pattern)
);

-- 顺序很关键：Edge 的 UA 里同时有 Chrome/ 和 Safari/，iOS 里同时有 Safari/ 和 Mac OS X；
-- 只能靠 priority 让更具体的规则先命中。
insert into ua_rule (kind, pattern, label, priority) values
  ('browser', 'edg/',                'Edge',             10),
  ('browser', 'edga/',               'Edge',             10),
  ('browser', 'opr/',                'Opera',            20),
  ('browser', 'opera',               'Opera',            21),
  ('browser', 'samsungbrowser',      'Samsung Internet', 30),
  ('browser', 'firefox/',            'Firefox',          40),
  ('browser', 'fxios',               'Firefox',          41),
  ('browser', 'chrome/',             'Chrome',           50),
  ('browser', 'crios',               'Chrome',           51),
  ('browser', 'safari/',             'Safari',           60),
  ('browser', 'msie ',               'Internet Explorer',70),
  ('browser', 'trident/',            'Internet Explorer',71),
  ('browser', 'curl/',               'curl',             80),
  ('browser', 'wget/',               'Wget',             81),
  ('browser', 'python-requests',     'Python Requests',  82),
  ('browser', 'go-http-client',      'Go HTTP',          83),
  ('browser', 'node-fetch',          'Node Fetch',       84),
  ('browser', 'postmanruntime',      'Postman',          85),

  ('os', 'iphone',                   'iOS',              10),
  ('os', 'ipad',                     'iPadOS',           11),
  ('os', 'android',                  'Android',          20),
  ('os', 'windows nt 10',            'Windows 10/11',    30),
  ('os', 'windows nt 6.3',           'Windows 8.1',      31),
  ('os', 'windows nt 6.1',           'Windows 7',        32),
  ('os', 'windows',                  'Windows',          39),
  ('os', 'mac os x',                 'Mac OS X',         40),
  ('os', 'macintosh',                'Mac OS X',         41),
  ('os', 'cros',                     'Chrome OS',        50),
  ('os', 'ubuntu',                   'Ubuntu',           60),
  ('os', 'linux',                    'Linux',            61),

  ('device', 'ipad',                 'tablet',           10),
  ('device', 'tablet',               'tablet',           11),
  ('device', 'kindle',               'tablet',           12),
  ('device', 'iphone',               'smartphone',       20),
  ('device', 'android',              'smartphone',       21),
  ('device', 'mobile',               'smartphone',       30)
on conflict (kind, pattern) do update
  set label = excluded.label, priority = excluded.priority;

-- ---------------------------------------------------------------------------
-- 2. 匹配与解析
-- ---------------------------------------------------------------------------
create or replace function ua_match(p_ua text, p_kind text)
returns text
language sql
stable
set search_path = public
as $$
  select label
    from ua_rule
   where enabled
     and kind = p_kind
     and position(pattern in lower(coalesce(p_ua, ''))) > 0
   order by priority, id
   limit 1;
$$;

-- 无命中时的兜底：browser/os 记 'Other'，device 记 'desktop'
-- （桌面浏览器和多数爬虫的 UA 都没有移动端标记，笼统归 desktop 与 shlink 口径一致）
create or replace function ua_parse(p_ua text)
returns table (browser text, os text, device text)
language sql
stable
set search_path = public
as $$
  select coalesce(ua_match(p_ua, 'browser'), 'Other'),
         coalesce(ua_match(p_ua, 'os'), 'Other'),
         coalesce(ua_match(p_ua, 'device'), 'desktop');
$$;

-- ---------------------------------------------------------------------------
-- 3. drain 里补三列（其余逻辑与 0005 完全一致，仅 ins 段多取 ua_parse）
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
      visited_url, redirect_url, potential_bot, browser, os, device
    )
    select sc.occurred_at, sc.short_url_id, sc.orphan_type, sc.visitor_key, sc.ua, sc.referer,
           sc.visited_url, sc.redirect_to, sc.potential_bot, u.browser, u.os, u.device
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
-- 4. 权限收口
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'alter table ua_rule enable row level security';
  execute 'alter table ua_rule force  row level security';
  execute 'revoke all on table ua_rule from anon, authenticated';
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'ua_match(text,text)',
    'ua_parse(text)',
    'drain_visit_inbox(integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
