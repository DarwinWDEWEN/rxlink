// rxlink 跳转函数（FC Web 函数，零依赖）
// 运行时要求 Node.js 18+（用内置 fetch）；启动命令 `node index.js`，监听 0.0.0.0:${FC_SERVER_PORT:-9000}
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY，可选 VISITOR_SALT / CACHE_POLL_MS / CACHE_SNAPSHOT_LIMIT
const http = require('http');
const crypto = require('crypto');
const cache = require('./cache');

const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
// 访问明细里的 visitor_key = sha256(ip + salt)，不落明文 IP。
// 没配盐时不写 visitor_key（宁可少一个去重口径，也不留可爆破的弱哈希）。
const SALT = process.env.VISITOR_SALT || '';
const RESOLVE_PATH = '/rest/v1/rpc/resolve_short';
const INBOX_PATH = '/rest/v1/visit_inbox';
const SEQ_PATH = '/rest/v1/rpc/link_seq';
const SNAPSHOT_PATH = '/rest/v1/rpc/snapshot_short_links';
const FALLBACK_PATH = '/rest/v1/rpc/not_found_redirects';
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PORT = Number(process.env.FC_SERVER_PORT || 9000);

function gateway(path, body, prefer) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=minimal',
    },
    body: JSON.stringify(body),
  });
}

