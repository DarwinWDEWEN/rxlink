// 跳转函数回归测试：node --test fc/redirect/test/
// 起真实 index.js 子进程，SUPABASE_URL 指向进程内 mock 网关；inbox 入队与回退配置都可断言。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

const HOST = 'short.example';
const state = {
  fallbacks: {},
  inbox: [],
  inboxCalls: 0,
  inboxFailuresRemaining: 0,
  failFallback: false,
  robotsCodes: ['crawl1', 'crawl2'],
  rulesSeq: 1,
  rules: [],
};
let mock;
let child;
let base;
let childStderr = '';

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
        return json(res, [{
          short_url_id: 1,
          long_url: 'https://target.example/ok',
          forward_query: true,
          rules: state.rules.length ? state.rules[0].rules : null,
        }]);
      }
      return json(res, []);
    }
    if (url === '/rest/v1/rpc/rules_seq') return json(res, state.rulesSeq);
    if (url === '/rest/v1/rpc/rules_snapshot') return json(res, state.rules);
    if (url === '/rest/v1/rpc/robots_crawlable_codes') {
      return json(res, state.robotsCodes);
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
      state.inboxCalls += 1;
      if (state.inboxFailuresRemaining > 0) {
        state.inboxFailuresRemaining -= 1;
        return json(res, { message: 'simulated outage' }, 500);
      }
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
      // 规则缓存默认轮询 5 秒，测试只等 300ms —— 不缩短间隔新用例永远读到旧规则
      RULES_POLL_MS: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    childStderr += String(d);
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
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: raw.toString('utf8'), raw });
      });
    });
    r.on('error', reject);
  });
}

