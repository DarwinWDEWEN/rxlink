-- 0017_delete_expired_short_urls.sql —— 过期/超次短链清理（I8 / R5）
--
-- 出处：shlink module/Core/src/ShortUrl/Repository/ExpiredShortUrlsRepository.php:50-69
--       （shlink 物理删；rxlink 软删，与 prune_dead_links 口径一致，可逆）
-- 与 prune_dead_links 的关系：两条独立规则——「到期/超次」与「180 天无访问」，都要有。
-- 调度：先不挂 cron；dry-run 出清单后由负责人确认，再手动挂（见文件末尾注释）。
-- 权限：security invoker + set search_path；只授 service_role。

create or replace function delete_expired_short_urls(p_dry_run boolean default true)
returns table (short_url_id bigint, short_code text, domain text, reason text)
language plpgsql
set search_path = public
as $$
begin
  return query
  with expired as (
    select s.id,
           s.short_code,
           d.authority as domain,
           case
             when s.valid_until is not null and s.valid_until < now() then 'valid_until'
             when s.max_visits is not null and s.visits_count >= s.max_visits then 'max_visits'
           end as reason
      from short_url s
      join domain d on d.id = s.domain_id
     where s.enabled
       and ((s.valid_until is not null and s.valid_until < now())
            or (s.max_visits is not null and s.visits_count >= s.max_visits))
     for update of s skip locked
  ), dis as (
    update short_url s
       set enabled = false
      from expired e
     where s.id = e.id
       and not p_dry_run
    returning 1
  )
  select e.id, e.short_code, e.domain, e.reason from expired e;
end;
$$;

revoke execute on function delete_expired_short_urls(boolean) from public, anon, authenticated;
grant execute on function delete_expired_short_urls(boolean) to service_role;

-- 挂 cron（每天 GMT 20:00；DB timezone = GMT，pg_cron 5 字段）。
-- 先 dry-run：select * from delete_expired_short_urls(true);
-- 确认清单后取消下面注释、逐条执行：
-- select cron.schedule('rxlink-expired', '0 20 * * *', 'select delete_expired_short_urls(false)');
-- select * from cron.job where jobname = 'rxlink-expired';
-- select cron.unschedule('rxlink-expired');
