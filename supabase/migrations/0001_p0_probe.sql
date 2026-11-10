-- P0 验证用 migration。执行方式（本机没有 psql，用阿里云 Supabase CLI 直连）：
--   supabase db query --db-url "$SUPABASE_DB_URL" -o table "<单条语句>"
--   注意：db query 走 prepared statement，一次只能一条语句；db push 需要阿里云 AK/SK。
-- 全部对象带 probe_ 前缀，验证结束后 DROP 干净，不污染业务 schema。
-- 平台限制：ADB 禁止 SECURITY DEFINER（SQLSTATE 42501），下面全部用 security invoker。

-- ── 项 2/3：跳转函数的读路径是否够快（单次 RPC 完成短码解析）───────────────
-- 跳转链路在库里只需要这一次交互：按短码 + 域名优先级取目标地址。
create table if not exists probe_short_url (
  id          bigserial primary key,
  short_code  text        not null,
  domain      text        not null default '',
  long_url    text        not null,
  enabled     boolean     not null default true,
  unique (domain, short_code)
);

insert into probe_short_url (short_code, domain, long_url)
values ('AbC123', '', 'https://example.com/from-global'),
       ('AbC123', 's.probe.test', 'https://example.com/from-domain')
on conflict (domain, short_code) do nothing;

-- 域名专属短码优先于全局短码；命中不到返回 0 行。
-- 和 shlink 的 findOneWithDomainFallback 同一思路：一条查询 + 排序优先级，不做两次查询。
-- ADB 上 CREATE OR REPLACE 不能改返回列签名，重跑前先 drop。
drop function if exists probe_resolve(text, text);
create or replace function probe_resolve(p_code text, p_domain text)
returns table (long_url text, hit_domain text)
language sql
security invoker
set search_path = public, pg_catalog
as $$
  select s.long_url, s.domain
  from (
    select long_url, domain
    from probe_short_url
    where short_code = p_code
      and (domain = p_domain or domain = '')
      and enabled
    order by (domain = p_domain) desc nulls last
    limit 1
  ) s;
$$;

-- ── 项 4：pg_cron 能否调度「纯 SQL 函数」做批量物化 ────────────────────────
-- 注意：pg_cron 作业按 GMT 调度，且 cron.job / cron.job_run_details 查的是 postgres 库。
create table if not exists probe_inbox (
  id           bigserial primary key,
  payload      jsonb       not null,
  occurred_at  timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists probe_sink (
  id           bigserial primary key,
  payload      jsonb       not null,
  occurred_at  timestamptz not null,
  batch_size   integer     not null
);

create or replace function probe_drain_batch(p_limit integer default 500)
returns integer
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  moved integer;
begin
  with picked as (
    select id
    from probe_inbox
    where processed_at is null
    order by id
    limit p_limit
    for update skip locked          -- 多个并发批次互不阻塞
  ),
  moved_rows as (
    insert into probe_sink (payload, occurred_at, batch_size)
    select i.payload, i.occurred_at, count(*) over ()
    from probe_inbox i
    join picked p on p.id = i.id
    returning 1
  )
  update probe_inbox
  set processed_at = now()
  where id in (select id from picked);

  moved := (select count(*) from probe_sink);
  return moved;
end;
$$;

-- 手动跑一次，确认函数本身可用（先别挂 cron）
-- select probe_drain_batch(100);

-- 挂到 pg_cron（每分钟 GMT）；验证后记得 unschedule
-- select cron.schedule('probe-drain', '* * * * *', 'select probe_drain_batch(500)');
-- 作业存在 postgres 库里：
--   select * from cron.job where jobname = 'probe-drain';
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname='probe-drain') order by start_time desc limit 5;
-- select cron.unschedule('probe-drain');

-- ── 项 5：UNLOGGED 表在 ADB 上的支持度（热路径落地区的前提）─────────────────
create unlogged table if not exists probe_unlogged (
  id        bigserial primary key,
  visitor   text        not null,
  ua        text,
  referer   text,
  slot      smallint    not null,
  ts        timestamptz not null default now()
);

-- 写入 + 按 slot 打散 UPSERT（shlink 的热点计数方案在 ADB 上是否成立）
create table if not exists probe_visits_counts (
  id            bigserial primary key,
  short_url_id  bigint      not null,
  potential_bot boolean     not null default false,
  slot_id       smallint    not null,
  count         bigint      not null default 1,
  unique (short_url_id, potential_bot, slot_id)
);

-- select probe_unlogged_write('AbC123');
create or replace function probe_unlogged_write(p_code text)
returns void
language sql
security invoker
set search_path = public, pg_catalog
as $$
  insert into probe_unlogged (visitor, ua, referer, slot)
  values (p_code, 'probe-ua', 'https://referer.probe.test', floor(random() * 100)::smallint);

  insert into probe_visits_counts (short_url_id, potential_bot, slot_id, count)
  select 1, false, floor(random() * 100)::smallint, 1
  on conflict (short_url_id, potential_bot, slot_id)
    do update set count = probe_visits_counts.count + 1;
$$;

-- ── 项 7：确认扩展可用性（pg_cron 是否已装、有无 pg_net、版本口径）──────────
create or replace function probe_env_report()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  out jsonb;
begin
  select jsonb_build_object(
    'version', version(),
    'server_version', current_setting('server_version', false),
    'db_timezone', current_setting('TimeZone', false),
    'is_mpp_engine', exists (select 1 from pg_class where relname = 'gp_segment_configuration'),
    'pg_cron_installed', exists (select 1 from pg_extension where extname = 'pg_cron'),
    'pg_net_installed', exists (select 1 from pg_extension where extname = 'pg_net'),
    'unlogged_tables_count', (select count(*) from pg_class where relpersistence = 'u')
  ) into out;
  return out;
end;
$$;

-- 实测结论（别再被字段名误导）：
--   is_mpp_engine = false，with (appendonly=true) 被拒 ⇒ 这个实例不是 Greenplum/ADB MPP；
--   pg_net 在 available 清单里但 create extension 报「无安装脚本」⇒ 库内发不了 HTTP；
--   db_timezone = GMT，但 cron.job_run_details 的时间戳按 CST 展示。

-- 服务端吞吐：把 N 次「unlogged 落地球 + slot 计数 UPSERT」压在一个循环里计时，
-- 排除客户端往返，只看库本身扛不扛得住跳转写入量级。
-- 形参名也算签名的一部分：CREATE OR REPLACE 改参数名同样报错，重跑前先 drop。
drop function if exists probe_time_writes(integer);
create or replace function probe_time_writes(p_n integer)
returns text
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  t0 timestamptz;
  t1 timestamptz;
  i  integer;
begin
  t0 := clock_timestamp();
  for i in 1..p_n loop
    perform probe_unlogged_write('AbC123');
  end loop;
  t1 := clock_timestamp();
  return format('%s writes => %s ms total, %s ms/write',
                p_n,
                round(extract(epoch from (t1 - t0)) * 1000, 1),
                round(extract(epoch from (t1 - t0)) * 1000 / p_n, 3));
end;
$$;

-- select probe_env_report();
-- select probe_time_writes(200);