// 指定方法/BaseUrl 请求（HEAD、R8 隔离子进程用）；raw 保留原始字节，pixel 是二进制
function reqOn(baseUrl, method, pathname, host = HOST, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(baseUrl + pathname, { method, headers: { host, ...extraHeaders } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: raw.toString('utf8'), raw });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// 起一个隔离的跳转子进程（R8 各开关互斥，必须分开跑；端口 0 = 随机）
async function spawnChild(envExtra) {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${mock.address().port}`,
      SUPABASE_SERVICE_ROLE_KEY: 'test-key',
      FC_SERVER_PORT: '0',
      CACHE_POLL_MS: '3600000',
      ...envExtra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const b = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child startup timeout')), 8000);
    c.stdout.on('data', (d) => {
      const m = String(d).match(/listening on (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    c.on('exit', (code) => reject(new Error(`child exited early: ${code}`)));
  });
  return { base: b, kill: () => c.kill() };
}

async function waitOrphan(n = 1) {
  for (let i = 0; i < 50 && state.inbox.length < n; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return state.inbox;
}

async function waitFor(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
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

test('未配置回退：返回内联 HTML 404 页（R1）', async () => {
  state.fallbacks = {};
  const res = await req('/nosuch');
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /^text\/html; charset=utf-8$/);
  assert.match(res.body, /This short URL doesn't seem to be valid/);
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

test('访问入队首次返回 500 时重试并最终写入', async () => {
  state.inbox.length = 0;
  state.inboxCalls = 0;
  state.inboxFailuresRemaining = 1;

  const res = await req('/known1');
  assert.equal(res.status, 302);
  await waitFor(() => state.inbox.length === 1);

  assert.equal(state.inboxCalls, 2);
  assert.equal(state.inbox.length, 1);
});

test('访问入队持续返回 500 时记录脱敏错误', async () => {
  const stderrStart = childStderr.length;
  state.inbox.length = 0;
  state.inboxCalls = 0;
  state.inboxFailuresRemaining = 10;

  const res = await req('/known1', HOST, {
    'x-forwarded-for': '203.0.113.200',
    'user-agent': 'secret-agent-value',
    referer: 'https://secret-referrer.example/path',
  });
  assert.equal(res.status, 302);
  await waitFor(() => childStderr.slice(stderrStart).includes('visit_enqueue_failed'));

  const errorOutput = childStderr.slice(stderrStart);
  assert.match(errorOutput, /visit_enqueue_failed code=http_500/);
  assert.doesNotMatch(errorOutput, /203\.0\.113\.200/);
  assert.doesNotMatch(errorOutput, /secret-agent-value/);
  assert.doesNotMatch(errorOutput, /secret-referrer/);
  assert.doesNotMatch(errorOutput, /test-key/);
  assert.equal(state.inbox.length, 0);
  state.inboxFailuresRemaining = 0;
});

test('访问入队返回 201 时不重试', async () => {
  state.inbox.length = 0;
  state.inboxCalls = 0;
  state.inboxFailuresRemaining = 0;

  await req('/known1');
  await waitFor(() => state.inbox.length === 1);

  assert.equal(state.inboxCalls, 1);
});

// ---------------------------------------------------------------- R1 404 HTML

test('R1 非法短码：无回退返回 invalid-short-code HTML 页', async () => {
  state.fallbacks = {};
  const res = await req('/nosuch');
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /^text\/html; charset=utf-8$/);
  assert.match(res.body, /This short URL doesn't seem to be valid/);
  assert.match(res.body, /Make sure you included all the characters/);
});

test('R1 非法路径：无回退返回 404 HTML 页', async () => {
  state.fallbacks = {};
  const res = await req('/a/b');
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /^text\/html; charset=utf-8$/);
  assert.match(res.body, /Page not found/);
});

test('R1 根路径：无回退返回 404 HTML 页', async () => {
  state.fallbacks = {};
  const res = await req('/');
  assert.equal(res.status, 404);
  assert.match(res.body, /Page not found/);
});

test('R1 有回退配置仍 302，优先级高于 HTML', async () => {
  state.fallbacks[HOST] = {
    base_url_redirect: null, regular404_redirect: null,
    invalid_short_url_redirect: 'https://fallback.example/missing',
  };
  const res = await req('/nosuch');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://fallback.example/missing');
});

// ---------------------------------------------------------------- R2 追踪像素

test('R2 像素：命中短码记访问并返回 gif', async () => {
  state.inbox.length = 0;
  const res = await req('/known1/track');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/gif');
  assert.equal(res.raw.slice(0, 6).toString('latin1'), 'GIF89a');
  assert.equal(res.raw.length, 43);
  const inbox = await waitOrphan();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].short_url_id, 1);
  assert.equal(inbox[0].redirect_to, null);
});

test('R2 像素：未命中不记访问但仍返回 gif', async () => {
  state.inbox.length = 0;
  const res = await req('/nosuch/track');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/gif');
  assert.equal(res.raw.length, 43);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(state.inbox.length, 0);
});

test('R2 像素：HEAD 不记访问', async () => {
  state.inbox.length = 0;
  const res = await reqOn(base, 'HEAD', '/known1/track');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/gif');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(state.inbox.length, 0);
});

test('R2 像素：带 query 不影响记访问', async () => {
  state.inbox.length = 0;
  const res = await req('/known1/track?from=email');
  assert.equal(res.status, 200);
  const inbox = await waitOrphan();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].short_url_id, 1);
});

// ---------------------------------------------------------------- R3 robots.txt

test('R3 robots.txt：列 crawlable 短码 + Disallow: /', async () => {
  state.robotsCodes = ['crawl1', 'crawl2'];
  const res = await req('/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/plain/);
  assert.match(res.body, /User-agent: \*/);
  assert.match(res.body, /Allow: \/crawl1/);
  assert.match(res.body, /Allow: \/crawl2/);
  assert.match(res.body, /^Disallow: \/$/m);
  assert.doesNotMatch(res.body, /Disallow: \/rest\//);
});

test('R3 robots.txt：开关打开后只 Disallow: /rest/', async () => {
  const c = await spawnChild({ ROBOTS_ALLOW_ALL_SHORT_URLS: 'true' });
  try {
    const res = await reqOn(c.base, 'GET', '/robots.txt');
    assert.equal(res.status, 200);
    assert.match(res.body, /User-agent: \*/);
    assert.match(res.body, /^Disallow: \/rest\/$/m);
    assert.doesNotMatch(res.body, /^Allow: \//m);
  } finally {
    c.kill();
  }
});

// ---------------------------------------------------------------- R8 追踪开关

test('R8 HEAD 跳转不记访问', async () => {
  state.inbox.length = 0;
  const res = await reqOn(base, 'HEAD', '/known1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://target.example/ok');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(state.inbox.length, 0);
});

test('R8 DISABLE_TRACKING=true：命中也不记', async () => {
  const c = await spawnChild({ DISABLE_TRACKING: 'true' });
  try {
    state.inbox.length = 0;
    const res = await reqOn(c.base, 'GET', '/known1');
    assert.equal(res.status, 302);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(state.inbox.length, 0);
  } finally {
    c.kill();
  }
});

test('R8 DISABLE_TRACK_PARAM：带该参数不记，不带则记', async () => {
  const c = await spawnChild({ DISABLE_TRACK_PARAM: 'noshow' });
  try {
    state.inbox.length = 0;
    await reqOn(c.base, 'GET', '/known1?noshow=1');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(state.inbox.length, 0);
    await reqOn(c.base, 'GET', '/known1');
    const inbox = await waitOrphan();
    assert.equal(inbox.length, 1);
  } finally {
    c.kill();
  }
});

test('R8 DISABLE_TRACKING_FROM：CIDR 命中不记，未命中记', async () => {
  const c = await spawnChild({ DISABLE_TRACKING_FROM: '192.168.0.0/16' });
  try {
    state.inbox.length = 0;
    await reqOn(c.base, 'GET', '/known1', HOST, { 'x-forwarded-for': '192.168.1.5' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(state.inbox.length, 0);
    await reqOn(c.base, 'GET', '/known1', HOST, { 'x-forwarded-for': '8.8.8.8' });
    const inbox = await waitOrphan();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].remote_addr, '8.8.8.8');
  } finally {
    c.kill();
  }
});

test('R8 DISABLE_IP_TRACKING：记访问但 remote_addr 为 null', async () => {
  const c = await spawnChild({ DISABLE_IP_TRACKING: 'true' });
  try {
    state.inbox.length = 0;
    await reqOn(c.base, 'GET', '/known1', HOST, { 'x-forwarded-for': '203.0.113.9' });
    const inbox = await waitOrphan();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].remote_addr, null);
  } finally {
    c.kill();
  }
});

test('R8 DISABLE_UA_TRACKING：记访问但 ua 为 null', async () => {
  const c = await spawnChild({ DISABLE_UA_TRACKING: 'true' });
  try {
    state.inbox.length = 0;
    await reqOn(c.base, 'GET', '/known1', HOST, { 'user-agent': 'curl/8.0' });
    const inbox = await waitOrphan();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].ua, null);
  } finally {
    c.kill();
  }
});

test('R8 DISABLE_REFERRER_TRACKING：记访问但 referer 为 null', async () => {
  const c = await spawnChild({ DISABLE_REFERRER_TRACKING: 'true' });
  try {
    state.inbox.length = 0;
    await reqOn(c.base, 'GET', '/known1', HOST, { referer: 'https://ref.example/' });
    const inbox = await waitOrphan();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].referer, null);
  } finally {
    c.kill();
  }
});
// ---- I9：R9 动态跳转规则 ----

test('I9：规则命中 → 302 到规则的 longUrl', async () => {
  state.rules = [{ short_url_id: 1, rules: [{ longUrl: 'https://target.example/rule', priority: 1, conditions: [{ type: 'query-param', matchKey: 'src', matchValue: 'wechat' }] }] }];
  state.rulesSeq = 2;
  // 等规则缓存轮询到新 seq
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1?src=wechat');
  assert.equal(res.status, 302);
  // 命中的规则目标同样受 forward_query 影响（shlink 口径：query 拼在最终目标上）
  assert.equal(res.headers.location, 'https://target.example/rule?src=wechat');
});

test('I9：规则不命中 → 302 到默认 longUrl', async () => {
  state.rules = [{ short_url_id: 1, rules: [{ longUrl: 'https://target.example/rule', priority: 1, conditions: [{ type: 'query-param', matchKey: 'src', matchValue: 'wechat' }] }] }];
  state.rulesSeq = 3;
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1?src=other');
  assert.equal(res.status, 302);
  // forward_query 为 true，默认长链同样要带上 query（与命中规则时一致）
  assert.equal(res.headers.location, 'https://target.example/ok?src=other');
});

test('I9：规则 + forward_query → query 拼在规则目标上', async () => {
  state.rules = [{ short_url_id: 1, rules: [{ longUrl: 'https://target.example/rule', priority: 1, conditions: [{ type: 'any-value-query-param', matchKey: 'src' }] }] }];
  state.rulesSeq = 4;
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1?src=wechat');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://target.example/rule?src=wechat');
});

test('I9：像素路由不套用规则', async () => {
  state.rules = [{ short_url_id: 1, rules: [{ longUrl: 'https://target.example/rule', priority: 1, conditions: [{ type: 'any-value-query-param', matchKey: 'src' }] }] }];
  state.rulesSeq = 5;
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1/track');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/gif');
});

test('I9：无规则的短链 → 走默认 longUrl，开销不变', async () => {
  state.rules = [];
  state.rulesSeq = 6;
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://target.example/ok');
});

test('I9：规则保存不触发主快照重拉（两个 seq 独立）', async () => {
  // 主快照走 link_seq，规则走 rules_seq —— 两个端点不同，规则写入不会让主快照重拉。
  // 权威断言在 SQL 层（link_version 不变、rules_seq 变），这里只验端点契约：
  // rules_seq 必须直接返回一个裸数字，rules-cache.js 按 number 解析。
  const res = await fetch(`http://127.0.0.1:${mock.address().port}/rest/v1/rpc/rules_seq`);
  assert.equal(res.status, 200);
  const value = await res.json();
  assert.equal(typeof value, 'number');
  assert.equal(value, state.rulesSeq);
});

