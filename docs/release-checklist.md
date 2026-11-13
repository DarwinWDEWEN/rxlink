# rxlink 上线前置清单（Release Checklist）

> 状态：**待执行**（2026-11-12 整理）。用途：把「发布前必须做完、且本机做不了的事」集中成一份可勾选的清单。
> 每一项都标了：**谁做**（用户 / 本机可做）、**现状**（已核实的真实状态，不是推测）、**怎么验证**、**是否阻塞发布**。
> 整理依据：`docs/handover.md` §7.2 + `docs/iteration-plan.md` C 表 I7 的遗留项 + 本轮（I11 收尾轮）的云侧探测结果。

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

| 项 | 现状（2026-11-12 实测） | 动作 |
|---|---|---|
| `cdn.example.com` | **DNS 仍解析**到 `203.0.113.10` | 下线域名 + 解析记录（代码侧已无任何引用，纯云侧遗留） |
| Edge 函数 `statictest` | **状态 `DELETING`**（Version 4） | 等删除完成；若卡住需在控制台强制删 |
| Edge 函数 `console` | ACTIVE（Version 3） | **保留** —— 这是 `console.example.com` 的静态包宿主，不是遗留 |

> `functions-cli list` 实测只有 3 个函数：`compat`（ACTIVE v14）、`console`（ACTIVE v3）、`statictest`（DELETING）。
> `statictest` 是探针期遗留，删完即可。

---

## 二、发布后动作（不阻塞发布，但发布完成要做）

### 4. 备份表 `visit_bak_0012` —— **本机可做** · 🟢 158 行待 drop

- **现状**：`visit_bak_0012` 有 **158 行**（I7 迁移 0012 前的备份；授权已收口）。
- **动作**：发布确认无误后 `drop table visit_bak_0012;`
- **怎么验证**：`select count(*) from visit_bak_0012;` → 报 relation does not exist。
- **注意**：**先发布、确认线上正常，再 drop**。反了就没退路。

### 5. 释放探针期残留授权 —— **本机可做** · 🟢

- **现状**：I6 已做探针退场（探针函数/表/Edge Function/定时任务都撤了），但备份表与其授权仍在。
- **动作**：随第 4 项一起清。

---

## 三、已核实「不需要做」的项（省得你重复查）

| handover 里的待办 | 实测结论 |
|---|---|
| 重传 `dist/console.zip`（DB-IP 署名页脚） | **已上线** —— `https://console.example.com/` 的 HTML 里已含 `IP Geolocation by DB-IP` ✅ |
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

# ③ 数据库健康（见 runbook §3.1）
```

**期望值**：`117 passed | 0 failed`；`deno check` 无输出；`{"status":"pass","version":"5.1.0"}`；robots/pixel 200、跳转 302。

---

## 五、发布后的验收口径（避免被当成 bug）

1. **统计是近实时，不是即时**：我们是 inbox + 批量 drain（秒到分钟），上游 shlink 是同步写、即时可见。差异是口径问题，不是缺陷。
2. **bot 判定精度低于上游**：上游用 `crawler-detect` 库，我们用 `ua_rule` 规则表自建（库在 vendor 不可移植）。已知 `curl` 等会被判为 bot（实测 `potential_bot=true`）。
3. **地理无 `time_zone` 字段**：`visit.timezone` 恒 NULL（DB-IP 源不含该字段）；控制台不渲染，可忽略。
4. **实时推送没有对应物**：控制台「实时更新」开关降级为轮询。
