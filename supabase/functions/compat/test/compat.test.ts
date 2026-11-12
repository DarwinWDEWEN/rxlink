// 兼容层单测（I8：R4 /short-urls/shorten、R7 /visits/export + 既有路由回归）
// 运行：deno test --allow-env supabase/functions/compat/test/compat.test.ts
//
// handler.ts 在模块加载时读 env，所以先 set env 再动态 import；
// RPC 全部走全局 fetch，测试里替换成 mock，不碰真库。
const BASE = 'https://test.supabase.co';
Deno.env.set('SUPABASE_URL', BASE);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

type RpcReply =
  | { ok: true; body: unknown }
  | { ok: false; status: number; code: string; message: string };

type RpcCall = { fn: string; body: Record<string, unknown> };
const calls: RpcCall[] = [];
let rpcImpl: (fn: string, body: Record<string, unknown>) => RpcReply = () => ({ ok: true, body: null });

// 外部（非 /rpc/）请求的桩：R10 的标题抓取会走这里
let externalImpl: (url: string, init?: RequestInit) => Promise<Response> =
  () => Promise.reject(new Error('unexpected external request'));

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  // R10：按 URL 分流，抓取请求不能被 RPC mock 吞掉
  if (!url.includes('/rpc/')) return externalImpl(url, init);
  const fn = url.slice(url.lastIndexOf('/rpc/') + '/rpc/'.length);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ fn, body });
  const reply = rpcImpl(fn, body);
  const payload = reply.ok ? reply.body : { code: reply.code, message: reply.message };
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status: reply.ok ? 200 : reply.status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}) as typeof fetch;

const { handleRequest, titleResolverDeps } = await import('../handler.ts');

const KEY = 'rxl_test_key';
const AUTH = { 'X-Api-Key': KEY };

function req(path: string, init: RequestInit = {}): Promise<Response> {
  return handleRequest(new Request(`${BASE}/functions/v1/compat/rest/v3${path}`, init));
}

async function bodyJson(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text());
}

// 不引外部 assert 库：仓库没有 deno.json imports，避免测试依赖网络
function assert(cond: unknown, msg = 'assertion failed'): void {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}

// 每个测试前清空调用记录；默认 compat_auth 放行、其余 RPC 返回 null
function reset(impl?: (fn: string, body: Record<string, unknown>) => RpcReply) {
  calls.length = 0;
  // R10：默认关掉自动解析，既有用例不受影响；R10 用例自己打开
  Deno.env.set('AUTO_RESOLVE_TITLES', 'false');
  externalImpl = () => Promise.reject(new Error('unexpected external request'));
  rpcImpl = impl ??
    ((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
}

Deno.test('health 免鉴权返回 pass', async () => {
  reset();
  const res = await req('/health');
  assertEquals(res.status, 200);
  const body = await bodyJson(res);
  assertEquals(body, { status: 'pass', version: '5.1.0' });
  assertEquals(calls.length, 0); // 连通性闸门不打 RPC
});

Deno.test('OPTIONS 预检 204 且回显 Origin', async () => {
  reset();
  const res = await req('/short-urls', { method: 'OPTIONS', headers: { Origin: 'https://console.example' } });
  assertEquals(res.status, 204);
  assertEquals(res.headers.get('access-control-allow-origin'), 'https://console.example');
  assertEquals(res.headers.get('access-control-allow-credentials'), 'true');
});

Deno.test('受保护路由无 key → 401 missing-authentication', async () => {
  reset();
  const res = await req('/short-urls');
  assertEquals(res.status, 401);
  const body = await bodyJson(res);
  assertEquals(body.type, 'https://shlink.io/api/error/missing-authentication');
});

Deno.test('compat_auth 判过期/停用 → 401 文案含 expired', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: null } : { ok: true, body: null }));
  const res = await req('/short-urls', { headers: AUTH });
  assertEquals(res.status, 401);
  const body = await bodyJson(res);
  assertEquals(body.type, 'https://shlink.io/api/error/invalid-api-key');
  assert(String(body.detail).includes('has expired'));
});

Deno.test('R4：X-Api-Key 建链返回 JSON', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortUrl: 'https://example.com/abcde', longUrl: 'https://example.com/a' } };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/shorten?longUrl=https%3A%2F%2Fexample.com%2Fa', { headers: AUTH });
  assertEquals(res.status, 200);
  const body = await bodyJson(res);
  assertEquals(body.shortUrl, 'https://example.com/abcde');
  const call = calls.find((c) => c.fn === 'create_short_url');
  assertEquals(call?.body.p_long_url, 'https://example.com/a');
  assertEquals(call?.body.p_author_api_key_id, 7);
});

