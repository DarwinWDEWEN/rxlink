// 地理富化的纯逻辑：URL 拼装、记录 → 定位字段、查表安全包装、批次映射、时效判断
// 与运行环境无关，便于单测；index.js 负责 IO（下载 / 落盘 / RPC）。

// DB-IP City Lite：免注册免 key 的 MMDB 下载源，CC BY 4.0 允许商用（需署名）。
// 文件名带发布年月，所以按当前 UTC 月份拼 URL。
const DBIP_BASE = 'https://download.db-ip.com/free';

function buildMmdbUrl(now, base = DBIP_BASE) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${base}/dbip-city-lite-${y}-${m}.mmdb.gz`;
}

// names 是 {'en': 'San Francisco', 'zh-CN': '旧金山'}；优先英文，取不到就退第一个
function pickName(names) {
  if (!names) return '';
  if (names.en) return names.en;
  const first = Object.values(names)[0];
  return first || '';
}

// MMDB 记录 → 定位字段（DB-IP 与 GeoLite2 同为 GeoIP2 City 布局）
// 缺失一律给空串：SQL 侧 nullif(x,'') 会转成 NULL，契约里就是「无此字段」
//
// 已知限制：DB-IP City Lite 的 location 只有 latitude/longitude，**没有 time_zone**，
//   所以 timezone 恒为空。契约 ShlinkVisitLocation.timezone 允许 null，
//   控制台也不渲染它（只渲染 country/region/city/latitude/longitude），不影响使用。
//   要时区就把 GEO_MMDB_URL 指向带 time_zone 的库（IP2Location LITE / GeoLite2）。
function locationOf(record) {
  if (!record) {
    return {
      country_code: '', country_name: '', region_name: '',
      city_name: '', lat: '', lon: '', timezone: '',
    };
  }
  const country = record.country || null;
  const sub = Array.isArray(record.subdivisions) ? record.subdivisions[0] : null;
  const loc = record.location || null;
  return {
    country_code: (country && country.iso_code) || '',
    country_name: pickName(country && country.names),
    region_name: pickName(sub && sub.names),
    city_name: pickName(record.city && record.city.names),
    // 0 是合法坐标，不能用 || '' 抹掉
    lat: loc && loc.latitude != null ? String(loc.latitude) : '',
    lon: loc && loc.longitude != null ? String(loc.longitude) : '',
    timezone: (loc && loc.time_zone) || '',
  };
}

// reader.get() 不校验 IP：'1.2.3' 也会返回个国家。这里先 validate 再查，
// 异常一律吞成 null（一条脏 IP 不该让整批失败）。
function makeLookup(reader, validate) {
  return (ip) => {
    if (!ip) return null;
    try {
      if (typeof validate === 'function' && !validate(ip)) return null;
      return reader.get(ip) || null;
    } catch {
      return null;
    }
  };
}

// 待富化批次 → 回写 payload。
// 查不到的 IP 也要产出一行（字段全空）：否则 remote_addr 永远清不掉，
// 每轮都会被重复捞取。产出的 payload 不含原始 IP。
function enrichRows(rows, lookup) {
  return rows.map((row) => ({
    id: row.id,
    occurred_at: row.occurred_at,
    ...locationOf(lookup(row.remote_addr)),
  }));
}

function isStale(mtimeMs, nowMs, maxAgeDays) {
  if (!mtimeMs) return true; // 文件不存在
  return nowMs - mtimeMs > maxAgeDays * 86400000;
}

// 下载失败后有一段退避期，期间不再打数据源
function shouldDownload(lastFailMs, nowMs, backoffMs) {
  if (!lastFailMs) return true;
  return nowMs - lastFailMs >= backoffMs;
}

module.exports = {
  DBIP_BASE,
  buildMmdbUrl,
  pickName,
  locationOf,
  makeLookup,
  enrichRows,
  isStale,
  shouldDownload,
};
