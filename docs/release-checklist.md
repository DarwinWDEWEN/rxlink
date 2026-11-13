# rxlink 上线前置清单（Release Checklist）

> 状态：**部分已执行**（2026-11-12 整理，2026-11-13 更新）。用途：把「发布前必须做完、且本机做不了的事」集中成一份可勾选的清单。
> 每一项都标了：**谁做**（用户 / 本机可做）、**现状**（已核实的真实状态，不是推测）、**怎么验证**、**是否阻塞发布**。
> 整理依据：`docs/handover.md` §7.2 + `docs/iteration-plan.md` C 表 I7 的遗留项 + 本轮（I11 收尾轮）的云侧探测结果。
>
> **2026-11-13 更新**：`statictest` 与 Edge 副本 `console` 均已删除；`visit_bak_0012` 已归档+还原验证+drop；控制台宿主的记录已订正；
> 补了跳转快照的冷启动判读口径和署名 grep 的正确写法。**剩余阻塞项仍只有 Supabase 升付费版。**

---

## 一、发布阻塞项（不做完不算「可发布」）

### 1. Supabase 升付费版 —— **用户动作** · 🔴 阻塞发布

- **现状**：当前跑在免费版。ADB Supabase 免费版**禁生产**（官方口径）。
- **动作**：控制台升级付费套餐。
- **怎么验证**：升级后确认实例规格（CPU/内存）变化；再跑一次 `docs/runbook.md` §3.1 的健康查询。
- **备注**：这是**唯一一个真正卡住发布**的项。其余都是清理与确认。

### 2. 确认 FC 定时触发器 cron 是 6 字段 —— **用户动作** · 🟠 发布前必须确认

- **现状**：本机无法验证 FC 触发器配置（只能在 FC 控制台看）。
- **目标值**：`CRON_TZ=Asia/Shanghai 0 0 * * * *`（6 字段：秒 分 时 日 月 周）。
- **为什么是 6 字段**：5 字段写法在阿里云 FC 的定时触发器里语义是 **UTC**，会导致富化任务和 prune 任务差 8 小时。
- **怎么验证**：FC 控制台看触发器表达式；或等一次触发后查 `visit` 表的 `occurred_at` 落在哪个时段。

### 3. 云侧资源清理 —— **用户动作** · 🟡 不阻塞，但要清

| 项 | 现状 | 动作 |
|---|---|---|
| `cdn.example.com` | **DNS 仍解析**到 `203.0.113.10` | 下线域名 + 解析记录（代码侧已无任何引用，纯云侧遗留） |
| Edge 函数 `statictest` | ✅ **2026-11-13 已删除**（`functions-cli delete -s statictest` 返回 200） | 无需再动 |
| Edge 函数 `console` | ✅ **2026-11-13 已删除**（`functions-cli delete -s console` → 200） | 无需再动 |

> **订正（2026-11-13 实测）**：本清单上一版写「Edge 函数 `console` 是 `console.example.com` 的静态包宿主」—— **这是错的**。
> 实测：`console.example.com` 返回的 HTML **含 DB-IP 署名**（`.rxlink-attribution` 节点），而署名只由
> `fc/console/index.js`（FC Web 函数）注入；当时的 Edge 模板**没有**这段代码。
> 且两边提供的 asset 完全同一个（`assets/index-XmYP89Qr.js`，1,462,669 B），Edge 副本仅 6,238 B、
> FC 副本 6,753 B（差值正是注入的署名 + 样式）。
> ⇒ **真正托管域名的是 FC 函数**（runbook §5.2 写的 `console-prod` 是对的），Edge 函数 `console` 只是同构建的重复副本。
> **2026-11-13 已确认删除**（用户确认：我们统一走 FC 版本，Edge 路径无法作为入口），
> Edge 版源码与构建链（`supabase/functions/console/`、`scripts/build-console-function.mjs`、`scripts/console-function.template.ts`）同日一并退役。
> 删除后复验 `console.example.com` 完全不受影响：index 200 / 6,753 B / asset `index-XmYP89Qr.js` 200（1,462,669 B）/
> `manifest.json` 200 / 署名节点仍在。

> `functions-cli list` 现存 **1 个**函数：`compat`（ACTIVE v14）。Edge 侧静态站副本 `console` 已删，控制台由 FC 函数托管。

---

## 二、发布后动作（不阻塞发布，但发布完成要做）

### 4. 备份表 `visit_bak_0012` —— ✅ **2026-11-13 已执行**

- **原状**：158 行（I7 迁移 0012 前的备份；授权已收口）。
- **已做**：先按「先备份再删」的规矩导出归档并做了**还原验证**：
  1. 用 `supabase db query -o csv` 生成 158 条 `INSERT` → `.backups/visit_bak_0012-restore.sql`；
  2. 建临时表 `visit_bak_0012_restore_test` 灌入 → `INSERT 0 158`；
  3. 比对两边 `md5(string_agg(t::text,'|' order by id))` → `79c8f191d3b35bd9e140c36edf6d2b0a` **完全一致**；
  4. `drop table visit_bak_0012_restore_test;` → `drop table visit_bak_0012;` 均 rc=0。
- **验证**：`select count(*) from visit_bak_0012;` → `ERROR: relation "visit_bak_0012" does not exist (SQLSTATE 42P01)`；
  `pg_class` 里 `visit_bak%` 零残留。