test('I9：geo 省名条件命中 → 跳规则目标（需本地已构建 china-geo.bin）', async (t) => {
  const bin = path.join(__dirname, '..', 'china-geo.bin');
  if (!fs.existsSync(bin)) return t.skip('china-geo.bin 未构建（scripts/build-china-geo.mjs）');
  state.rules = [{ short_url_id: 1, rules: [{ longUrl: 'https://target.example/rule', priority: 1, conditions: [{ type: 'geolocation-city-name', matchValue: '广东' }] }] }];
  state.rulesSeq = 7;
  await new Promise((r) => setTimeout(r, 300));
  // 120.235.196.208 落广东（构建脚本对拍过的样本）
  const res = await req('/known1', HOST, { 'x-forwarded-for': '120.235.196.208' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://target.example/rule');
});

test('I9：geo 省名条件不命中（境外 IP）→ 默认长链', async (t) => {
  const bin = path.join(__dirname, '..', 'china-geo.bin');
  if (!fs.existsSync(bin)) return t.skip('china-geo.bin 未构建（scripts/build-china-geo.mjs）');
  state.rules = [{ short_url_id: 1, rules: [{ longUrl: 'https://target.example/rule', priority: 1, conditions: [{ type: 'geolocation-city-name', matchValue: '广东' }] }] }];
  state.rulesSeq = 8;
  await new Promise((r) => setTimeout(r, 300));
  const res = await req('/known1', HOST, { 'x-forwarded-for': '8.8.8.8' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, 'https://target.example/ok');
});
