# I10 标题自动解析（R10）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 shlink 的「标题自动解析」在 rxlink 上真正可用——建链时未填标题就自动抓目标页 `<title>` 写进 `short_url.title`，并用新增的来源列记住「这标题是自动抓的还是用户手填的」，使得编辑时只有自动解析的标题才会被刷新。

**Architecture:** 抓取发生在兼容层 Edge Function（Supabase Edge Function / Deno）内，**同步**在建链与编辑请求里完成。新增独立模块 `title-resolver.ts`：纯函数（标题提取 / charset 探测 / 转码 / 实体解码 / IP 判定）+ 一条带 SSRF fail-closed 校验的抓取主流程。新增迁移 `0020`：给 `short_url` 加 `title_was_auto_resolved` 列，并重建 `create_short_url`（13→14 参）与 `update_short_url`（3→4 参）。**写标题的判定放在 DB 内**（`update_short_url` 的 UPDATE 语句里），因为判定需要「旧标题 + 旧来源」的原子读取，且与上游 `ShortUrl::update()` 的判定位置一致；抓到的自动标题走**独立参数** `p_auto_title`，绝不混进 `p_patch`（`p_patch` 里有 `title` 键即代表「用户手填」）。

**Tech Stack:** PostgreSQL（ADB Supabase，平台一次只认一条 SQL）、Deno（Supabase Edge Function 兼容层，`deno test` / `deno check`）、`functions-cli`（本机部署兼容层）。

**设计稿：** `docs/superpowers/specs/2026-11-12-r10-title-auto-resolve-design.md`（commit `bf8a7b8` + 自审修正 `3c39d16`）。本计划的每个技术选择都出自该文档；文档与本计划冲突时以文档为准并回头修本计划。

---

## Global Constraints

以下约束对**每个** task 都生效，不再逐条重复：

- **凭据红线**：只写变量名。任何地方都**不回显、不记录** `SUPABASE_SERVICE_ROLE_KEY`、`x-fc-access-key-*`、`x-edge-env-*` 等请求头；`.env` 的值不进文档、不进 git、不进聊天。
- **迁移不可变**：`0001`–`0019` 不改不删。新变更写新编号文件（`0020`）。覆盖已有函数时**必须在注释里注明原出处**（例：`-- 覆盖 0005 的 create_short_url`）。
- **平台一次只认一条 SQL 语句**：迁移文件里的多条语句必须由切分脚本逐条执行（见 Task 1 的命令）。
- **判断失败必须用退出码**：supabase CLI 的报错文案有两种（`failed to execute query: ERROR:` / `query error: ERROR:`），**只 grep 前者会漏掉后者**。两种情况退出码都非 0。
- **以 `--` 开头的语句会被 CLI 当成参数**：切分后必须剥掉每条语句开头的注释行（Task 1 的脚本已处理）。
- **RPC 权限**：新函数一律 `revoke execute on function ... from public, anon, authenticated;` + `grant execute on function ... to service_role;`。**DROP 函数会连带删掉 ACL**，重建后必须对新签名重新收口。
- **改函数参数个数必须先 DROP 旧签名**（Postgres 不允许 `CREATE OR REPLACE` 改参数个数；保留新旧两个签名还会有重载歧义）。
- **TDD**：先写失败测试并**实际跑一遍看到它失败**，再写实现，再跑一遍看到它通过。
- **提交粒度**：每个 task 结束提交一次；commit message 用中文，格式 `feat(I10): …` / `test(I10): …` / `docs(I10): …`。
- **本机工具路径**：
  - Deno：`/Users/wang/.deno/bin/deno`
  - Node：`/Users/wang/.nvm/versions/node/v24.14.0/bin/node`（本机 `node` 不在 PATH）
  - supabase CLI：`/Users/wang/.nvm/versions/node/v24.14.0/bin/supabase`
- **单测命令**：
  - 兼容层：`/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/compat.test.ts supabase/functions/compat/test/title-resolver.test.ts`
  - 类型检查：`/Users/wang/.deno/bin/deno check supabase/functions/compat/index.ts supabase/functions/compat/handler.ts supabase/functions/compat/title-resolver.ts supabase/functions/compat/test/compat.test.ts supabase/functions/compat/test/title-resolver.test.ts`
  - **不要加 `--allow-net`**：标题解析测试一律注入假的 DNS 解析器与假的 fetch，忘了注入会因权限报错而失败（这是有意的响亮失败）。
- **`/tmp` 会被清理**：`functions-cli`、切分脚本、api-key 明文等临时文件随时会消失，需要时重新下载/重建（见 Task 6）。
- **不造一次性工具**：新增脚本一律放 `scripts/`，可重复执行、幂等。本计划的切分脚本是**一次性 heredoc**，不落仓库。
- **降级红线**：标题抓取的**任何**失败都必须降级为「无标题」，绝不抛给调用方、绝不让建链/编辑失败。
- **日志红线**：只记原因码 + host，**不记完整 URL**（长链 query 里可能带 token）、不记响应体、不记请求头。

---

## File Structure

| 文件 | 责任 | 状态 |
|---|---|---|
| `supabase/migrations/0020_title_auto_resolve.sql` | 加 `title_was_auto_resolved` 列 + 重建 `create_short_url` / `update_short_url` + 权限收口 | 新建 |
| `supabase/functions/compat/title-resolver.ts` | 标题纯逻辑 + SSRF 地址判定 + 抓取主流程 | 新建 |
| `supabase/functions/compat/test/title-resolver.test.ts` | 上述模块的单测（纯逻辑 / SSRF / 抓取） | 新建 |
| `supabase/functions/compat/handler.ts` | 建链与编辑的编排（何时抓、抓到的标题往哪传）+ 导出可注入的 `titleResolverDeps` | 修改 |
| `supabase/functions/compat/test/compat.test.ts` | fetch mock 按 URL 分流（`/rpc/` vs 外部）+ R10 集成用例 | 修改 |
| `docs/verification/r10-results.md` | 验收记录 | 新建 |
| `docs/runbook.md` | 标题自动解析操作段 + 迁移清单 | 修改 |
| `docs/iteration-plan.md` | I10 章节 + B10 清单 + C 表 + 变更记录 | 修改 |
| `docs/shlink-feature-checklist.md` | `autoResolveTitles` 项 | 修改 |

---

## Task 1: 迁移 `0020` —— 来源列 + 两个 RPC 重建 + 权限收口

**Files:**
- Create: `supabase/migrations/0020_title_auto_resolve.sql`

**Interfaces:**
- Consumes: 现有 `create_short_url(text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint)`（`0005_shorten_and_resolve.sql:61-189`）、现有 `update_short_url(text,text,jsonb)`（`0008_compat_api.sql:194-269`）
- Produces:
  - `short_url.title_was_auto_resolved boolean not null default false`
  - `create_short_url(text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint,boolean)` —— 新增尾部参数 `p_title_was_auto_resolved boolean default false`
  - `update_short_url(text,text,jsonb,text)` —— 新增尾部参数 `p_auto_title text default null`

- [ ] **Step 1: 备份将被覆盖的两个函数定义**

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
sed -n '61,189p'  supabase/migrations/0005_shorten_and_resolve.sql > /tmp/rxl-backup-create_short_url.sql
sed -n '194,269p' supabase/migrations/0008_compat_api.sql          > /tmp/rxl-backup-update_short_url.sql
wc -l /tmp/rxl-backup-*.sql
```

Expected: 两个文件各约 129 / 76 行。

- [ ] **Step 2: 写迁移文件**

`supabase/migrations/0020_title_auto_resolve.sql` 全文如下（**整体写入，不要手工拼**）：

```sql
-- 0020：R10 标题自动解析
--
-- 目标：
--   1. 新增 short_url.title_was_auto_resolved，记录标题来源
--      （列名对齐上游 ShortUrl 实体映射 entities-mappings/...ShortUrl.php:127）
--   2. 重建 create_short_url：新增尾部参数 p_title_was_auto_resolved boolean default false
--   3. 重建 update_short_url：新增尾部参数 p_auto_title text default null
--   4. 权限收口：平台默认把 EXECUTE 授给 PUBLIC，DROP 函数会连带删掉 ACL
--      → 重建后必须对新签名重新 revoke/grant
--
-- 覆盖 0005 的 create_short_url、0008 的 update_short_url
-- （同名函数，改参数个数必须先 DROP 旧签名，否则会出现重载歧义）。
--
-- 兼容性：新参数都带默认值 → 迁移后旧调用点（13 参 / 3 参）仍能解析到新函数，
--         所以「迁移先行、兼容层后发」是安全的；反过来会因函数不存在而报错。

-- ---------------------------------------------------------------------------
-- 1. 新列
-- ---------------------------------------------------------------------------
alter table short_url add column if not exists title_was_auto_resolved boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. create_short_url
--    覆盖 0005 的同名函数：新增尾部参数 p_title_was_auto_resolved
-- ---------------------------------------------------------------------------
drop function if exists create_short_url(text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint);

