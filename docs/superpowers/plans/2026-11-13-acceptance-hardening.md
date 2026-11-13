# rxlink Acceptance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复四个高置信度验收阻塞问题，并建立可重复执行的整体验收门禁。

**Architecture:** 标题抓取将 DNS 校验结果绑定到实际 TCP 连接；访问入队增加状态检查、有限重试和脱敏日志；数据库通过最终收口迁移恢复生产基线；前端国际化只作用于构建，根级 CI 统一执行全部门禁。

**Tech Stack:** Deno 2、TypeScript、Node.js 24、node:test、React 19、Vite 8、Vitest Browser、PostgreSQL 14、Supabase CLI、GitHub Actions。

---

### Task 1: 固定标题抓取的连接地址

**Files:**
- Modify: `supabase/functions/compat/title-resolver.ts`
- Modify: `supabase/functions/compat/test/title-resolver.test.ts`
- Generated: `supabase/functions/compat/dist/index.ts`

- [ ] **Step 1: 写失败测试**

新增测试，令 DNS 返回 `93.184.216.34`，断言请求器第三个参数只能收到该地址；再验证重定向下一跳会收到下一次独立校验的地址。

- [ ] **Step 2: 验证测试先失败**

Run:

```bash
/Users/wang/.deno/bin/deno test --allow-env \
  supabase/functions/compat/test/title-resolver.test.ts
```

Expected: 新测试因当前请求器没有接收固定地址而失败。

- [ ] **Step 3: 实现最小安全请求器**

让 `assertPublicHost()` 返回已校验地址。新增使用 `node:http` / `node:https` 的请求器，通过自定义 `lookup` 仅返回这些地址，并将响应转换为 Web `Response`。`resolveTitle()` 每一跳都把当前校验结果传给请求器。

- [ ] **Step 4: 验证安全测试与兼容层**

Run:

```bash
/Users/wang/.deno/bin/deno test --allow-env \
  supabase/functions/compat/test/title-resolver.test.ts \
  supabase/functions/compat/test/compat.test.ts
/Users/wang/.deno/bin/deno check \
  supabase/functions/compat/index.ts \
  supabase/functions/compat/handler.ts \
  supabase/functions/compat/title-resolver.ts
```

Expected: 全部通过，无类型错误。

### Task 2: 让访问入队失败可重试、可观测

**Files:**
- Modify: `fc/redirect/index.js`
- Modify: `fc/redirect/test/redirect.test.js`

- [ ] **Step 1: 写失败测试**

扩展 mock 网关状态：首次 `/visit_inbox` 返回 500 后恢复时应发生第二次调用；持续 500 时 stderr 必须包含固定错误码，但不得包含访问 IP、UA、Referer 或密钥。

- [ ] **Step 2: 验证测试先失败**

Run:

```bash
node --test fc/redirect/test/redirect.test.js
```

Expected: 当前 `recordVisit()` 不检查 HTTP 状态，新用例失败。

- [ ] **Step 3: 实现有限重试**

将 `recordVisit()` 改为异步重试，检查 `res.ok`，使用短退避，最终只输出状态码或网络错误类别。保持调用方 fire-and-forget，不改变 302、pixel 和 404 回退响应。

- [ ] **Step 4: 验证跳转函数**

Run:

```bash
node --test fc/redirect/test/*.test.js
```

Expected: 全部通过。

### Task 3: 建立可重放的生产数据库基线

**Files:**
- Create: `supabase/migrations/0021_production_baseline.sql`
- Modify: `supabase/config.toml`
- Create: `scripts/test-production-baseline.mjs`

- [ ] **Step 1: 写失败的静态基线测试**

测试必须断言：seed 已关闭；`0021` 存在；包含探针清理、默认域名更新和四个生产 cron 名称。

- [ ] **Step 2: 验证测试先失败**

Run:

```bash
node --test scripts/test-production-baseline.mjs
```

Expected: 因 `0021` 不存在且 seed 仍启用而失败。

- [ ] **Step 3: 新增幂等收口迁移**

迁移按依赖顺序删除 P0 探针函数和表；只在 id=0 仍为占位值时更新默认域名；按同名任务取消后重建四个生产任务。将 `[db.seed].enabled` 改为 `false`。

- [ ] **Step 4: 验证静态契约**

