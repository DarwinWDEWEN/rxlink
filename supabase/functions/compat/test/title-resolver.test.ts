// R10 标题自动解析 —— 纯逻辑单测
// 运行：deno test --allow-env supabase/functions/compat/test/title-resolver.test.ts
import {
  assertPublicHost,
  CHROME_USER_AGENT,
  charsetFromContentType,
  charsetFromMeta,
  decodeHtmlEntities,
  decodeWithCharset,
  extractTitle,
  isBlockedAddress,
  isIpLiteral,
  MAX_REDIRECTS,
  phpTrim,
  resolveTitle,
  truncateTitle,
  type ResolveDns,
} from '../title-resolver.ts';

function assert(cond: unknown, msg = 'assertion failed'): void {
  if (!cond) throw new Error(msg);
}

function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}

// --- 标题提取 -------------------------------------------------------------

Deno.test('标题提取：普通 title', () => {
  assertEquals(extractTitle('<html><head><title>Hello World</title></head></html>'), 'Hello World');
});

Deno.test('标题提取：带属性的 title 标签', () => {
  assertEquals(extractTitle('<title lang="zh-CN">中文标题</title>'), '中文标题');
});

Deno.test('标题提取：大小写不敏感', () => {
  assertEquals(extractTitle('<TITLE>Upper</TITLE>'), 'Upper');
});

Deno.test('标题提取：没有 title 返回 null', () => {
  assertEquals(extractTitle('<html><body>no title</body></html>'), null);
});

Deno.test('标题提取：跨行不匹配（对齐上游正则没有 s 标志）', () => {
  assertEquals(extractTitle('<title>line1\nline2</title>'), null);
});

Deno.test('标题提取：取第一个 title（上游是非贪婪）', () => {
  assertEquals(extractTitle('<title>First</title><title>Second</title>'), 'First');
});

// --- charset 探测 ---------------------------------------------------------

Deno.test('charset：从 Content-Type 头取', () => {
  assertEquals(charsetFromContentType('text/html; charset=utf-8'), 'utf-8');
  assertEquals(charsetFromContentType('text/html; charset=UTF-8'), 'UTF-8');
  assertEquals(charsetFromContentType('text/html'), null);
});

Deno.test('charset：从 meta 标签取（两种写法都认）', () => {
  assertEquals(charsetFromMeta('<meta charset="gbk">'), 'gbk');
  assertEquals(charsetFromMeta('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">'), 'gb2312');
  assertEquals(charsetFromMeta('<html><body>x</body></html>'), null);
});

// --- 转码 -----------------------------------------------------------------

Deno.test('转码：utf-8', () => {
  assertEquals(decodeWithCharset(new TextEncoder().encode('中文标题'), 'utf-8'), '中文标题');
});

Deno.test('转码：gb2312 标签能解 GBK 字节（WHATWG 标签归一）', () => {
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2]);
  assertEquals(decodeWithCharset(gbk, 'gb2312'), '中文标题');
  assertEquals(decodeWithCharset(gbk, 'gbk'), '中文标题');
});

Deno.test('转码：latin1', () => {
  assertEquals(decodeWithCharset(new Uint8Array([0xe9]), 'iso-8859-1'), 'é');
});

Deno.test('转码：不认识的 charset 标签 → null（丢弃标题）', () => {
  assertEquals(decodeWithCharset(new Uint8Array([1, 2, 3]), 'x-unknown-charset'), null);
});

// --- 实体解码 -------------------------------------------------------------

Deno.test('实体解码：命名实体', () => {
  assertEquals(decodeHtmlEntities('A &amp; B'), 'A & B');
  assertEquals(decodeHtmlEntities('&lt;tag&gt;'), '<tag>');
  assertEquals(decodeHtmlEntities('&quot;hi&quot;'), '"hi"');
  assertEquals(decodeHtmlEntities('&nbsp;x&nbsp;'), '\u00a0x\u00a0');
});

Deno.test('实体解码：数字实体', () => {
  assertEquals(decodeHtmlEntities('&#39;'), "'");
  assertEquals(decodeHtmlEntities('&#x4e2d;'), '中');
});

Deno.test('实体解码：双重编码语义（&amp;amp; → &amp;）', () => {
  assertEquals(decodeHtmlEntities('&amp;amp;'), '&amp;');
});

Deno.test('实体解码：&apos; 不在 HTML401 集 → 不解码', () => {
  assertEquals(decodeHtmlEntities('&apos;'), '&apos;');
});

Deno.test('实体解码：未知命名实体原样保留', () => {
  assertEquals(decodeHtmlEntities('&unknownentity;'), '&unknownentity;');
});

// --- trim 与截断 ----------------------------------------------------------

Deno.test('trim：PHP 口径（不删 NBSP）', () => {
  assertEquals(phpTrim('  hi  '), 'hi');
  assertEquals(phpTrim('\t\nhi\r\n'), 'hi');
  assertEquals(phpTrim('\u00a0hi\u00a0'), '\u00a0hi\u00a0');
});