create or replace function create_short_url(
  p_long_url            text,
  p_domain              text        default null,
  p_custom_slug         text        default null,
  p_title               text        default null,
  p_tags                text[]      default null,
  p_crawlable           boolean     default false,
  p_forward_query       boolean     default true,
  p_valid_since         timestamptz default null,
  p_valid_until         timestamptz default null,
  p_max_visits          integer     default null,
  p_short_code_length   integer     default 5,
  p_find_if_exists      boolean     default false,
  p_author_api_key_id   bigint      default null,
  p_title_was_auto_resolved boolean default false
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_domain    text;
  v_domain_id bigint;
  v_code      text;
  v_len       int;
  v_id        bigint;
  v_try       int;
  v_i         int;
  v_alphabet  constant text := 'abcdefghijklmnopqrstuvwxyz0123456789';
begin
  if p_long_url is null or btrim(p_long_url) = '' then
    raise exception using errcode = '22023', message = 'invalid_long_url';
  end if;
  if p_valid_since is not null and p_valid_until is not null and p_valid_until <= p_valid_since then
    raise exception using errcode = '22023', message = 'invalid_validity';
  end if;

  -- 域名：空 = 默认域名（domain_id 0）；未知域名按 shlink 的做法隐式创建
  if p_domain is null or btrim(p_domain) = '' then
    v_domain_id := 0;
  else
    v_domain := lower(btrim(p_domain));
    select id into v_domain_id from domain where authority = v_domain;
    if v_domain_id is null then
      insert into domain (authority) values (v_domain) on conflict (authority) do nothing;
      select id into v_domain_id from domain where authority = v_domain;
    end if;
  end if;

  -- 同链复用：比较所有会影响有效性的字段，命中即原样返回
  if p_find_if_exists then
    select id into v_id
      from short_url
     where domain_id = v_domain_id
       and long_url_hash = sha256(btrim(p_long_url)::bytea)
       and valid_since  is not distinct from p_valid_since
       and valid_until  is not distinct from p_valid_until
       and max_visits   is not distinct from p_max_visits
       and enabled
     order by id
     limit 1;
    if v_id is not null then
      return short_url_json(v_id);
    end if;
  end if;

  if p_custom_slug is not null and btrim(p_custom_slug) <> '' then
    v_code := lower(btrim(p_custom_slug));
    if v_code !~ '^[a-z0-9_-]{1,64}$' then
      raise exception using errcode = '22023', message = 'invalid_slug';
    end if;
    -- 并发下同一 (domain, code) 串行化，避免「先查后插」的竞态
    perform pg_advisory_xact_lock(hashtext(v_domain_id::text || ':' || v_code));
    if exists (select 1 from short_url where domain_id = v_domain_id and short_code = v_code) then
      raise exception using errcode = '23505', message = 'non_unique_slug';
    end if;

    insert into short_url (
      domain_id, short_code, long_url, title, crawlable, forward_query,
      valid_since, valid_until, max_visits, author_api_key_id,
      title_was_auto_resolved
    ) values (
      v_domain_id, v_code, btrim(p_long_url), p_title, coalesce(p_crawlable, false),
      coalesce(p_forward_query, true), p_valid_since, p_valid_until, p_max_visits, p_author_api_key_id,
      case when p_title is null then false else coalesce(p_title_was_auto_resolved, false) end
    ) returning id into v_id;
  else
    -- 随机码：单行 insert 捕 23505（多值 insert 一行冲突会回滚整条语句，P0 已记）
    v_len := greatest(4, least(coalesce(p_short_code_length, 5), 32));
    for v_try in 1..20 loop
      v_code := '';
      for v_i in 1..v_len loop
        v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
      end loop;
      perform pg_advisory_xact_lock(hashtext(v_domain_id::text || ':' || v_code));
      begin
        insert into short_url (
          domain_id, short_code, long_url, title, crawlable, forward_query,
          valid_since, valid_until, max_visits, author_api_key_id,
          title_was_auto_resolved
        ) values (
          v_domain_id, v_code, btrim(p_long_url), p_title, coalesce(p_crawlable, false),
          coalesce(p_forward_query, true), p_valid_since, p_valid_until, p_max_visits, p_author_api_key_id,
          case when p_title is null then false else coalesce(p_title_was_auto_resolved, false) end
        ) returning id into v_id;
        exit;
      exception when unique_violation then
        v_id := null;
      end;
    end loop;
    if v_id is null then
      raise exception using errcode = '23505', message = 'short_code_exhausted';
    end if;
  end if;

  -- 标签：整组替换语义在 update 里；创建时只做「补齐 + 关联」
  if p_tags is not null then
    insert into tag (name)
    select distinct lower(btrim(x))
      from unnest(p_tags) as x
     where btrim(x) <> ''
    on conflict (name) do nothing;

    insert into short_url_tag (short_url_id, tag_id)
    select distinct v_id, t.id
      from unnest(p_tags) as x
      join tag t on t.name = lower(btrim(x))
     where btrim(x) <> ''
    on conflict do nothing;
  end if;

  return short_url_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. update_short_url
--    覆盖 0008 的同名函数：新增尾部参数 p_auto_title
--
--    写标题的判定放在 DB 内（与上游 Entity/ShortUrl.php:167-178 逐条等价）：
--      p_patch 里有 title 键   → 用户手填，优先写入，来源置 false
--      p_auto_title 非空 且
--        (旧标题为 null 或 旧来源是自动解析) → 写入，来源置 true
--      都不满足                → 保留原标题与原来源
-- ---------------------------------------------------------------------------
drop function if exists update_short_url(text,text,jsonb);

create or replace function update_short_url(p_code text, p_domain text default null, p_patch jsonb default '{}'::jsonb, p_auto_title text default null)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_id     bigint;
  v_domain bigint;
begin
  if p_code is null or btrim(p_code) = '' then
    raise exception using errcode = '22023', message = 'invalid_short_code';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_payload';
  end if;

  if p_domain is null or btrim(p_domain) = '' or upper(btrim(p_domain)) = 'DEFAULT' then
    v_domain := 0;
  else
    select id into v_domain from domain where authority = lower(btrim(p_domain));
    if v_domain is null then
      raise exception using errcode = 'P0002', message = 'short_url_not_found';
    end if;
  end if;

  select id into v_id
    from short_url
   where short_code = lower(btrim(p_code))
     and domain_id = v_domain
     and enabled;
  if v_id is null then
    raise exception using errcode = 'P0002', message = 'short_url_not_found';
  end if;

  if p_patch ? 'longUrl' and btrim(coalesce(p_patch->>'longUrl', '')) = '' then
    raise exception using errcode = '22023', message = 'invalid_long_url';
  end if;

  update short_url s
     set long_url      = case when p_patch ? 'longUrl'      then btrim(p_patch->>'longUrl')
                              else s.long_url end,
         title         = case
                           when p_patch ? 'title' then nullif(btrim(p_patch->>'title'), '')
                           when p_auto_title is not null
                                and (s.title is null or s.title_was_auto_resolved)
                             then btrim(p_auto_title)
                           else s.title
                         end,
         title_was_auto_resolved = case
                           when p_patch ? 'title' then false
                           when p_auto_title is not null
                                and (s.title is null or s.title_was_auto_resolved)
                             then true
                           else s.title_was_auto_resolved
                         end,
         crawlable     = case when p_patch ? 'crawlable'    then coalesce((p_patch->>'crawlable')::boolean, s.crawlable)
                              else s.crawlable end,
         forward_query = case when p_patch ? 'forwardQuery' then coalesce((p_patch->>'forwardQuery')::boolean, s.forward_query)
                              else s.forward_query end,
         valid_since   = case when p_patch ? 'validSince'   then (p_patch->>'validSince')::timestamptz
                              else s.valid_since end,
         valid_until   = case when p_patch ? 'validUntil'   then (p_patch->>'validUntil')::timestamptz
                              else s.valid_until end,
         max_visits    = case when p_patch ? 'maxVisits'    then (p_patch->>'maxVisits')::integer
                              else s.max_visits end
   where s.id = v_id;

  if p_patch ? 'tags' then
    delete from short_url_tag where short_url_id = v_id;
    if jsonb_typeof(p_patch->'tags') = 'array' then
      insert into tag (name)
      select distinct lower(btrim(x))
        from jsonb_array_elements_text(p_patch->'tags') x
       where btrim(x) <> ''
      on conflict (name) do nothing;

      insert into short_url_tag (short_url_id, tag_id)
      select distinct v_id, t.id
        from jsonb_array_elements_text(p_patch->'tags') x
        join tag t on t.name = lower(btrim(x))
       where btrim(x) <> ''
      on conflict do nothing;
    end if;
  end if;

  return short_url_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. 权限收口（DROP 函数会连带删掉 ACL → 必须对新签名重新收口）
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'create_short_url(text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint,boolean)',
    'update_short_url(text,text,jsonb,text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
```

- [ ] **Step 3: 切分并逐条执行**

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
set -a; source supabase/functions/.env; set +a
cat > /tmp/rxl-split-sql.py <<'PY'
import re, sys, pathlib

def split_statements(sql):
    stmts, buf, i, n = [], [], 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":                      # 单引号字符串（'' 是转义）
            buf.append(ch); i += 1
            while i < n:
                buf.append(sql[i])
                if sql[i] == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        buf.append(sql[i + 1]); i += 2; continue
                    i += 1; break
                i += 1
            continue
        if sql.startswith('--', i):         # 行注释
            j = sql.find('\n', i); j = n if j < 0 else j
            buf.append(sql[i:j]); i = j; continue
        if sql.startswith('/*', i):         # 块注释
            j = sql.find('*/', i + 2); j = n if j < 0 else j + 2
            buf.append(sql[i:j]); i = j; continue
        if ch == '$':                      # dollar-quote（$$ 或 $tag$）
            m = re.match(r'\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$', sql[i:])
            if m:
                tag = m.group(0)
                j = sql.find(tag, i + len(tag)); j = n if j < 0 else j
                buf.append(sql[i:j + len(tag)]); i = j + len(tag); continue
        buf.append(ch)
        if ch == ';':
            stmts.append(''.join(buf)); buf = []
        i += 1
    tail = ''.join(buf)
    if tail.strip():
        stmts.append(tail)
    return [s.strip() for s in stmts if s.strip()]

src = pathlib.Path(sys.argv[1]).read_text()
out_dir = pathlib.Path(sys.argv[2]); out_dir.mkdir(parents=True, exist_ok=True)
for f in out_dir.glob('stmt-*.sql'):
    f.unlink()
stmts = split_statements(src)
for i, s in enumerate(stmts, 1):
    # 去掉开头的注释行：supabase db query 会把以 `--` 开头的参数当成 CLI 选项
    lines = s.splitlines()
    while lines and (not lines[0].strip() or lines[0].strip().startswith('--')):
        lines.pop(0)
    body = '\n'.join(lines).strip()
    (out_dir / f'stmt-{i:03d}.sql').write_text((body if body.endswith(';') else body + ';') + '\n')
print('statements:', len(stmts))
PY
python3 /tmp/rxl-split-sql.py "$PWD/supabase/migrations/0020_title_auto_resolve.sql" /tmp/rxlink-split/stmts20
```

**先人工核对切分结果**（关键：两个函数体各自完整、权限块独立成条）：

```bash
ls /tmp/rxlink-split/stmts20/
head -2 /tmp/rxlink-split/stmts20/stmt-001.sql
grep -c ";" /tmp/rxlink-split/stmts20/stmt-*.sql
```

Expected: `statements: 6`，依次是

1. `alter table short_url add column if not exists title_was_auto_resolved ...`
2. `drop function if exists create_short_url(...)`
3. `create or replace function create_short_url(...)`（含完整函数体）
4. `drop function if exists update_short_url(text,text,jsonb)`
5. `create or replace function update_short_url(...)`（含完整函数体）
6. `do $$ ... $$;`（权限收口块）

> 切分脚本按分号切，`drop function if exists ...;` 与后面的 `create or replace function ... $$ ... $$;` 是两条独立语句。
> **必须人工确认第 3、5 条的函数体完整**（`grep -c "return short_url_json" stmt-003.sql stmt-005.sql` 应各为 1）。

再逐条执行：

```bash
for f in /tmp/rxlink-split/stmts20/stmt-*.sql; do
  echo "--- $f"
  supabase db query --db-url "$SUPABASE_DB_URL" "$(cat "$f")"
  rc=$?
  if [ $rc -ne 0 ]; then echo "❌ 失败于 $(basename "$f")（退出码 $rc）"; break; fi
done
```

Expected: 全部成功，无报错。

- [ ] **Step 4: 断言结构与权限**

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'short_url' and column_name = 'title_was_auto_resolved'"
supabase db query --db-url "$SUPABASE_DB_URL" "select p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_short_url','update_short_url') order by p.proname"
supabase db query --db-url "$SUPABASE_DB_URL" "select has_function_privilege('anon','create_short_url(text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint,boolean)','execute') as anon_can_create, has_function_privilege('anon','update_short_url(text,text,jsonb,text)','execute') as anon_can_update, has_function_privilege('service_role','create_short_url(text,text,text,text,text[],boolean,boolean,timestamptz,timestamptz,integer,integer,boolean,bigint,boolean)','execute') as svc_can_create"
```

Expected:
- 第一条：1 行，`boolean | NO | false`
- 第二条：2 行 —— `create_short_url(...,boolean)` 与 `update_short_url(text,text,jsonb,text)`
- 第三条：`f | f | t`

- [ ] **Step 5: 断言写标题规则（用真实数据）**

```bash
# 建链：自动解析的标题
supabase db query --db-url "$SUPABASE_DB_URL" "select create_short_url(p_long_url => 'https://example.com/r10-a', p_custom_slug => 'r10auto1', p_title => 'Auto Title', p_title_was_auto_resolved => true)"
# 建链：手填标题
supabase db query --db-url "$SUPABASE_DB_URL" "select create_short_url(p_long_url => 'https://example.com/r10-b', p_custom_slug => 'r10auto2', p_title => 'Manual Title')"
# 建链：没标题
supabase db query --db-url "$SUPABASE_DB_URL" "select create_short_url(p_long_url => 'https://example.com/r10-c', p_custom_slug => 'r10auto3')"
# 旧调用点（13 个位置参数）仍能解析到新函数 —— 验证「迁移先行、代码后发」安全
supabase db query --db-url "$SUPABASE_DB_URL" "select create_short_url('https://example.com/r10-legacy', null, 'r10legacy', 'Legacy Title', null, false, true, null, null, null, 5, false, null)"
# 查状态
supabase db query --db-url "$SUPABASE_DB_URL" "select short_code, title, title_was_auto_resolved from short_url where short_code in ('r10auto1','r10auto2','r10auto3','r10legacy') order by short_code"
```

Expected 第三条：`r10auto1 | Auto Title | t`、`r10auto2 | Manual Title | f`、`r10auto3 | null | f`、`r10legacy | Legacy Title | f`（最后一条证明旧签名调用没被 DROP 掉）。

```bash
# 编辑：手填标题 → 来源置 false
supabase db query --db-url "$SUPABASE_DB_URL" "select update_short_url(p_code => 'r10auto1', p_patch => '{\"title\":\"Manual Now\"}'::jsonb)"
# 编辑：改长链但原标题是手填 → 不覆盖
supabase db query --db-url "$SUPABASE_DB_URL" "select update_short_url(p_code => 'r10auto1', p_patch => '{\"longUrl\":\"https://example.com/r10-b2\"}'::jsonb, p_auto_title => 'Should Not Apply')"
# 编辑：改长链 + p_auto_title → 原标题为空 → 写入
supabase db query --db-url "$SUPABASE_DB_URL" "select update_short_url(p_code => 'r10auto3', p_patch => '{\"longUrl\":\"https://example.com/r10-c2\"}'::jsonb, p_auto_title => 'Filled Title')"
# 编辑：改长链 + p_auto_title → 原标题是自动解析 → 刷新
supabase db query --db-url "$SUPABASE_DB_URL" "select update_short_url(p_code => 'r10auto3', p_patch => '{\"longUrl\":\"https://example.com/r10-c3\"}'::jsonb, p_auto_title => 'Refreshed Title')"
# 编辑：改长链但 p_auto_title 为 null → 保留原标题
supabase db query --db-url "$SUPABASE_DB_URL" "select update_short_url(p_code => 'r10auto3', p_patch => '{\"longUrl\":\"https://example.com/r10-c4\"}'::jsonb)"
# 查最终状态
supabase db query --db-url "$SUPABASE_DB_URL" "select short_code, long_url, title, title_was_auto_resolved from short_url where short_code in ('r10auto1','r10auto3') order by short_code"
```

Expected 最终状态：
- `r10auto1 | https://example.com/r10-b2 | Manual Now | f`（手填标题粘性：改长链没被 `Should Not Apply` 覆盖）
- `r10auto3 | https://example.com/r10-c4 | Refreshed Title | t`（自动解析的标题被刷新；最后一步 `p_auto_title=null` 没把标题清掉）

- [ ] **Step 6: 确认 link_version 未因写标题而前进**

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select seq from link_version where id = 1"
supabase db query --db-url "$SUPABASE_DB_URL" "select update_short_url(p_code => 'r10auto2', p_patch => '{\"title\":\"Only Title Changed\"}'::jsonb)"
supabase db query --db-url "$SUPABASE_DB_URL" "select seq from link_version where id = 1"
```

Expected: 两次 `seq` **相差 1**。

> **实测结论（2026-11-12 线上）**：Postgres 的 `UPDATE OF col` 触发器按 **SET 列表**判定，
> **不看值是否真的变化**。`update_short_url` 的 SET 列表永远包含 `forward_query` /
> `valid_since` / `valid_until` / `max_visits`（用 CASE 保留旧值），这些列都在触发器清单里
> → **任何一次 `update_short_url` 调用都会 bump `link_version`**。
>
> 这是 **0008 起的既有行为**，R10 只是多加一列 `title_was_auto_resolved`，不改变触发与否。
> 对照实验：手写 `update short_url set title = title where ...` → seq **不前进**（触发器清单不含 title）。
>
> 影响：无正确性问题，只是每次 PATCH 都会让 FC 实例重拉一次全量短链快照（原本就如此）。

- [ ] **Step 7: 清理测试数据**

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "delete from short_url where short_code in ('r10auto1','r10auto2','r10auto3','r10legacy')"
supabase db query --db-url "$SUPABASE_DB_URL" "select count(*) from short_url where short_code like 'r10%'"
```

Expected: `0`。相关表的外键都是 `on delete cascade`（`0004_core_tables.sql:75,85`、`0018_redirect_rules.sql:19`），删主表即可。

- [ ] **Step 8: 提交**

```bash
git add supabase/migrations/0020_title_auto_resolve.sql
git commit -m "feat(I10): 迁移 0020 —— 标题来源列 + 重建 create/update RPC

- short_url 新增 title_was_auto_resolved boolean not null default false
- create_short_url 13->14 参（p_title_was_auto_resolved）
- update_short_url 3->4 参（p_auto_title），写标题判定放在 DB 内
- 权限收口按新签名重做（DROP 会连带删 ACL）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `title-resolver.ts` 纯逻辑 + 单测

**Files:**
- Create: `supabase/functions/compat/title-resolver.ts`（本 task 只写纯函数部分）
- Create: `supabase/functions/compat/test/title-resolver.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（本 task 导出的函数，后续 task 会用）：
  - `extractTitle(text: string): string | null`
  - `findTitleSpan(text: string): { start: number; end: number } | null`
  - `charsetFromContentType(contentType: string): string | null`
  - `charsetFromMeta(text: string): string | null`
  - `decodeWithCharset(bytes: Uint8Array, charset: string): string | null`
  - `decodeHtmlEntities(input: string): string`
  - `phpTrim(input: string): string`
  - `truncateTitle(text: string, max?: number): string`
  - 常量 `CHROME_USER_AGENT` / `MAX_REDIRECTS` / `FETCH_TIMEOUT_MS` / `MAX_BODY_BYTES` / `MAX_TITLE_LENGTH`

- [ ] **Step 1: 写失败测试**

`supabase/functions/compat/test/title-resolver.test.ts` 全文：

```ts
// R10 标题自动解析 —— 纯逻辑单测
// 运行：deno test --allow-env supabase/functions/compat/test/title-resolver.test.ts
import {
  charsetFromContentType,
  charsetFromMeta,
  decodeHtmlEntities,
  decodeWithCharset,
  extractTitle,
  phpTrim,
  truncateTitle,
} from '../title-resolver.ts';

function assert(cond: unknown, msg = 'assertion failed'): void {
  if (!cond) throw new Error(msg);
}

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}

// --- 标题提取 -------------------------------------------------------------

Deno.test('标题提取：普通 title', () => {
  assertEquals(extractTitle('<html><head><title>Hello World</title></head></html>'), 'Hello World');
});

Deno.test('标题提取：带属性的 title 标签', () => {
  assertEquals(extractTitle('<title lang="zh-CN">中文标题</title>'), '中文标题');
});

Deno.test('标题提取：大小写不敏感', () => {
  assertEquals(extractTitle('<TITLE>Upper</TITLE>'), 'Upper');
});

Deno.test('标题提取：没有 title 返回 null', () => {
  assertEquals(extractTitle('<html><body>no title</body></html>'), null);
});

Deno.test('标题提取：跨行不匹配（对齐上游正则没有 s 标志）', () => {
  assertEquals(extractTitle('<title>line1\nline2</title>'), null);
});

Deno.test('标题提取：取第一个 title（上游是非贪婪）', () => {
  assertEquals(extractTitle('<title>First</title><title>Second</title>'), 'First');
});

// --- charset 探测 ---------------------------------------------------------

Deno.test('charset：从 Content-Type 头取', () => {
  assertEquals(charsetFromContentType('text/html; charset=utf-8'), 'utf-8');
  assertEquals(charsetFromContentType('text/html; charset=UTF-8'), 'UTF-8');
  assertEquals(charsetFromContentType('text/html'), null);
});

Deno.test('charset：从 meta 标签取（两种写法都认）', () => {
  assertEquals(charsetFromMeta('<meta charset="gbk">'), 'gbk');
  assertEquals(charsetFromMeta('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">'), 'gb2312');
  assertEquals(charsetFromMeta('<html><body>x</body></html>'), null);
});

// --- 转码 -----------------------------------------------------------------

Deno.test('转码：utf-8', () => {
  assertEquals(decodeWithCharset(new TextEncoder().encode('中文标题'), 'utf-8'), '中文标题');
});

Deno.test('转码：gb2312 标签能解 GBK 字节（WHATWG 标签归一）', () => {
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2]);
  assertEquals(decodeWithCharset(gbk, 'gb2312'), '中文标题');
  assertEquals(decodeWithCharset(gbk, 'gbk'), '中文标题');
});

Deno.test('转码：latin1', () => {
  assertEquals(decodeWithCharset(new Uint8Array([0xe9]), 'iso-8859-1'), 'é');
});

Deno.test('转码：不认识的 charset 标签 → null（丢弃标题）', () => {
  assertEquals(decodeWithCharset(new Uint8Array([1, 2, 3]), 'x-unknown-charset'), null);
});

// --- 实体解码 -------------------------------------------------------------

Deno.test('实体解码：命名实体', () => {
  assertEquals(decodeHtmlEntities('A &amp; B'), 'A & B');
  assertEquals(decodeHtmlEntities('&lt;tag&gt;'), '<tag>');
  assertEquals(decodeHtmlEntities('&quot;hi&quot;'), '"hi"');
  assertEquals(decodeHtmlEntities('&nbsp;x&nbsp;'), '\u00a0x\u00a0');
});

Deno.test('实体解码：数字实体', () => {
  assertEquals(decodeHtmlEntities('&#39;'), "'");
  assertEquals(decodeHtmlEntities('&#x4e2d;'), '中');
});

Deno.test('实体解码：双重编码语义（&amp;amp; → &amp;）', () => {
  assertEquals(decodeHtmlEntities('&amp;amp;'), '&amp;');
});

Deno.test('实体解码：&apos; 不在 HTML401 集 → 不解码', () => {
  assertEquals(decodeHtmlEntities('&apos;'), '&apos;');
});

Deno.test('实体解码：未知命名实体原样保留', () => {
  assertEquals(decodeHtmlEntities('&unknownentity;'), '&unknownentity;');
});

// --- trim 与截断 ----------------------------------------------------------

Deno.test('trim：PHP 口径（不删 NBSP）', () => {
  assertEquals(phpTrim('  hi  '), 'hi');
  assertEquals(phpTrim('\t\nhi\r\n'), 'hi');
  assertEquals(phpTrim('\u00a0hi\u00a0'), '\u00a0hi\u00a0');
});

Deno.test('截断：超过 512 字符则截断', () => {
  assertEquals(truncateTitle('x'.repeat(600)).length, 512);
  assertEquals(truncateTitle('short'), 'short');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/title-resolver.test.ts
```

Expected: FAIL —— 报 `Module not found "file:///.../title-resolver.ts"`。

- [ ] **Step 3: 写实现**

`supabase/functions/compat/title-resolver.ts` 全文（**本 task 只写这一版；Task 3 / Task 4 会继续往里加**）：

```ts
// R10：自动解析目标页 <title>（对齐上游 shlink ShortUrlTitleResolutionHelper）
//
// 用途：建链未填标题 / 编辑时刷新自动解析的标题时，抓目标页的 <title>。
// 安全：longUrl 用户可控，服务端去 fetch 等价于内网探测器 → 全部走 SSRF fail-closed 校验。
// 降级：任何失败一律返回 null（无标题），绝不抛给调用方。
//
// 运行在 Supabase Edge Function（Deno）。纯函数无副作用，便于 deno test 直接覆盖。

export const CHROME_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
export const MAX_REDIRECTS = 15;
export const FETCH_TIMEOUT_MS = 3000;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_TITLE_LENGTH = 512;

// 上游正则原样；d 标志只用于取捕获组下标，不改匹配语义
const TITLE_TAG_VALUE = /<title[^>]*>(.*?)<\/title>/id;
const CHARSET_VALUE = /charset=([^;]+)/i;
const CHARSET_FROM_META = /<meta\b[^>]*\bcharset\s*=\s*(?:["']?)([^"'\s>;]+)/i;

// ---------------------------------------------------------------------------
// 标题提取
// ---------------------------------------------------------------------------

export type TitleSpan = { start: number; end: number };

export function findTitleSpan(text: string): TitleSpan | null {
  const m = TITLE_TAG_VALUE.exec(text);
  if (!m || !m.indices) return null;
  const span = m.indices[1];
  if (!span) return null;
  return { start: span[0], end: span[1] };
}

export function extractTitle(text: string): string | null {
  const span = findTitleSpan(text);
  return span ? text.slice(span.start, span.end) : null;
}

// ---------------------------------------------------------------------------
// charset 探测（上游 resolvePageCharset 的顺序：Content-Type 头 → meta 标签）
// ---------------------------------------------------------------------------

export function charsetFromContentType(contentType: string): string | null {
  const m = CHARSET_VALUE.exec(contentType);
  return m ? m[1]!.trim() : null;
}

export function charsetFromMeta(text: string): string | null {
  const m = CHARSET_FROM_META.exec(text);
  return m ? m[1]!.trim() : null;
}

// ---------------------------------------------------------------------------
// 转码（WHATWG 编码集，含 gb18030 / big5 / shift_jis / euc-kr 等 decoder-only）
// ---------------------------------------------------------------------------

export function decodeWithCharset(bytes: Uint8Array, charset: string): string | null {
  try {
    const decoder = new TextDecoder(charset.trim().toLowerCase());
    const text = decoder.decode(bytes);
    return text.length > 0 ? text : null;
  } catch {
    // 标签不认识 → 丢弃标题（有意偏差，见设计稿 §9 偏差 #2）
    return null;
  }
}

// ---------------------------------------------------------------------------
// 实体解码（对齐 PHP html_entity_decode 的默认口径 ENT_QUOTES|ENT_HTML401）
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  laquo: '\u00ab',
  raquo: '\u00bb',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  bull: '\u2022',
  middot: '\u00b7',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6',
  trade: '\u2122',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

// PHP trim 的默认字符集是 " \t\n\r\0\x0B"；JS 的 trim() 会多删 NBSP → 自己实现
export function phpTrim(input: string): string {
  return input.replace(/^[ \t\n\r\0\u000b]+/, '').replace(/[ \t\n\r\0\u000b]+$/, '');
}

// 上游 DB 列是 varchar(512) → 截断到 512 个字符（按码点算，不按 UTF-16 码元）
export function truncateTitle(text: string, max: number = MAX_TITLE_LENGTH): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/title-resolver.test.ts
```

Expected: 全部 PASS（18 例）。

- [ ] **Step 5: 类型检查**

```bash
/Users/wang/.deno/bin/deno check supabase/functions/compat/title-resolver.ts supabase/functions/compat/test/title-resolver.test.ts
```

Expected: 无输出（干净）。

- [ ] **Step 6: 提交**

```bash
git add supabase/functions/compat/title-resolver.ts supabase/functions/compat/test/title-resolver.test.ts
git commit -m "feat(I10): title-resolver 纯逻辑（标题/charset/转码/实体/截断）

- 正则与上游 ShortUrlTitleResolutionHelper 逐条对齐
- charset 标签走 WHATWG 编码集，gb2312/gbk 都能解
- 实体解码按 PHP html_entity_decode 默认口径（&apos; 不解码）
- PHP trim 口径（不删 NBSP）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: SSRF 地址判定 + 主机校验 + 单测

**Files:**
- Modify: `supabase/functions/compat/title-resolver.ts`（追加 IP 判定与主机校验）
- Modify: `supabase/functions/compat/test/title-resolver.test.ts`（追加 SSRF 用例）

**Interfaces:**
- Consumes: Task 2 的 `title-resolver.ts`
- Produces:
  - `isBlockedAddress(raw: string): boolean`
  - `isIpLiteral(raw: string): boolean`
  - `assertPublicHost(hostname: string, resolveDns: ResolveDns): Promise<void>`
  - `type ResolveDns = (host: string) => Promise<string[]>`
  - `defaultResolveDns(host: string): Promise<string[]>`
  - `type TitleResolveReason`（失败原因码联合类型）+ 内部类 `ResolveError` —— **Task 4 直接复用**，不要重复定义

- [ ] **Step 1: 写失败测试**

在 `supabase/functions/compat/test/title-resolver.test.ts` 末尾追加：

```ts
// --- SSRF：IP 判定 --------------------------------------------------------

import { assertPublicHost, isBlockedAddress, isIpLiteral, type ResolveDns } from '../title-resolver.ts';

const BLOCKED_ADDRESSES = [
  '0.0.0.0',
  '10.0.0.1',
  '100.64.0.1',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.1',
  '192.168.1.1',
  '198.18.0.1',
  '224.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  'fc00::1',
  'fd12:3456::1',
  'fe80::1',
  'ff00::1',
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.1',
  '64:ff9b::127.0.0.1',
  '2002:7f00:1::1',
];

for (const ip of BLOCKED_ADDRESSES) {
  Deno.test(`SSRF：${ip} 必须被拦截`, () => {
    assert(isBlockedAddress(ip), `${ip} 应该被拦截`);
  });
}

const PUBLIC_ADDRESSES = [
  '1.1.1.1',
  '8.8.8.8',
  '93.184.216.34',
  '100.128.0.1',
  '172.32.0.1',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
];

for (const ip of PUBLIC_ADDRESSES) {
  Deno.test(`SSRF：${ip} 必须放行`, () => {
    assert(!isBlockedAddress(ip), `${ip} 不该被拦截`);
  });
}

Deno.test('SSRF：认不出来的地址 fail closed', () => {
  assert(isBlockedAddress('not-an-ip'));
  assert(isBlockedAddress(''));
  assert(isBlockedAddress('999.1.1.1'));
});

Deno.test('SSRF：IP 字面量识别', () => {
  assert(isIpLiteral('127.0.0.1'));
  assert(isIpLiteral('::1'));
  assert(isIpLiteral('[::1]'));
  assert(!isIpLiteral('example.com'));
});

// --- SSRF：主机校验 -------------------------------------------------------

Deno.test('assertPublicHost：域名解析到公网 → 放行', async () => {
  const dns: ResolveDns = async () => ['93.184.216.34'];
  await assertPublicHost('example.com', dns);
});

Deno.test('assertPublicHost：域名解析到内网 → 抛错', async () => {
  const dns: ResolveDns = async () => ['10.0.0.5'];
  let threw = false;
  try {
    await assertPublicHost('evil.example.com', dns);
  } catch {
    threw = true;
  }
  assert(threw, '解析到内网必须被拒');
});

Deno.test('assertPublicHost：任一解析结果落在内网 → 抛错（fail closed，不挑一个）', async () => {
  const dns: ResolveDns = async () => ['93.184.216.34', '127.0.0.1'];
  let threw = false;
  try {
    await assertPublicHost('mixed.example.com', dns);
  } catch {
    threw = true;
  }
  assert(threw, '混合解析结果必须整体拒绝');
});

Deno.test('assertPublicHost：DNS 解析为空 → 抛错', async () => {
  const dns: ResolveDns = async () => [];
  let threw = false;
  try {
    await assertPublicHost('empty.example.com', dns);
  } catch {
    threw = true;
  }
  assert(threw, '解析为空必须被拒');
});

Deno.test('assertPublicHost：内网 IP 字面量 → 抛错，且不查 DNS', async () => {
  let queried = false;
  const dns: ResolveDns = async () => {
    queried = true;
    return ['93.184.216.34'];
  };
  let threw = false;
  try {
    await assertPublicHost('127.0.0.1', dns);
  } catch {
    threw = true;
  }
  assert(threw, '内网字面量必须被拒');
  assert(!queried, 'IP 字面量不该查 DNS');
});

Deno.test('assertPublicHost：IPv6 字面量带方括号 → 抛错', async () => {
  let threw = false;
  try {
    await assertPublicHost('[::1]', async () => ['93.184.216.34']);
  } catch {
    threw = true;
  }
  assert(threw, '[::1] 必须被拒');
});
```

> 注：测试文件里 `import` 写在文件末尾是合法的 ES 模块语法（import 会被提升），但为了可读性，**实际执行时应把新增的 import 合并到文件顶部**的 import 块里。最终文件顶部的 import 为：
> ```ts
> import {
>   assertPublicHost,
>   charsetFromContentType,
>   charsetFromMeta,
>   decodeHtmlEntities,
>   decodeWithCharset,
>   extractTitle,
>   isBlockedAddress,
>   isIpLiteral,
>   phpTrim,
>   truncateTitle,
>   type ResolveDns,
> } from '../title-resolver.ts';
> ```

- [ ] **Step 2: 跑测试确认失败**

```bash
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/title-resolver.test.ts
```

Expected: FAIL —— 报 `Module ... does not provide an export named 'assertPublicHost'`。

- [ ] **Step 3: 写实现**

在 `supabase/functions/compat/title-resolver.ts` 末尾追加：

```ts
// ---------------------------------------------------------------------------
// 失败原因码
//
// 只允许在日志里出现这些码 + host，绝不能出现完整 URL（长链 query 可能带 token）。
// ---------------------------------------------------------------------------

export type TitleResolveReason =
  | 'unsupported_scheme'
  | 'credentials_in_url'
  | 'missing_host'
  | 'blocked_address'
  | 'dns_failed'
  | 'request_failed'
  | 'timeout'
  | 'redirect_limit'
  | 'not_html'
  | 'no_charset'
  | 'no_title'
  | 'unknown_charset';

class ResolveError extends Error {
  constructor(readonly code: TitleResolveReason) {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// SSRF：IP 判定（fail-closed）
// ---------------------------------------------------------------------------

function parseIpv4(raw: string): number[] | null {
  const parts = raw.trim().split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function ipv4ToNumber(v: number[]): number {
  return ((v[0]! << 24) >>> 0) + (v[1]! << 16) + (v[2]! << 8) + v[3]!;
}

// 禁止网段：[起始, 结束]
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8      「本网络」
  [0x0a000000, 0x0affffff], // 10.0.0.0/8     私有
  [0x64400000, 0x647fffff], // 100.64.0.0/10  CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8   环回
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
  [0xac100000, 0xac1fffff], // 172.16.0.0/12 私有
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24  IETF 协议赋值
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16 私有
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 基准测试
  [0xe0000000, 0xefffffff], // 224.0.0.0/4   组播
  [0xf0000000, 0xffffffff], // 240.0.0.0/4   保留（含 255.255.255.255）
];

function isBlockedIpv4(v: number[]): boolean {
  const n = ipv4ToNumber(v);
  return BLOCKED_V4.some(([lo, hi]) => n >= lo && n <= hi);
}

function parseHextet(raw: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(raw)) return null;
  return parseInt(raw, 16);
}

function parseIpv6(raw: string): number[] | null {
  let s = raw.trim().split('%')[0]!.toLowerCase();
  if (!s.includes(':')) return null;
  // 内嵌 IPv4（::ffff:1.2.3.4 / 64:ff9b::1.2.3.4 形态）
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const v4 = parseIpv4(s.slice(cut + 1));
    if (!v4) return null;
    s = `${s.slice(0, cut + 1)}${ipv4ToNumber(v4).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string[]): number[] | null => {
    const out: number[] = [];
    for (const h of part) {
      const n = parseHextet(h);
      if (n === null) return null;
      out.push(n);
    }
    return out;
  };
  const head = toGroups(halves[0] ? halves[0]!.split(':') : []);
  const tail = halves.length === 2 ? toGroups(halves[1] ? halves[1]!.split(':') : []) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null; // '::' 至少压缩一个 0 组
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isBlockedIpv6(g: number[]): boolean {
  const firstZero = (n: number) => g.slice(0, n).every((x) => x === 0);
  const v4FromLast32 = () => [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (g.every((x) => x === 0)) return true; // ::
  if (firstZero(6) && g[7] === 1) return true; // ::1
  const first = g[0]!;
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7  ULA
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 链路本地
  if (first >= 0xff00) return true; // ff00::/8  组播
  if (firstZero(5) && g[5] === 0xffff) return isBlockedIpv4(v4FromLast32()); // ::ffff:x.x.x.x
  if (
    g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0
  ) {
    return isBlockedIpv4(v4FromLast32()); // 64:ff9b::/96  NAT64
  }
  if (first === 0x2002) {
    // 2002::/16  6to4：内嵌 IPv4 在第 2、3 组
    return isBlockedIpv4([g[1]! >> 8, g[1]! & 255, g[2]! >> 8, g[2]! & 255]);
  }
  if (first === 0x2001 && g[1] === 0x0000) {
    // 2001::/32  Teredo：末 32 位是取反后的 IPv4
    const obf = v4FromLast32();
    return isBlockedIpv4([255 - obf[0]!, 255 - obf[1]!, 255 - obf[2]!, 255 - obf[3]!]);
  }
  return false;
}

export function isBlockedAddress(raw: string): boolean {
  const ip = raw.trim();
  if (!ip) return true; // 空地址 → fail closed
  const v4 = parseIpv4(ip);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(ip);
  if (!v6) return true; // 认不出来 → fail closed
  return isBlockedIpv6(v6);
}

export function isIpLiteral(raw: string): boolean {
  const ip = raw.trim();
  return parseIpv4(ip) !== null || parseIpv6(ip) !== null;
}

// ---------------------------------------------------------------------------
// SSRF：主机校验
// ---------------------------------------------------------------------------

export type ResolveDns = (host: string) => Promise<string[]>;

export async function defaultResolveDns(host: string): Promise<string[]> {
  const out: string[] = [];
  for (const family of ['A', 'AAAA'] as const) {
    try {
      out.push(...await Deno.resolveDns(host, family));
    } catch {
      // A 解析失败不代表 AAAA 也失败，继续试下一个
    }
  }
  return out;
}

export async function assertPublicHost(hostname: string, resolveDns: ResolveDns): Promise<void> {
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (!host) throw new ResolveError('missing_host');
  if (isIpLiteral(host)) {
    if (isBlockedAddress(host)) throw new ResolveError('blocked_address');
    return;
  }
  const addresses = await resolveDns(host);
  if (!addresses.length) throw new ResolveError('dns_failed');
  // 全部解析结果都要检查：任一落在禁止网段就整体拒绝
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) throw new ResolveError('blocked_address');
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/title-resolver.test.ts
```

Expected: 全部 PASS（18 + 22 + 6 + 7 = 53 例）。

- [ ] **Step 5: 类型检查**

```bash
/Users/wang/.deno/bin/deno check supabase/functions/compat/title-resolver.ts supabase/functions/compat/test/title-resolver.test.ts
```

Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add supabase/functions/compat/title-resolver.ts supabase/functions/compat/test/title-resolver.test.ts
git commit -m "feat(I10): SSRF 地址判定与主机校验

- IPv4/IPv6 解析，禁止网段按设计稿 §7.2
- 映射/NAT64/6to4/Teredo 抽出内嵌 IPv4 再判
- 认不出来的地址 fail closed
- 主机校验：所有解析结果都要过，任一落内网整体拒绝

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 抓取主流程（fetch / 重定向 / 超时 / 流式读取）+ 单测

**Files:**
- Modify: `supabase/functions/compat/title-resolver.ts`（追加抓取主流程）
- Modify: `supabase/functions/compat/test/title-resolver.test.ts`（追加抓取用例）

**Interfaces:**
- Consumes: Task 2 的纯函数、Task 3 的 `assertPublicHost` / `defaultResolveDns` / 内部类 `ResolveError`（Task 3 里定义，Task 4 直接用）
- Produces:
  - `type TitleResolverDeps = { fetchImpl?: typeof fetch; resolveDns?: ResolveDns; timeoutMs?: number; maxRedirects?: number; log?: (message: string) => void }`
  - `resolveTitle(rawUrl: string, deps?: TitleResolverDeps): Promise<string | null>` —— 失败时**通过 `deps.log` 上报「原因码 + host」**，绝不把完整 URL 交给调用方

- [ ] **Step 1: 写失败测试**

在 `supabase/functions/compat/test/title-resolver.test.ts` 末尾追加（并把 `resolveTitle`、`CHROME_USER_AGENT`、`MAX_REDIRECTS` 加进顶部 import）：

```ts
// --- 抓取主流程 -----------------------------------------------------------

import { CHROME_USER_AGENT, MAX_REDIRECTS, resolveTitle } from '../title-resolver.ts';

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

const PUBLIC_DNS: ResolveDns = async () => ['93.184.216.34'];

Deno.test('抓取：正常页面取到标题', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => htmlResponse('<html><head><title>Example Domain</title></head></html>'),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, 'Example Domain');
});

Deno.test('抓取：请求带 Chrome UA 且 redirect=manual', async () => {
  let seen: RequestInit | undefined;
  await resolveTitle('https://example.com/a', {
    fetchImpl: async (_url, init) => {
      seen = init;
      return htmlResponse('<title>X</title>');
    },
    resolveDns: PUBLIC_DNS,
  });
  const headers = seen?.headers as Record<string, string>;
  assertEquals(headers['user-agent'], CHROME_USER_AGENT);
  assertEquals(seen?.redirect, 'manual');
});

Deno.test('抓取：实体解码后再入库', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => htmlResponse('<title>A &amp; B</title>'),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, 'A & B');
});

Deno.test('抓取：超长标题截断到 512', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => htmlResponse(`<title>${'x'.repeat(600)}</title>`),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title?.length, 512);
});

Deno.test('抓取：非 text/html → 无标题', async () => {
  const title = await resolveTitle('https://example.com/a.json', {
    fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
});

Deno.test('抓取：没有 charset 且没有 meta charset → 丢弃标题（上游行为）', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () =>
      new Response('<title>X</title>', { headers: { 'content-type': 'text/html' } }),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
});

Deno.test('抓取：meta charset 能救回来', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () =>
      new Response('<meta charset="utf-8"><title>X</title>', { headers: { 'content-type': 'text/html' } }),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, 'X');
});

Deno.test('抓取：跟随重定向到公网', async () => {
  const calls: string[] = [];
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://example.com/b' } });
      }
      return htmlResponse('<title>Redirected</title>');
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, 'Redirected');
  assertEquals(calls.length, 2);
});

Deno.test('抓取：重定向到内网 → 拒绝', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
});

Deno.test('抓取：重定向超过 15 跳 → 放弃', async () => {
  let n = 0;
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => {
      n++;
      return new Response(null, { status: 302, headers: { location: `https://example.com/${n}` } });
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
  assertEquals(n, MAX_REDIRECTS + 1);
});

Deno.test('抓取：直接指向内网 IP → 拒绝且不发请求', async () => {
  let fetched = 0;
  const title = await resolveTitle('http://169.254.169.254/latest/', {
    fetchImpl: async () => {
      fetched++;
      return htmlResponse('<title>secret</title>');
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
  assertEquals(fetched, 0);
});

Deno.test('抓取：域名解析到内网 → 拒绝且不发请求', async () => {
  let fetched = 0;
  const title = await resolveTitle('https://evil.example.com/', {
    fetchImpl: async () => {
      fetched++;
      return htmlResponse('<title>x</title>');
    },
    resolveDns: async () => ['10.0.0.5'],
  });
  assertEquals(title, null);
  assertEquals(fetched, 0);
});

Deno.test('抓取：非 http(s) 协议 → 拒绝', async () => {
  let fetched = 0;
  const title = await resolveTitle('file:///etc/passwd', {
    fetchImpl: async () => {
      fetched++;
      return htmlResponse('<title>x</title>');
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
  assertEquals(fetched, 0);
});

Deno.test('抓取：带凭据的 URL → 拒绝', async () => {
  let fetched = 0;
  const title = await resolveTitle('https://user:pass@example.com/', {
    fetchImpl: async () => {
      fetched++;
      return htmlResponse('<title>x</title>');
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
  assertEquals(fetched, 0);
});

Deno.test('抓取：网络异常 → 无标题（降级不抛）', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => {
      throw new Error('network down');
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
});

Deno.test('抓取：超时 → 无标题', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    resolveDns: PUBLIC_DNS,
    timeoutMs: 50,
  });
  assertEquals(title, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/title-resolver.test.ts
```

Expected: FAIL —— 报 `does not provide an export named 'resolveTitle'`。

- [ ] **Step 3: 写实现**

在 `supabase/functions/compat/title-resolver.ts` 末尾追加：

```ts
// ---------------------------------------------------------------------------
// 抓取主流程
// ---------------------------------------------------------------------------

export type TitleResolverDeps = {
  fetchImpl?: typeof fetch;
  resolveDns?: ResolveDns;
  timeoutMs?: number;
  maxRedirects?: number;
  // 失败原因回调：只应收到「原因码 + host」，绝不能收到完整 URL
  log?: (message: string) => void;
};

function parseTargetUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ResolveError('unsupported_scheme');
  }
  if (url.username || url.password) throw new ResolveError('credentials_in_url');
  if (!url.hostname) throw new ResolveError('missing_host');
  return url;
}

// 日志里只允许出现 host（不含 query、不含凭据）
function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname || '(empty)';
  } catch {
    return '(invalid)';
  }
}

// latin1 是 1 字节 1 字符的映射 → 字符下标 == 字节下标，方便按字节切标题
const LATIN1 = new TextDecoder('latin1');

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

type Collected = { bytes: Uint8Array; text: string; charset: string | null };

async function collectBody(res: Response, contentType: string, cap: number): Promise<Collected> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), text: '', charset: null };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let text = '';
  let charset = charsetFromContentType(contentType);
  try {
    for (;;) {
      // 标题与 charset 都拿到就可以停（对齐上游 STREAM：读到 </title> 即止）
      if (findTitleSpan(text) && charset) break;
      if (total >= cap) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      chunks.push(value);
      total += value.length;
      text = LATIN1.decode(concatBytes(chunks, total));
      if (!charset) charset = charsetFromMeta(text);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 已经读完时 cancel 会抛，忽略
    }
  }
  return { bytes: concatBytes(chunks, total), text, charset };
}

async function readTitleFromResponse(res: Response): Promise<string> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('text/html')) throw new ResolveError('not_html');
  const collected = await collectBody(res, contentType, MAX_BODY_BYTES);
  const span = findTitleSpan(collected.text);
  if (!span) throw new ResolveError('no_title');
  const charset = collected.charset;
  if (!charset) throw new ResolveError('no_charset'); // 认不出 charset → 丢弃（上游同）
  const raw = decodeWithCharset(collected.bytes.slice(span.start, span.end), charset);
  if (!raw) throw new ResolveError('unknown_charset');
  return truncateTitle(decodeHtmlEntities(phpTrim(raw)));
}

export async function resolveTitle(rawUrl: string, deps: TitleResolverDeps = {}): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const resolveDns = deps.resolveDns ?? defaultResolveDns;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  const log = deps.log ?? (() => {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const host = safeHost(rawUrl);
  try {
    let url = parseTargetUrl(rawUrl);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // 每一跳都要重新校验（含重定向目标）
      await assertPublicHost(url.hostname, resolveDns);
      const res = await fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': CHROME_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === maxRedirects) throw new ResolveError('redirect_limit');
        url = parseTargetUrl(new URL(location, url).toString());
        continue;
      }
      return await readTitleFromResponse(res);
    }
    throw new ResolveError('redirect_limit');
  } catch (err) {
    const code = err instanceof ResolveError
      ? err.code
      : (controller.signal.aborted ? 'timeout' : 'request_failed');
    // 只记原因码 + host：绝不记完整 URL（长链 query 可能带 token）
    log(`title-resolve failed code=${code} host=${host}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/title-resolver.test.ts
```

Expected: 全部 PASS（53 + 15 = 68 例）。

- [ ] **Step 5: 类型检查**

```bash
/Users/wang/.deno/bin/deno check supabase/functions/compat/title-resolver.ts supabase/functions/compat/test/title-resolver.test.ts
```

Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add supabase/functions/compat/title-resolver.ts supabase/functions/compat/test/title-resolver.test.ts
git commit -m "feat(I10): 抓取主流程（fetch/重定向/超时/流式读取）

- 总超时 3s（一个 AbortController 覆盖整条重定向链）
- 手动跟随重定向最多 15 跳，每跳重新做 SSRF 校验
- 只接受 text/html；流式读取，标题与 charset 都拿到就停
- 任何失败一律降级为 null，不抛给调用方

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 兼容层编排 —— 建链/编辑接线 + 集成测试

**Files:**
- Modify: `supabase/functions/compat/handler.ts`
- Modify: `supabase/functions/compat/test/compat.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `resolveTitle(url, deps)` 与 `TitleResolverDeps`
- Produces:
  - `handler.ts` 导出 `titleResolverDeps: TitleResolverDeps`（测试注入用，生产留空）
  - `create_short_url` RPC 新增参数 `p_title_was_auto_resolved`（Task 1 已建）
  - `update_short_url` RPC 新增参数 `p_auto_title`（Task 1 已建）

- [ ] **Step 1: 改测试的 fetch mock（按 URL 分流）**

在 `supabase/functions/compat/test/compat.test.ts` 中，把原来的全局 fetch mock（第 18–31 行）替换成下面这版 —— **R10 的标题抓取走真实 HTTP，不能被 RPC mock 吞掉**：

```ts
// 外部（非 /rpc/）请求的桩：R10 的标题抓取会走这里
let externalImpl: (url: string, init?: RequestInit) => Promise<Response> =
  () => Promise.reject(new Error('unexpected external request'));

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  // R10：按 URL 分流，抓取请求不能被 RPC mock 吞掉
  if (!url.includes('/rpc/')) return externalImpl(url, init);
  const fn = url.slice(url.lastIndexOf('/rpc/') + '/rpc/'.length);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ fn, body });
  const reply = rpcImpl(fn, body);
  const payload = reply.ok ? reply.body : { code: reply.code, message: reply.message };
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status: reply.ok ? 200 : reply.status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}) as typeof fetch;
```

把 import 改成：

```ts
const { handleRequest, titleResolverDeps } = await import('../handler.ts');
```

在 `reset()` 函数**开头**加上两行（避免既有建链用例意外发起外部请求，也让每个用例从干净状态开始）：

```ts
  // R10：默认关掉自动解析，既有用例不受影响；R10 用例自己打开
  Deno.env.set('AUTO_RESOLVE_TITLES', 'false');
  externalImpl = () => Promise.reject(new Error('unexpected external request'));
