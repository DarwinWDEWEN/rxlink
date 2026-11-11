// rxlink 跳转函数（FC Web 函数，零依赖）
// 运行时要求 Node.js 18+（用内置 fetch）；启动命令 `node index.js`，监听 0.0.0.0:${FC_SERVER_PORT:-9000}
// 环境变量：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY，可选 VISITOR_SALT / CACHE_POLL_MS / CACHE_SNAPSHOT_LIMIT
// 追踪开关（R8，默认全关）：DISABLE_TRACK_PARAM / DISABLE_TRACKING / DISABLE_TRACKING_FROM /
//   DISABLE_REFERRER_TRACKING / DISABLE_UA_TRACKING / DISABLE_IP_TRACKING
// robots（R3）：ROBOTS_ALLOW_ALL_SHORT_URLS
const http = require('http');
const crypto = require('crypto');
const cache = require('./cache');
const ipmat = require('./ipmat');

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
const ROBOTS_PATH = '/rest/v1/rpc/robots_crawlable_codes';
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PORT = Number(process.env.FC_SERVER_PORT || 9000);

// R8 追踪开关：默认值与 shlink 一致（全关），命中即不记访问或置空字段
const TRACK = {
  disableParam: process.env.DISABLE_TRACK_PARAM || '',
  disableAll: process.env.DISABLE_TRACKING === 'true',
  from: (process.env.DISABLE_TRACKING_FROM || '').split(',').map((s) => s.trim()).filter(Boolean),
  disableReferrer: process.env.DISABLE_REFERRER_TRACKING === 'true',
  disableUa: process.env.DISABLE_UA_TRACKING === 'true',
  disableIp: process.env.DISABLE_IP_TRACKING === 'true',
};
// R3 robots：默认列 crawlable 短码 + Disallow: /；开关打开后只 Disallow: /rest/
const ROBOTS_ALLOW_ALL = process.env.ROBOTS_ALLOW_ALL_SHORT_URLS === 'true';
// 1×1 透明 GIF89a（43 字节），追踪像素用
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
  'base64',
);

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

// R8：命中即不记访问。HEAD 由 shlink 的 ImplicitHeadMiddleware 转发后按 HEAD 处理，同样不记。
function shouldSkipTracking(req, query, ip) {
  if (req.method === 'HEAD') return true;
  if (TRACK.disableAll) return true;
  if (TRACK.disableParam && query.has(TRACK.disableParam)) return true;
  if (ip && ipmat.ipMatchesGroups(ip, TRACK.from)) return true;
  return false;
}

// 访问明细：追踪开关置空对应字段（visitor_key 保留——shlink 的 disableIpTracking 也只清 IP 本身）
function buildVisit(req, ip) {
  return {
    visitor_key: visitorKey(req),
    ua: TRACK.disableUa ? null : clip(req.headers['user-agent'], 512),
    referer: TRACK.disableReferrer ? null : clip(req.headers['referer'], 1024),
    visited_url: clip(fullUrl(req), 2048),
    // 原始 IP 只在 visit.remote_addr 短暂留存：富化函数写完定位结果后清空，
    // 7 天硬上限由 retire_remote_addr() 兜底（见 docs/geo-enrichment.md §7）。
    // x-forwarded-for 可被伪造成长串，所以截断到 64。
    remote_addr: TRACK.disableIp || !ip ? null : clip(ip, 64),
    occurred_at: new Date().toISOString(),
  };
}

// 像素路由的解析：命中/未命中都返回 gif，所以上游失败也按未命中降级（不记访问）
async function lookupForPixel(code, domain) {
  let entry = cache.ready() ? cache.lookup(code, domain) : null;
  if (!cache.ready() || (entry && entry.visitsLimited)) {
    try {
      entry = await resolve(code, domain);
    } catch {
      return null;
    }
  }
  return entry;
}

// R1：无回退配置时的内联 404 页（shlink 模板的精简版，去掉品牌与 favicon）
const HTML_STYLE = [
  '*, :before, :after {box-sizing: border-box;}',
  'html, body {margin: 0; padding: 0; height: 100%; font-size: 1rem; font-weight: 400; line-height: 1.5;',
  '  color: #212529; text-align: center;',
  '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;}',
  'p {margin-bottom: 20px;}',
  'hr {margin-top: 1rem; margin-bottom: 1rem; border: 0; border-top: 1px solid rgba(0, 0, 0, .1);}',
  '.app {min-height: 100%; display: flex; align-items: center; justify-content: center; flex-flow: column;}',
  '.container {width: 100%; max-width: 1140px; padding: 0 20px;}',
].join('\n');

function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${title}</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
${HTML_STYLE}
  </style>
</head>
<body>
  <div class="app">
    <main class="container">
${body}
    </main>
  </div>
