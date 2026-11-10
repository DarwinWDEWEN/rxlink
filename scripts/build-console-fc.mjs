// 把控制台 build 产物 + fc/console/index.js 打成 FC Web 函数上传包。
// 用法：node scripts/build-console-fc.mjs
// 产物：dist/console.zip（在 FC 控制台函数「代码上传」里直接用）
import { cpSync, mkdtempSync, rmSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(repo, 'shlink-web-client/build');
const fnDir = join(repo, 'fc/console');
const zipPath = join(repo, 'dist/console.zip');

if (!statSync(buildDir).isDirectory()) {
  console.error(`missing ${buildDir}; run the console build first`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'rxlink-console-'));
try {
  cpSync(join(fnDir, 'index.js'), join(tmp, 'index.js'));
  cpSync(join(fnDir, 'package.json'), join(tmp, 'package.json'));
  cpSync(buildDir, join(tmp, 'build'), { recursive: true });

  mkdirSync(dirname(zipPath), { recursive: true });
  rmSync(zipPath, { force: true });
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: tmp });

  const count = (dir) =>
    readdirSync(dir, { withFileTypes: true }).reduce(
      (n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1),
      0,
    );
  const assets = count(join(tmp, 'build'));
  const size = (statSync(zipPath).size / 1024).toFixed(0);
  console.log(`wrote ${zipPath}: ${assets} assets, ${size} KB`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
