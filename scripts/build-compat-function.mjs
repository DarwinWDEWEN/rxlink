// 把 compat/handler.ts 打成单文件部署包（supabase/functions/compat/dist/index.ts）。
//
// 为什么需要：functions-cli 的部署包以入口文件为准，多文件/静态资源的支持有歧义
// （I5 实测 .txt 资源进不了部署包，官方文档又明示 index.ts + foo.ts 可多文件）。
// 为消除歧义、保证 compat 部署一定可用，部署包统一用本脚本生成的单文件。
// 本地开发与单测仍直接用 handler.ts（导出 handleRequest，不触发 Deno.serve）。
//
// 用法：node scripts/build-compat-function.mjs
// 部署：node scripts/build-compat-function.mjs &&
//       SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat \
//         -d supabase/functions/compat/dist --no-verify-jwt
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'supabase/functions/compat/handler.ts');
const outDir = join(root, 'supabase/functions/compat/dist');
const outFile = join(outDir, 'index.ts');

const source = readFileSync(src, 'utf8');
// handler.ts 导出 handleRequest 是给单测导入用的；部署包是普通入口模块，去掉 export
const body = source.replace(/^export async function handleRequest/m, 'async function handleRequest');
if (body === source) throw new Error('handler.ts 里找不到 export async function handleRequest，构建中止');

mkdirSync(outDir, { recursive: true });
const banner = [
  '// 本文件由 scripts/build-compat-function.mjs 从 compat/handler.ts 生成，请勿手改。',
  '// 部署：node scripts/build-compat-function.mjs && functions-cli deploy compat -d supabase/functions/compat/dist --no-verify-jwt',
  '',
].join('\n') + '\n';
const out = banner + body + '\nDeno.serve(handleRequest);\n';
writeFileSync(outFile, out);
console.log(`built ${outFile} (${Buffer.byteLength(out)} bytes)`);