- **归档位置**：`.backups/visit_bak_0012-restore.sql`（**已 gitignore** —— 含访客 IP/UA 派生数据，不入库）。
  该表结构是迁移 0012 **之前**的旧列名（`country` / `region` / `city`），与现行 `visit` 表的
  `country_name` / `region_name` / `city_name` 不同；还原时需按旧 DDL 建表。
- **数据没丢**：现行 `visit` 表 990 行，最早一条 `2026-11-09 16:01:47.985+08` 与备份表最早一条同源同刻。

### 5. 释放探针期残留授权 —— ✅ **2026-11-13 已执行**

- I6 已做探针退场（探针函数/表/Edge Function/定时任务都撤了）；备份表与其授权随第 4 项一起清完。

---

## 三、已核实「不需要做」的项（省得你重复查）

| handover 里的待办 | 实测结论 |
|---|---|
| 重传 `dist/console.zip`（DB-IP 署名页脚） | **已上线** —— `https://console.example.com/` 的 HTML 里已含 `IP Geolocation by DB-IP` ✅ |
| 控制台中文化（I12） | **已上线** —— `dist/console.zip` 已重打上传，线上 `assets/index-C7FdqMXW.js` 200、旧英文包 `index-XmYP89Qr.js` 404，Playwright 实测 4 页全中文 ✅ |
| FC 账号探针残留 | I6 已全退场（探针函数/表/Edge Function/cron 作业都撤了）✅ |
| Domains 红标处置 | I0 已定「先接受」（方案 a），不是待办 |
| 备份表 `visit_bak_0012` 授权收口 | 已收口，只剩 drop 本体（第 4 项） |

---

## 四、发布前最后一次自检（脚本清单）

```bash
# ① 兼容层自检（本机）
/Users/wang/.deno/bin/deno test --allow-env \
  supabase/functions/compat/test/compat.test.ts \
  supabase/functions/compat/test/title-resolver.test.ts
/Users/wang/.deno/bin/deno check \
  supabase/functions/compat/index.ts supabase/functions/compat/handler.ts \
  supabase/functions/compat/title-resolver.ts supabase/functions/compat/dist/index.ts

# ② 线上冒烟
curl -sS https://your-project-ref.supabase.co/functions/v1/compat/rest/v3/health
curl -sS -o /dev/null -w 'robots: %{http_code}\n' https://example.com/robots.txt
curl -sS -o /dev/null -w 'pixel:  %{http_code}\n' https://example.com/2b9yj/track
curl -sS -o /dev/null -w '302:    %{http_code}\n' https://example.com/2b9yj

# ③ 跳转函数快照是否真的热起来（**要看 header，不能只看 302**）
curl -sS -D- -o /dev/null https://example.com/2b9yj | grep -iE '^(location|x-link-snapshot|server-timing)'

# ④ 控制台静态站 + DB-IP 署名（FC 函数宿主）
curl -sS https://console.example.com/ | grep -c 'rxlink-attribution'   # 期望 1

# ⑤ 数据库健康（见 runbook §3.1）
```

**期望值**：`117 passed | 0 failed`；`deno check` 无输出；`{"status":"pass","version":"5.1.0"}`；robots/pixel 200、跳转 302。

### ③ 的判读口径（别踩坑）

`X-Link-Snapshot` 的格式是 `rows|seq|age`：

| 观测值 | 含义 | 处置 |
|---|---|---|
| `1\|158\|216146` | ✅ 快照已加载（1 行、seq 158、3.6 分钟前加载），`cached=1` | 正常 |
| `0\|null\|-1` | ⚠️ **冷启动实例**：刚部署，轮询还没完成第一轮 | **重打一次**即可，别误判成 bug |
| `0\|null\|-1` 且**连续多次**都是 | ❌ 真的快照加载失败 | 看 FC 日志 `snapshot poll failed: ...` |

> 2026-11-13 实测踩过这个坑：用户刚发布 FC 函数后打的第一发命中冷启动实例 → `0|null|-1`，
> 连打 5 次全部 `1|158|<age>`、`cached=1`、`dur=0`。**快照机制本身没问题。**

### ④ 的判读口径

签名节点是 `<div class="rxlink-attribution">IP Geolocation by <a>DB-IP</a></div>`。
注意 **`IP Geolocation by DB-IP` 这个连续字符串在 HTML 里不存在**（文字被 `<a>` 标签隔开），
用 `grep 'IP Geolocation by DB-IP'` 会**误判为"没上线"**。正确写法是 `grep -c 'rxlink-attribution'`。

---

## 五、发布后的验收口径（避免被当成 bug）

1. **统计是近实时，不是即时**：我们是 inbox + 批量 drain（秒到分钟），上游 shlink 是同步写、即时可见。差异是口径问题，不是缺陷。
2. **bot 判定精度低于上游**：上游用 `crawler-detect` 库，我们用 `ua_rule` 规则表自建（库在 vendor 不可移植）。已知 `curl` 等会被判为 bot（实测 `potential_bot=true`）。
3. **地理无 `time_zone` 字段**：`visit.timezone` 恒 NULL（DB-IP 源不含该字段）；控制台不渲染，可忽略。
4. **实时推送没有对应物**：控制台「实时更新」开关降级为轮询。
