// rxlink 地理富化函数（阿里云 FC 事件函数 exports.handler）
//
// 职责：把 visit.remote_addr 里的原始 IP 查成地理信息，写回 visit，然后清空 IP。
//   1. ensureReader：优先用代码包内自带的 mmdb；没有才从数据源下载
//   2. visits_pending_location：拉待富化批次
//   3. 本地查 mmdb（不发网络请求、不计费）
//   4. apply_visit_locations：写定位结果 + 清空 remote_addr
//
// 隐私：原始 IP 不写日志、不进回写 payload、不进契约；富化后立即清空，
//      7 天硬上限由库侧 retire_remote_addr() 兜底（见 docs/geo-enrichment.md §7）。
//
// 数据源：DB-IP City Lite（CC BY 4.0，允许商用与嵌入分发，需署名 "IP Geolocation by DB-IP"）。
//   - 默认随代码包分发（geoip/dbip-city-lite.mmdb.br），运行时不联网、无冷启动下载
//   - 包内没有时回退到 GEO_MMDB_URL 运行时下载（换源/自定义时用）
//
// 环境变量：
//   SUPABASE_URL              必填，FC 侧是 VPC 内网地址
//   SUPABASE_SERVICE_ROLE_KEY 必填
//   GEO_MMDB_PATH             默认 /tmp/dbip-city-lite.mmdb（解压后的落地位置）
//   GEO_MMDB_BUNDLE           默认 <代码包>/geoip/dbip-city-lite.mmdb.br；置空串可禁用
//   GEO_MMDB_URL              可选，覆盖运行时下载地址
//   GEO_MMDB_BASE             可选，覆盖下载源根路径
//   GEO_MMDB_MAX_AGE_DAYS     默认 14（落地文件的复用天数）
//   GEO_BATCH_LIMIT           默认 500（一批多少行）
//   GEO_MAX_BATCHES           默认 20（一轮最多处理几批）
//   GEO_TIME_BUDGET_MS        默认 45000（一轮的时间预算，防超时被杀）
//   GEO_DOWNLOAD_BACKOFF_MS   默认 3600000（下载失败退避 1 小时）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const maxmind = require('maxmind');
const lib = require('./lib');

function createHandler(deps = {}) {
  const {
    env = process.env,
    now = () => new Date(),
    fsPromises = fs.promises,
    gunzip = (buf) => zlib.gunzipSync(buf),
    brotliDecompress = (buf) => zlib.brotliDecompressSync(buf),
    openReader = (p) => maxmind.open(p),
    fetchImpl = (...args) => globalThis.fetch(...args),
    log = (...a) => console.log(...a),
    rpc: rpcOverride = null,
  } = deps;

  const mmdbPath = env.GEO_MMDB_PATH || '/tmp/dbip-city-lite.mmdb';
  const failMarkPath = `${mmdbPath}.last_fail`;
  // mmdb bundle 的候选位置，按顺序取第一个存在的：
  //   1. GEO_MMDB_BUNDLE 显式指定（置空串 = 全部禁用，只走运行时下载）
  //   2. 代码包内 geoip/（把 mmdb 一起打进代码包时）
  //   3. FC Layer 挂载点 /opt/geoip/（把 mmdb 做成 Layer 时）
  const bundleCandidates = env.GEO_MMDB_BUNDLE !== undefined
    ? (env.GEO_MMDB_BUNDLE ? [env.GEO_MMDB_BUNDLE] : [])
    : [
      path.join(__dirname, 'geoip', 'dbip-city-lite.mmdb.br'),
      '/opt/geoip/dbip-city-lite.mmdb.br',
    ];
  const maxAgeDays = Number(env.GEO_MMDB_MAX_AGE_DAYS || 14);
  const batchLimit = Number(env.GEO_BATCH_LIMIT || 500);
  const maxBatches = Number(env.GEO_MAX_BATCHES || 20);
  const timeBudgetMs = Number(env.GEO_TIME_BUDGET_MS || 45000);
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

  async function statSafe(p) {
    try {
      return await fsPromises.stat(p);
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

  // 写临时文件再改名：避免半截文件被当成有效数据库
  async function writeAtomic(target, data) {
    const tmp = `${target}.tmp`;
    await fsPromises.writeFile(tmp, data);
    await fsPromises.rename(tmp, target);
  }

  // 下载源可能带凭据（换数据源时），所以错误信息里要把 URL 抹掉再记日志
  function scrub(msg, url) {
    let s = msg ? String(msg) : 'unknown';
    if (url) s = s.split(url).join('<url>');
    return s;
  }

  // 代码包内 / Layer 里自带的 mmdb：
  //   .br / .gz → 解压到 /tmp 再读（/code 与 /opt 都只读）
  //   原始 .mmdb → 直接从只读目录读，零解压、零 /tmp 占用
  async function openBundledReader() {
    for (const candidate of bundleCandidates) {
      const stat = await statSafe(candidate);
      if (!stat) continue;
      try {
        if (/\.br$/i.test(candidate)) {
          const raw = await fsPromises.readFile(candidate);
          const mmdb = brotliDecompress(raw);
          await writeAtomic(mmdbPath, mmdb);
          log(`[geo-enrich] bundled mmdb expanded bytes=${mmdb.length}`);
          return await openReader(mmdbPath);
        }
        if (/\.gz$/i.test(candidate)) {
          const raw = await fsPromises.readFile(candidate);
          const mmdb = gunzip(raw);
          await writeAtomic(mmdbPath, mmdb);
          log(`[geo-enrich] bundled mmdb expanded bytes=${mmdb.length}`);
          return await openReader(mmdbPath);
        }
        return await openReader(candidate);
      } catch (err) {
        log('[geo-enrich] bundled mmdb failed:', scrub(err && err.message, null));
        return null;
      }
    }
    return null;
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
      await writeAtomic(mmdbPath, mmdb);
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
    // 1) /tmp 里有新鲜的落地文件就直接用
    const stat = await statSafe(mmdbPath);
    if (stat && !lib.isStale(stat.mtimeMs, nowMs(), maxAgeDays)) {
      try {
        return await openReader(mmdbPath);
      } catch {
        // 落地的文件坏了，往下走重新准备
      }
    }
    // 2) 代码包内自带（不联网，冷启动零下载）
    const bundled = await openBundledReader();
    if (bundled) return bundled;
    // 3) 运行时下载（包内没有时兜底）
    const ok = await downloadMmdb();
    if (!ok) return null;
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
        // 时间预算：别让一轮跑太久被平台超时杀掉（超时设 60s，预算 45s）
        if (nowMs() - startedAt > timeBudgetMs) {
          log('[geo-enrich] time budget reached, stop early');
          break;
        }
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
