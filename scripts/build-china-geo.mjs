// 构建中国省级 IP 查表：DB-IP City Lite mmdb → fc/redirect/china-geo.bin
//
// 用法：node scripts/build-china-geo.mjs
// 输入：fc/geo-enrich/geoip/dbip-city-lite.mmdb.br（由 scripts/build-geoip-bundle.mjs 生成）
// 输出：fc/redirect/china-geo.bin（构建产物，已 gitignore）
//
// 算法（与 mmdb 语义一致）：
//   1) 遍历 mmdb 搜索树，收集所有 country.iso_code = 'CN' 的叶子前缀 (start, prefixLen, province)
//   2) 收集所有前缀边界 → 基本区间
//   3) 扫基本区间，用「按 prefixLen 优先的最大堆」求每个区间的最长匹配前缀
//   4) 相邻同省合并 → 扁平不重叠区间表
//
// 为什么必须做最长前缀归并：MMDB 里同一个数据指针被多个前缀共享，
// 直接按 start 排序取「最后一条 start ≤ v」会错配约 0.66% 的 IP。
// 本脚本末尾自带随机对拍（与 reader.get() 比对），错配数必须为 0。
//
// 许可：DB-IP City Lite 是 CC BY 4.0，允许商用与嵌入分发，
//   条件是在展示/使用结果的页面署名 "IP Geolocation by DB-IP"（见 docs/geo-enrichment.md §0）。
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MMDB_BR = path.join(ROOT, 'fc/geo-enrich/geoip/dbip-city-lite.mmdb.br');
const OUT = path.join(ROOT, 'fc/redirect/china-geo.bin');
const { Reader } = require(path.join(ROOT, 'fc/geo-enrich/node_modules/mmdb-lib'));

// DB-IP 的 subdivision 只有英文名；中文名来自这张表（31 个省级行政区）
const PROVINCE_ZH = {
  Beijing: '北京', Tianjin: '天津', Shanghai: '上海', Chongqing: '重庆',
  Hebei: '河北', Shanxi: '山西', Liaoning: '辽宁', Jilin: '吉林',
  Heilongjiang: '黑龙江', Jiangsu: '江苏', Zhejiang: '浙江', Anhui: '安徽',
  Fujian: '福建', Jiangxi: '江西', Shandong: '山东', Henan: '河南',
  Hubei: '湖北', Hunan: '湖南', Guangdong: '广东', Guangxi: '广西',
  Hainan: '海南', Sichuan: '四川', Guizhou: '贵州', Yunnan: '云南',
  Tibet: '西藏', Shaanxi: '陕西', Gansu: '甘肃', Qinghai: '青海',
  Ningxia: '宁夏', Xinjiang: '新疆', 'Inner Mongolia': '内蒙古',
};

function lowerBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// 按 prefixLen 大者优先的最大堆
class MaxHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  peek() { return this.a[0]; }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].bits >= a[i].bits) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].bits > a[m].bits) m = l;
        if (r < a.length && a[r].bits > a[m].bits) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function main() {
  if (!existsSync(MMDB_BR)) {
    console.error(`找不到 ${MMDB_BR}\n先跑：node scripts/build-geoip-bundle.mjs`);
    process.exit(1);
  }
  console.log('[china-geo] 解压 mmdb…');
  const db = brotliDecompressSync(readFileSync(MMDB_BR));
  const reader = new Reader(db);
  const meta = reader.metadata;
  const nodeCount = meta.nodeCount;
  const walker = reader.walker;
  const ipv4Start = reader.ipv4StartNodeNumber;

  // 1) 收集 CN 前缀
  console.log('[china-geo] 遍历 mmdb 树…');
  const t0 = Date.now();
  const entries = [];
  const stack = [[ipv4Start, 0, 0]];
  while (stack.length) {
    const [node, depth, acc] = stack.pop();
    if (node >= nodeCount) {
      if (node > nodeCount) {
        let rec = null;
        try { rec = reader.resolveDataPointer(node); } catch { continue; }
        if (rec && rec.country && rec.country.iso_code === 'CN') {
          const sub = Array.isArray(rec.subdivisions) ? rec.subdivisions[0] : null;
          const en = (sub && sub.names && sub.names.en) || '';
          const size = 2 ** (32 - depth);
          entries.push({ start: acc * size, bits: depth, prov: en, end: acc * size + size - 1 });
        }
      }
      continue;
    }
    const offset = node * meta.nodeByteSize;
    stack.push([walker.right(offset), depth + 1, acc * 2 + 1]);
    stack.push([walker.left(offset), depth + 1, acc * 2]);
  }
  console.log(`[china-geo] CN 前缀 ${entries.length} 条（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  // 2) 边界
  const boundSet = new Set();
  for (const e of entries) { boundSet.add(e.start); boundSet.add(e.end + 1); }
  const bounds = [...boundSet].sort((a, b) => a - b);
  for (const e of entries) {
    e.iStart = lowerBound(bounds, e.start);
    e.iEnd = lowerBound(bounds, e.end + 1);
  }

  // 3) 扫 + 堆 → 最长前缀优先
  const byStart = new Map();
  for (const e of entries) {
    if (!byStart.has(e.iStart)) byStart.set(e.iStart, []);
    byStart.get(e.iStart).push(e);
  }
  const startsSorted = [...byStart.keys()].sort((a, b) => a - b);
  const heap = new MaxHeap();
  const flat = [];
  let si = 0;
  for (let i = 0; i < bounds.length - 1; i++) {
    while (si < startsSorted.length && startsSorted[si] <= i) {
      for (const e of byStart.get(startsSorted[si])) heap.push(e);
      si++;
    }
    while (heap.size && heap.peek().iEnd <= i) heap.pop();
    if (!heap.size) continue;
    const win = heap.peek();
    const segStart = bounds[i];
    const segEnd = bounds[i + 1] - 1;
    const last = flat[flat.length - 1];
    if (last && last.prov === win.prov && last.end + 1 === segStart) last.end = segEnd;
    else flat.push({ start: segStart, end: segEnd, prov: win.prov });
  }
  console.log(`[china-geo] 扁平区间 ${flat.length} 条`);

  // 4) 省名表
  const provList = [];
  const provIndex = new Map();
  for (const f of flat) {
    if (provIndex.has(f.prov)) continue;
    provIndex.set(f.prov, provList.length);
    provList.push({ en: f.prov, zh: PROVINCE_ZH[f.prov] || '' });
  }
  const unknown = provList.filter((p) => !PROVINCE_ZH[p.en] && p.en !== '');
  if (unknown.length) {
    console.warn(`[china-geo] ⚠ 这些省名没有中文映射（只能用英文名匹配）：${unknown.map((p) => p.en).join(', ')}`);
  }
  console.log(`[china-geo] 省名 ${provList.length} 个`);

  // 5) 编码
  const nameChunks = [];
  let nameBytes = 0;
  for (const p of provList) {
    const en = Buffer.from(p.en, 'utf8');
    const zh = Buffer.from(p.zh, 'utf8');
    nameChunks.push(Buffer.from([en.length]), en, Buffer.from([zh.length]), zh);
    nameBytes += 2 + en.length + zh.length;
  }
  const header = Buffer.alloc(16);
  Buffer.from('CNGEO1', 'ascii').copy(header, 0);
  header.writeUInt16LE(provList.length, 6);
  header.writeUInt32LE(nameBytes, 8);
  header.writeUInt32LE(flat.length, 12);
  const entriesBuf = Buffer.alloc(flat.length * 9);
  flat.forEach((iv, i) => {
    entriesBuf.writeUInt32BE(iv.start, i * 9);
    entriesBuf.writeUInt32BE(iv.end, i * 9 + 4);
    entriesBuf.writeUInt8(provIndex.get(iv.prov), i * 9 + 8);
  });
  const out = Buffer.concat([header, Buffer.concat(nameChunks), entriesBuf]);
  writeFileSync(OUT, out);
  console.log(`[china-geo] 写入 ${OUT}（${(out.length / 1024).toFixed(0)} KB）`);

  // 6) 自检：随机 IP 与 reader.get() 对拍
  let mismatch = 0;
  let hits = 0;
  const N = 200000;
  const t1 = Date.now();
  for (let i = 0; i < N; i++) {
    const a = Math.floor(Math.random() * 224);
    const b = Math.floor(Math.random() * 256);
    const c = Math.floor(Math.random() * 256);
    const d = Math.floor(Math.random() * 256);
    const ip = `${a}.${b}.${c}.${d}`;
    const rec = reader.get(ip);
    const expected = rec && rec.country && rec.country.iso_code === 'CN'
      ? (((rec.subdivisions || [])[0] || {}).names || {}).en || null
      : null;
    const got = lookupFlat(flat, a * 16777216 + b * 65536 + c * 256 + d);
    if (got) hits++;
    if (expected !== got) {
      mismatch++;
      if (mismatch <= 5) console.error(`  MISMATCH ${ip} expected=${expected} got=${got}`);
    }
  }
  console.log(`[china-geo] 自检：${N} 个随机 IP，命中 ${hits}，失配 ${mismatch}（耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s）`);
  if (mismatch > 0) {
    console.error('[china-geo] ❌ 自检失败，产物不可信');
    process.exit(1);
  }
  console.log('[china-geo] ✅ 自检通过');
}

function lookupFlat(flat, v) {
  let lo = 0;
  let hi = flat.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flat[mid].start <= v) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return null;
  return v <= flat[found].end ? flat[found].prov : null;
}

main();