Deno.test('R4：query apiKey 鉴权（shlink 契约）', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortUrl: 'https://example.com/query' } };
    return { ok: true, body: null };
  });
  const res = await req(`/short-urls/shorten?longUrl=https%3A%2F%2Fexample.com%2Fb&apiKey=${KEY}`);
  assertEquals(res.status, 200);
  assert(calls.some((c) => c.fn === 'compat_auth'));
  assert(calls.some((c) => c.fn === 'create_short_url'));
});

Deno.test('R4：format=txt 返回纯文本短链', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortUrl: 'https://example.com/texty' } };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/shorten?longUrl=https%3A%2F%2Fexample.com%2Fc&format=txt', { headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('content-type'), 'text/plain');
  assertEquals(await res.text(), 'https://example.com/texty');
});

Deno.test('R4：Accept: text/plain 也走纯文本', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortUrl: 'https://example.com/accepty' } };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/shorten?longUrl=https%3A%2F%2Fexample.com%2Fd', {
    headers: { ...AUTH, Accept: 'text/plain' },
  });
  assertEquals(res.headers.get('content-type'), 'text/plain');
  assertEquals(await res.text(), 'https://example.com/accepty');
});

Deno.test('R4：缺 longUrl → 400 invalid-data', async () => {
  reset();
  const res = await req('/short-urls/shorten?domain=example.com', { headers: AUTH });
  assertEquals(res.status, 400);
  const body = await bodyJson(res);
  assertEquals(body.type, 'https://shlink.io/api/error/invalid-data');
});

const VISIT_ROW = {
  date: '2026-11-11T10:00:00+00:00',
  referer: 'https://news.example/a?x=1,2',
  userAgent: 'Mozilla/5.0 ("test")',
  potentialBot: false,
  visitLocation: { countryCode: 'US', regionName: 'California', cityName: 'San Jose' },
  visitedUrl: 'https://example.com/abcde',
  redirectUrl: 'https://example.com/a',
  type: null,
};

Deno.test('R7：默认 non-orphan 导出 CSV', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'list_visits') return { ok: true, body: { data: [VISIT_ROW] } };
    return { ok: true, body: null };
  });
  const res = await req('/visits/export', { headers: AUTH });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assertEquals(res.headers.get('content-disposition'), 'attachment; filename="visits.csv"');
  const text = await res.text();
  const lines = text.split('\n').filter((l) => l !== '');
  assertEquals(lines[0], 'date,referer,userAgent,potentialBot,visitLocation,visitedUrl,redirectUrl,type');
  // referer 含逗号 → 加引号；userAgent 含引号 → 双写
  assert(lines[1].includes('"https://news.example/a?x=1,2",'));
  assert(lines[1].includes('"Mozilla/5.0 (""test"")"'));
  assert(lines[1].includes('US / California / San Jose'));
  assert(lines[1].endsWith('https://example.com/a,')); // type 为空 → 行尾单个逗号
  const call = calls.find((c) => c.fn === 'list_visits');
  assertEquals(call?.body.p_scope, 'non-orphan');
});

Deno.test('R7：visitLocation 为 null → 空单元格', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'list_visits') return { ok: true, body: { data: [{ ...VISIT_ROW, visitLocation: null }] } };
    return { ok: true, body: null };
  });
  const res = await req('/visits/export?scope=orphan&type=invalid', { headers: AUTH });
  assertEquals(res.status, 200);
  const lines = (await res.text()).split('\n').filter((l) => l !== '');
  // null 位置：potentialBot 后紧跟两个逗号
  assert(lines[1].includes('false,,https://example.com/abcde'));
  const call = calls.find((c) => c.fn === 'list_visits');
  assertEquals(call?.body.p_scope, 'orphan');
  assertEquals(call?.body.p_orphan_type, 'invalid');
});

Deno.test('R7：scope=short 缺 code → 400', async () => {
  reset();
  const res = await req('/visits/export?scope=short', { headers: AUTH });
  assertEquals(res.status, 400);
  const body = await bodyJson(res);
  assertEquals(body.type, 'https://shlink.io/api/error/invalid-data');
});

Deno.test('R7：非法 scope → 400', async () => {
  reset();
  const res = await req('/visits/export?scope=bogus', { headers: AUTH });
  assertEquals(res.status, 400);
});

Deno.test('既有：GET /short-urls 透传分页默认值', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'list_short_urls') return { ok: true, body: { data: [], pagination: { currentPage: 1 } } };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls', { headers: AUTH });
  assertEquals(res.status, 200);
  const body = await bodyJson(res);
  assertEquals(body.shortUrls, { data: [], pagination: { currentPage: 1 } });
  const call = calls.find((c) => c.fn === 'list_short_urls');
  assertEquals(call?.body.p_page, 1);
  assertEquals(call?.body.p_items, 20);
});

