# rxlink 运维 Runbook

> 面向没参与过开发的人。目标：照着能加域名、能回滚、能定位三类常见故障。
> 凭据一律只写**变量名**，值在 `supabase/functions/.env`（gitignore）与 FC 函数环境变量里，由负责人本人填写，不进文档/聊天。
> 库操作通道：`supabase db query --db-url "$SUPABASE_DB_URL" -o table "<单条 SQL>"`（平台一次只认一条语句；`numeric`/`void` 要 `::text` 或包一层）。CLI 需 Node ≥20（本机 `nvm use 24`）。

## 1. 拓扑与组件

| 层 | 组件 | 地址 / 标识 | 代码 |
|---|---|---|---|
| 跳转热路径 | FC Web 函数（Node 20） | 自定义域名 `example.com`（已配证书 + 强制 HTTPS），路由 `/*` | `fc/redirect/index.js` + `cache.js` + `ipmat.js` + `rules.js` + `rules-cache.js` + `china-geo.js`（+ 构建产物 `china-geo.bin`） |
| 数据面 | ADB PostgreSQL Supabase | API host `https://your-project-ref.supabase.co`；FC 走 **VPC 内网地址** | `supabase/migrations/` |
| 兼容层 | Supabase Edge Function `compat` | `…/functions/v1/compat/rest/v3/*`（shlink 契约） | `supabase/functions/compat/index.ts` |
| 控制台 | FC Web 函数 `console-prod` | `https://console.example.com`（已配证书 + 强制 HTTPS） | `shlink-web-client/` build → `fc/console/index.js` |
| 落库 | cron `rxlink-drain`（job 6，每分钟） | `drain_visit_inbox(500)`（`0014` 起落库后即清空入队侧原始 IP） | `0005` / `0012` / `0014` |
| 死链清理 | cron `rxlink-prune`（job 8，每天 19:00） | `prune_dead_links(180, false)`（真实执行） | `0005` |
| IP 兜底清理 | cron `rxlink-retire-ip`（job 9，每小时） | `retire_remote_addr(7)`（7 天硬留存上限） | `0012` |
| 地理富化 | FC 事件函数 `geo-enrich`（**已部署**） | 请求处理程序 `index.handler`；定时触发器**每小时**（cron 6 字段：`0 0 * * * *`）；mmdb 在 Layer `/opt/geoip/` | `fc/geo-enrich/`（数据源 DB-IP City Lite） |

关键表：`short_url`、`domain`（id 0 = 默认域名 `example.com`）、`visit_inbox`（UNLOGGED 热路径入队）、`visit`（按月分区明细）、`short_url_visits_counts`、`link_version`（单行 seq，主快照失效依据）、`rules_version`（单行 seq，**跳转规则**失效依据，与 link_version 互不干扰）、`short_url_redirect_rule` + `redirect_condition`（规则与条件）、`api_key`（只存 sha256）。

## 2. 连接与凭据（只列变量名）

- `supabase/functions/.env`：`SUPABASE_URL`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_API_URL`。
- 跳转 FC 函数环境变量：`SUPABASE_URL`（**VPC 内网连接地址**，不是公网 host）、`SUPABASE_SERVICE_ROLE_KEY`。
- 兼容层鉴权：控制台请求带 `X-Api-Key`，函数算 sha256 后比对 `api_key.key_hash`；明文不落库。
- 安全红线：任何函数**不回显、不记录请求头**（含 `x-fc-access-key-*`、service role key）；`Location` 只取库里 `long_url`，请求不参与拼接。

## 3. 日常运维查询

### 3.1 一条健康查询（积压 + drain 存活 + seq）

```sql
select
  (select count(*) from visit_inbox where processed_at is null)::text as inbox_pending,
  (select coalesce(max(extract(epoch from (now()-occurred_at)))::int,0)
     from visit_inbox where processed_at is null)::text as inbox_oldest_sec,
  (select coalesce(extract(epoch from (now()-max(start_time)))::int,-1)
     from cron.job_run_details where jobid=6 and status='succeeded')::text as drain_last_success_sec,
  (select seq from link_version where id=1)::text as link_seq,
  (select seq from rules_version where id=1)::text as rules_seq;