```

再在文件末尾追加 R10 的辅助与用例：

```ts
// ---------------------------------------------------------------------------
// R10：标题自动解析
// ---------------------------------------------------------------------------

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

// 把抓取依赖换掉：假 DNS + 假 fetch，绝不碰真网
function setupTitleFetch(body: string, addresses: string[] = ['93.184.216.34']) {
  titleResolverDeps.resolveDns = async () => addresses;
  externalImpl = async () => htmlResponse(body);
}

function createCall() {
  return calls.find((c) => c.fn === 'create_short_url');
}

function updateCall() {
  return calls.find((c) => c.fn === 'update_short_url');
}

Deno.test('R10：默认（未设环境变量）→ 建链不带 title 时抓标题并标自动解析', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES'); // 未设置 = 默认开
  setupTitleFetch('<html><head><title>Fetched Title</title></head></html>');

  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/x' }),
  });

  assertEquals(res.status, 200);
  assertEquals(createCall()?.body.p_title, 'Fetched Title');
  assertEquals(createCall()?.body.p_title_was_auto_resolved, true);
});

Deno.test('R10：建链带 title → 不抓，来源 false', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  setupTitleFetch('<title>Should Not Be Used</title>');

  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/x', title: 'Manual Title' }),
  });

  assertEquals(res.status, 200);
  assertEquals(createCall()?.body.p_title, 'Manual Title');
  assertEquals(createCall()?.body.p_title_was_auto_resolved, false);
});