Deno.test('既有：POST /short-urls 带 author key id', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortUrl: 'https://example.com/posted' } };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/post', customSlug: 'posted' }),
  });
  assertEquals(res.status, 200);
  const call = calls.find((c) => c.fn === 'create_short_url');
  assertEquals(call?.body.p_custom_slug, 'posted');
  assertEquals(call?.body.p_author_api_key_id, 7);
});

// ---- I9：R9 动态跳转规则 ----

function ruleBody(rules: unknown) {
  return JSON.stringify({ redirectRules: rules });
}

Deno.test('I9：version 旋钮提到 5.1.0', async () => {
  reset();
  const res = await req('/health');
  const body = await bodyJson(res);
  assertEquals(body.version, '5.1.0');
});

Deno.test('I9：GET redirect-rules 透传 RPC 结果', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'get_short_url_redirect_rules') {
      return {
        ok: true,
        body: {
          defaultLongUrl: 'https://example.com/default',
          redirectRules: [
            { longUrl: 'https://example.com/m', priority: 1, conditions: [{ type: 'device', matchKey: null, matchValue: 'mobile' }] },
          ],
        },
      };
    }
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/abc/redirect-rules', { headers: AUTH });
  assertEquals(res.status, 200);
  const body = await bodyJson(res);
  assertEquals(body.defaultLongUrl, 'https://example.com/default');
  assertEquals((body.redirectRules as unknown[]).length, 1);
  const call = calls.find((c) => c.fn === 'get_short_url_redirect_rules');
  assertEquals(call?.body.p_code, 'abc');
});

Deno.test('I9：POST redirect-rules 调 set RPC 并返回结果', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'set_short_url_redirect_rules') {
      return {
        ok: true,
        body: {
          defaultLongUrl: 'https://example.com/default',
          redirectRules: [
            { longUrl: 'https://example.com/m', priority: 1, conditions: [{ type: 'device', matchKey: null, matchValue: 'mobile' }] },
          ],
        },
      };
    }
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://example.com/m', conditions: [{ type: 'device', matchValue: 'mobile' }] }]),
  });
  assertEquals(res.status, 200);
  const call = calls.find((c) => c.fn === 'set_short_url_redirect_rules');
  assertEquals(call?.body.p_code, 'abc');
  const rules = (call?.body.p_rules as Array<{ longUrl: string; conditions: unknown[] }>);
  assertEquals(rules.length, 1);
  assertEquals(rules[0].longUrl, 'https://example.com/m');
});

Deno.test('I9：PATCH 也支持', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'set_short_url_redirect_rules') return { ok: true, body: { defaultLongUrl: 'https://x', redirectRules: [] } };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([]),
  });
  assertEquals(res.status, 200);
  assert(calls.some((c) => c.fn === 'set_short_url_redirect_rules'));
});

Deno.test('I9：device 非法值 → 400 invalid-data', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'device', matchValue: 'desktop2' }] }]),
  });
  assertEquals(res.status, 400);
  const body = await bodyJson(res);
  assertEquals(body.type, 'https://shlink.io/api/error/invalid-data');
  assert(String(body.detail).includes('desktop2'));
});

Deno.test('I9：browser 非法值 → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'browser', matchValue: 'ie' }] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：ip-address 非法值 → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'ip-address', matchValue: '999.1.1.1' }] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：geolocation-country-code 非两字母 → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'geolocation-country-code', matchValue: 'CHN' }] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：query-param 空 matchValue → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'query-param', matchKey: 'k', matchValue: '' }] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：未知 type → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ longUrl: 'https://x', conditions: [{ type: 'nope', matchValue: 'v' }] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：缺 longUrl → 400', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([{ conditions: [] }]),
  });
  assertEquals(res.status, 400);
});

