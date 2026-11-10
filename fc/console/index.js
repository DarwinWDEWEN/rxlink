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
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': entry.body.length,
  });
  res.end(req.method === 'HEAD' ? undefined : entry.body);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`console listening on ${PORT}, root=${ROOT}`);
});