Run:

```bash
node --test scripts/test-production-baseline.mjs
```

Expected: 通过。

- [ ] **Step 5: 在 Supabase 本地环境重放**

Run:

```bash
supabase start
supabase db reset
```

Expected: 所有迁移成功，探针对象为 0，默认域名是 `example.com`，四个 cron 均存在。若本机容器环境不可用，在 CI 中完成同一验证并明确记录本机限制。

### Task 4: 修复前端中英文行为和测试

**Files:**
- Modify: `scripts/i18n/vite-plugin-i18n.mjs`
- Modify: `scripts/i18n/zh-CN.json`
- Modify: `scripts/i18n/expected.src.json`
- Modify: `scripts/i18n/test/replace-literals.test.mjs`
- Modify: `shlink-web-client/src/servers/EditServer.tsx`
- Modify: `shlink-web-client/package.json`

- [ ] **Step 1: 写失败测试**

增加完整标题模板替换测试；增加构建后 HTML 语言断言。现有前端测试继续作为不对称引号回归测试。

- [ ] **Step 2: 验证当前失败**

Run:

```bash
I18N_LANG=en npm test
```

Working directory: `shlink-web-client`

Expected: 3 条编辑标题断言失败。

- [ ] **Step 3: 修复插件作用域和标题模板**

插件增加 `apply: 'build'`；编辑标题使用 `Edit "{serverName}"` 完整模板并在中文词典中整体映射；中文构建的 `transformIndexHtml` 输出 `lang="zh-CN"`，英文保持 `lang="en"`。

- [ ] **Step 4: 验证前端完整门禁**

Run:

```bash
npm run cs
npm run types
npm test
npm run build
rg -q '<html lang="zh-CN">' build/index.html
npm run build:en
rg -q '<html lang="en">' build/index.html
```

Working directory: `shlink-web-client`

Expected: 237 条测试全部通过，两种语言构建与语言标记正确。

### Task 5: 建立根级 CI 与发布门禁

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: 新增 CI 静态失败测试**

在 `scripts/test-production-baseline.mjs` 中断言根目录存在 CI，且包含前端测试、Deno 测试、云函数测试、双构建和 Supabase reset。

- [ ] **Step 2: 验证测试先失败**

Run:

```bash
node --test scripts/test-production-baseline.mjs
```

Expected: 根级 workflow 不存在，测试失败。

- [ ] **Step 3: 创建根级 workflow**

CI 安装 Node、Deno、Playwright 和 Supabase CLI，执行全部本地门禁与数据库重放。Release 通过 `workflow_run` 或可复用 workflow 依赖 CI 成功，再生成控制台与函数部署包。

- [ ] **Step 4: 验证 workflow 契约**

Run:

```bash
node --test scripts/test-production-baseline.mjs
```

Expected: 通过。

### Task 6: 全量验收

**Files:**
- Verify all modified files

- [ ] **Step 1: 运行本地全门禁**

Run:

```bash
node --test fc/console/test/console.test.js \
  fc/geo-enrich/test/geo-enrich.test.js \
  fc/redirect/test/*.test.js \
  scripts/i18n/test/*.test.mjs \
  scripts/test-production-baseline.mjs
/Users/wang/.deno/bin/deno test --allow-env \
  supabase/functions/compat/test/compat.test.ts \
  supabase/functions/compat/test/title-resolver.test.ts
/Users/wang/.deno/bin/deno check \
  supabase/functions/compat/index.ts \
  supabase/functions/compat/handler.ts \
  supabase/functions/compat/title-resolver.ts \
  supabase/functions/compat/dist/index.ts
```

Run in `shlink-web-client`:

```bash
npm run cs
npm run types
npm test
npm run build
npm run build:en
```

- [ ] **Step 2: 重建部署包**

Run:

```bash
node scripts/build-compat-function.mjs
node scripts/build-console-fc.mjs
node scripts/build-geo-enrich-fc.mjs
```

Expected: 全部成功且生成产物。

- [ ] **Step 3: 运行线上只读冒烟**

验证 health 200、robots 200、pixel 200、短链 302 且快照热、控制台署名存在。不得执行写操作。

- [ ] **Step 4: 检查最终差异**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: 仅包含本轮规格、计划、测试、实现、迁移和 workflow 文件。
