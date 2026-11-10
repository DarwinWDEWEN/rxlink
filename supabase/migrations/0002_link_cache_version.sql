-- 缓存版本号：跳转函数常驻快照的失效依据。
-- 一张只有一行的表 + 一个触发器：任何写短链映射的路径都自动把 seq 加一，不依赖调用方记得更新。

create table if not exists link_version (
  id   int     primary key default 1,
  seq  bigint  not null default 0,
  check (id = 1)
);

insert into link_version (id, seq) values (1, 0)
on conflict (id) do nothing;

alter table link_version enable row level security;
alter table link_version force row level security;
-- postgres 与 service_role 都带 BYPASSRLS（实测），所以 force 只挡住 anon/authenticated 与未来的 anon 写路径。
revoke all on table link_version from anon, authenticated;
grant select, update on link_version to service_role;

-- 上一句让 bump 触发器对 anon 是「拒绝」而不是「静默失效」，所以短链映射的写路径必须只留 service_role。
-- 只收回写权限：`/rest/v1/probe_short_url` + anon key 的读口径要留给 P0 复现。
revoke insert, update, delete, truncate on probe_short_url from anon, authenticated;

create or replace function bump_link_version()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  update link_version set seq = seq + 1 where id = 1;
  return null;
end;
$$;

drop trigger if exists link_version_after_write on probe_short_url;
create trigger link_version_after_write
after insert or update or delete on probe_short_url
for each statement
execute function bump_link_version();

-- 全量快照：跳转函数启动时拉一次，之后只在 seq 变化时重拉。
-- 只给启用的行；域名空的行是全局短码，由函数侧在查表时做优先级。
drop function if exists probe_link_snapshot();
create or replace function probe_link_snapshot()
returns table (short_code text, domain text, long_url text)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select short_code, domain, long_url
  from probe_short_url
  where enabled;
$$;

-- 读 seq 单独一个函数，避免每次轮询把整行返回出来。
drop function if exists probe_link_seq();
create or replace function probe_link_seq()
returns bigint
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select seq from link_version where id = 1;
$$;