</body>
</html>
`;
}

function notFoundHtml() {
  return htmlPage(
    'Not Found',
    '      <h1>404</h1>\n      <hr>\n      <h3>Page not found.</h3>\n      <p>The page you requested could not be found.</p>',
  );
}

function invalidShortCodeHtml() {
  return htmlPage(
    'Invalid Short URL',
    "      <h1>Oops!</h1>\n      <hr>\n      <p>This short URL doesn't seem to be valid.</p>\n      <p>Make sure you included all the characters, with no extra punctuation.</p>",
  );
}

// R3：robots.txt。默认列 crawlable 短码 + Disallow: /；开关打开后只 Disallow: /rest/。
async function replyRobots(res, domain) {
  const lines = [
    '# For more information about the robots.txt standard, see:',
    '# https://www.robotstxt.org/orig.html',
    '',
    'User-agent: *',
  ];
  if (!ROBOTS_ALLOW_ALL) {
    let codes = [];
    try {
      const r = await gateway(ROBOTS_PATH, { p_authority: domain }, 'return=representation');
      if (r.ok) {
        const body = await r.json();
        // PostgREST 对 returns text[] 的 RPC 直接返回数组
        if (Array.isArray(body)) codes = body.filter((c) => typeof c === 'string');
      }
    } catch {
      // RPC 失败：降级为不允许任何短码，仍有 Disallow: / 兜底
    }
    for (const c of codes) lines.push(`Allow: /${c}`);
  }
  lines.push(ROBOTS_ALLOW_ALL ? 'Disallow: /rest/' : 'Disallow: /');
  reply(res, 200, lines.join('\n') + '\n', { 'Content-Type': 'text/plain; charset=utf-8' });
}

// 404 才查回退配置（低频路径，不进快照）：域名级优先、缺省回落全局由 SQL coalesce 完成。
// 查询失败或没配置都降级到内联 HTML 404 页（R1），回退能力不能反过来拖垮主链路。
async function replyNotFound(req, res, visit, orphanType, timing, snapshot, record) {
  if (record) recordVisit({ ...visit, orphan_type: orphanType });
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
    // 降级 HTML 404
  }
  const html = orphanType === 'invalid_short_url' ? invalidShortCodeHtml() : notFoundHtml();
  return reply(res, 404, html, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return reply(res, 405, 'method not allowed');
  }
  if (!BASE || !KEY) {
    return reply(res, 500, 'not configured');
  }

  const url = new URL(req.url, 'http://placeholder');
  const path = url.pathname;
  const query = url.searchParams;
  const domain = hostname(req);
  const ip = clientIp(req);
  const skipTracking = shouldSkipTracking(req, query, ip);
  const visit = buildVisit(req, ip);

  // R3 robots.txt：不记访问
  if (path === '/robots.txt') {
    return replyRobots(res, domain);
  }

  // R2 追踪像素：命中才记访问，未命中/HEAD 不记，都返回 1×1 gif
  const trackMatch = /^\/([A-Za-z0-9_-]{1,64})\/track$/.exec(path);
  if (trackMatch) {
    const entry = await lookupForPixel(trackMatch[1], domain);
    if (entry && withinValidity(entry, Date.now()) && !skipTracking) {
      recordVisit({ ...visit, short_url_id: entry.id, redirect_to: null });
    }
    return reply(res, 200, PIXEL, { 'Content-Type': 'image/gif' });
  }

  const code = path.startsWith('/') ? path.slice(1) : path;
  const started = Date.now();
  const stats0 = cache.stats();

  if (code === '' || !CODE_RE.test(code)) {
    // shlink NotFoundType：根路径=base_url；路由形状不合法=regular_404
    return replyNotFound(
      req, res, visit, code === '' ? 'base_url' : 'regular_404',
      `resolve;dur=0;cached=${stats0.cached ? 1 : 0}`,
      `${stats0.rows}|${stats0.seq}|${stats0.age}`,
      !skipTracking,
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
    return replyNotFound(req, res, visit, 'invalid_short_url', timing, snapshot, !skipTracking);
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
  // 缓存命中不豁免统计：每次请求仍然入队（HEAD / 命中开关除外）
  if (!skipTracking) {
    recordVisit({ ...visit, short_url_id: entry.id, redirect_to: clip(location, 2048) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // 端口可能是 0（随机），日志打实际绑定端口，便于测试与排查
  console.log(`redirect listening on ${server.address().port}`);
  if (!SALT) console.warn('VISITOR_SALT not set, visitor_key will be null');
});

// 首拉失败不影响起服务：cache 未就绪时请求自动走查库路径
cache.init({ seq: readSeq, snapshot: readSnapshot }).then(() => {
  console.log(`snapshot ready ${JSON.stringify(cache.stats())}`);
});