Deno.test('R10：建链抓不到 → title 为空、来源 false、建链仍成功', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  externalImpl = async () => Promise.reject(new Error('network down'));

  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/x' }),
  });

  assertEquals(res.status, 200);
  assertEquals(createCall()?.body.p_title, null);
  assertEquals(createCall()?.body.p_title_was_auto_resolved, false);
});

Deno.test('R10：AUTO_RESOLVE_TITLES=false → 完全不抓', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.set('AUTO_RESOLVE_TITLES', 'false');
  setupTitleFetch('<title>Should Not Be Used</title>');

  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/x' }),
  });

  assertEquals(res.status, 200);
  assertEquals(createCall()?.body.p_title, null);
  assertEquals(createCall()?.body.p_title_was_auto_resolved, false);
});

Deno.test('R10：编辑带 title → 不抓，p_auto_title 为 null', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'update_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  setupTitleFetch('<title>Should Not Be Used</title>');

  const res = await req('/short-urls/abc12', {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/y', title: 'Manual' }),
  });

  assertEquals(res.status, 200);
  assertEquals(updateCall()?.body.p_auto_title, null);
  assertEquals((updateCall()?.body.p_patch as Record<string, unknown>).title, 'Manual');
});

Deno.test('R10：编辑改 longUrl → 抓到的标题走 p_auto_title，且不进 patch', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'update_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  setupTitleFetch('<title>Refreshed</title>');

  const res = await req('/short-urls/abc12', {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/y' }),
  });

  assertEquals(res.status, 200);
  assertEquals(updateCall()?.body.p_auto_title, 'Refreshed');
  const patch = updateCall()?.body.p_patch as Record<string, unknown>;
  assertEquals(patch.title, undefined);
});

