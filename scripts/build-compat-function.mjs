// 把 compat/handler.ts 打成单文件部署包（supabase/functions/compat/dist/index.ts）。
//
// 为什么需要：functions-cli 的部署包以入口文件为准，多文件/静态资源的支持有歧义
// （I5 实测 .txt 资源进不了部署包，官方文档又明示 index.ts + foo.ts 可多文件）。
// 为消除歧义、保证 compat 部署一定可用，部署包统一用本脚本生成的单文件。
// 本地开发与单测仍直接用 handler.ts（导出 handleRequest，不触发 Deno.serve）。
//
// I10：handler.ts 开始 import 本地模块（./title-resolver.ts）。部署包是单文件，
// 所以本地相对 import 必须**内联**进产物 —— 否则入口的 import 会指向一个
// 不在部署包里的模块，运行时直接加载失败。本脚本按依赖顺序内联，并做两层保护：
//   1. 顶层声明重名 → 构建中止（内联后同名会互相覆盖）
//   2. 出现非相对 import（npm 包 / node: 内置）→ 构建中止（无法内联）
//
// 用法：node scripts/build-compat-function.mjs
// 部署：node scripts/build-compat-function.mjs &&
//       SUPABASE_API_KEY="$SUPABASE_SERVICE_ROLE_KEY" /tmp/functions-cli deploy compat \
//         -d supabase/functions/compat/dist --no-verify-jwt
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'supabase/functions/compat/handler.ts');
const outDir = join(root, 'supabase/functions/compat/dist');
const outFile = join(outDir, 'index.ts');

// 单行 import 语句（不含分号，跨行的 import 会被下面的「残留检查」抓到并中止）
const IMPORT_RE = /^[ \t]*import\s+[^;]*?from\s*['"]([^'"]+)['"];?[ \t]*$/gm;
// 顶层声明的名字（用于重名检查）
const DECL_RE = /^(?:export\s+)?(?:declare\s+)?(?:const|let|var|function|async\s+function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
// 内联模块时要去掉的 export 关键字
const EXPORT_PREFIX_RE = /^export\s+(?=(?:declare\s+)?(?:const|let|var|function|async\s+function|class|type|interface|enum)\b)/gm;

function readModule(file) {
  return readFileSync(file, 'utf8');
}

function importsOf(source) {
  const out = [];
  for (const m of source.matchAll(IMPORT_RE)) out.push(m[1]);
  return out;
}

function declaredNames(source) {
  const names = new Set();
  for (const m of source.matchAll(DECL_RE)) names.add(m[1]);
  return names;
}

// 收集「所有 import 语句」的文本区间，用来判断是否残留
function stripImports(source) {
  return source.replace(IMPORT_RE, '');
}

function inlineLocalImports(entryFile) {
  const seen = new Set();
  const owners = new Map();
  const chunks = [];

  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readModule(file);

    for (const name of declaredNames(source)) {
      const prev = owners.get(name);
      if (prev && prev !== file) {
        throw new Error(`顶层声明重名：${name}（${prev} 与 ${file}）→ 内联后会互相覆盖，构建中止`);
      }
      owners.set(name, file);
    }

    // 先递归处理依赖，保证依赖的代码排在前面
    for (const spec of importsOf(source)) {
      if (!spec.startsWith('.')) {
        throw new Error(`${file} 里有非相对 import（${spec}）→ 无法内联进单文件，构建中止`);
      }
      visit(resolvePath(dirname(file), spec));
    }

    let body = stripImports(source);
    if (body.includes('\nimport ') || /^[ \t]*import\s/m.test(body)) {
      throw new Error(`${file} 里有本脚本处理不了的 import（跨行写法？）→ 构建中止`);
    }
    // 被内联的模块去掉 export 关键字；入口模块保留（titleResolverDeps 是测试钩子）
    if (file !== entryFile) {
      body = body.replace(EXPORT_PREFIX_RE, '');
    }
    chunks.push({ file, body });
  }

  visit(entryFile);
  return chunks;
}

const chunks = inlineLocalImports(src);
let entry = chunks.find((c) => c.file === src);
if (!entry) throw new Error(`入口模块 ${src} 不在结果里，构建中止`);

// handler.ts 导出 handleRequest 是给单测导入用的；部署包是普通入口模块，去掉 export
const entryBody = entry.body.replace(/^export async function handleRequest/m, 'async function handleRequest');
if (entryBody === entry.body) {
  throw new Error('handler.ts 里找不到 export async function handleRequest，构建中止');
}
entry = { file: entry.file, body: entryBody };

mkdirSync(outDir, { recursive: true });
const banner = [
  '// 本文件由 scripts/build-compat-function.mjs 从 compat/handler.ts 生成，请勿手改。',
  '// 部署：node scripts/build-compat-function.mjs && functions-cli deploy compat -d supabase/functions/compat/dist --no-verify-jwt',
  '',
].join('\n') + '\n';
const out = banner + chunks.map((c) => c.body).join('\n\n') + '\nDeno.serve(handleRequest);\n';
writeFileSync(outFile, out);
console.log(`built ${outFile} (${Buffer.byteLength(out)} bytes)`);
console.log(`inlined ${chunks.length - 1} local module(s): ${chunks.slice(0, -1).map((c) => c.file).join(', ') || '(none)'}`);