async function resolve(code, domain) {
  const res = await gateway(RESOLVE_PATH, { p_code: code, p_domain: domain });
  if (!res.ok) throw new Error(`resolve ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // 查库这条路径的 enabled / 有效期 / 次数上限都由 SQL 判完了，这里不再重复判
  return {
    id: rows[0].short_url_id,
    longUrl: rows[0].long_url,
    forwardQuery: rows[0].forward_query,
    validSince: null,
    validUntil: null,
    visitsLimited: false,
  };
}

function clip(value, max) {
  return value === undefined || value === null ? null : String(value).slice(0, max);
}

function recordVisit(fields) {
  gateway(INBOX_PATH, fields).catch(() => {});
}

async function readSeq() {
  const res = await gateway(SEQ_PATH, {});
  if (!res.ok) throw new Error(`seq ${res.status}`);
  const value = await res.json();
  return typeof value === 'number' ? value : null;
}

async function readSnapshot() {
  const res = await gateway(SNAPSHOT_PATH, {});
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

function reply(res, status, body, extra) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function hostname(req) {
  const host = req.headers.host || '';
  return host.replace(/:\d+$/, '').toLowerCase();
}

function clientIp(req) {
  // FC 自定义域名链路上只有 x-forwarded-for 首元素可信（P0 项 18）
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

function visitorKey(req) {
  if (!SALT) return null;
  const ip = clientIp(req);
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip + SALT).digest('hex');
}

function fullUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host || ''}${req.url || ''}`;
}

function withinValidity(entry, now) {
  if (entry.validSince && Date.parse(entry.validSince) > now) return false;
  if (entry.validUntil && Date.parse(entry.validUntil) <= now) return false;
  return true;
}

function withQuery(longUrl, req) {
  const q = req.url.indexOf('?');
  if (q < 0) return longUrl;
  const query = req.url.slice(q + 1);
  if (!query) return longUrl;
  return longUrl + (longUrl.includes('?') ? '&' : '?') + query;
}

// shlink NotFoundRedirectResolver 语义：path 段原样替换，query 段编码替换；
// 字面与 percent-encoded 两种占位符写法都认。
function fillPlaceholders(template, domain, originalPath) {
  const raw = (s, encode) => {
    const d = encode ? encodeURIComponent(domain) : domain;
    const p = encode ? encodeURIComponent(originalPath) : originalPath;
    return s
      .replaceAll('{DOMAIN}', d)
      .replaceAll('%7BDOMAIN%7D', d)
      .replaceAll('{ORIGINAL_PATH}', p)
      .replaceAll('%7BORIGINAL_PATH%7D', p);
  };
  try {
    const u = new URL(template);
    // shlink：path 段原样替换后折叠相邻斜杠；query 段编码替换
    u.pathname = raw(u.pathname, false).replace(/\/{2,}/g, '/');
    u.search = raw(u.search, true);
    return u.toString();
  } catch {
    // 配置不是合法 URL：原样返回（shlink 打 warning 后也按原样用）
    return template;
  }
}

// 404 才查回退配置（低频路径，不进快照）：域名级优先、缺省回落全局由 SQL coalesce 完成。
// 查询失败或没配置都降级裸 404，回退能力不能反过来拖垮主链路。
async function replyNotFound(req, res, visit, orphanType, timing, snapshot) {
  recordVisit({ ...visit, orphan_type: orphanType });
  const headers = { 'Server-Timing': timing, 'X-Link-Snapshot': snapshot };
  try {
    const r = await gateway(FALLBACK_PATH, { p_authority: hostname(req) }, 'return=representation');
    if (r.ok) {
      const rows = await r.json();
      const column = {
        base_url: 'base_url_redirect',
        regular_404: 'regular404_redirect',
        invalid_short_url: 'invalid_short_url_redirect',
      }[orphanType];
      const url = rows[0] && rows[0][column];
      if (url) {
        const path = new URL(req.url, 'http://placeholder').pathname;
        const location = fillPlaceholders(url, hostname(req), path);
        return reply(res, 302, null, { ...headers, Location: location });
      }
    }
  } catch {
    // 降级裸 404
  }
  return reply(res, 404, 'not found', headers);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return reply(res, 405, 'method not allowed');
  }
  if (!BASE || !KEY) {
    return reply(res, 500, 'not configured');
  }

  const path = new URL(req.url, 'http://placeholder').pathname;
  const code = path.startsWith('/') ? path.slice(1) : path;
  const domain = hostname(req);
  const started = Date.now();
  const stats0 = cache.stats();
  const visit = {
    visitor_key: visitorKey(req),
    ua: clip(req.headers['user-agent'], 512),
    referer: clip(req.headers['referer'], 1024),
    visited_url: clip(fullUrl(req), 2048),
    occurred_at: new Date().toISOString(),
  };

  if (code === '' || !CODE_RE.test(code)) {
    // shlink NotFoundType：根路径=base_url；路由形状不合法=regular_404
    return replyNotFound(
      req, res, visit, code === '' ? 'base_url' : 'regular_404',
      `resolve;dur=0;cached=${stats0.cached ? 1 : 0}`,
      `${stats0.rows}|${stats0.seq}|${stats0.age}`,
    );
  }

  let entry = cache.ready() ? cache.lookup(code, domain) : null;
  let resolveMs = 0;

  // 需要打库的两种情况：快照没就绪；命中的是限次链接（计数分钟级变化，快照里必然陈旧）
  if (!cache.ready() || (entry && entry.visitsLimited)) {
    try {
      entry = await resolve(code, domain);
    } catch (err) {
      return reply(res, 502, 'upstream error');
    }
    resolveMs = Date.now() - started;
  }

  const st = cache.stats();
  const timing = `resolve;dur=${resolveMs};cached=${st.cached ? 1 : 0}`;
  const snapshot = `${st.rows}|${st.seq}|${st.age}`;

  if (!entry || !withinValidity(entry, Date.now())) {
    // shlink NotFoundType：路由命中但码不存在/失效=invalid_short_url
    return replyNotFound(req, res, visit, 'invalid_short_url', timing, snapshot);
  }

  let location = entry.longUrl;
  if (entry.forwardQuery) location = withQuery(location, req);

  try {
    // Location 只可能来自库里写入过的长链，请求本身不参与拼接
    reply(res, 302, null, {
      Location: location,
      'Server-Timing': timing,
      'X-Link-Snapshot': snapshot,
    });
  } catch (err) {
    // 长链里有非法请求头字符时 writeHead 会抛，不能让整个实例崩掉
    return reply(res, 502, 'bad redirect target', { 'Server-Timing': timing });
  }
  // 缓存命中不豁免统计：每次请求仍然入队
  recordVisit({ ...visit, short_url_id: entry.id, redirect_to: clip(location, 2048) });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`redirect listening on ${PORT}`);
  if (!SALT) console.warn('VISITOR_SALT not set, visitor_key will be null');
});

// 首拉失败不影响起服务：cache 未就绪时请求自动走查库路径
cache.init({ seq: readSeq, snapshot: readSnapshot }).then(() => {
  console.log(`snapshot ready ${JSON.stringify(cache.stats())}`);
});
