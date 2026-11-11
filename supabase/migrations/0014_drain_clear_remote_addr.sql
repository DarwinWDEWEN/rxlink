-- ---------------------------------------------------------------------------
-- I7 收尾：drain 落库后立即清空 visit_inbox 的原始 IP
--
--   覆盖 0012_geo_location.sql 的同名函数 drain_visit_inbox（其余逻辑完全一致，
--   仅在 WITH 块之后多一条清空语句）。0012 是已应用历史，不改；这是可追溯的覆盖。
--
--   为什么要改：
--     visit.remote_addr 由 apply_visit_locations 回写地理结果时清空（毫秒级），
--     但入队表 visit_inbox 的行要等 processed_at 满 1 天才物理删除，
--     期间原始 IP 一直留在库里 —— 这是链路上最长的一处 IP 留存。
--     改成 drain 成功落库后立即清空 → 原始 IP 留存从「最长 1 天」压到「分钟级」，
--     与「原始 IP 只短暂留存」的对外承诺对齐。
--
--   为什么清空放在 WITH 块之后：
--     WITH 内的 scored CTE 已经把 remote_addr 读进 ins（写入 visit），
--     之后才清 inbox 的同名列；两步在同一事务内，先读后清，不会丢 IP。
--     反过来（先清 inbox 再 insert）会让 visit 拿不到 IP，富化就失效了。
--
--   幂等：update 只碰 processed_at 非空且 remote_addr 非空的行，重复执行安全。
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
      visited_url, redirect_url, potential_bot, browser, os, device, remote_addr
    )
    select sc.occurred_at, sc.short_url_id, sc.orphan_type, sc.visitor_key, sc.ua, sc.referer,
           sc.visited_url, sc.redirect_to, sc.potential_bot, u.browser, u.os, u.device, sc.remote_addr
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

  -- 原始 IP 只在入队队列短暂留存：落库后立即清空（0012 里是等 1 天物理删除）
  update visit_inbox set remote_addr = null
   where processed_at is not null
     and remote_addr is not null;

  -- 已处理的入队行留一天便于排查，之后物理删除（UNLOGGED 表本身不参与备份）
  delete from visit_inbox where processed_at < now() - interval '1 day';

  return v_count;
end;
$$;