```

告警阈值（建议）：
- `inbox_oldest_sec > 120` 或 `inbox_pending > 1000` ⇒ 落库积压，查 drain。
- `drain_last_success_sec > 180` ⇒ drain cron 停摆（正常应 < 60）。
- `link_seq` 只在写短链/停用/删除时 +1；只读流量不应让它停滞告警，停滞与否结合 `cron.job_run_details` 判断。

实测基线（2026-11-10）：`inbox_pending=0`、`inbox_oldest_sec=0`、`drain_last_success_sec≈4`、`link_seq=85`。

### 3.1b 地理富化管道（IP 短暂留存）

```sql
select
  (select count(*) from visit where remote_addr is not null)::text as ip_pending,
  (select count(*) from visit where country_code is not null)::text as enriched_total,
  (select count(*) from visit
     where remote_addr is not null
       and occurred_at < now() - interval '7 days')::text as ip_over_7d,
  (select count(*) from visit_inbox where remote_addr is not null)::text as inbox_holding_ip;
```

- `ip_pending > 0` 且持续增长 → 富化函数（#43）没跑或跑挂了；超过 7 天的部分会被 job 9 兜底清掉（数据丢失但不越权留存）。
- `ip_over_7d > 0` → job 9（`rxlink-retire-ip`）没跑，查 `cron.job_run_details` 里 jobid=9。
- `inbox_holding_ip > 0` → `drain_visit_inbox` 没跑到（job 6 每分钟一次）或函数被旧版本覆盖；正常值恒为 0（`0014` 起落库即清）。
- 跳转函数新包上传前 `ip_pending` 恒为 0（线上跑的是老版本，不带 `remote_addr`）。

### 3.2 cron 运行历史

```sql
select jobid, status, start_time::text, end_time::text
from cron.job_run_details where jobid in (6,8,9) order by start_time desc limit 10;
```

prune 每天 19:00 才跑一次；当天未到点时 job 8 无记录属正常。`status` 应为 `succeeded`。

### 3.3 手动落库 / 撤销 prune / 生成 key

```sql
-- 手动把积压 inbox 落库（返回处理行数）
select drain_visit_inbox(500);
-- 撤销某条被 prune 停用的短链（prune 是软删 enabled=false，可逆）
update short_url set enabled=true where short_code='<码>';
-- 临时停掉自动 prune / 恢复
select cron.unschedule(8);
select cron.schedule('rxlink-prune','0 19 * * *','select prune_dead_links(180, false)');
```

生成控制台 API key（明文只打印一次，库里只存 sha256）：

```bash
nvm use 24
bash scripts/new-api-key.sh <name>   # name: 字母/数字/_/-，1-40 字
bash scripts/new-api-key.sh <name> --expires-at 2027-01-01T00:00:00Z   # 可选过期时间
```

### 3.4 访问明细导出 / 单步建链（兼容层）

```bash
key='<rxl_…>'   # 只写变量名，别把明文写进文档/日志
base='https://your-project-ref.supabase.co/functions/v1/compat/rest/v3'

# R7 导出访问明细 CSV（8 列；scope 可选 non-orphan/short/tag/domain/orphan）
curl -s -H "X-Api-Key: $key" "$base/visits/export?itemsPerPage=5000" -o visits.csv
curl -s -H "X-Api-Key: $key" "$base/visits/export?scope=short&code=abcde" -o one.csv

