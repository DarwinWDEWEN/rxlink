-- Production baseline: make a clean migration replay match the accepted runtime.

-- P0 probe functions must be removed before their backing tables.
drop function if exists probe_drain_batch(integer);
drop function if exists probe_env_report();
drop function if exists probe_link_seq();
drop function if exists probe_link_snapshot();
drop function if exists probe_prune_dead_links(integer, boolean);
drop function if exists probe_resolve(text, text);
drop function if exists probe_time_writes(integer);
drop function if exists probe_unlogged_write(text);

drop table if exists probe_inbox;
drop table if exists probe_prune_report;
drop table if exists probe_sink;
drop table if exists probe_unlogged;
drop table if exists probe_visits_counts;
drop table if exists probe_short_url;

-- Preserve an explicitly configured domain while repairing fresh replays.
update domain
   set authority = 'example.com',
       scheme = 'https'
 where id = 0
   and authority = '__default__';

create extension if not exists pg_cron;

-- Remove every duplicate or historical job before installing the accepted set.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid
      from cron.job
     where jobname in (
       'probe-drain',
       'probe-prune',
       'rxlink-drain',
       'rxlink-prune',
       'rxlink-retire-ip',
       'rxlink-expired'
     )
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'rxlink-drain',
  '* * * * *',
  'select drain_visit_inbox(500)'
);
select cron.schedule(
  'rxlink-prune',
  '0 19 * * *',
  'select prune_dead_links(180, false)'
);
select cron.schedule(
  'rxlink-retire-ip',
  '0 * * * *',
  'select retire_remote_addr(7)'
);
select cron.schedule(
  'rxlink-expired',
  '0 20 * * *',
  'select delete_expired_short_urls(false)'
);
