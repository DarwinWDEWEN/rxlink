-- 0015_api_key_expires_at.sql —— API key 过期（I8 / R6）
--
-- 原出处：0004_core_tables.sql 建 api_key；0008_compat_api.sql 定义 compat_auth。
-- 本文件覆盖 compat_auth（原出处 0008），加 expires_at 判空；其余逻辑逐字保留。
-- 平台约束：security invoker + set search_path；只授 service_role。
-- 语义：过期 key 视为无效，compat_auth 返回 null，兼容层 401。
-- 出处：shlink module/Rest/src/Entity/ApiKey.php（expirationDate + isExpired()）。

alter table api_key add column if not exists expires_at timestamptz;

create or replace function compat_auth(p_hash_hex text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', k.id,
    'name', k.name,
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object('role', r.role, 'domainId', r.domain_id)
                       order by r.role, r.domain_id)
        from api_key_role r
       where r.api_key_id = k.id
    ), '[]'::jsonb)
  )
  from api_key k
  where k.enabled
    and (k.expires_at is null or k.expires_at > now())
    and k.key_hash = decode(lower(btrim(p_hash_hex)), 'hex');
$$;

-- create or replace 保留原 ACL，这里显式再收口一次，确保口径不漂移
revoke execute on function compat_auth(text) from public, anon, authenticated;
grant execute on function compat_auth(text) to service_role;
