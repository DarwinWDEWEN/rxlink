// 把 shlink-web-client 的 build 产物内联成单文件 Edge Function。
// functions-cli 只上传入口文件，不做静态资源打包，所以必须内联。
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const root = 'shlink-web-client/build';
const outDir = 'supabase/functions/console';
const outFile = join(outDir, 'index.ts');
const template = readFileSync('scripts/console-function.template.ts', 'utf8');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(root).sort();
const lines = files.map((file) => {
  const rel = `/${relative(root, file).split('\\').join('/')}`;
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const b64 = readFileSync(file).toString('base64');
  return `  ${JSON.stringify(rel)}: { t: ${JSON.stringify(type)}, b: ${JSON.stringify(b64)} },`;
});

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, template.replace('/*__ASSETS__*/', lines.join('\n')));
console.log(`wrote ${outFile}: ${files.length} assets, ${(statSync(outFile).size / 1024 / 1024).toFixed(2)} MB`);
