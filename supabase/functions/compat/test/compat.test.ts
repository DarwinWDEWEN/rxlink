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

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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

const { handleRequest } = await import('../handler.ts');

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
