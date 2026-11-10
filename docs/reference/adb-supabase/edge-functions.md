# 在 AnalyticDB Supabase 中使用边缘函数

> 来源：https://help.aliyun.com/zh/analyticdb/analyticdb-for-postgresql/using-edge-functions-in-analyticdb-supabase
> 存档日期：2026-10-28

云原生数据仓库 AnalyticDB PostgreSQL 版 Supabase（简称 AnalyticDB Supabase）Edge Functions 是一项全托管边缘计算服务，允许您将 TypeScript Deno 函数部署到 AnalyticDB Supabase 项目中。与开源自托管的 Supabase 相比，AnalyticDB Supabase 提供了完整的 Edge Functions 管理能力，确保您的代码和数据完全自主可控，同时提供与 Supabase Cloud 一致的开发体验。

## 功能简介

基于 Deno 的边缘计算方案。开源社区提供的 Supabase，其函数管理后台未开放源码，自建用户无法通过图形界面或命令行工具完成生产环境部署；AnalyticDB Supabase 通过自有 Edge Functions 管控平台解决该问题，所有代码和配置数据驻留在私有环境中。同时提供原生 Secrets 配置与集中管理能力，敏感信息（如百炼 API Key）存放在密钥库中，通过 `Deno.env.get` 读取。

### 优势

- **TypeScript 原生开发**：无需编译打包，TypeScript 源码直接部署。
- **生态互通**：函数内可直接访问 Supabase 数据库、用户鉴权、对象存储等服务，无需额外配置。
- **隔离与高性能**：沙箱机制 + Deno 安全模型，每个请求独立运行，毫秒级响应、几乎无感冷启动。

## 部署 Edge Function

### 方式一：Dashboard

1. 登录 Supabase Dashboard。
2. 侧边栏 **Edge Function** > **Functions**。
3. 右上角 **Deploy a new function** > **Via Editor**。
4. 编写代码（可多文件，如 `index.ts` + `foo.ts`）。

   > **重要**：如需在 Function 中导入第三方依赖或调用公网 API，需要为 Supabase 项目**开通公网访问**（文档：how-to-enable-public-network-access-for-analyticdb-supabase）。

5. 右下角编辑函数名称，单击 **Deploy**。

示例 `index.ts`：

```typescript
import { foo } from './foo.ts';
console.info('server started');
Deno.serve(async (req)=>{
  const { name } = await req.json();
  const data = {
    message: `Hello ${foo()} ${name}!`
  };
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Connection': 'keep-alive'
    }
  });
});
```

示例 `foo.ts`：

```typescript
export function foo() {
  return 'bar';
}
```

### 方式二：functions-cli

1. 获取并配置目标项目的 `SUPABASE_API_URL` 与 `SUPABASE_API_KEY`（后者为 **service role key**）。三种配置方式：
   - 环境变量：`export SUPABASE_API_KEY=xxx`
   - `.env` 文件：`SUPABASE_API_KEY=xxx`
   - 命令行参数：`-key xxx`

   ```bash
   export SUPABASE_API_URL=https://sbp-xxx.supabase.co
   export SUPABASE_API_KEY=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2Vxxxx
   ```

2. 准备函数文件（目录结构固定为 `supabase/functions/<函数名>/index.ts`）：

   ```text
   supabase
   └── functions
       └── hello
           ├── foo.ts
           └── index.ts
   ```

3. 下载 functions-cli（** darwin-arm64 即本机 Apple Silicon 用的包 **，版本日期 2026-03-17）：

   | 平台 | 下载地址 |
   |---|---|
   | darwin-arm64 | https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260319/wjjgdp/functions-cli-darwin-arm64-2026-03-17 |
   | darwin-amd64 | https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260319/lbdrxw/functions-cli-darwin-amd64-2026-03-17 |
   | windows-386 | https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260319/qtvoiu/functions-cli-windows-386-2026-03-17.exe |
   | windows-amd64 | https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260319/rumrmj/functions-cli-windows-amd64-2026-03-17.exe |
   | linux-386 | https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260319/xfihwf/functions-cli-linux-386-2026-03-17 |
   | linux-amd64 | https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260319/yaruon/functions-cli-linux-amd64-2026-03-17 |
   | linux-arm | https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260319/fxllon/functions-cli-linux-arm-2026-03-17 |
   | linux-arm64 | https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20260319/ifdjyq/functions-cli-linux-arm64-2026-03-17 |

4. 执行部署：

   ```bash
   ./functions-cli deploy hello
   ```

   > **说明**：部署命令在**当前执行目录**下查找 `supabase/functions/` 里名为 `hello` 的函数目录。
   > 若报错 “At least one file is required”，登录控制台在目标 Supabase 项目所在行 **操作** > **更多** > **升级版本** 后重试；项目版本为 v1.0.0 时升级会更新数据库连接串。

