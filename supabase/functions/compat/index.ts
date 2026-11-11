// shlink 兼容层本地入口（/rest/v3）。请求处理与路由表见 handler.ts。
//
// 注意：本文件是本地开发/调试入口，**不是部署产物**。
// functions-cli 的部署包以入口文件为准，为消除多文件支持歧义，
// 部署用 scripts/build-compat-function.mjs 生成的单文件：
//   node scripts/build-compat-function.mjs
//   SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat \
//     -d supabase/functions/compat/dist --no-verify-jwt
// 服务端 RPC 见 supabase/migrations/0008_compat_api.sql
import { handleRequest } from './handler.ts';

Deno.serve(handleRequest);