Deno.test('截断：超过 512 字符则截断', () => {
  assertEquals(truncateTitle('x'.repeat(600)).length, 512);
  assertEquals(truncateTitle('short'), 'short');
});

// --- SSRF：IP 判定 --------------------------------------------------------

const BLOCKED_ADDRESSES = [
  '0.0.0.0',
  '10.0.0.1',
  '100.64.0.1',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.1',
  '192.168.1.1',
  '198.18.0.1',
  '224.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  'fc00::1',
  'fd12:3456::1',
  'fe80::1',
  'ff00::1',
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.1',
  '64:ff9b::127.0.0.1',
  '2002:7f00:1::1',
];

for (const ip of BLOCKED_ADDRESSES) {
  Deno.test(`SSRF：${ip} 必须被拦截`, () => {
    assert(isBlockedAddress(ip), `${ip} 应该被拦截`);
  });
}

const PUBLIC_ADDRESSES = [
  '1.1.1.1',
  '8.8.8.8',
  '93.184.216.34',
  '100.128.0.1',
  '172.32.0.1',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
];

for (const ip of PUBLIC_ADDRESSES) {
  Deno.test(`SSRF：${ip} 必须放行`, () => {
    assert(!isBlockedAddress(ip), `${ip} 不该被拦截`);
  });
}

Deno.test('SSRF：认不出来的地址 fail closed', () => {
  assert(isBlockedAddress('not-an-ip'));
  assert(isBlockedAddress(''));
  assert(isBlockedAddress('999.1.1.1'));
});

Deno.test('SSRF：IP 字面量识别', () => {
  assert(isIpLiteral('127.0.0.1'));
  assert(isIpLiteral('::1'));
  assert(isIpLiteral('[::1]'));
  assert(!isIpLiteral('example.com'));
});

// --- SSRF：主机校验 -------------------------------------------------------

Deno.test('assertPublicHost：域名解析到公网 → 放行', async () => {
  const dns: ResolveDns = async () => ['93.184.216.34'];
  const addresses: unknown = await assertPublicHost('example.com', dns);
  assertEquals(addresses, ['93.184.216.34']);
});

Deno.test('assertPublicHost：域名解析到内网 → 抛错', async () => {
  const dns: ResolveDns = async () => ['10.0.0.5'];
  let threw = false;
  try {
    await assertPublicHost('evil.example.com', dns);
  } catch {
    threw = true;
  }
  assert(threw, '解析到内网必须被拒');
});

Deno.test('assertPublicHost：任一解析结果落在内网 → 抛错（fail closed，不挑一个）', async () => {
  const dns: ResolveDns = async () => ['93.184.216.34', '127.0.0.1'];
  let threw = false;
  try {
    await assertPublicHost('mixed.example.com', dns);
  } catch {
    threw = true;
  }
  assert(threw, '混合解析结果必须整体拒绝');
});

Deno.test('assertPublicHost：DNS 解析为空 → 抛错', async () => {
  const dns: ResolveDns = async () => [];
  let threw = false;
  try {
    await assertPublicHost('empty.example.com', dns);
  } catch {
    threw = true;
  }
  assert(threw, '解析为空必须被拒');
});

Deno.test('assertPublicHost：内网 IP 字面量 → 抛错，且不查 DNS', async () => {
  let queried = false;
  const dns: ResolveDns = async () => {
    queried = true;
    return ['93.184.216.34'];
  };
  let threw = false;
  try {
    await assertPublicHost('127.0.0.1', dns);
  } catch {
    threw = true;
  }
  assert(threw, '内网字面量必须被拒');
  assert(!queried, 'IP 字面量不该查 DNS');
});

Deno.test('assertPublicHost：IPv6 字面量带方括号 → 抛错', async () => {
  let threw = false;
  try {
    await assertPublicHost('[::1]', async () => ['93.184.216.34']);
  } catch {
    threw = true;
  }
  assert(threw, '[::1] 必须被拒');
});

// --- 抓取主流程 -----------------------------------------------------------

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

const PUBLIC_DNS: ResolveDns = async () => ['93.184.216.34'];

Deno.test('抓取：请求连接只能使用本轮已校验的 DNS 地址', async () => {
  let connectedAddresses: unknown;
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: (async (...args: unknown[]) => {
      connectedAddresses = args[2];
      return htmlResponse('<title>Pinned</title>');
    }) as typeof fetch,
    resolveDns: async () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
  });
  assertEquals(title, 'Pinned');
  assertEquals(connectedAddresses, ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
});

Deno.test('抓取：正常页面取到标题', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => htmlResponse('<html><head><title>Example Domain</title></head></html>'),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, 'Example Domain');
});

