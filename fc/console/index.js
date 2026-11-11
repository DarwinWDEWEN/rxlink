// rxlink 控制台静态站（FC Web 函数，零依赖）
// 运行时 Node.js 18+；启动命令 `node index.js`，监听 0.0.0.0:${FC_SERVER_PORT:-9000}
// 代码包内需带 build/ 目录（由 scripts/build-console-fc.mjs 生成 zip）。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.CONSOLE_ROOT
  ? path.resolve(process.env.CONSOLE_ROOT)
  : path.join(__dirname, 'build');
const PORT = Number(process.env.FC_SERVER_PORT || 9000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const cache = new Map();

// DB-IP 许可要求：在展示地理定位结果处标注来源并链接到 db-ip.com。
// 控制台是预构建的 Angular SPA（重编成本高），所以在函数返回 HTML 时动态注入一行页脚。
const ATTRIBUTION_CSS =
  '.rxlink-attribution{position:fixed;left:0;right:0;bottom:0;padding:6px 12px;' +
  'font:12px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:#8a8f98;' +
  'background:rgba(255,255,255,.92);text-align:center;border-top:1px solid rgba(0,0,0,.08);z-index:9999}' +
  '.rxlink-attribution a{color:#2b6cb0;text-decoration:none}' +
  '.rxlink-attribution a:hover{text-decoration:underline}';
const ATTRIBUTION_HTML =
  '<div class="rxlink-attribution">IP Geolocation by ' +
  '<a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">DB-IP</a></div>';

function injectAttribution(html) {
  // 已注入过就直接返回，避免重复叠加
  if (html.includes('rxlink-attribution')) return html;
  const style = `<style>${ATTRIBUTION_CSS}</style>`;
  let out = html;
  if (out.includes('</head>')) out = out.replace('</head>', `${style}</head>`);
  else out = style + out;
  if (out.includes('</body>')) out = out.replace('</body>', `${ATTRIBUTION_HTML}</body>`);
  else out += ATTRIBUTION_HTML;
  return out;
}

function asset(rel) {
  if (cache.has(rel)) return cache.get(rel);
  let entry = null;
  try {
    const full = path.join(ROOT, rel);
    if (full.startsWith(ROOT + path.sep)) {
      entry = {
        body: fs.readFileSync(full),
        type: MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
      };
    }
  } catch {
    // 不存在就走调用方的 404 / SPA 回退
  }
  cache.set(rel, entry);
  return entry;
}

function reply(res, status, body, headers) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function normalize(pathname) {
  let p = pathname;
  for (const prefix of ['/functions/v1/console', '/console']) {
    if (p === prefix || p.startsWith(`${prefix}/`)) {
      p = p.slice(prefix.length) || '/';
      break;
    }
  }
  return p;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return reply(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  let pathname;
  try {
    pathname = normalize(decodeURIComponent(new URL(req.url, 'http://placeholder').pathname));
  } catch {
    return reply(res, 400, 'Bad Request');
  }

  if (pathname.endsWith('/')) pathname += 'index.html';
  let rel = pathname.replace(/^\/+/, '');

  let entry = asset(rel);
  if (!entry) {
    // 带扩展名还找不到就是真 404；其余按 SPA 路由回 index.html
    if (/\.[a-z0-9]+$/i.test(path.basename(rel))) return reply(res, 404, 'Not Found');
    rel = 'index.html';
    entry = asset(rel);
  }
  if (!entry) return reply(res, 500, 'console build missing');

  const immutable = rel.startsWith('assets/');
  let body = entry.body;
  if (entry.type.startsWith('text/html')) body = Buffer.from(injectAttribution(entry.body.toString('utf8')));
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': body.length,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`console listening on ${PORT}, root=${ROOT}`);
});
