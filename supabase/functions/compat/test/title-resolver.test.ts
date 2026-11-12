// R10 标题自动解析 —— 纯逻辑单测
// 运行：deno test --allow-env supabase/functions/compat/test/title-resolver.test.ts
import {
  charsetFromContentType,
  charsetFromMeta,
  decodeHtmlEntities,
  decodeWithCharset,
  extractTitle,
  phpTrim,
  truncateTitle,
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
