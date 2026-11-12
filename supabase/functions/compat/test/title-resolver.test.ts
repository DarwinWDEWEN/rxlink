// R10 标题自动解析 —— 纯逻辑单测
// 运行：deno test --allow-env supabase/functions/compat/test/title-resolver.test.ts
import {
  assertPublicHost,
  charsetFromContentType,
  charsetFromMeta,
  decodeHtmlEntities,
  decodeWithCharset,
  extractTitle,
  isBlockedAddress,
  isIpLiteral,
  phpTrim,
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
  await assertPublicHost('example.com', dns);
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
