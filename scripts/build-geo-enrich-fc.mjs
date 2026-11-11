// 把地理富化函数打成 FC 事件函数上传包。
// 用法：node scripts/build-geo-enrich-fc.mjs
//
// 产物两个：
//   dist/geo-enrich.zip    代码包（不含 mmdb，~55KB）→ FC 控制台「代码上传」直接拖
//   dist/geoip-layer.zip   Layer 包（含 mmdb bundle，~52MB）→ FC 控制台「层」里上传
//
// 为什么 mmdb 走 Layer 而不是打进代码包：
//   FC 的 ZIP 直传上限 50MB，而 DB-IP City Lite 压缩后 51.6MB，压不进去；
//   OSS 上传（250MB）也行，但要跨到 OSS 控制台开桶传文件，比在 FC 里建 Layer 麻烦。
//   Layer 与函数都在 FC 控制台内，mmdb 还能独立于代码更新。
//
// 想把 mmdb 一起打进代码包（走 OSS 上传）：
//   node scripts/build-geo-enrich-fc.mjs --with-mmdb
import { cpSync, existsSync, mkdtempSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnDir = join(repo, 'fc/geo-enrich');
const bundleDir = join(fnDir, 'geoip');
const distDir = join(repo, 'dist');

const withMmdb = process.argv.includes('--with-mmdb');
const hasBundle = existsSync(bundleDir) && statSync(bundleDir).isDirectory();

function zipDir(srcDir, outPath) {
  rmSync(outPath, { force: true });
  execFileSync('zip', ['-qr', outPath, '.'], { cwd: srcDir });
  return statSync(outPath).size;
}

const tmp = mkdtempSync(join(tmpdir(), 'rxlink-geoenrich-'));
try {
  for (const f of ['index.js', 'lib.js', 'package.json']) {
    cpSync(join(fnDir, f), join(tmp, f));
  }
  cpSync(join(fnDir, 'node_modules'), join(tmp, 'node_modules'), { recursive: true });
  if (hasBundle && withMmdb) {
    cpSync(bundleDir, join(tmp, 'geoip'), { recursive: true });
  }

  mkdirSync(distDir, { recursive: true });

  const codeZip = join(distDir, 'geo-enrich.zip');
  const codeSize = zipDir(tmp, codeZip);
  console.log(`wrote ${codeZip}: ${(codeSize / 1024).toFixed(0)} KB`);
  console.log(
    codeSize <= 50 * 1024 * 1024
      ? '  ✅ 低于 50MB → FC 控制台「代码上传」直接拖这个'
      : '  ❌ 超过 50MB → 需改用 OSS 上传（上限 250MB）',
  );

  if (hasBundle) {
    const layerZip = join(distDir, 'geoip-layer.zip');
    const layerTmp = mkdtempSync(join(tmpdir(), 'rxlink-geoip-layer-'));
    try {
      cpSync(bundleDir, join(layerTmp, 'geoip'), { recursive: true });
      const layerSize = zipDir(layerTmp, layerZip);
      console.log(`wrote ${layerZip}: ${(layerSize / 1048576).toFixed(2)} MB`);
      console.log('  ✅ Layer 包：FC 控制台「层」创建层时上传这个，函数会自动在 /opt/geoip/ 找到');
    } finally {
      rmSync(layerTmp, { recursive: true, force: true });
    }
  } else {
    console.log('  ⚠ 没有 mmdb bundle（先跑 node scripts/build-geoip-bundle.mjs）');
    console.log('    没有它函数会退化成「运行时从 DB-IP 下载」：需开公网出口，且冷启动多约 15 秒');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