Deno.test('I9：11 种合法 type 全部放行', async () => {
  const cases: Array<[string, string | null, string | null]> = [
    ['device', null, 'mobile'],
    ['browser', null, 'chrome'],
    ['language', null, 'zh-CN'],
    ['query-param', 'src', 'wechat'],
    ['any-value-query-param', 'src', null],
    ['valueless-query-param', 'src', null],
    ['ip-address', null, '192.168.0.0/16'],
    ['geolocation-country-code', null, 'CN'],
    ['geolocation-city-name', null, 'Guangdong'],
    ['before-date', null, '2027-01-01T00:00:00Z'],
    ['after-date', null, '2020-01-01T00:00:00Z'],
  ];
  for (const [type, matchKey, matchValue] of cases) {
    reset((fn) => {
      if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
      if (fn === 'set_short_url_redirect_rules') return { ok: true, body: { defaultLongUrl: 'https://x', redirectRules: [] } };
      return { ok: true, body: null };
    });
    const cond: Record<string, unknown> = { type };
    if (matchKey !== null) cond.matchKey = matchKey;
    if (matchValue !== null) cond.matchValue = matchValue;
    const res = await req('/short-urls/abc/redirect-rules', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: ruleBody([{ longUrl: 'https://x', conditions: [cond] }]),
    });
    assertEquals(res.status, 200, `type=${type} 应该放行`);
  }
});

Deno.test('I9：空 redirectRules 数组合法（清空规则）', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'set_short_url_redirect_rules') return { ok: true, body: { defaultLongUrl: 'https://x', redirectRules: [] } };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/abc/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([]),
  });
  assertEquals(res.status, 200);
});

Deno.test('I9：短链不存在 → 404 short-url-not-found', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'set_short_url_redirect_rules') return { ok: false, status: 404, code: 'P0002', message: 'short_url_not_found' };
    return { ok: true, body: null };
  });
  const res = await req('/short-urls/nope/redirect-rules', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: ruleBody([]),
  });
  assertEquals(res.status, 404);
  const body = await bodyJson(res);
  assertEquals(body.type, 'https://shlink.io/api/error/short-url-not-found');
});

Deno.test('I9：excludeTags 传给 list_short_urls', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  await req('/short-urls?excludeTags%5B%5D=alpha&excludeTags%5B%5D=beta&excludeTagsMode=any', { headers: AUTH });
  const call = calls.find((c) => c.fn === 'list_short_urls');
  assertEquals(call?.body.p_excluded_tags, ['alpha', 'beta']);
  assertEquals(call?.body.p_excluded_tags_mode, 'any');
});

Deno.test('I9：tags/excludeTags 逗号串要拆成数组（shlink splitByComma 口径）', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  await req('/short-urls?tags=i3,i4%20x&excludeTags=a,b', { headers: AUTH });
  const call = calls.find((c) => c.fn === 'list_short_urls');
  assertEquals(call?.body.p_tags, ['i3', 'i4 x']);
  assertEquals(call?.body.p_excluded_tags, ['a', 'b']);
});

Deno.test('I9：数组写法 tags[]= 与逗号写法可混用', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  await req('/short-urls?tags%5B%5D=a&tags%5B%5D=b,c&excludeTags%5B%5D=x,y', { headers: AUTH });
  const call = calls.find((c) => c.fn === 'list_short_urls');
  assertEquals(call?.body.p_tags, ['a', 'b', 'c']);
  assertEquals(call?.body.p_excluded_tags, ['x', 'y']);
});

Deno.test('I9：tagsMode/excludeTagsMode 缺省为 any（对齐上游 TagsMode::ANY）', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  await req('/short-urls?tags=a', { headers: AUTH });
  const call = calls.find((c) => c.fn === 'list_short_urls');
  assertEquals(call?.body.p_tags_mode, 'any');
  assertEquals(call?.body.p_excluded_tags_mode, 'any');
});

Deno.test('I9：显式传的 tagsMode=all 仍然生效', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  await req('/short-urls?tags=a,b&tagsMode=all&excludeTags=c&excludeTagsMode=all', { headers: AUTH });
  const call = calls.find((c) => c.fn === 'list_short_urls');
  assertEquals(call?.body.p_tags_mode, 'all');
  assertEquals(call?.body.p_excluded_tags_mode, 'all');
});