Deno.test('抓取：请求带 Chrome UA 且 redirect=manual', async () => {
  let seen: RequestInit | undefined;
  await resolveTitle('https://example.com/a', {
    fetchImpl: async (_url, init) => {
      seen = init;
      return htmlResponse('<title>X</title>');
    },
    resolveDns: PUBLIC_DNS,
  });
  const headers = seen?.headers as Record<string, string>;
  assertEquals(headers['user-agent'], CHROME_USER_AGENT);
  assertEquals(seen?.redirect, 'manual');
});

Deno.test('抓取：实体解码后再入库', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => htmlResponse('<title>A &amp; B</title>'),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, 'A & B');
});

Deno.test('抓取：超长标题截断到 512', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => htmlResponse(`<title>${'x'.repeat(600)}</title>`),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title?.length, 512);
});

Deno.test('抓取：非 text/html → 无标题', async () => {
  const title = await resolveTitle('https://example.com/a.json', {
    fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
});

Deno.test('抓取：没有 charset 且没有 meta charset → 丢弃标题（上游行为）', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () =>
      new Response('<title>X</title>', { headers: { 'content-type': 'text/html' } }),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
});

Deno.test('抓取：meta charset 能救回来', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () =>
      new Response('<meta charset="utf-8"><title>X</title>', { headers: { 'content-type': 'text/html' } }),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, 'X');
});

Deno.test('抓取：跟随重定向到公网', async () => {
  const calls: string[] = [];
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://example.com/b' } });
      }
      return htmlResponse('<title>Redirected</title>');
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, 'Redirected');
  assertEquals(calls.length, 2);
});

Deno.test('抓取：跟随重定向前取消上一跳响应流', async () => {
  let cancelled = false;
  let calls = 0;
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }), {
          status: 302,
          headers: { location: 'https://example.com/b' },
        });
      }
      return htmlResponse('<title>Redirected</title>');
    },
    resolveDns: PUBLIC_DNS,
  });

  assertEquals(title, 'Redirected');
  assertEquals(cancelled, true);
});

Deno.test('抓取：重定向到内网 → 拒绝', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
});

Deno.test('抓取：重定向超过 15 跳 → 放弃', async () => {
  let n = 0;
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => {
      n++;
      return new Response(null, { status: 302, headers: { location: `https://example.com/${n}` } });
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
  assertEquals(n, MAX_REDIRECTS + 1);
});

Deno.test('抓取：直接指向内网 IP → 拒绝且不发请求', async () => {
  let fetched = 0;
  const title = await resolveTitle('http://169.254.169.254/latest/', {
    fetchImpl: async () => {
      fetched++;
      return htmlResponse('<title>secret</title>');
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
  assertEquals(fetched, 0);
});

Deno.test('抓取：域名解析到内网 → 拒绝且不发请求', async () => {
  let fetched = 0;
  const title = await resolveTitle('https://evil.example.com/', {
    fetchImpl: async () => {
      fetched++;
      return htmlResponse('<title>x</title>');
    },
    resolveDns: async () => ['10.0.0.5'],
  });
  assertEquals(title, null);
  assertEquals(fetched, 0);
});

Deno.test('抓取：非 http(s) 协议 → 拒绝', async () => {
  let fetched = 0;
  const title = await resolveTitle('file:///etc/passwd', {
    fetchImpl: async () => {
      fetched++;
      return htmlResponse('<title>x</title>');
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
  assertEquals(fetched, 0);
});

Deno.test('抓取：带凭据的 URL → 拒绝', async () => {
  let fetched = 0;
  const title = await resolveTitle('https://user:pass@example.com/', {
    fetchImpl: async () => {
      fetched++;
      return htmlResponse('<title>x</title>');
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
  assertEquals(fetched, 0);
});

Deno.test('抓取：网络异常 → 无标题（降级不抛）', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: async () => {
      throw new Error('network down');
    },
    resolveDns: PUBLIC_DNS,
  });
  assertEquals(title, null);
});

Deno.test('抓取：超时 → 无标题', async () => {
  const title = await resolveTitle('https://example.com/a', {
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    resolveDns: PUBLIC_DNS,
    timeoutMs: 50,
  });
  assertEquals(title, null);
});

Deno.test('抓取：失败只记原因码 + host，不记完整 URL', async () => {
  const logs: string[] = [];
  const title = await resolveTitle('https://example.com/x?token=secret', {
    fetchImpl: async () => {
      throw new Error('network down');
    },
    resolveDns: PUBLIC_DNS,
    log: (m) => logs.push(m),
  });
  assertEquals(title, null);
  assert(logs.length > 0, '应该记录了失败原因');
  assert(logs[0]!.includes('code='), `缺原因码：${logs[0]}`);
  assert(logs[0]!.includes('host=example.com'), `缺 host：${logs[0]}`);
  assert(!logs[0]!.includes('token=secret'), `日志泄露了完整 URL：${logs[0]}`);
});
