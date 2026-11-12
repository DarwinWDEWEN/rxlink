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

// ---------------------------------------------------------------------------
// 失败原因码
//
// 只允许在日志里出现这些码 + host，绝不能出现完整 URL（长链 query 可能带 token）。
// ---------------------------------------------------------------------------

export type TitleResolveReason =
  | 'unsupported_scheme'
  | 'credentials_in_url'
  | 'missing_host'
  | 'blocked_address'
  | 'dns_failed'
  | 'request_failed'
  | 'timeout'
  | 'redirect_limit'
  | 'not_html'
  | 'no_charset'
  | 'no_title'
  | 'unknown_charset';

class ResolveError extends Error {
  constructor(readonly code: TitleResolveReason) {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// SSRF：IP 判定（fail-closed）
// ---------------------------------------------------------------------------

function parseIpv4(raw: string): number[] | null {
  const parts = raw.trim().split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function ipv4ToNumber(v: number[]): number {
  return ((v[0]! << 24) >>> 0) + (v[1]! << 16) + (v[2]! << 8) + v[3]!;
}

// 禁止网段：[起始, 结束]
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8      「本网络」
  [0x0a000000, 0x0affffff], // 10.0.0.0/8     私有
  [0x64400000, 0x647fffff], // 100.64.0.0/10  CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8   环回
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
  [0xac100000, 0xac1fffff], // 172.16.0.0/12 私有
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24  IETF 协议赋值
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16 私有
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 基准测试
  [0xe0000000, 0xefffffff], // 224.0.0.0/4   组播
  [0xf0000000, 0xffffffff], // 240.0.0.0/4   保留（含 255.255.255.255）
];

function isBlockedIpv4(v: number[]): boolean {
  const n = ipv4ToNumber(v);
  return BLOCKED_V4.some(([lo, hi]) => n >= lo && n <= hi);
}

function parseHextet(raw: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(raw)) return null;
  return parseInt(raw, 16);
}

function parseIpv6(raw: string): number[] | null {
  let s = raw.trim();
  // URL 的 hostname 对 IPv6 字面量是带方括号的形式（[::1]）→ 在解析层剥掉
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  s = s.split('%')[0]!.toLowerCase();
  if (!s.includes(':')) return null;
  // 内嵌 IPv4（::ffff:1.2.3.4 / 64:ff9b::1.2.3.4 形态）
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const v4 = parseIpv4(s.slice(cut + 1));
    if (!v4) return null;
    s = `${s.slice(0, cut + 1)}${ipv4ToNumber(v4).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string[]): number[] | null => {
    const out: number[] = [];
    for (const h of part) {
      const n = parseHextet(h);
      if (n === null) return null;
      out.push(n);
    }
    return out;
  };
  const head = toGroups(halves[0] ? halves[0]!.split(':') : []);
  const tail = halves.length === 2 ? toGroups(halves[1] ? halves[1]!.split(':') : []) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null; // '::' 至少压缩一个 0 组
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isBlockedIpv6(g: number[]): boolean {
  const firstZero = (n: number) => g.slice(0, n).every((x) => x === 0);
  const v4FromLast32 = () => [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (g.every((x) => x === 0)) return true; // ::
  if (firstZero(6) && g[7] === 1) return true; // ::1
  const first = g[0]!;
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7  ULA
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 链路本地
  if (first >= 0xff00) return true; // ff00::/8  组播
  if (firstZero(5) && g[5] === 0xffff) return isBlockedIpv4(v4FromLast32()); // ::ffff:x.x.x.x
  if (
    g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0
  ) {
    return isBlockedIpv4(v4FromLast32()); // 64:ff9b::/96  NAT64
  }
  if (first === 0x2002) {
    // 2002::/16  6to4：内嵌 IPv4 在第 2、3 组
    return isBlockedIpv4([g[1]! >> 8, g[1]! & 255, g[2]! >> 8, g[2]! & 255]);
  }
  if (first === 0x2001 && g[1] === 0x0000) {
    // 2001::/32  Teredo：末 32 位是取反后的 IPv4
    const obf = v4FromLast32();
    return isBlockedIpv4([255 - obf[0]!, 255 - obf[1]!, 255 - obf[2]!, 255 - obf[3]!]);
  }
  return false;
}

export function isBlockedAddress(raw: string): boolean {
  const ip = raw.trim();
  if (!ip) return true; // 空地址 → fail closed
  const v4 = parseIpv4(ip);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(ip);
  if (!v6) return true; // 认不出来 → fail closed
  return isBlockedIpv6(v6);
}

export function isIpLiteral(raw: string): boolean {
  const ip = raw.trim();
  return parseIpv4(ip) !== null || parseIpv6(ip) !== null;
}

// ---------------------------------------------------------------------------
// SSRF：主机校验
// ---------------------------------------------------------------------------

export type ResolveDns = (host: string) => Promise<string[]>;

export async function defaultResolveDns(host: string): Promise<string[]> {
  const out: string[] = [];
  for (const family of ['A', 'AAAA'] as const) {
    try {
      out.push(...await Deno.resolveDns(host, family));
    } catch {
      // A 解析失败不代表 AAAA 也失败，继续试下一个
    }
  }
  return out;
}

export async function assertPublicHost(hostname: string, resolveDns: ResolveDns): Promise<void> {
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (!host) throw new ResolveError('missing_host');
  if (isIpLiteral(host)) {
    if (isBlockedAddress(host)) throw new ResolveError('blocked_address');
    return;
  }
  const addresses = await resolveDns(host);
  if (!addresses.length) throw new ResolveError('dns_failed');
  // 全部解析结果都要检查：任一落在禁止网段就整体拒绝
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) throw new ResolveError('blocked_address');
  }
}

// ---------------------------------------------------------------------------
// 抓取主流程
// ---------------------------------------------------------------------------

export type TitleResolverDeps = {
  fetchImpl?: typeof fetch;
  resolveDns?: ResolveDns;
  timeoutMs?: number;
  maxRedirects?: number;
  // 失败原因回调：只应收到「原因码 + host」，绝不能收到完整 URL
  log?: (message: string) => void;
};

function parseTargetUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ResolveError('unsupported_scheme');
  }
  if (url.username || url.password) throw new ResolveError('credentials_in_url');
  if (!url.hostname) throw new ResolveError('missing_host');
  return url;
}

// 日志里只允许出现 host（不含 query、不含凭据）
function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname || '(empty)';
  } catch {
    return '(invalid)';
  }
}

// latin1 是 1 字节 1 字符的映射 → 字符下标 == 字节下标，方便按字节切标题
const LATIN1 = new TextDecoder('latin1');

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

type Collected = { bytes: Uint8Array; text: string; charset: string | null };

async function collectBody(res: Response, contentType: string, cap: number): Promise<Collected> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), text: '', charset: null };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let text = '';
  let charset = charsetFromContentType(contentType);
  try {
    for (;;) {
      // 标题与 charset 都拿到就可以停（对齐上游 STREAM：读到 </title> 即止）
      if (findTitleSpan(text) && charset) break;
      if (total >= cap) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      chunks.push(value);
      total += value.length;
      text = LATIN1.decode(concatBytes(chunks, total));
      if (!charset) charset = charsetFromMeta(text);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 已经读完时 cancel 会抛，忽略
    }
  }
  return { bytes: concatBytes(chunks, total), text, charset };
}

async function readTitleFromResponse(res: Response): Promise<string> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('text/html')) throw new ResolveError('not_html');
  const collected = await collectBody(res, contentType, MAX_BODY_BYTES);
  const span = findTitleSpan(collected.text);
  if (!span) throw new ResolveError('no_title');
  const charset = collected.charset;
  if (!charset) throw new ResolveError('no_charset'); // 认不出 charset → 丢弃（上游同）
  const raw = decodeWithCharset(collected.bytes.slice(span.start, span.end), charset);
  if (!raw) throw new ResolveError('unknown_charset');
  return truncateTitle(decodeHtmlEntities(phpTrim(raw)));
}

export async function resolveTitle(rawUrl: string, deps: TitleResolverDeps = {}): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const resolveDns = deps.resolveDns ?? defaultResolveDns;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  const log = deps.log ?? (() => {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const host = safeHost(rawUrl);
  try {
    let url = parseTargetUrl(rawUrl);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // 每一跳都要重新校验（含重定向目标）
      await assertPublicHost(url.hostname, resolveDns);
      const res = await fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': CHROME_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === maxRedirects) throw new ResolveError('redirect_limit');
        url = parseTargetUrl(new URL(location, url).toString());
        continue;
      }
      return await readTitleFromResponse(res);
    }
    throw new ResolveError('redirect_limit');
  } catch (err) {
    const code = err instanceof ResolveError
      ? err.code
      : (controller.signal.aborted ? 'timeout' : 'request_failed');
    // 只记原因码 + host：绝不记完整 URL（长链 query 可能带 token）
    log(`title-resolve failed code=${code} host=${host}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
