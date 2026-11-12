// 中国省级 IP 查表（纯函数，零依赖）
// 数据文件 china-geo.bin 由 scripts/build-china-geo.mjs 从 DB-IP City Lite mmdb 生成。
//
// 二进制格式（小端 / 大端按字段标注）：
//   头部 16 字节：
//     magic         6 字节 "CNGEO1"
//     provCount     uint16 LE
//     nameBytes     uint32 LE
//     intervalCount uint32 LE
//   省名表（provCount 条）：
//     enLen uint8, en bytes(UTF-8), zhLen uint8, zh bytes(UTF-8)
//   区间表（intervalCount 条，按 start 升序，每条 9 字节）：
//     start uint32 BE, end uint32 BE, provId uint8
//
// 区间表已经是「扁平不重叠」的结果（构建期按最长前缀优先归并过），
// 运行时只做二分查找，不再做前缀比较。

const MAGIC = 'CNGEO1';

function parse(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('china-geo: 需要 Buffer');
  if (buffer.length < 16) throw new Error('china-geo: 文件过短');
  if (buffer.toString('ascii', 0, 6) !== MAGIC) throw new Error('china-geo: 魔数不对');

  const provCount = buffer.readUInt16LE(6);
  const nameBytes = buffer.readUInt32LE(8);
  const intervalCount = buffer.readUInt32LE(12);

  const provinces = [];
  let off = 16;
  for (let i = 0; i < provCount; i++) {
    const enLen = buffer.readUInt8(off); off += 1;
    const en = buffer.toString('utf8', off, off + enLen); off += enLen;
    const zhLen = buffer.readUInt8(off); off += 1;
    const zh = buffer.toString('utf8', off, off + zhLen); off += zhLen;
    provinces.push({ en, zh });
  }
  if (off !== 16 + nameBytes) throw new Error('china-geo: 省名表长度不符');

  const intervals = new Array(intervalCount);
  for (let i = 0; i < intervalCount; i++) {
    const base = off + i * 9;
    intervals[i] = {
      start: buffer.readUInt32BE(base),
      end: buffer.readUInt32BE(base + 4),
      provId: buffer.readUInt8(base + 8),
    };
  }
  return { provinces, intervals };
}

function ipToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v >>> 0;
}

function createLookup(buffer) {
  const { provinces, intervals } = parse(buffer);
  return function lookup(ip) {
    const v = ipToInt(ip);
    if (v === null) return null;
    // 找最后一个 start <= v 的区间
    let lo = 0;
    let hi = intervals.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (intervals[mid].start <= v) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (found < 0) return null;
    const iv = intervals[found];
    if (v > iv.end) return null;
    const p = provinces[iv.provId];
    if (!p) return null;
    return { province: p.en, provinceZh: p.zh };
  };
}

module.exports = { parse, createLookup, ipToInt };