5. **关闭 JWT 校验部署**（本项目跳转函数需要）：

   ```bash
   ./functions-cli deploy hello --no-verify-jwt
   ```

## 测试 Edge Function

- Dashboard：Functions 页面右上角 **Test** > **Send Request**，成功返回 200 与 JSON body。
- curl：复制 Details / **Invoke function** 页签下的 curl 命令（提供 cURL、JavaScript、Swift、Flutter、Python 示例），把 `[YOUR ANON KEY]` 换成 anon key 或 service role key。

  ```bash
  curl -L -X POST 'https://sbp-5xxx.supabase.co/functions/v1/bright-service' \
    -H 'Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5xxxxxxljA' \
    -H 'Content-Type: application/json' \
    --data '{"name":"Functions"}'
  {"message":"Hello bar Functions!"}
  ```

  注意 URL 形态固定为 `/functions/v1/{函数slug}`——**文档中没有自定义路由/路径前缀的配置项**。

## 更新 / 删除 Edge Function

- 更新：Functions > 目标函数 > **Code** 页签编辑 > 右下角 **Deploy updates**。
- 删除：Functions > 目标函数 > **Details** 页签 > **Delete function** 区域 > **Delete edge function**。

## 迁移与同步

### 从 Supabase Cloud 迁移到 AnalyticDB Supabase

1. 源端配置：
   - 访问 https://supabase.com/dashboard/account/tokens 生成 Access Token（如命名 `migration token`，Expires in 30 days）。
   - 源端 Project Ref = 项目 URL 末尾（如 `https://supabase.com/dashboard/project/qeqfhfoebrtkbmwd****` 中的 `qeqfhfoebrtkbmwd****`）。
   - 目标端 `SUPABASE_API_URL` + `SUPABASE_API_KEY`（service role key）。

   ```bash
   export SUPABASE_SOURCE_REF=abcdefghijkl****
   export SUPABASE_SOURCE_TOKEN=sbp_1760f47cc82fe3466dce9aa*********
   export SUPABASE_API_URL=https://sbp-xxx.supabase.co
   export SUPABASE_API_KEY=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2V****
   ```

2. 安装 Deno（https://docs.deno.com/runtime/getting_started/installation/）。
3. 迁移：

   ```bash
   # 单个函数
   ./functions-cli migrate -s hello \
     --source-ref abcdefghijkl**** \
     --source-token sbp_1a2b3c4d5e6f7g8h**** \
     --target-key eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2V**** \
     --target-url https://sbp-****.supabase.co

   # 全部函数
   ./functions-cli migrate --all --source-ref ... --source-token ... --target-key ... --target-url ...
   ```

### AnalyticDB Supabase 项目之间同步

```bash
export SOURCE_API_URL=https://sbp-source***.supabase.co
export SOURCE_API_KEY=...
export SUPABASE_API_URL=https://sbp-target***.supabase.co
export SUPABASE_API_KEY=...

./functions-cli sync -s hello --source-key ... --source-url ... --target-key ... --target-url ...
./functions-cli sync --all  --source-key ... --source-url ... --target-key ... --target-url ...
```

## Secrets 管理

### 默认 Secrets（每个函数可直接读）

| 名称 | 说明 |
|---|---|
| `SUPABASE_URL` | 项目的 API 网关地址。 |
| `SUPABASE_LOCAL_URL` | 项目的 API **本地网关地址（不经过公网，延迟更低）**。 |
| `SUPABASE_ANON_KEY` | 匿名密钥。启用行安全策略（RLS）时可在浏览器中安全使用。 |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务角色密钥。可在 Edge Functions 中安全使用，**切勿在浏览器使用，会绕过 RLS**。 |

### 创建自定义 Secrets

- Dashboard：**Edge Function** > **Secrets**，输入 Key/Value，Save。
- functions-cli：

  ```bash
  functions-cli secrets set DASHSCOPE_API_KEY=sk_test123456
  functions-cli secrets set DASHSCOPE_API_KEY=sk_test123456 OPENAI_API_KEY=test123456
  functions-cli secrets set --env-file supabase/functions/.env
  ```

### 读取

```typescript
Deno.env.get('NAME_OF_SECRET')
```

## 文档未覆盖、需要实测的点

- 函数执行的超时时间、内存上限、并发上限、计费口径（文档只说「毫秒级响应、几乎无感冷启动」，无数值）。
- 运行时日志的查看入口（本文档只出现 `console.info`，未说明日志在哪看；产品总览页宣称 Edge Functions 有全链路日志可观测）。
- 关闭 JWT 后能否**匿名 GET** 并返回 **302 + 自定义 Location**（文档示例全部是 POST + JSON）。
- 是否支持自定义路由把 `/{shortCode}` 映射到函数（文档无此能力，需靠 CDN 重写）。
