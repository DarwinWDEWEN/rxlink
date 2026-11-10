-- 0004_core_tables.sql —— 正式业务表（已执行 2026-11-09，验证记录见 docs/verification/i1-results.md）
--
-- 依据：docs/tech-framework.md §4/§4.1/§5、docs/shlink-api-contract.md §4/§7、
--       docs/verification/p0-results.md（禁 SECURITY DEFINER、新表默认裸奔、PG14 保守子集、sha256 生成列可用）
-- 平台约束：不使用 security definer、nulls not distinct、returning old/new、appendonly；
--           每张表建完立刻 enable/force RLS 并 revoke anon/authenticated。
-- 执行方式：平台一次只认一条语句（supabase db query 走 prepared statement），必须逐条执行。

-- ---------------------------------------------------------------------------
-- 1. 域名
-- ---------------------------------------------------------------------------
create table if not exists domain (
  id                        bigint generated always as identity primary key,
  authority                 text        not null unique,           -- host[:port]，不带协议
  scheme                    text        not null default 'http',
  is_default                boolean     not null default false,
  icp_status                text        not null default 'unknown',
  base_url_redirect         text,                                  -- 命中域名但无短码
  regular404_redirect       text,                                  -- 短码不存在
  invalid_short_url_redirect text,                                 -- 短码格式非法
  created_at                timestamptz not null default now(),
  constraint domain_authority_lower check (authority = lower(authority)),
  constraint domain_scheme_chk check (scheme in ('http', 'https')),
  constraint domain_icp_chk check (icp_status in ('pending', 'valid', 'invalid', 'unknown'))
);

-- 默认域名哨兵：domain_id = 0 表示「默认域名」。authority 是占位值，
-- 必须由负责人在应用前改成真实主域名（见文件末尾 UPDATE），否则 shortUrl 拼不出来。
insert into domain (id, authority, scheme, is_default, icp_status)
overriding system value
values (0, '__default__', 'http', true, 'unknown')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. 短链
-- ---------------------------------------------------------------------------
create table if not exists short_url (
  id                bigint generated always as identity primary key,
  domain_id         bigint      not null default 0 references domain(id) on delete restrict,
  short_code        text        not null,
  long_url          text        not null,
  long_url_hash     bytea       generated always as (sha256(long_url::bytea)) stored,
  title             text,
  crawlable         boolean     not null default false,
  forward_query     boolean     not null default true,
  valid_since       timestamptz,
  valid_until       timestamptz,
  max_visits        integer,
  visits_count      bigint      not null default 0,
  last_visit_at     timestamptz,
  enabled           boolean     not null default true,
  author_api_key_id bigint,                                       -- 作用域 AUTHORED_SHORT_URLS 的依据
  created_at        timestamptz not null default now(),
  constraint short_url_code_chk check (short_code ~ '^[a-z0-9_-]{1,64}$'),
  constraint short_url_long_url_chk check (btrim(long_url) <> ''),
  constraint short_url_validity_chk check (valid_until is null or valid_since is null or valid_until > valid_since),
  constraint short_url_max_visits_chk check (max_visits is null or max_visits >= 0),
  unique (domain_id, short_code)
);

create index if not exists short_url_long_url_hash_idx on short_url (long_url_hash);
create index if not exists short_url_last_visit_idx on short_url (last_visit_at);

-- ---------------------------------------------------------------------------
-- 3. 标签
-- ---------------------------------------------------------------------------
create table if not exists tag (
  id         bigint generated always as identity primary key,
  name       text        not null unique,
  created_at timestamptz not null default now(),
  constraint tag_name_chk check (btrim(name) <> '')
);

