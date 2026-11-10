-- 0011：404 回退 RPC + 默认域名 scheme 修正
-- 背景：domain 表三列回跳配置（0004）与控制台编辑接口（0010）已就绪，
-- 但跳转函数一直没用；本文件把「按域名取回退配置」的读取口补齐，
-- 并把默认域名哨兵的 scheme 从占位 'http' 改为正式 'https'（证书已配）。

-- ---------------------------------------------------------------------------
-- 1. not_found_redirects：按 authority 返回回退配置
--    语义照 shlink NotFoundRedirectHandler：域名级优先、逐列回落全局（id=0 哨兵）。
--    只在 404 分支按需调用（低频路径），配置改动立即生效，无需缓存失效。
-- ---------------------------------------------------------------------------
create or replace function not_found_redirects(p_authority text)
returns table (
  base_url_redirect text,
  regular404_redirect text,
  invalid_short_url_redirect text
)
language sql
stable
set search_path = public
as $$
  select coalesce(d.base_url_redirect, g.base_url_redirect),
         coalesce(d.regular404_redirect, g.regular404_redirect),
         coalesce(d.invalid_short_url_redirect, g.invalid_short_url_redirect)
    from domain g
    left join domain d on d.authority = p_authority
   where g.id = 0;
$$;

-- 0004 建表时的列注释与 shlink 语义相反（把「路由形状不合法」记成了 invalid），
-- 这里按 shlink NotFoundType 纠正：单段短码形状但码不存在 = invalid_short_url；
-- 多段/非法字符等路由不匹配 = regular_404。跳转函数孤儿分类同口径。
comment on column domain.invalid_short_url_redirect is
  '短码形状合法但码不存在（或过期/失效）时的回跳 URL，占位符 {DOMAIN}/{ORIGINAL_PATH}';
comment on column domain.regular404_redirect is
  '路由形状不匹配（多段路径、非法字符等）时的回跳 URL，占位符 {DOMAIN}/{ORIGINAL_PATH}';
comment on column domain.base_url_redirect is
  '命中域名根路径时的回跳 URL，占位符 {DOMAIN}/{ORIGINAL_PATH}';

revoke execute on function not_found_redirects(text) from public, anon, authenticated;
grant execute on function not_found_redirects(text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. 默认域名 scheme 修正：证书已配 + 强制 HTTPS，短链拼出来应为 https
-- ---------------------------------------------------------------------------
update domain
   set scheme = 'https'
 where id = 0
   and authority = 'example.com';
