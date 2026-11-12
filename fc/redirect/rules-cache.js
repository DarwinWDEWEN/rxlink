// 跳转函数的规则快照缓存：与主快照（cache.js）平行，但走自己的 seq 通道。
//
// 为什么独立：规则是高频写操作（用户反复调规则）。若与 link_version 共用 seq，
// 每存一次规则就要让全网实例重拉全量短链快照 —— 代价不对等。
// 这里只重拉「有规则的短链」这一小块数据。

const POLL_MS = Number(process.env.RULES_POLL_MS || 5000);

let byId = new Map();
let seq = null;
let ready = false;
let rows = 0;
let loadedAt = 0;
let reloads = 0;
let warned = false;
let fetchers = null;

async function load() {
  const list = await fetchers.snapshot();
  const m = new Map();
  for (const row of list) {
    const id = Number(row.short_url_id);
    if (!Number.isFinite(id)) continue;
    m.set(id, Array.isArray(row.rules) ? row.rules : []);
  }
  byId = m;
  rows = list.length;
  ready = true;
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
    // 拉取失败保留旧快照：宁可跳旧规则，也不能因为规则缓存抖动把跳转打成 502
    if (!warned) {
      warned = true;
      console.warn(`rules snapshot poll failed: ${err && err.message}`);
    }
  }
}

function init(f) {
  fetchers = f;
  return poll().then(() => {
    setInterval(poll, POLL_MS);
  });
}

// shortUrlId → rules[] | null（null = 无规则）
function get(shortUrlId) {
  if (!ready) return null;
  const r = byId.get(Number(shortUrlId));
  return r === undefined ? null : r;
}

function stats() {
  return {
    cached: ready,
    rows,
    seq,
    reloads,
    age: loadedAt ? Date.now() - loadedAt : -1,
    pollMs: POLL_MS,
  };
}

module.exports = { init, get, ready: () => ready, stats };
