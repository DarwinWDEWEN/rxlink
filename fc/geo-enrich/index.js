// rxlink 地理富化函数（阿里云 FC 事件函数 exports.handler）
//
// 职责：把 visit.remote_addr 里的原始 IP 查成地理信息，写回 visit，然后清空 IP。
//   1. ensureMmdb：/tmp 下没有或过期 → 从数据源下载 → 解压 → 落盘
//   2. visits_pending_location：拉待富化批次
//   3. 本地查 mmdb（不发网络请求、不计费）
//   4. apply_visit_locations：写定位结果 + 清空 remote_addr
//
// 隐私：原始 IP 不写日志、不进回写 payload、不进契约；富化后立即清空，
//      7 天硬上限由库侧 retire_remote_addr() 兜底（见 docs/geo-enrichment.md §7）。
//
// 环境变量：
//   SUPABASE_URL              必填，FC 侧是 VPC 内网地址
//   SUPABASE_SERVICE_ROLE_KEY 必填
//   GEO_MMDB_PATH             默认 /tmp/dbip-city-lite.mmdb
//   GEO_MMDB_URL              可选，覆盖下载地址（换数据源时用）
//   GEO_MMDB_BASE             可选，覆盖下载源根路径
//   GEO_MMDB_MAX_AGE_DAYS    默认 14
//   GEO_BATCH_LIMIT           默认 500
//   GEO_MAX_BATCHES           默认 5（一轮最多处理几批）
//   GEO_DOWNLOAD_BACKOFF_MS   默认 3600000（1 小时）
const fs = require('fs');
const zlib = require('zlib');
const maxmind = require('maxmind');
const lib = require('./lib');

const DAY = 86400000;

function createHandler(deps = {}) {
  const {
    env = process.env,
    now = () => new Date(),
    fsPromises = fs.promises,
    gunzip = (buf) => zlib.gunzipSync(buf),
    openReader = (p) => maxmind.open(p),
    fetchImpl = (...args) => globalThis.fetch(...args),
    log = (...a) => console.log(...a),
    rpc: rpcOverride = null,
  } = deps;

  const mmdbPath = env.GEO_MMDB_PATH || '/tmp/dbip-city-lite.mmdb';
  const failMarkPath = `${mmdbPath}.last_fail`;
  const maxAgeDays = Number(env.GEO_MMDB_MAX_AGE_DAYS || 14);
  const batchLimit = Number(env.GEO_BATCH_LIMIT || 500);
  const maxBatches = Number(env.GEO_MAX_BATCHES || 5);
  const backoffMs = Number(env.GEO_DOWNLOAD_BACKOFF_MS || 3600000);

  const base = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';

  // 全函数统一用注入的时间源，便于单测确定性
  const nowMs = () => now().getTime();

  // PostgREST RPC 通道。头里带 service role key —— 任何日志都不得回显它。
  async function rpc(name, body) {
    const res = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`rpc ${name} failed: ${res.status}`);
    return res.json();
  }
  const callRpc = rpcOverride || rpc;

  async function statSafe(path) {
    try {
      return await fsPromises.stat(path);
    } catch {
      return null;
    }
  }

  async function readFailMark() {
    try {
      const raw = await fsPromises.readFile(failMarkPath, 'utf8');
      const n = Number(String(raw).trim());
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  async function clearFailMark() {
    try {
      await fsPromises.writeFile(failMarkPath, '');
    } catch {
      // 清标记失败不影响主流程
    }
  }

  // 下载源可能带凭据（换数据源时），所以错误信息里要把 URL 抹掉再记日志
  function scrub(msg, url) {
    let s = msg ? String(msg) : 'unknown';
    if (url) s = s.split(url).join('<url>');
    return s;
  }

  async function downloadMmdb() {
    const t = nowMs();
    const lastFail = await readFailMark();
    if (!lib.shouldDownload(lastFail, t, backoffMs)) {
      log('[geo-enrich] mmdb download in backoff, skip');
      return false;
    }
    const url = env.GEO_MMDB_URL || lib.buildMmdbUrl(now(), env.GEO_MMDB_BASE || lib.DBIP_BASE);
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`http ${res.status}`);
      const raw = Buffer.from(await res.arrayBuffer());
      const mmdb = gunzip(raw);
      // 先写临时文件再改名，避免半截文件被当成有效数据库
      const tmp = `${mmdbPath}.tmp`;
      await fsPromises.writeFile(tmp, mmdb);
      await fsPromises.rename(tmp, mmdbPath);
      await clearFailMark();
      log(`[geo-enrich] mmdb downloaded bytes=${mmdb.length}`);
      return true;
    } catch (err) {
      try {
        await fsPromises.writeFile(failMarkPath, String(nowMs()));
      } catch {
        // 写不了失败标记就退化成「每轮都重试」，不影响正确性
      }
      log('[geo-enrich] mmdb download failed:', scrub(err && err.message, url));
      return false;
    }
  }

  async function ensureReader() {
    const stat = await statSafe(mmdbPath);
    if (!stat || lib.isStale(stat.mtimeMs, nowMs(), maxAgeDays)) {
      const ok = await downloadMmdb();
      if (!ok) return null;
    }
    try {
      return await openReader(mmdbPath);
    } catch (err) {
      log('[geo-enrich] mmdb open failed:', scrub(err && err.message, null));
      return null;
    }
  }

  return async function handler(event, context) {
    const startedAt = nowMs();
    if (!base || !key) {
      log('[geo-enrich] not configured, skip');
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
    }

    const reader = await ensureReader();
    if (!reader) {
      // 没有 mmdb 就这轮不做事：远程 IP 还在库里等下一轮，7 天兜底 cron 兜底
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'mmdb_unavailable' }) };
    }
    const lookup = lib.makeLookup(reader, maxmind.validate);

    let batches = 0;
    let pulled = 0;
    let updated = 0;
    try {
      for (let i = 0; i < maxBatches; i++) {
        const rows = await callRpc('visits_pending_location', { p_limit: batchLimit });
        if (!Array.isArray(rows) || rows.length === 0) break;
        batches++;
        pulled += rows.length;
        const payload = lib.enrichRows(rows, lookup);
        const n = await callRpc('apply_visit_locations', { p_rows: payload });
        updated += Number(n || 0);
        if (rows.length < batchLimit) break; // 这一批没满，说明已经拉干净
      }
    } catch (err) {
      log('[geo-enrich] batch failed:', scrub(err && err.message, null));
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: false, reason: 'batch_failed', batches, pulled, updated }),
      };
    }

    // 日志只有计数，没有任何 IP
    log(`[geo-enrich] batches=${batches} pulled=${pulled} updated=${updated} ms=${nowMs() - startedAt}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, batches, pulled, updated }),
    };
  };
}

// FC 事件函数入口：exports.handler = async (event, context) => {...}
exports.handler = createHandler();
exports.createHandler = createHandler;
