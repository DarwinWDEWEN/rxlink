// 跳转函数的常驻映射快照：全量装进实例内存，用库里单行 seq 做变更驱动失效。
// 命中与「确认不存在」都不打库；未就绪、或命中「限次链接」时由调用方回落查库。

const POLL_MS = Number(process.env.CACHE_POLL_MS || 5000);
// 超过这个条数只报警并整体退回查库，不做 LRU——映射本身很小，半缓存会把失效问题变复杂。
const SNAPSHOT_LIMIT = Number(process.env.CACHE_SNAPSHOT_LIMIT || 20000);

let byDomain = new Map();
let byGlobal = new Map();
let seq = null;
let ready = false;
let oversized = false;
let rows = 0;
let loadedAt = 0;
let reloads = 0;
let warned = false;
let fetchers = null;

function entryOf(row) {
  return {
    id: row.id,
    longUrl: row.long_url,
    forwardQuery: row.forward_query,
    // 有效期是固定时刻，可以安全地随快照下发；到期不会 bump seq，只能靠请求时判定
    validSince: row.valid_since,
    validUntil: row.valid_until,
    // 计数是分钟级变化的值，下发必然陈旧 ⇒ 只下发标记，命中时回落查库
    visitsLimited: row.visits_limited,
  };
}

async function load() {
  const list = await fetchers.snapshot();
  if (list.length > SNAPSHOT_LIMIT) {
    if (!oversized) console.warn(`snapshot ${list.length} rows > limit ${SNAPSHOT_LIMIT}, disable cache`);
    byDomain = new Map();
    byGlobal = new Map();
    rows = 0;
    ready = false;
    oversized = true;
    return;
  }
  // 先建好新表再整体替换引用：轮询与请求共用同一进程，替换要是一步完成的
  const d = new Map();
  const g = new Map();
  for (const row of list) {
    // 默认域名（domain_id = 0）在快照里 domain 为 null，只能进全局表；
    // 域名表优先于全局表，与 resolve_short 的 order by (domain_id = v) desc 一致。
    if (row.domain) d.set(row.domain + '|' + row.short_code, entryOf(row));
    else g.set(row.short_code, entryOf(row));
  }
  byDomain = d;
  byGlobal = g;
  rows = list.length;
  ready = true;
  oversized = false;
  loadedAt = Date.now();
  reloads++;
}

async function poll() {
  try {
    const next = await fetchers.seq();
    if (next === null) return;
    if (!ready || next !== seq) {
      seq = next;
      await load();
    }
    warned = false;
  } catch (err) {
    // 刷新的库调用失败时保留旧快照：宁可跳旧长链，也不能因为缓存抖动把跳转打成 502
    // 首次失败打一行，避免「缓存一直没生效但日志一片安静」
    if (!warned) {
      warned = true;
      console.warn(`snapshot poll failed: ${err && err.message}`);
    }
  }
}

function init(f) {
  fetchers = f;
  return poll().then(() => {
    setInterval(poll, POLL_MS);
  });
}

function lookup(code, domain) {
  const hit = byDomain.get(domain + '|' + code);
  return hit === undefined ? (byGlobal.get(code) ?? null) : hit;
}

function stats() {
  return {
    cached: ready,
    oversized,
    rows,
    seq,
    reloads,
    age: loadedAt ? Date.now() - loadedAt : -1,
    limit: SNAPSHOT_LIMIT,
    pollMs: POLL_MS,
  };
}

module.exports = { init, lookup, poll, ready: () => ready, stats };
