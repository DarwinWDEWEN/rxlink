// R10：自动解析目标页 <title>（对齐上游 shlink ShortUrlTitleResolutionHelper）
//
// 用途：建链未填标题 / 编辑时刷新自动解析的标题时，抓目标页的 <title>。
// 安全：longUrl 用户可控，服务端去 fetch 等价于内网探测器 → 全部走 SSRF fail-closed 校验。
// 降级：任何失败一律返回 null（无标题），绝不抛给调用方。
//
// 运行在 Supabase Edge Function（Deno）。纯函数无副作用，便于 deno test 直接覆盖。

export const CHROME_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
export const MAX_REDIRECTS = 15;
export const FETCH_TIMEOUT_MS = 3000;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_TITLE_LENGTH = 512;

// 上游正则原样；d 标志只用于取捕获组下标，不改匹配语义
const TITLE_TAG_VALUE = /<title[^>]*>(.*?)<\/title>/id;
const CHARSET_VALUE = /charset=([^;]+)/i;
const CHARSET_FROM_META = /<meta\b[^>]*\bcharset\s*=\s*(?:["']?)([^"'\s>;]+)/i;

// ---------------------------------------------------------------------------
// 标题提取
// ---------------------------------------------------------------------------

export type TitleSpan = { start: number; end: number };

export function findTitleSpan(text: string): TitleSpan | null {
  const m = TITLE_TAG_VALUE.exec(text);
  if (!m || !m.indices) return null;
  const span = m.indices[1];
  if (!span) return null;
  return { start: span[0], end: span[1] };
}

export function extractTitle(text: string): string | null {
  const span = findTitleSpan(text);
  return span ? text.slice(span.start, span.end) : null;
}

// ---------------------------------------------------------------------------
// charset 探测（上游 resolvePageCharset 的顺序：Content-Type 头 → meta 标签）
// ---------------------------------------------------------------------------

export function charsetFromContentType(contentType: string): string | null {
  const m = CHARSET_VALUE.exec(contentType);
  return m ? m[1]!.trim() : null;
}

export function charsetFromMeta(text: string): string | null {
  const m = CHARSET_FROM_META.exec(text);
  return m ? m[1]!.trim() : null;
}

// ---------------------------------------------------------------------------
// 转码（WHATWG 编码集，含 gb18030 / big5 / shift_jis / euc-kr 等 decoder-only）
// ---------------------------------------------------------------------------

export function decodeWithCharset(bytes: Uint8Array, charset: string): string | null {
  try {
    const decoder = new TextDecoder(charset.trim().toLowerCase());
    const text = decoder.decode(bytes);
    return text.length > 0 ? text : null;
  } catch {
    // 标签不认识 → 丢弃标题（有意偏差，见设计稿 §9 偏差 #2）
    return null;
  }
}

// ---------------------------------------------------------------------------
// 实体解码（对齐 PHP html_entity_decode 的默认口径 ENT_QUOTES|ENT_HTML401）
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  laquo: '\u00ab',
  raquo: '\u00bb',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  bull: '\u2022',
  middot: '\u00b7',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6',
  trade: '\u2122',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

// PHP trim 的默认字符集是 " \t\n\r\0\x0B"；JS 的 trim() 会多删 NBSP → 自己实现
export function phpTrim(input: string): string {
  return input.replace(/^[ \t\n\r\0\u000b]+/, '').replace(/[ \t\n\r\0\u000b]+$/, '');
}

// 上游 DB 列是 varchar(512) → 截断到 512 个字符（按码点算，不按 UTF-16 码元）
export function truncateTitle(text: string, max: number = MAX_TITLE_LENGTH): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}