create table if not exists short_url_tag (
  short_url_id bigint not null references short_url(id) on delete cascade,
  tag_id       bigint not null references tag(id)       on delete cascade,
  primary key (short_url_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- 4. 计数（slot 打散，规避单行热点）
-- ---------------------------------------------------------------------------
create table if not exists short_url_visits_counts (
  id            bigserial primary key,
  short_url_id  bigint    not null references short_url(id) on delete cascade,
  potential_bot boolean   not null default false,
  slot_id       smallint  not null,
  count         bigint    not null default 1,
  constraint svc_slot_chk check (slot_id between 1 and 100),
  unique (short_url_id, potential_bot, slot_id)
);

create table if not exists orphan_visits_counts (
  id            bigserial primary key,
  potential_bot boolean  not null default false,
  slot_id       smallint not null,
  count         bigint   not null default 1,
  constraint ovc_slot_chk check (slot_id between 1 and 100),
  unique (potential_bot, slot_id)
);

-- ---------------------------------------------------------------------------
-- 5. 访问：热路径入队表 + 明细表
-- ---------------------------------------------------------------------------
-- 热路径只写这张；UNLOGGED 换吞吐，崩了丢的是统计不是业务（P0 项 5 实测可用）。
create unlogged table if not exists visit_inbox (
  id            bigserial primary key,
  short_url_id  bigint,                                            -- null = 孤儿访问
  orphan_type   text,                                              -- base_url / invalid_short_url / regular_404
  visitor_key   text,                                              -- sha256(ip + salt)，不落明文 IP
  ua            text,
  referer       text,
  visited_url   text,
  redirect_to   text,
  potential_bot boolean,
  occurred_at   timestamptz not null default now(),
  processed_at  timestamptz,
  constraint visit_inbox_orphan_chk check (
    orphan_type is null or orphan_type in ('base_url', 'invalid_short_url', 'regular_404')
  ),
  constraint visit_inbox_target_chk check (short_url_id is not null or orphan_type is not null)
);

create index if not exists visit_inbox_pending_idx on visit_inbox (occurred_at) where processed_at is null;

-- 明细表：普通表 + 按月 range 分区；保留期靠 drop 分区回收（P0 项 10 实测分区可用）。
create table if not exists visit (
  id            bigserial,
  occurred_at   timestamptz not null,
  short_url_id  bigint,
  orphan_type   text,
  visitor_key   text,
  ua            text,
  referer       text,
  visited_url   text,
  redirect_url  text,
  potential_bot boolean     not null default false,
  country       text,
  region        text,
  city          text,
  browser       text,
  os            text,
  device        text,
  primary key (id, occurred_at)
) partition by range (occurred_at);

-- 分区按需创建：调用一次建当月与后两个月，之后由 cron 每月补。
create or replace function ensure_visit_partition(p_month date default current_date)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_name  text := 'visit_' || to_char(v_start, 'YYYY_MM');
begin
  if to_regclass('public.' || v_name) is null then
    execute format(
      'create table %I partition of visit for values from (%L) to (%L)',
      v_name, v_start, (v_start + interval '1 month')::date
    );
    -- 分区不继承父表的 ACL 与 RLS 开关：不显式收口，anon 可以直接读分区
    execute format('alter table %I enable row level security', v_name);
    execute format('alter table %I force  row level security', v_name);
    execute format('revoke all on table %I from anon, authenticated', v_name);
  end if;
  return v_name;
end;
$$;

select ensure_visit_partition(current_date);
select ensure_visit_partition((current_date + interval '1 month')::date);
select ensure_visit_partition((current_date + interval '2 month')::date);

-- ---------------------------------------------------------------------------
-- 6. 快照版本号（跳转函数 5s 轮询这一行）
-- ---------------------------------------------------------------------------
create table if not exists link_version (
  id  int    primary key default 1,
  seq bigint not null default 0,
  constraint link_version_single_row check (id = 1)
);
insert into link_version (id, seq) values (1, 0) on conflict (id) do nothing;

-- 只在「会影响跳转结果」的列变化时 bump。
-- 关键：visits_count / last_visit_at 每分钟都会被 drain 更新，若不限定列，
-- 快照会每分钟重拉一次全量（2 万行 ≈0.6s），白白浪费。
create or replace function bump_link_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update link_version set seq = seq + 1 where id = 1;
  return null;
end;
$$;

drop trigger if exists link_version_after_write on short_url;
create trigger link_version_after_write
after insert or delete or update of
  short_code, domain_id, long_url, forward_query, enabled, valid_since, valid_until, max_visits
on short_url
for each statement
execute function bump_link_version();

-- ---------------------------------------------------------------------------
-- 7. Bot 字典（shlink 的规则在 vendor 里取不到，这张表是我们自己维护的）
-- ---------------------------------------------------------------------------
create table if not exists bot_pattern (
  id         bigint generated always as identity primary key,
  pattern    text        not null unique,   -- 小写子串匹配，落库前对 UA 做 lower() 后 contains
  label      text,
  enabled    boolean     not null default true,
  created_at timestamptz not null default now(),
  constraint bot_pattern_chk check (btrim(pattern) <> '')
);

-- 初始集只放最稳的几条；M2 再扩（不要假装能还原 CrawlerDetect 的全量规则）。
insert into bot_pattern (pattern, label) values
  ('bot', 'generic-bot'),
  ('crawler', 'generic-crawler'),
  ('spider', 'generic-spider'),
  ('curl/', 'curl'),
  ('wget/', 'wget'),
  ('headlesschrome', 'headless-chrome'),
  ('facebookexternalhit', 'facebook'),
  ('slackbot', 'slack'),
  ('googlebot', 'google'),
  ('bingbot', 'bing')
on conflict (pattern) do nothing;

-- ---------------------------------------------------------------------------
-- 8. API Key 与作用域（控制台只认 X-Api-Key）
-- ---------------------------------------------------------------------------
create table if not exists api_key (
  id         bigint generated always as identity primary key,
  key_hash   bytea       not null unique,   -- sha256(明文 key)，明文不落库
  name       text        not null unique,
  enabled    boolean     not null default true,
  created_at timestamptz not null default now(),
  constraint api_key_name_chk check (btrim(name) <> '')
);

create table if not exists api_key_role (
  id         bigint generated always as identity primary key,
  api_key_id bigint not null references api_key(id) on delete cascade,
  role       text   not null,
  domain_id  bigint references domain(id) on delete cascade,
  constraint api_key_role_name_chk check (role in ('AUTHORED_SHORT_URLS', 'DOMAIN_SPECIFIC', 'NO_ORPHAN_VISITS')),
  constraint api_key_role_domain_chk check ((role = 'DOMAIN_SPECIFIC') = (domain_id is not null)),
  unique (api_key_id, role, domain_id)
);

-- 外键在 api_key 建好后再挂（short_url 先建表，此处补约束）
alter table short_url drop constraint if exists short_url_author_fk;
alter table short_url
  add constraint short_url_author_fk
  foreign key (author_api_key_id) references api_key(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 9. 死链清理报告（dry-run 与真跑都写）
-- ---------------------------------------------------------------------------
create table if not exists prune_report (
  id            bigserial primary key,
  run_at        timestamptz not null default now(),
  dry_run       boolean     not null,
  short_url_id  bigint      not null,
  short_code    text        not null,
  domain        text,
  last_visit_at timestamptz,
  stale_days    integer
);

-- ---------------------------------------------------------------------------
-- 10. 权限收口（每张表：enable + force + revoke；函数在 0005 里逐个 revoke）
--     平台实测：新表默认给 anon/authenticated 全量 DML 且 RLS 关闭。
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'domain', 'short_url', 'tag', 'short_url_tag',
    'short_url_visits_counts', 'orphan_visits_counts',
    'visit_inbox', 'visit', 'link_version', 'bot_pattern',
    'api_key', 'api_key_role', 'prune_report'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end;
$$;

revoke all on all sequences in schema public from anon, authenticated;
revoke all on function ensure_visit_partition(date) from public, anon, authenticated;
grant execute on function ensure_visit_partition(date) to service_role;

-- ---------------------------------------------------------------------------
-- 11. 应用前必须由负责人执行的一次性 UPDATE
-- ---------------------------------------------------------------------------
-- 把默认域名的真实主机名写进哨兵行（scheme 也一并定；没有证书就先 http）。
-- update domain set authority = 'example.com', scheme = 'http' where id = 0;
--
-- 说明：不执行这一步，id=0 行的 authority 仍是 '__default__'，所有「默认域名」短链的
-- shortUrl 字段会拼成 http://__default__/xxxx，控制台无法复制/打开。