Deno.test('R10：编辑抓不到 → p_auto_title 为 null', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'update_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  externalImpl = async () => Promise.reject(new Error('network down'));

  const res = await req('/short-urls/abc12', {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/y' }),
  });

  assertEquals(res.status, 200);
  assertEquals(updateCall()?.body.p_auto_title, null);
});

Deno.test('R10：编辑既不改 longUrl 也不给 title → 不抓', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'update_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  setupTitleFetch('<title>Should Not Be Used</title>');

  const res = await req('/short-urls/abc12', {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ crawlable: true }),
  });

  assertEquals(res.status, 200);
  assertEquals(updateCall()?.body.p_auto_title, null);
});

Deno.test('R10：抓取失败只记原因码 + host，不记完整 URL', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  const logs: string[] = [];
  titleResolverDeps.log = (m: string) => logs.push(m);
  // 解析到内网 → 被 SSRF 拦截
  titleResolverDeps.resolveDns = async () => ['10.0.0.5'];
  externalImpl = async () => htmlResponse('<title>x</title>');

  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/x?token=secret' }),
  });

  assertEquals(res.status, 200);
  assertEquals(createCall()?.body.p_title, null);
  assert(logs.length > 0, '应该记录了失败原因');
  assert(logs[0]!.includes('code=blocked_address'), `原因码不对：${logs[0]}`);
  assert(logs[0]!.includes('host=example.com'), `host 不对：${logs[0]}`);
  // 关键：不能出现完整 URL（query 里可能有 token）
  assert(!logs[0]!.includes('token=secret'), `日志里泄露了完整 URL：${logs[0]}`);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/compat.test.ts
