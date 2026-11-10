// 跳转函数回归测试：node --test fc/redirect/test/
// 起真实 index.js 子进程，SUPABASE_URL 指向进程内 mock 网关；inbox 入队与回退配置都可断言。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const HOST = 'short.example';
const state = { fallbacks: {}, inbox: [], failFallback: false };
let mock;
let child;
let base;

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

before(async () => {
  mock = http.createServer(async (req, res) => {
    const url = req.url;
    const body = await readBody(req);
    if (url === '/rest/v1/rpc/link_seq') return json(res, 1);
    if (url === '/rest/v1/rpc/snapshot_short_links') {
      return json(res, [{
        id: 1, domain: null, short_code: 'known1', long_url: 'https://target.example/ok',
        forward_query: true, valid_since: null, valid_until: null, visits_limited: false,
      }]);
    }
    if (url === '/rest/v1/rpc/resolve_short') {
      if (body.p_code === 'known1') {
        return json(res, [{ short_url_id: 1, long_url: 'https://target.example/ok', forward_query: true }]);
      }
      return json(res, []);
    }
    if (url === '/rest/v1/rpc/not_found_redirects') {
      if (state.failFallback) return json(res, { message: 'simulated outage' }, 500);
      // 模拟 SQL 契约：逐列 coalesce(域名级, 全局 __default__)
      const g = state.fallbacks.__default__ || {};
      const d = state.fallbacks[body.p_authority] || {};
      const pick = (k) => d[k] ?? g[k] ?? null;
      return json(res, [{
        base_url_redirect: pick('base_url_redirect'),
        regular404_redirect: pick('regular404_redirect'),
        invalid_short_url_redirect: pick('invalid_short_url_redirect'),
      }]);
    }
    if (url === '/rest/v1/visit_inbox') {
      state.inbox.push(body);
      res.writeHead(201);
      return res.end();
    }
    json(res, { message: `unexpected ${url}` }, 404);
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${port}`,
      SUPABASE_SERVICE_ROLE_KEY: 'test-key',
      FC_SERVER_PORT: '19101',
      CACHE_POLL_MS: '3600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('redirect server startup timeout')), 8000);
    child.stdout.on('data', (d) => {
      const m = String(d).match(/listening on (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    child.on('exit', (code) => reject(new Error(`redirect exited early: ${code}`)));
  });
  // 等首拉快照完成，避免测试落在未就绪窗口
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  if (child) child.kill();
  if (mock) await new Promise((r) => mock.close(r));
});

function req(pathname, host = HOST, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const r = http.get(base + pathname, { headers: { host, ...extraHeaders } }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    r.on('error', reject);
  });
}

async function waitOrphan(n = 1) {
  for (let i = 0; i < 50 && state.inbox.length < n; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return state.inbox;
}

test('命中短码仍 302 到长链（回归）', async () => {
  const res = await req('/known1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://target.example/ok');
});

test('码不存在：配了 invalid_short_url_redirect 时 302 回跳', async () => {
  state.fallbacks[HOST] = {
    base_url_redirect: null, regular404_redirect: null,
    invalid_short_url_redirect: 'https://fallback.example/missing',
  };
  const res = await req('/nosuch');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://fallback.example/missing');
});

test('码不存在的孤儿访问记 invalid_short_url（shlink 语义）', async () => {
  state.inbox.length = 0;
  state.fallbacks[HOST] = {
    base_url_redirect: null, regular404_redirect: null,
    invalid_short_url_redirect: 'https://fallback.example/missing',
  };
  await req('/nosuch');
  const inbox = await waitOrphan();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].orphan_type, 'invalid_short_url');
});

test('非法路径：配了 regular404_redirect 时 302，孤儿记 regular_404', async () => {
  state.inbox.length = 0;
  state.fallbacks[HOST] = {
    base_url_redirect: null, regular404_redirect: 'https://fallback.example/404',
    invalid_short_url_redirect: null,
  };
  const res = await req('/a/b');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://fallback.example/404');
  const inbox = await waitOrphan();
  assert.equal(inbox[0].orphan_type, 'regular_404');
});

test('根路径：配了 base_url_redirect 时 302，孤儿记 base_url', async () => {
  state.inbox.length = 0;
  state.fallbacks[HOST] = {
    base_url_redirect: 'https://fallback.example/home',
    regular404_redirect: null, invalid_short_url_redirect: null,
  };
  const res = await req('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://fallback.example/home');
  const inbox = await waitOrphan();
  assert.equal(inbox[0].orphan_type, 'base_url');
});

test('未配置回退：维持裸 404', async () => {
  state.fallbacks = {};
  const res = await req('/nosuch');
  assert.equal(res.status, 404);
});

test('域名级缺省回落全局默认（id=0 哨兵）', async () => {
  state.fallbacks = {
    __default__: {
      base_url_redirect: null, regular404_redirect: null,
      invalid_short_url_redirect: 'https://fallback.example/global',
    },
  };
  const res = await req('/nosuch', 'other.example');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://fallback.example/global');
});

test('域名级配置优先于全局', async () => {
  state.fallbacks = {
    __default__: {
      base_url_redirect: null, regular404_redirect: null,
      invalid_short_url_redirect: 'https://fallback.example/global',
    },
    [HOST]: {
      base_url_redirect: null, regular404_redirect: null,
      invalid_short_url_redirect: 'https://fallback.example/domain',
    },
  };
  const res = await req('/nosuch');
  assert.equal(res.headers.location, 'https://fallback.example/domain');
});

test('占位符：path 原样替换、query 编码替换', async () => {
  state.fallbacks[HOST] = {
    base_url_redirect: null, regular404_redirect: null,
    invalid_short_url_redirect: 'https://fallback.example/p/{DOMAIN}{ORIGINAL_PATH}?d={DOMAIN}&p={ORIGINAL_PATH}',
  };
  const res = await req('/nosuch');
  assert.equal(
    res.headers.location,
    `https://fallback.example/p/${HOST}/nosuch?d=${HOST}&p=%2Fnosuch`,
  );
});

test('path 替换后折叠双斜杠（照 shlink NotFoundRedirectResolver）', async () => {
  state.fallbacks[HOST] = {
    base_url_redirect: null, regular404_redirect: null,
    invalid_short_url_redirect: 'https://fallback.example/fb/{ORIGINAL_PATH}',
  };
  const res = await req('/nosuch');
  assert.equal(res.headers.location, 'https://fallback.example/fb/nosuch');
});

test('回退查询失败：降级裸 404，不影响服务', async () => {
  state.fallbacks[HOST] = {
    base_url_redirect: null, regular404_redirect: null,
    invalid_short_url_redirect: 'https://fallback.example/missing',
  };
  state.failFallback = true;
  const res = await req('/nosuch');
  state.failFallback = false;
  assert.equal(res.status, 404);
});

test('入队带 remote_addr：取 x-forwarded-for 首元素', async () => {
  state.inbox.length = 0;
  const res = await req('/known1', HOST, { 'x-forwarded-for': '203.0.113.45, 70.41.3.18, 150.172.238.178' });
  assert.equal(res.status, 302);
  const inbox = await waitOrphan();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].remote_addr, '203.0.113.45');
});

test('入队带 remote_addr：孤儿访问同样带', async () => {
  state.inbox.length = 0;
  await req('/nosuch', HOST, { 'x-forwarded-for': '198.51.100.7' });
  const inbox = await waitOrphan();
  assert.equal(inbox[0].remote_addr, '198.51.100.7');
});

test('没有 x-forwarded-for 时 remote_addr 为 null（不留空串）', async () => {
  state.inbox.length = 0;
  await req('/known1');
  const inbox = await waitOrphan();
  assert.equal(inbox[0].remote_addr, null);
});

test('remote_addr 长度截断（x-forwarded-for 可被伪造成任意长度）', async () => {
  state.inbox.length = 0;
  await req('/known1', HOST, { 'x-forwarded-for': 'a'.repeat(300) });
  const inbox = await waitOrphan();
  assert.ok(inbox[0].remote_addr.length <= 64, `实际长度 ${inbox[0].remote_addr.length}`);
});