-- 死链清理（方案 B：按「长期无访问」判定，软删 enabled=false，先 dry-run 出清单）。
-- 阈值 180 天、清理后 404、自动跑但先只出清单，均为用户 2026-11-06 定。
-- 探针版落在 probe_* 表上；正式表落地时把同样的三段搬到 short_url / visit_inbox 即可。

-- ① 判定依据：最后一次被访问的时间。**不扫 visit 明细**，由落库任务顺手维护。
alter table probe_short_url add column if not exists last_visit_at timestamptz;
alter table probe_short_url add column if not exists created_at timestamptz not null default now();

-- ② 落库任务里带上 last_visit_at：命中访问（hit=true）才刷新，且必须挑 resolve 会命中的那一行
--    （域名专属优先，回落全局），否则会把没被访问的全局短码一起刷脏。
-- 形参名算签名的一部分，改名会报 "cannot change name of input parameter"，这里保持 p_limit。
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
  ),
  hit_batch as (
    select i.payload->>'code'   as code,
           i.payload->>'domain' as domain,
           max(i.occurred_at)   as last_ts
    from probe_inbox i
    join picked p on p.id = i.id
    where (i.payload->>'hit')::boolean
    group by 1, 2
  ),
  touched as (
    update probe_short_url s
    set last_visit_at = greatest(s.last_visit_at, h.last_ts)
    from hit_batch h
    where s.id = (
      select s2.id
      from probe_short_url s2
      where s2.short_code = h.code
        and (s2.domain = h.domain or s2.domain = '')
        and s2.enabled
      order by (s2.domain = h.domain) desc nulls last
      limit 1
    )
  )
  update probe_inbox
  set processed_at = now()
  where id in (select id from picked);

  moved := (select count(*) from probe_sink);
  return moved;
end;
$$;

-- ③ 清单落这张表，方便他自己看「哪些会被清」而不用等真删。
create table if not exists probe_prune_report (
  id            bigserial primary key,
  run_at        timestamptz not null default now(),
  dry_run       boolean     not null default true,
  short_url_id  bigint,
  short_code    text,
  domain        text,
  last_seen     timestamptz,
  stale_days    integer
);

alter table probe_prune_report enable row level security;
alter table probe_prune_report force row level security;
revoke all on table probe_prune_report from anon, authenticated;
grant select, insert on table probe_prune_report to service_role;

-- ④ 清理函数：dry_run 只写清单不动数据；真删只置 enabled=false（可撤销，且明细统计不牵动）。
-- 触发器 link_version_after_write 会在真删那次 update 上自动 bump ⇒ 跳转侧 ≤5s 生效。
drop function if exists probe_prune_dead_links(integer, boolean);
create or replace function probe_prune_dead_links(p_days integer default 180, p_dry_run boolean default true)
returns table (id bigint, short_code text, domain text, last_seen timestamptz, stale_days integer, pruned boolean)
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  cutoff timestamptz;
begin
  cutoff := now() - make_interval(days => p_days);

  insert into probe_prune_report (dry_run, short_url_id, short_code, domain, last_seen, stale_days)
  select p_dry_run, c.id, c.short_code, c.domain, c.last_seen,
         floor(extract(epoch from (now() - c.last_seen)) / 86400)::int
  from (
    select s.id, s.short_code, s.domain,
           coalesce(s.last_visit_at, s.created_at) as last_seen
    from probe_short_url s
    where s.enabled
      and coalesce(s.last_visit_at, s.created_at) < cutoff
  ) c;

  if p_dry_run then
    return query
      select s.id, s.short_code, s.domain,
             coalesce(s.last_visit_at, s.created_at),
             floor(extract(epoch from (now() - coalesce(s.last_visit_at, s.created_at))) / 86400)::int,
             false
      from probe_short_url s
      where s.enabled
        and coalesce(s.last_visit_at, s.created_at) < cutoff
      order by 4;
    return;
  end if;

  return query
  with doomed as (
    select s.id
    from probe_short_url s
    where s.enabled
      and coalesce(s.last_visit_at, s.created_at) < cutoff
    for update skip locked            -- cron 与人工编辑撞上时不互相等死
  ),
  done as (
    update probe_short_url s
    set enabled = false
    from doomed d
    where s.id = d.id
    returning s.id, s.short_code, s.domain, s.last_visit_at, s.created_at
  )
  select done.id, done.short_code, done.domain,
         coalesce(done.last_visit_at, done.created_at),
         floor(extract(epoch from (now() - coalesce(done.last_visit_at, done.created_at))) / 86400)::int,
         true
  from done
  order by 4;
end;
$$;

-- 挂 cron（GMT 口径：19:00 GMT = 次日 03:00 CST）。默认 dry-run，他看完清单再把第二个参数改 false。
-- select cron.schedule('probe-prune', '0 19 * * *', 'select probe_prune_dead_links(180, true)');
-- select * from cron.job where jobname = 'probe-prune';
-- select cron.unschedule('probe-prune');
