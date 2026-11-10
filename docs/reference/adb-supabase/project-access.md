# Supabase 项目创建 / 访问 / API Keys / 直连

> 来源：https://help.aliyun.com/zh/analyticdb/analyticdb-for-postgresql/supabase/ （同 https://help.aliyun.com/document_detail/2938618.html）
> 存档日期：2026-10-28
> 抓取说明：该页是 Supabase 章节主页，正文要点由多次抓取与搜索结果拼装而成，**措辞可能与原文有出入，落库前请以线上页面为准**；子文档（功能配置与使用指南、MCP 使用指南、第三方登录、邮件服务、短信验证登录、企业 SSO 接入、Supabase CLI 使用指南、Supabase 自动启停、实践教程）尚未逐一存档。

## 创建与登录

- 入口：登录 [云原生数据仓库 AnalyticDB PostgreSQL 版控制台](https://gpdbnext.console.aliyun.com/gpdb/cn-hangzhou/supabase)，选择地域，左侧导航栏单击 **Supabase**。
- 创建项目后可查询项目列表；每个项目有形如 `sbp-xxxxxxxxxx.supabase.co` 的 API 网关域名。
- 登录 Dashboard：**复制登录账号与登录密码**，单击 **确定** 跳转到 Supabase Dashboard 登录窗口，输入用户名密码登录。
  > **重要**：Dashboard 的登录密码无法修改，请妥善保管。（能改的是**数据库密码**）

## 获取 API Keys

- **anon key**：
  - 在控制台弹出窗口中单击 **App Frameworks**，即可获取 Supabase 实例的 `SUPABASE_URL` 和 `SUPABASE_ANON_KEY`。
  - 或在 Supabase Dashboard 左侧导航单击 **Authentication**，获取 `SERVICE KEY`。
- **service role key**（身份验证与授权等管理操作）：
  - Dashboard 左侧导航 **API Docs** > **Introduction**，右上角切到 **Bash**，**Project API Key** 选择 `service_role(secret)`；
  - 或左侧 **Authentication** 获取 `SERVICE KEY`。
- **建议把 API Key 配置到环境变量**，避免在代码里显式配置，降低泄漏风险。

两类 key 的语义与开源 Supabase 一致：anon key 受 RLS 约束、可放前端；service role key 绕过 RLS、只能服务端持有（Edge Function 里通过默认 Secret `SUPABASE_SERVICE_ROLE_KEY` 读取）。

## 通过 REST API 使用

```bash
# 数据库 CRUD（PostgREST）
curl 'http://<SUPABASE_URL>/rest/v1/users' \
  -H "Authorization: Bearer <anon key>" \
  -H "apikey: <anon key>" \
  -H "Content-Type: application/json"

# Auth 管理接口（需 service role key）
curl 'http://<SUPABASE_URL>/admin/users' \
  -H "Authorization: Bearer <service role key>" \
  -H "apikey: <service role key>" \
  -H "Content-Type: application/json"
```

端点前缀汇总：`/rest/v1/`（数据库）、`/auth/v1/`（认证）、`/functions/v1/{name}`（边缘函数）、`/storage/v1/`（对象存储）。更多功能参见 Supabase 官方文档。

## 常见问题：如何直连 PostgreSQL 数据库

**2025 年 08 月 27 日后创建的 AnalyticDB PostgreSQL 版 Supabase 已支持标准 PostgreSQL 直连**，可用 psql、JDBC、DBeaver、DataGrip、Tableau 等工具连接。

连接步骤：
1. 登录 ADB PostgreSQL 控制台，选择实例地域，左侧导航单击 **Supabase**。
2. **设置白名单**：目标项目所在行 **操作** > **修改白名单**，把客户端公网 IP 加入白名单。
3. （可选）**设置并保管数据库账号密码**：**操作** > **重置数据库密码**。
4. **获取连接信息并连接**：
   - 默认端口 `5432`。
   - 连接地址：单击目标项目所在行 **操作** > **登录 Dashboard** > **跳转**，跳转后页面的 URL 即为数据库连接地址；若跳转后 URL 显示为 `http://<IP>:8000`，则 `<IP>` 即为数据库连接地址。

## 常见问题：如何修改 Auth 配置

Auth 服务提供 `PATCH /auth/v1/modify/settings` 接口，用于**运行时动态修改认证配置，无需重启服务即可生效**。

认证方式：需要使用 **Service Role Key**，同时放在 `Authorization` 与 `apikey` **两个 Header** 中传入。

## 管理 Supabase 项目

| 操作 | 路径 |
|---|---|
| 重置数据库密码 | 目标实例 **操作** > **重置数据库密码** > 填新密码 > **确定** |
| 修改白名单 | 目标实例 **操作** > **修改白名单** > 填 IP 白名单 > **确定** |
| 删除项目 | 目标实例 **操作** > **释放** > **确定** |

## 相关 OpenAPI

文档列出的项目管理 API：创建 Supabase 项目、查询 Supabase 项目列表、**查询 Supabase 项目 API Keys（含 anon key 与 service role key）**、修改 Supabase 项目数据库密码、修改 Supabase 项目白名单、删除 Supabase 项目。

> 意味着 CI/脚本可以用 OpenAPI 拿 key、管白名单，不必全靠控制台手点。

## 对本项目的含义（分析，非文档原文）

1. **直连 PG 可用** → migration、P0 的 SQL 验证（pg_cron、UNLOGGED 表）都能用本地 `psql` 跑，不需要绕 PostgREST，这大幅降低验证成本。前提：项目创建于 2025-08-27 之后 + 配好白名单。
2. **Edge Function 里连库优先用 `SUPABASE_LOCAL_URL`**（默认 Secret，不走公网、延迟更低），公网网关地址留给外部客户端。
3. **Auth 配置可运行时 PATCH 修改** → 后续接微信/支付宝 OAuth、改注册策略不需要重启，运维友好。
4. service role key 只在函数与 CI 里用；Dashboard 登录密码不可改，要在团队内做好保管与传递。
