// 构建地理富化用的 DB-IP City Lite mmdb bundle
//
// 用法：node scripts/build-geoip-bundle.mjs [YYYY-MM]
//   不带参数 = 当前 UTC 月份。产物：fc/geo-enrich/geoip/dbip-city-lite.mmdb.br
//
// 为什么是 .br（brotli）：
//   DB-IP 的原始 mmdb 是 121MB，gzip 后 58MB，brotli 再小一截。
//   Node 内置 zlib 支持 brotli 解压，运行时就地解压 0.7 秒，不需要额外依赖。
//
// 许可：DB-IP City Lite 是 CC BY 4.0，允许商用与嵌入分发，
//   条件是在展示/使用结果的页面署名 "IP Geolocation by DB-IP"（见 docs/geo-enrichment.md §0）。
//
// 月更：DB-IP 每月初发布新版本 → 跑本脚本 → 重新打包部署。
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createBrotliCompress, constants } from 'node:zlib';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT_DIR = path.join(ROOT, 'fc/geo-enrich/geoip');
const OUT_FILE = path.join(OUT_DIR, 'dbip-city-lite.mmdb.br');
const WORK_DIR = path.join(ROOT, 'dist/.geoip-tmp');

const BASE = process.env.GEO_MMDB_BASE || 'https://download.db-ip.com/free';

function monthTag() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  const tag = process.argv[2] || monthTag();
  const url = `${BASE}/dbip-city-lite-${tag}.mmdb.gz`;

  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  const raw = path.join(WORK_DIR, 'dbip-city-lite.mmdb');
  const gz = path.join(WORK_DIR, 'dbip-city-lite.mmdb.gz');

  console.log(`[geoip] 下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[geoip] 下载失败: HTTP ${res.status} —— ${tag} 这个版本可能还没发布`);
    process.exit(1);
  }
  await pipeline(res.body, createWriteStream(gz));

  console.log('[geoip] 解 gunzip');
  await pipeline(createReadStream(gz), createGunzip(), createWriteStream(raw));

  const rawSize = (await stat(raw)).size;
  console.log(`[geoip] 原始 mmdb: ${(rawSize / 1048576).toFixed(1)} MB`);

  console.log('[geoip] brotli 压缩（q6：4 秒 / 51.6MB；q11 要 20+ 分钟且只省 2MB，不划算）…');
  await pipeline(createReadStream(raw), createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 6,
      [constants.BROTLI_PARAM_SIZE_HINT]: rawSize,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
    },
  }), createWriteStream(OUT_FILE));

  const outSize = (await stat(OUT_FILE)).size;
  console.log(`[geoip] 产物: ${OUT_FILE}`);
  console.log(`[geoip] 压缩后: ${(outSize / 1048576).toFixed(2)} MB`);
  console.log(`[geoip] FC ZIP 直传上限 50MB → ${outSize <= 50 * 1024 * 1024 ? '✅ 可以直接 ZIP 上传' : '❌ 超限，需用 OSS 上传（上限 250MB）'}`);

  await rm(WORK_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('[geoip] 构建失败:', err && err.message);
  process.exit(1);
});
