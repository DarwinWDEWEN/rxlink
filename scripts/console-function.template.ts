// 生成文件，勿手改。源模板 scripts/console-function.template.ts，
// 由 scripts/build-console-function.mjs 把 shlink-web-client/build 内联进来。
type Asset = { t: string; b: string };

const ASSETS: Record<string, Asset> = {
/*__ASSETS__*/
};

const cached = new Map<string, Uint8Array>();

function bytes(asset: Asset): Uint8Array {
  let v = cached.get(asset.b);
  if (!v) {
    const raw = atob(asset.b);
    v = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) v[i] = raw.charCodeAt(i);
    cached.set(asset.b, v);
  }
  return v;
}

function normalize(pathname: string): string {
  let p = pathname;
  for (const prefix of ['/functions/v1/console', '/console']) {
    if (p === prefix || p.startsWith(`${prefix}/`)) {
      p = p.slice(prefix.length) || '/';
      break;
    }
  }
  return p;
}

Deno.serve((req): Response => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const url = new URL(req.url);
  let path = normalize(decodeURIComponent(url.pathname));
  if (path.endsWith('/')) path += 'index.html';

  if (!ASSETS[path]) {
    // 带扩展名还找不到就是真 404；其余按 SPA 路由回 index.html
    if (/\.[a-z0-9]+$/i.test(path.split('/').pop() ?? '')) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    path = '/index.html';
  }

  const asset = ASSETS[path] ?? ASSETS['/index.html'];
  const immutable = path.startsWith('/assets/');
  const headers = {
    'Content-Type': asset.t,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  return new Response(req.method === 'HEAD' ? null : bytes(asset), { headers });
});