Deno.test('I9：畸形百分号编码不报 500（走正常的查不到分支）', async () => {
  reset((fn) => (fn === 'compat_auth' ? { ok: true, body: { id: 7, name: 'test-key' } } : { ok: true, body: null }));
  for (const path of ['/short-urls/%ZZ/redirect-rules', '/short-urls/%ZZ', '/short-urls/%ZZ/visits']) {
    const res = await req(path, { headers: AUTH });
    assert(res.status !== 500, `${path} 不该是 500，实际 ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// R10：标题自动解析
// ---------------------------------------------------------------------------

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

// 把抓取依赖换掉：假 DNS + 假 fetch，绝不碰真网
function setupTitleFetch(body: string, addresses: string[] = ['93.184.216.34']) {
  titleResolverDeps.resolveDns = async () => addresses;
  externalImpl = async () => htmlResponse(body);
}

function createCall() {
  return calls.find((c) => c.fn === 'create_short_url');
}

function updateCall() {
  return calls.find((c) => c.fn === 'update_short_url');
}

Deno.test('R10：默认（未设环境变量）→ 建链不带 title 时抓标题并标自动解析', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES'); // 未设置 = 默认开
  setupTitleFetch('<html><head><title>Fetched Title</title></head></html>');

  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/x' }),
  });

  assertEquals(res.status, 200);
  assertEquals(createCall()?.body.p_title, 'Fetched Title');
  assertEquals(createCall()?.body.p_title_was_auto_resolved, true);
});

Deno.test('R10：建链带 title → 不抓，来源 false', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  setupTitleFetch('<title>Should Not Be Used</title>');

  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/x', title: 'Manual Title' }),
  });

  assertEquals(res.status, 200);
  assertEquals(createCall()?.body.p_title, 'Manual Title');
  assertEquals(createCall()?.body.p_title_was_auto_resolved, false);
});

Deno.test('R10：建链抓不到 → title 为空、来源 false、建链仍成功', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  externalImpl = async () => Promise.reject(new Error('network down'));

  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/x' }),
  });

  assertEquals(res.status, 200);
  assertEquals(createCall()?.body.p_title, null);
  assertEquals(createCall()?.body.p_title_was_auto_resolved, false);
});

Deno.test('R10：AUTO_RESOLVE_TITLES=false → 完全不抓', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.set('AUTO_RESOLVE_TITLES', 'false');
  setupTitleFetch('<title>Should Not Be Used</title>');

  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/x' }),
  });

  assertEquals(res.status, 200);
  assertEquals(createCall()?.body.p_title, null);
  assertEquals(createCall()?.body.p_title_was_auto_resolved, false);
});

Deno.test('R10：编辑带 title → 不抓，p_auto_title 为 null', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'update_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  setupTitleFetch('<title>Should Not Be Used</title>');

  const res = await req('/short-urls/abc12', {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/y', title: 'Manual' }),
  });

  assertEquals(res.status, 200);
  assertEquals(updateCall()?.body.p_auto_title, null);
  assertEquals((updateCall()?.body.p_patch as Record<string, unknown>).title, 'Manual');
});

Deno.test('R10：编辑改 longUrl → 抓到的标题走 p_auto_title，且不进 patch', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'update_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  setupTitleFetch('<title>Refreshed</title>');

  const res = await req('/short-urls/abc12', {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/y' }),
  });

  assertEquals(res.status, 200);
  assertEquals(updateCall()?.body.p_auto_title, 'Refreshed');
  const patch = updateCall()?.body.p_patch as Record<string, unknown>;
  assertEquals(patch.title, undefined);
});

Deno.test('R10：编辑抓不到 → p_auto_title 为 null', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'update_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  externalImpl = async () => Promise.reject(new Error('network down'));

  const res = await req('/short-urls/abc12', {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/y' }),
  });

  assertEquals(res.status, 200);
  assertEquals(updateCall()?.body.p_auto_title, null);
});

Deno.test('R10：编辑既不改 longUrl 也不给 title → 不抓', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'update_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  setupTitleFetch('<title>Should Not Be Used</title>');

  const res = await req('/short-urls/abc12', {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ crawlable: true }),
  });

  assertEquals(res.status, 200);
  assertEquals(updateCall()?.body.p_auto_title, null);
});

Deno.test('R10：抓取失败只记原因码 + host，不记完整 URL', async () => {
  reset((fn) => {
    if (fn === 'compat_auth') return { ok: true, body: { id: 7, name: 'test-key' } };
    if (fn === 'create_short_url') return { ok: true, body: { shortCode: 'abc12' } };
    return { ok: true, body: null };
  });
  Deno.env.delete('AUTO_RESOLVE_TITLES');
  const logs: string[] = [];
  titleResolverDeps.log = (m: string) => logs.push(m);
  // 解析到内网 → 被 SSRF 拦截
  titleResolverDeps.resolveDns = async () => ['10.0.0.5'];
  externalImpl = async () => htmlResponse('<title>x</title>');

  const res = await req('/short-urls', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ longUrl: 'https://example.com/x?token=secret' }),
  });

  assertEquals(res.status, 200);
  assertEquals(createCall()?.body.p_title, null);
  assert(logs.length > 0, '应该记录了失败原因');
  assert(logs[0]!.includes('code=blocked_address'), `原因码不对：${logs[0]}`);
  assert(logs[0]!.includes('host=example.com'), `host 不对：${logs[0]}`);
  // 关键：不能出现完整 URL（query 里可能有 token）
  assert(!logs[0]!.includes('token=secret'), `日志里泄露了完整 URL：${logs[0]}`);
});