```

Expected: FAIL —— 报 `Module ... does not provide an export named 'titleResolverDeps'`（`handler.ts` 还没导出它）。

- [ ] **Step 3: 实现 handler 接线**

在 `supabase/functions/compat/handler.ts` 顶部 import 区加上：

```ts
import { resolveTitle, type TitleResolverDeps } from './title-resolver.ts';
```

在常量区（`VERSION` 那一行附近）加上：

```ts
// R10：测试可注入假的 fetch / DNS 解析器；生产留空（走默认实现）
export const titleResolverDeps: TitleResolverDeps = {};
```

在 `str()` 之后加上开关判定：

```ts
// R10：环境变量 AUTO_RESOLVE_TITLES 关闭自动解析；未设置 = 开启
function autoResolveTitlesEnabled(): boolean {
  const raw = Deno.env.get('AUTO_RESOLVE_TITLES');
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

// R10：抓取失败只记「原因码 + host」，绝不记完整 URL（长链 query 可能带 token）
function logTitleResolve(message: string): void {
  if (titleResolverDeps.log) {
    titleResolverDeps.log(message);
    return;
  }
  console.log(message);
}
```

把 `createShortUrl` 整体替换为：

```ts
async function createShortUrl(body: Json, keyId: number): Promise<Json> {
  const longUrl = str(body.longUrl);
  if (!longUrl) throw new ApiError(400, 'invalid-data', 'longUrl is required');

  // R10：上游 ShortUrlCreation::hasTitle() = title !== null
  //      → 未提供标题才抓；抓到的标题标成「自动解析」
  const userProvidedTitle = body.title !== undefined && body.title !== null;
  let title = userProvidedTitle ? str(body.title) : null;
  let titleWasAutoResolved = false;
  if (!userProvidedTitle && autoResolveTitlesEnabled()) {
    const resolved = await resolveTitle(longUrl, { ...titleResolverDeps, log: logTitleResolve });
    if (resolved) {
      title = resolved;
      titleWasAutoResolved = true;
    }
  }

  try {
    return (await rpc('create_short_url', {
      p_long_url: longUrl,
      p_domain: str(body.domain),
      p_custom_slug: str(body.customSlug),
      p_title: title,
      p_title_was_auto_resolved: titleWasAutoResolved,
      p_tags: Array.isArray(body.tags) ? body.tags : null,
      p_crawlable: body.crawlable === true,
      p_forward_query: body.forwardQuery !== false,
      p_valid_since: str(body.validSince),
      p_valid_until: str(body.validUntil),
      p_max_visits: typeof body.maxVisits === 'number' ? body.maxVisits : null,
      p_short_code_length: typeof body.shortCodeLength === 'number' ? body.shortCodeLength : 5,
      p_find_if_exists: body.findIfExists === true,
      p_author_api_key_id: keyId,
    })) as Json;
  } catch (err) {
    // 控制台直接把 detail 显示给用户，别把 SQL 的 snake_case 错误码原样抛出去
    if (err instanceof ApiError && err.type === 'non-unique-slug') {
      throw new ApiError(409, 'non-unique-slug', `Custom slug "${body.customSlug}" is already in use`);
    }
    throw err;
  }
}
```

把 `updateShortUrl` 整体替换为：

```ts
async function updateShortUrl(code: string, domain: string | null, body: Json): Promise<Json> {
  // R10：上游 ShortUrlService 只在 longUrl !== null 时才触发标题解析；
  //      用户显式给了 title 就不抓（手填优先）。
  //      抓到的自动标题走独立参数 p_auto_title，绝不能塞进 p_patch
  //      —— p_patch 里有 title 键即代表「用户手填」，两者必须可区分。
  const patch: Json = { ...body };
  const userProvidedTitle = 'title' in patch;
  const longUrl = typeof patch.longUrl === 'string' ? patch.longUrl : null;
  let autoTitle: string | null = null;
  if (!userProvidedTitle && longUrl && autoResolveTitlesEnabled()) {
    const resolved = await resolveTitle(longUrl, { ...titleResolverDeps, log: logTitleResolve });
    if (resolved) autoTitle = resolved;
  }
  return (await rpc('update_short_url', {
    p_code: code,
    p_domain: domain,
    p_patch: patch,
    p_auto_title: autoTitle,
  })) as Json;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/compat.test.ts supabase/functions/compat/test/title-resolver.test.ts
```

Expected: 全部 PASS（既有 35 例 + R10 8 例 + 68 例 = 111 例）。**既有 35 例一个都不能回归**。

- [ ] **Step 5: 类型检查**

```bash
/Users/wang/.deno/bin/deno check supabase/functions/compat/index.ts supabase/functions/compat/handler.ts supabase/functions/compat/title-resolver.ts supabase/functions/compat/test/compat.test.ts supabase/functions/compat/test/title-resolver.test.ts
```

Expected: 无输出。

- [ ] **Step 6: 构建兼容层并确认产物包含新模块**

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
/Users/wang/.nvm/versions/node/v24.14.0/bin/node scripts/build-compat-function.mjs
grep -c "resolveTitle" supabase/functions/compat/dist/index.ts
```

Expected: 输出一个大于 0 的数字（产物里含新逻辑）。

- [ ] **Step 7: 提交**

```bash
git add supabase/functions/compat/handler.ts supabase/functions/compat/test/compat.test.ts
git commit -m "feat(I10): 兼容层接线 —— 建链/编辑的标题自动解析

- 建链：未填标题才抓，来源标 true
- 编辑：用户给 title 优先；改 longUrl 时抓到的标题走 p_auto_title（不进 patch）
- AUTO_RESOLVE_TITLES 环境变量开关，未设置 = 开启
- 测试的 fetch mock 按 URL 分流，RPC 与外部请求不再互相吞掉

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 部署、线上验收与文档归档

**Files:**
- Create: `docs/verification/r10-results.md`
- Modify: `docs/runbook.md`、`docs/iteration-plan.md`、`docs/shlink-feature-checklist.md`

**Interfaces:**
- Consumes: Task 1 的迁移、Task 5 的兼容层代码
- Produces: 线上可用 + 验收归档

- [ ] **Step 1: 确认 `functions-cli` 存在（`/tmp` 会被清理）**

```bash
ls -l /tmp/functions-cli 2>/dev/null || (
  cd /tmp && curl -fsSL -o functions-cli "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260319/wjjgdp/functions-cli-darwin-arm64-2026-03-17" && chmod +x functions-cli
)
ls -l /tmp/functions-cli
```

Expected: 文件存在且可执行。

- [ ] **Step 2: 部署兼容层**

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
set -a; source supabase/functions/.env; set +a
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat \
  -d /Users/wang/Documents/work/ranxin/code/rxlink/supabase/functions/compat/dist --no-verify-jwt
```

Expected: 部署成功。**平台偶发 500 `Failed to deploy Deno function` → 重试即成功**。

- [ ] **Step 3: 线上验收 —— 建链自动抓标题**

先建一个临时 api_key（明文只打印一次，用完必须删）：

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
set -a; source supabase/functions/.env; set +a
./scripts/new-api-key.sh r10-verify --expires-at 2026-12-31T23:59:59Z
```

把输出的明文 key 存进环境变量（**不要回显**）：

```bash
RXL_KEY="$(cat /tmp/rxl-api-key.txt)"
```

建链（**不传 title**）：

```bash
curl -sS -X POST "https://your-project-ref.supabase.co/functions/v1/compat/rest/v3/short-urls" \
  -H "X-Api-Key: $RXL_KEY" -H 'Content-Type: application/json' \
  -d '{"longUrl":"https://example.com/"}'
```

Expected: 返回 JSON 里 `title` 为 `example.com`（example.com 的标题就是 "Example Domain"，以实际返回为准），且短链已落库。

用 SQL 核对来源标志：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select short_code, long_url, title, title_was_auto_resolved from short_url where long_url = 'https://example.com/' order by id desc limit 3"
```

Expected: `title` 非空、`title_was_auto_resolved = t`。

- [ ] **Step 4: 线上验收 —— SSRF 拦截（关键）**

```bash
curl -sS -X POST "https://your-project-ref.supabase.co/functions/v1/compat/rest/v3/short-urls" \
  -H "X-Api-Key: $RXL_KEY" -H 'Content-Type: application/json' \
  -d '{"longUrl":"http://169.254.169.254/latest/meta-data/"}'
```

Expected: **建链成功**（HTTP 200），返回的短链 **没有 title**（title 为 null 或空）。

再验证解析到内网的域名也被拒：

```bash
curl -sS -X POST "https://your-project-ref.supabase.co/functions/v1/compat/rest/v3/short-urls" \
  -H "X-Api-Key: $RXL_KEY" -H 'Content-Type: 'application/json' \
  -d '{"longUrl":"http://localhost:5432/"}'
```

Expected: 建链成功、**没有 title**。

- [ ] **Step 5: 线上验收 —— 编辑刷新 / 手填粘性**

拿到 Step 3 建的短链 code 后：

```bash
# 改长链 → 标题应被刷新
curl -sS -X PATCH "https://your-project-ref.supabase.co/functions/v1/compat/rest/v3/short-urls/$CODE" \
  -H "X-Api-Key: $RXL_KEY" -H 'Content-Type: application/json' \
  -d '{"longUrl":"https://www.iana.org/domains/reserved"}'

# 手填标题 → 改长链不再被覆盖
curl -sS -X PATCH "https://your-project-ref.supabase.co/functions/v1/compat/rest/v3/short-urls/$CODE" \
  -H "X-Api-Key: $RXL_KEY" -H 'Content-Type: application/json' \
  -d '{"title":"手填的标题"}'

curl -sS -X PATCH "https://your-project-ref.supabase.co/functions/v1/compat/rest/v3/short-urls/$CODE" \
  -H "X-Api-Key: $RXL_KEY" -H 'Content-Type: application/json' \
  -d '{"longUrl":"https://example.org/"}'
```

Expected:
- 第一次 PATCH 后标题变成新页面的标题，来源仍是 `t`
- 手填后来源变成 `f`
- 再改长链 → **标题仍是「手填的标题」**（手填粘性）

用 SQL 核对：

```bash
supabase db query --db-url "$SUPABASE_DB_URL" "select short_code, long_url, title, title_was_auto_resolved from short_url where short_code = '$CODE'"
```

- [ ] **Step 6: 线上验收 —— 开关关闭**

```bash
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli secrets set AUTO_RESOLVE_TITLES false
```

再发一次不带 title 的建链请求 → Expected: 建链成功、**没有 title**。

恢复默认（**必须还原**）：

```bash
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli secrets unset AUTO_RESOLVE_TITLES
```

> 若 `unset` 子命令不存在，用 `secrets list` 确认后 `secrets set` 一个空值；总之验收结束后必须保证开关处于「默认开」。

- [ ] **Step 7: 线上验收 —— 延迟实测**

```bash
for i in 1 2 3 4 5; do
  curl -sS -o /dev/null -w '%{time_total}\n' -X POST "https://your-project-ref.supabase.co/functions/v1/compat/rest/v3/short-urls" \
    -H "X-Api-Key: $RXL_KEY" -H 'Content-Type: application/json' \
    -d '{"longUrl":"https://example.com/"}'
done
```

Expected: 单次建链总耗时在 3s 以内（抓取超时上限 3s）；记录 p50 / p95 写进验收文档。

- [ ] **Step 8: 清理线上测试数据与临时 key**

```bash
# 删测试短链
supabase db query --db-url "$SUPABASE_DB_URL" "delete from short_url where long_url in ('https://example.com/','http://169.254.169.254/latest/meta-data/','http://localhost:5432/','https://www.iana.org/domains/reserved','https://example.org/')"
# 删临时 api_key
supabase db query --db-url "$SUPABASE_DB_URL" "delete from api_key where name = 'r10-verify'"
rm -f /tmp/rxl-api-key.txt
supabase db query --db-url "$SUPABASE_DB_URL" "select count(*) from api_key"
```

Expected: api_key 数量回到验收前的值（应为 2：`console` / `console-2`）。

- [ ] **Step 9: 写验收文档**

`docs/verification/r10-results.md` 全文（把 Step 3–7 的**真实输出**填进去）：

```markdown
# I10 / R10 标题自动解析 —— 验收记录

> 日期：2026-11-12
> 范围：建链自动抓标题、编辑刷新自动解析的标题、手填标题粘性、SSRF 拦截、开关降级。
> 设计稿：`docs/superpowers/specs/2026-11-12-r10-title-auto-resolve-design.md`
> 计划：`docs/superpowers/plans/2026-11-12-r10-title-auto-resolve.md`

## 1. 迁移 0020

- 列：`short_url.title_was_auto_resolved boolean not null default false`
- `create_short_url` 13→14 参；`update_short_url` 3→4 参
- 权限：`anon` 对两个函数 `execute` 均为 false，`service_role` 为 true
- 兼容性：旧调用点（13 参 / 3 参）在迁移后仍能解析到新函数

## 2. 本机测试

| 套件 | 用例数 | 结果 |
|---|---|---|
| `title-resolver.test.ts` | 68 | 全绿 |
| `compat.test.ts` | 43（既有 35 + R10 8） | 全绿 |

`deno check` 干净。

## 3. 线上验收

### 3.1 建链自动抓标题
（贴真实响应）

### 3.2 SSRF 拦截
（贴真实响应）

### 3.3 编辑刷新 / 手填粘性
（贴真实 SQL 结果）

### 3.4 开关关闭
（贴真实响应）

### 3.5 延迟
（贴 p50 / p95）

## 4. 已知限制与遗留

1. **DNS rebinding 残余风险**：校验用的解析结果与 `fetch` 实际连接用的解析结果可能不同（Deno `fetch` 内部二次解析，无法指定已解析 IP）。彻底消除需手写 pinned transport（`Deno.connect` + `Deno.startTls` + 手写 HTTP/1.1 与 chunked/gzip/br 解码），约 300 行，本次不做。
2. `findIfExists` 命中时会白抓一次（上游先查复用再决定抓不抓）。
3. 显式空标题归一为 `null`（上游存 `''`）。
4. 实体解码是 HTML401 核心集的近似实现，非 100% 逐条一致。
5. 若 Edge Function 实测无法出公网 → 退路是把抓取逻辑整体挪到 FC 函数（`fc/geo-enrich` 的 FC 双网已实测可行），DB 侧设计不受影响。
```

- [ ] **Step 10: 更新 `docs/runbook.md`**

在 `docs/runbook.md` 的数据库迁移小节后面新增一段：

```markdown
### 5.6 标题自动解析（I10 / R10）

建链时若**未填标题**，兼容层会自动抓目标页 `<title>` 写进 `short_url.title`。

| 项 | 值 |
|---|---|
| 开关 | 环境变量 `AUTO_RESOLVE_TITLES`（未设置 = 开启；`false`/`0`/`off`/`no` = 关闭） |
| 超时 | 3s（整条重定向链共用一个 3s 预算） |
| 重定向 | 最多 15 跳，每跳重新做 SSRF 校验 |
| 来源列 | `short_url.title_was_auto_resolved`（true = 自动抓的，false = 手填） |
| 降级 | 抓不到 / 被 SSRF 拦截 / 非 text/html / charset 认不出 → **一律留空，不报错** |

```bash
# 关闭自动解析（出网异常时止血）
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli secrets set AUTO_RESOLVE_TITLES false
# 恢复默认
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli secrets unset AUTO_RESOLVE_TITLES
```

**排查**：

- 建链没有标题 → 先看目标页是不是 `text/html`、有没有声明 charset（认不出 charset 会**故意丢弃**标题，防乱码入库）
- 目标页在内网地址 → 会被 SSRF 拦截（这是预期行为）
- 想看抓取失败的原因 → 兼容层日志里有原因码 + host，**没有完整 URL**（长链 query 可能带 token）
```

- [ ] **Step 11: 更新 `docs/iteration-plan.md` 与 `docs/shlink-feature-checklist.md`**

`docs/iteration-plan.md`：新增 I10 章节（目标 / 关键决策 / 完成情况）、B10 清单（全勾）、C 表补一行、变更记录追加一条。

`docs/shlink-feature-checklist.md`：改 **第 16 行**（`| 3 | \`createShortUrl\` | POST \`/short-urls\` | ✅ | …`）的备注列，把结尾改成：

```
自定义 slug、短码长度、findIfExists、标签、标题、crawlable、forwardQuery、有效期、maxVisits、**未填标题时自动抓目标页 `<title>`（env `AUTO_RESOLVE_TITLES` 控制，我们默认开；上游默认关）**
```

同时在 checklist 末尾的统计行里把 ✅ 数量 +1（改前先看该行原文，按实际数字改，别凭空写）。

- [ ] **Step 12: 提交**

```bash
git add docs/verification/r10-results.md docs/runbook.md docs/iteration-plan.md docs/shlink-feature-checklist.md
git commit -m "docs(I10): R10 标题自动解析验收与文档归档

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 13: 最终回归**

```bash
cd /Users/wang/Documents/work/ranxin/code/rxlink
/Users/wang/.deno/bin/deno test --allow-env supabase/functions/compat/test/compat.test.ts supabase/functions/compat/test/title-resolver.test.ts
/Users/wang/.deno/bin/deno check supabase/functions/compat/index.ts supabase/functions/compat/handler.ts supabase/functions/compat/title-resolver.ts supabase/functions/compat/test/compat.test.ts supabase/functions/compat/test/title-resolver.test.ts
git status --short
git log --oneline -8
```

Expected: 测试全绿、`deno check` 干净、工作区干净。

线上回归（既有行为不能变）：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://example.com/robots.txt"
curl -sS -o /dev/null -w '%{http_code}\n' "https://example.com/2b9yj/track?src=wechat"
```

Expected: `robots.txt` 200、像素路由 200。

---

## 附录 A：任务依赖图

```
Task 1 迁移 0020（独立，可与 Task 2/3/4 并行）
   │
   └──────────────► Task 6 部署验收（需要 Task 1 的 RPC + Task 5 的代码）

Task 2 纯逻辑
   └─► Task 3 SSRF
          └─► Task 4 抓取主流程
                 └─► Task 5 兼容层接线
                        └─► Task 6 部署验收
```

## 附录 B：与设计稿的差异

- 设计稿 §13 列的是 T1–T5 五个任务；本计划把原 T3「抓取与 SSRF」拆成 **Task 3（SSRF 判定）** 与 **Task 4（抓取主流程）**，因为二者的评审边界不同（一个是纯函数判定，一个是 I/O 流程）。设计稿 §13 的任务表需同步更新为 6 个任务。
