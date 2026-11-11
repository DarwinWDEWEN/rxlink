-- 0016_robots_crawlable_codes.sql —— robots.txt 的 crawlable 短码（I8 / R3）
--
-- 出处：shlink module/Core/src/Action/RobotsAction.php:32-57
--       + module/Core/src/ShortUrl/Repository/CrawlableShortCodesQuery.php
-- 差异：shlink 的 CrawlableShortCodesQuery 不按域名过滤（列全部 crawlable 码）；
--       rxlink 按请求域名过滤（I8 批准的设计），domain_id = 0 的默认域名经 join domain
--       归入 example.com，与 short_url_json 的 domain 口径一致。
-- 权限：security invoker + set search_path；只授 service_role。

create or replace function robots_crawlable_codes(p_authority text)
returns text[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(s.short_code order by s.short_code), '{}'::text[])
    from short_url s
    join domain d on d.id = s.domain_id
   where s.crawlable
     and d.authority = lower(btrim(coalesce(p_authority, '')));
$$;

revoke execute on function robots_crawlable_codes(text) from public, anon, authenticated;
grant execute on function robots_crawlable_codes(text) to service_role;