# R4 单步建链：JSON / 纯文本 / query 鉴权（shlink 契约里的 query 例外）
curl -s -H "X-Api-Key: $key" "$base/short-urls/shorten?longUrl=https%3A%2F%2Fexample.com%2Fa"
curl -s -H "X-Api-Key: $key" "$base/short-urls/shorten?longUrl=https%3A%2F%2Fexample.com%2Fa&format=txt"
curl -s "$base/short-urls/shorten?longUrl=https%3A%2F%2Fexample.com%2Fa&apiKey=$key"
```

说明：`/short-urls/shorten` 在 shlink 契约内（控制台不调它）；`/visits/export` 是 rxlink 扩展端点，控制台 UI 没有导出按钮，用 curl / 脚本调。

## 4. 加一个新短链域名（SOP）

1. **备案**：域名主体已在阿里云接入备案（同账号同地域 cn-hangzhou 无等待期）；新主体需先备案。
2. **库内加域名行**：
   ```sql
   insert into domain (authority, scheme, is_default, icp_status)
   values ('new.example.cn', 'https', false, 'valid');
   ```
   `authority` 不带协议、必须小写；`is_default` 全局只能有一个 true（id 0 已是默认）。
3. **FC 自定义域名**：函数计算 > 域名管理 > 添加 `new.example.cn`（地域 cn-hangzhou）。
4. **证书**：为该域名绑定覆盖它的证书，开启**强制 HTTPS**（`console.example.com` 已验证此流程：HTTP 301 → HTTPS）。
5. **路由**：`/*` → 跳转函数（LATEST），与 `example.com` 指向同一个函数。
6. **复测**：`curl -i https://new.example.cn/<已有码>` 应 `302 + Location`；陌生码 404。
7. **控制台域名页**会出现新域名；其健康检查走 `https://new.example.cn/…/health`，该路径被 `/*` 兜底进跳转函数返回 404 ⇒ 红标是已知现象（`example.com` 配好证书后仍红），非故障。

## 4b. 404 回退（三类回跳）

- **行为**：跳转函数在 404 分支按 shlink 语义查 `not_found_redirects(Host)` RPC，配了就 302 回跳，没配/查询失败维持裸 404。域名级配置优先、逐列回落全局（id=0 哨兵）；配置改动**立即生效**（每次 404 现查，不走快照缓存）。
- **三类**（照 shlink `NotFoundType`）：根路径=`base_url_redirect`；路由形状不合法（多段/非法字符）=`regular404_redirect`；单段码形状但码不存在/过期=`invalid_short_url_redirect`。孤儿访问按同一口径记 `orphan_type`。
- **占位符**：`{DOMAIN}`/`{ORIGINAL_PATH}`（及 percent-encoded 写法），path 段原样替换并折叠相邻斜杠，query 段编码替换；配置不是合法 URL 时原样使用。
- **配置入口**：控制台 Domains 页可编辑；或直接 SQL：
  ```sql
  update domain set invalid_short_url_redirect='https://example.com/fb/{ORIGINAL_PATH}' where authority='example.com';
  ```
- **平台事实**：FC 自定义域名会**改写 Host 头**——用 `curl -H 'Host: 其他域名'` 打线上不会生效，验证域名级配置只能配真实域名。
- **回归**：`node --test fc/redirect/test/redirect.test.js`（11 例，真实子进程 + mock 网关）。

## 5. 部署与回滚

### 5.1 跳转函数（fc/redirect）

- 部署：把 `index.js` + `cache.js` + `ipmat.js` + `rules.js` + `rules-cache.js` + `china-geo.js` + `china-geo.bin` 打包上传到 FC 跳转函数（Web 函数，启动命令 `node index.js`，监听 `0.0.0.0:${FC_SERVER_PORT:-9000}`）。
  ```bash
  # china-geo.bin 是构建产物（gitignore），打包前必须先构建/确认存在
  ls -la fc/redirect/china-geo.bin || node scripts/build-china-geo.mjs
  cd fc/redirect && zip -r ../../dist/redirect.zip \
    index.js cache.js ipmat.js rules.js rules-cache.js china-geo.js china-geo.bin
  unzip -l ../../dist/redirect.zip   # 必须 7 个文件都在
  ```
  FC 控制台 > 函数 > 代码上传 `dist/redirect.zip` > 部署。环境变量两条见 §2；触发器**无需认证**；**最小实例数 ≥ 1**；保持 VPC 访问开启。
- 回滚：上传上一版 zip 重新部署即可；代码与 zip 都不手改。改源码后必须重新打包。
- 验证：`curl -i https://example.com/2b9yj` → `302`，`Server-Timing` 含 `dur`/`cached`。

### 5.2 控制台（console.example.com）

- 部署：
  ```bash
  nvm use 24
  (cd shlink-web-client && npm run build)
  node scripts/build-console-fc.mjs        # 产出 dist/console.zip
  ```
  上传 `dist/console.zip` 到 FC 函数 `console-prod`（启动命令 `npm run start`，包内 `package.json` 指向 `node index.js`）。
- 署名：`fc/console/index.js` 在返回 HTML 时注入 DB-IP 署名页脚（`IP Geolocation by DB-IP` + db-ip.com 链接），**改 `index.js` 后必须重新打 zip 再上传**（`node scripts/build-console-fc.mjs`；不需要重编 Angular，`node --test fc/console/test/console.test.js` 可自检 7 例）。
- 回滚：回退 `shlink-web-client/` 源码 → 重新 build → 重新打 zip → 重新上传。
- 验证：`https://console.example.com/` 200；深链刷新不 404；SW active；页面底部出现 DB-IP 署名。

**中文化（I12）**：构建期由 vite 插件 `scripts/i18n/vite-plugin-i18n.mjs` 按 `scripts/i18n/zh-CN.json` 替换上游产物与 `src` 里的英文字面量；`buildEnd` 按 `expected.json` + `expected.src.json` 校验出现次数，上游改文案则构建失败。
- 出中文：`npm run build`（默认）
- 出英文：`npm run build:en`（`I18N_LANG=en`）
- 上游升级后：先跑 `node scripts/i18n/gen-expected.mjs` 刷新基准，再补字典
- 只翻界面文案；国家名 / 浏览器名 / OS 名等数据值保留英文。字典 301 条，基准 236（上游）+ 72（src）。

### 5.3 兼容层（compat Edge Function）

```bash
set -a; source supabase/functions/.env; set +a
node scripts/build-compat-function.mjs   # 把 handler.ts 打成单文件 dist/index.ts
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat \
  -d supabase/functions/compat/dist --no-verify-jwt
```
- 为什么多一步构建：`functions-cli` 的部署包以入口文件为准，多文件/静态资源支持有歧义（I5 实测 `.txt` 进不了部署包，官方文档又写 `index.ts + foo.ts` 可多文件）。部署统一走单文件构建产物，消除歧义；本地开发与单测仍直接用 `handler.ts`。
- 改代码后：`handler.ts` 是唯一改动点；`index.ts` 只是本地入口，`dist/index.ts` 由脚本生成（gitignore）。
- **标签参数口径**：`tags` / `excludeTags` 走**逗号分隔**（上游 `splitByComma()`，控制台实发 `excludeTags=i3,i4`）。兼容层会拆逗号，也兼容 `tags[]=a&tags[]=b` 数组写法；`tagsMode` / `excludeTagsMode` 缺省为 `any`（对齐上游 `TagsMode::ANY`）。
- 回滚：`git checkout <旧 commit> -- supabase/functions/compat/handler.ts` → 重新 build → 重新 deploy；或回退整个 commit 后同样走一遍。
- 验证：`curl …/functions/v1/compat/rest/v3/health` → `{"status":"pass","version":"5.1.0"}`；再带 key 打一个真实路由（如 `GET /rest/v3/short-urls?itemsPerPage=1`）。

### 5.4 跳转规则（I9 / R9）

- **数据**：`short_url_redirect_rule` + `redirect_condition`；失效走独立的 `rules_version`（**不是** `link_version`）。规则写入**不会**让全网实例重拉主快照。
- **兼容层**：`GET/POST|PATCH /rest/v3/short-urls/{code}/redirect-rules`。
- **跳转**：命中规则 → 跳规则里的 `longUrl`；不命中 → 跳短链默认长链。规则保存后 ≤5s（`RULES_POLL_MS`）生效。
- **支持的 11 种条件**：`device` / `browser` / `language` / `query-param` / `any-value-query-param` / `valueless-query-param` / `ip-address` / `geolocation-country-code` / `geolocation-city-name` / `before-date` / `after-date`。
- **geo 只覆盖中国大陆 31 省级**：`geolocation-country-code` 实际只匹配 `CN`；`geolocation-city-name` 匹配省名（中英文都认）。海外 IP 不命中 geo 条件；IPv6 不做 geo 匹配。
- **数据文件**：`fc/redirect/china-geo.bin`（构建产物，已 gitignore）。重建：`node scripts/build-china-geo.mjs`（约 70 秒）。改了 DB-IP mmdb 后要重建并重打 `dist/redirect.zip`。
- **排查**：
  1. 规则没生效 → 先看 `select seq from rules_version where id=1;`，再确认 FC 实例的 `rules snapshot ready` 日志里的 seq 是否跟上（seq 落后 → 轮询或网络问题）。
  2. 规则保存报 400 → 是条件值域校验（见设计稿 §5.3）；文案里会指出是哪个值非法。
  3. geo 条件不命中 → 确认 `fc/redirect/china-geo.bin` 在包里（`unzip -l dist/redirect.zip`），以及客户端是不是 IPv6（IPv6 不做 geo 匹配）。

### 5.5 数据库迁移

- 迁移文件是**已应用历史**，不改不删；新变更写新编号文件，逐条 `supabase db query` 执行（或控制台 SQL Editor）。
- 回滚靠新迁移补偿（如重新 `enabled=true`、补列），不做破坏性 down。

### 5.6 标题自动解析（I10 / R10）

建链时若**未填标题**，兼容层会自动抓目标页 `<title>` 写进 `short_url.title`。

| 项 | 值 |
|---|---|
| 开关 | 环境变量 `AUTO_RESOLVE_TITLES`（未设置 = 开启；`false`/`0`/`off`/`no` = 关闭） |
| 超时 | 3s（整条重定向链共用一个 3s 预算） |
| 重定向 | 最多 15 跳，**每跳重新做 SSRF 校验** |
| 来源列 | `short_url.title_was_auto_resolved`（true = 自动抓的，false = 手填） |
| 降级 | 抓不到 / 被 SSRF 拦截 / 非 text/html / charset 认不出 → **一律留空，不报错** |

**语义（对齐上游 shlink）**：手填标题是**粘性**的 —— 编辑时只有「自动解析来的」标题才会被刷新；
用户手填过的标题，改长链也不会被覆盖。

**开关的运维事实**：Edge Function 的 secret **必须重新部署才会注入**，
只 `secrets set` 不部署，开关不生效。语法是 `NAME=VALUE`。

```bash
# 关闭自动解析（出网异常时止血）
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli secrets set AUTO_RESOLVE_TITLES=false
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat \
  -d supabase/functions/compat/dist --no-verify-jwt     # ← 必须重新部署

# 恢复默认（取消 secret 后同样要重新部署）
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli secrets unset AUTO_RESOLVE_TITLES
SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat \
  -d supabase/functions/compat/dist --no-verify-jwt
```

**排查**：

- 建链没有标题 → 先看目标页是不是 `text/html`、有没有声明 charset（**认不出 charset 会故意丢弃标题**，防乱码入库）
- 目标页在内网地址 → 会被 SSRF 拦截（这是预期行为，建链照常成功、只是没标题）
- 想看抓取失败的原因 → 兼容层日志里有「原因码 + host」（`code=blocked_address host=example.com`），
  **没有完整 URL**（长链 query 可能带 token）
- 部署后行为没变 → 确认 `scripts/build-compat-function.mjs` 跑过；部署包是**单文件**，
  本地模块由构建脚本内联进去（`dist/index.ts` 里 `import` 行数应为 0）

## 6. 三类故障排查树

### A. 短链打不开（404 / 500 / 不跳转）
1. `curl -i https://example.com/<码>` 看状态码与 `Server-Timing`。
2. 404：查 `select enabled, valid_until, max_visits, visits_count from short_url where short_code='<码>';` —— 是否被 prune 停用（`enabled=false`，§3.3 撤销）、过期、超次数。若配了 404 回退（§4b）则应 302 而非裸 404，回退没生效先查 `not_found_redirects('<authority>')` 返回。
3. 库里 enabled=true 但仍 404：缓存未失效？查 `link_version.seq` 是否随写入 +1；FC 实例是否最小实例数≥1（冷启动首请求查库）。
4. 500：FC 日志查 ERROR（§7）；多半是 `SUPABASE_URL` 用了公网而非 VPC 内网地址，或 service role key 失效。
5. 默认公网域名（`*.fcapp.run`）发 302 会 `400 ExternalRedirectForbidden`——必须走自定义域名，这是平台策略不是 bug。

### B. 统计不更新（访问数不动 / 明细缺失）
1. 跑 §3.1 健康查询：`inbox_pending` 是否堆积、`drain_last_success_sec` 是否 > 180。
2. 积压：`select drain_visit_inbox(500);` 手动落库；查 cron job 6 是否 active、`cron.job_run_details` 最近是否 failed。
3. `visit_inbox` 是 UNLOGGED：实例崩溃会丢未落库的统计（设计取舍，丢统计不丢业务）。
4. 明细在 `visit` 按月分区；跨月查不到先确认分区已建（`ensure_visit_partition()`）。

### C. 控制台连不上 / 报错
1. 页脚版本是否 `5.1.0`；Add server 的 URL 应为 `…/functions/v1/compat`，key 为 `rxl_…`。
2. `curl …/compat/rest/v3/health` 与带 `X-Api-Key` 的 `…/short-urls`：401 ⇒ key 错/被删（`api_key` 只存哈希，重新生成 §3.3）；CORS 报错 ⇒ 兼容层 CORS 配置。
3. Domains 页红标：健康检查走短链域名，`…/health` 路径被跳转函数兜底返回 404 ⇒ 必红（§4 第 7 步），非故障。
4. 跳转规则保存报 501：`POST /short-urls/{code}/redirect-rules` 尚未实现（M3），预期行为。
5. Mercure 404：未配置实时推送，控制台自动降级，预期行为。

## 7. FC 日志检索口径

- 入口：函数计算控制台 > 对应函数 > **日志查询**（对接 SLS）。
- 跳转函数：按 `Server-Timing` 区分「函数排队」与「查库」——`resolve;dur=` 是查库耗时（命中缓存 `cached=1`、`dur≈0`）；首请求慢多为 VPC 挂载 + 全量拉快照。
- 检索建议：按时间窗 + 关键词 `ERROR`/`resolve`/具体 requestId（响应头 `X-Fc-Request-Id`）过滤。
- 红线复核：日志里**不应出现任何请求头明文**；若发现，立即查代码是否误打印 header。