// shlink 兼容层处理器（/rest/v3），I3：B1 短链读写 5 方法 + /health 闸门
// 入口见 index.ts；本文件导出 handleRequest，供 Deno.test 直接导入（不触发 Deno.serve）。
//
// 契约细节见 docs/shlink-api-contract.md：
//   只认 /rest/v3；鉴权只有 X-Api-Key（哈希后查 api_key）；错误体 RFC7807。
// I8 扩展：R4 GET /short-urls/shorten、R7 GET /visits/export（rxlink 扩展端点）。
// I10 扩展：标题自动解析（未填标题时抓目标页 <title>）。
import { resolveTitle, type TitleResolverDeps } from './title-resolver.ts';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? Deno.env.get('SUPABASE_API_URL') ?? '')
  .replace(/\/+$/, '');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const VERSION = '5.1.0';

// R10：测试可注入假的 fetch / DNS 解析器；生产留空（走默认实现）
export const titleResolverDeps: TitleResolverDeps = {};

type Json = Record<string, unknown>;

const ERROR_URL = 'https://shlink.io/api/error/';
const MAP_STATUS: Record<string, number> = {
  P0002: 404, // no_data_found → short-url-not-found
  '23505': 409, // unique_violation → non-unique-slug
  '22023': 400, // invalid_parameter_value → invalid-data
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  501: 'Not Implemented',
};

function problem(err: ApiError, origin: string | null): Response {
  return new Response(
    JSON.stringify({
      type: `${ERROR_URL}${err.type}`,
      detail: err.detail,
      title: TITLES[err.status] ?? 'Error',
      status: err.status,
    }),
    {
      status: err.status,
      headers: { 'Content-Type': 'application/problem+json', ...corsHeaders(origin) },
    },
  );
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'X-Api-Key, Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  // 控制台若带 credentials，Allow-Origin 不能是 *，必须回显
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Credentials'] = 'true';
  } else {
    h['Access-Control-Allow-Origin'] = '*';
  }
  return h;
}

function json(res: unknown, status: number, origin: string | null, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(res), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

async function rpc(fn: string, body: Json): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.ok) return text ? JSON.parse(text) : null;

  let parsed: { code?: string; message?: string } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // 网关层错误不是 JSON，下面统一按 500 处理
  }
  const status = MAP_STATUS[parsed.code ?? ''] ?? 500;
  const detail = parsed.message ?? `upstream ${res.status}`;
  const NOT_FOUND: Record<string, string> = {
    tag_not_found: 'tag-not-found',
    domain_not_found: 'domain-not-found',
    short_url_not_found: 'short-url-not-found',
  };
  const type =
    status === 404 ? (NOT_FOUND[detail] ?? 'short-url-not-found')
    : status === 409 ? 'non-unique-slug'
    : status === 400 ? 'invalid-data'
    : 'not-found';
  throw new ApiError(status, type, detail);
}

function sha256Hex(value: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((buf) =>
    Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
  );
}

async function authenticate(apiKey: string | null): Promise<{ id: number }> {
  if (!apiKey) throw new ApiError(401, 'missing-authentication', 'X-Api-Key header is required');
  const hash = await sha256Hex(apiKey);
  const key = (await rpc('compat_auth', { p_hash_hex: hash })) as { id: number; name: string } | null;
  // 过期 key 由 compat_auth 判 expires_at 后返回 null（0015），与停用/不存在同一口径
  if (!key) {
    throw new ApiError(401, 'invalid-api-key', 'Provided API key does not exist, is disabled or has expired');
  }
  return key;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

// R10：环境变量 AUTO_RESOLVE_TITLES 关闭自动解析；未设置 = 开启
function autoResolveTitlesEnabled(): boolean {
  const raw = Deno.env.get('AUTO_RESOLVE_TITLES');
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

// R10：抓取失败只记「原因码 + host」，绝不记完整 URL（长链 query 可能带 token）
function logTitleResolve(message: string): void {
  if (titleResolverDeps.log) {
    titleResolverDeps.log(message);
    return;
  }
  console.log(message);
}

function bool(v: string | null): boolean {
  return v === 'true';
}

function int(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseOrder(raw: string | null): { field: string; dir: string } {
  if (!raw) return { field: 'dateCreated', dir: 'DESC' };
  const i = raw.lastIndexOf('-');
  if (i < 1) return { field: raw, dir: 'DESC' };
  return { field: raw.slice(0, i), dir: raw.slice(i + 1) };
}

// ---- I9：R9 动态跳转规则校验（对齐 shlink RedirectConditionType::isValid）----
const CONDITION_TYPES = [
  'device', 'language', 'query-param', 'any-value-query-param', 'valueless-query-param',
  'ip-address', 'geolocation-country-code', 'geolocation-city-name',
  'before-date', 'after-date', 'browser',
] as const;

const DEVICE_VALUES = ['android', 'ios', 'mobile', 'windows', 'macos', 'linux', 'chromeos', 'desktop'];
const BROWSER_VALUES = ['chrome', 'firefox', 'edge', 'safari', 'opera', 'android_browser'];

function invalidCondition(value: string, type: string): ApiError {
  return new ApiError(
    400,
    'invalid-data',
    `"${value}" is not a valid value for the "${type.toUpperCase()}" redirect condition`,
  );
}

// 路径段解码：畸形百分号编码（如 %ZZ）不能让 decodeURIComponent 抛 URIError
// 变成 500 —— 解不出来就按原样传下去，让它走正常的「查不到」分支。
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// IPv4 / IPv6 静态地址、CIDR、通配符 —— 粗筛明显非法的值。
// 真正的判定在跳转侧 ipmat.js（IPv6 用 node:net 严格解析），这里只负责挡住垃圾输入。
function isValidIpPattern(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (s.includes('*')) {
    // 通配符只允许 IPv4 的四段形式
    const parts = s.split('.');
    return parts.length === 4 && parts.every((p) => p === '*' || (/^\d{1,3}$/.test(p) && Number(p) <= 255));
  }
  const slash = s.indexOf('/');
  const base = slash < 0 ? s : s.slice(0, slash);
  const len = slash < 0 ? null : s.slice(slash + 1);
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(base) && base.split('.').every((p) => Number(p) <= 255);
  const isV6 = /^[0-9a-fA-F:]+$/.test(base) && base.includes(':');
  if (!isV4 && !isV6) return false;
  if (len !== null) {
    const n = Number(len);
    const max = isV4 ? 32 : 128;
    if (!Number.isInteger(n) || n < 0 || n > max) return false;
  }
  return true;
}

function validateCondition(cond: unknown): void {
  if (typeof cond !== 'object' || cond === null) {
    throw new ApiError(400, 'invalid-data', 'Each redirect condition must be an object');
  }
  const c = cond as { type?: unknown; matchKey?: unknown; matchValue?: unknown };
  const type = typeof c.type === 'string' ? c.type : '';
  if (!CONDITION_TYPES.includes(type as (typeof CONDITION_TYPES)[number])) {
    throw new ApiError(400, 'invalid-data', `"${type}" is not a valid redirect condition type`);
  }
  const value = c.matchValue === undefined || c.matchValue === null ? '' : String(c.matchValue);
  switch (type) {
    case 'device':
      if (!DEVICE_VALUES.includes(value)) throw invalidCondition(value, type);
      break;
    case 'browser':
      if (!BROWSER_VALUES.includes(value)) throw invalidCondition(value, type);
      break;
    case 'ip-address':
      if (!isValidIpPattern(value)) throw invalidCondition(value, type);
      break;
    case 'geolocation-country-code':
      if (!/^[A-Za-z]{2}$/.test(value)) throw invalidCondition(value, type);
      break;
    case 'query-param':
      if (value === '') throw invalidCondition(value, type);
      break;
    default:
      // 其余类型 shlink 也不校验值
      break;
  }
}

function validateRules(body: unknown): Array<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null) {
    throw new ApiError(400, 'invalid-data', 'Request body must be an object');
  }
  const rules = (body as { redirectRules?: unknown }).redirectRules;
  if (rules === undefined || rules === null) {
    throw new ApiError(400, 'invalid-data', 'redirectRules is required');
  }
  if (!Array.isArray(rules)) {
    throw new ApiError(400, 'invalid-data', 'redirectRules must be an array');
  }
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null) {
      throw new ApiError(400, 'invalid-data', 'Each redirect rule must be an object');
    }
    const r = rule as { longUrl?: unknown; conditions?: unknown };
    if (typeof r.longUrl !== 'string' || r.longUrl.trim() === '') {
      throw new ApiError(400, 'invalid-data', 'longUrl is required for each redirect rule');
    }
    if (r.conditions === undefined || r.conditions === null) {
      throw new ApiError(400, 'invalid-data', 'conditions is required for each redirect rule');
    }
    if (!Array.isArray(r.conditions)) {
      throw new ApiError(400, 'invalid-data', 'conditions must be an array');
    }
    for (const cond of r.conditions) validateCondition(cond);
  }
  return rules as Array<Record<string, unknown>>;
}

// shlink 的 tags/excludeTags 走逗号分隔（上游 splitByComma，functions.php:243），
// 控制台的 web-component 实际发的就是 `tags=a,b`；同时兼容 `tags[]=a&tags[]=b` 数组写法。
// 不拆逗号的话多标签会被当成一个字面标签名，筛选静默失效。
function parseTagList(url: URL, name: string): string[] {
  const raw = [...url.searchParams.getAll(`${name}[]`), ...url.searchParams.getAll(name)];
  return raw
    .flatMap((v) => String(v).split(','))
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

async function listShortUrls(url: URL): Promise<Json> {
  const q = url.searchParams;
  const order = parseOrder(q.get('orderBy'));
  const tags = parseTagList(url, 'tags');
  const excludedTags = parseTagList(url, 'excludeTags');
  const result = await rpc('list_short_urls', {
    p_page: int(q.get('page'), 1),
    p_items: int(q.get('itemsPerPage'), 20),
    p_search: str(q.get('searchTerm')),
    p_domain: str(q.get('domain')),
    p_tags: tags.length ? tags : null,
    // 上游默认是 ANY（ShortUrlsParams::$tagsMode = TagsMode::ANY）
    p_tags_mode: str(q.get('tagsMode')) ?? 'any',
    p_order_field: order.field,
    p_order_dir: order.dir,
    p_exclude_max: bool(q.get('excludeMaxVisitsReached')),
    p_exclude_expired: bool(q.get('excludePastValidUntil')),
    p_start: str(q.get('startDate')),
    p_end: str(q.get('endDate')),
    p_excluded_tags: excludedTags.length ? excludedTags : null,
    p_excluded_tags_mode: str(q.get('excludeTagsMode')) ?? 'any',
  });
  // SDK 解包的是 { shortUrls: { data, pagination } }，不是 data 本身
  return { shortUrls: result };
}

async function createShortUrl(body: Json, keyId: number): Promise<Json> {
  const longUrl = str(body.longUrl);
  if (!longUrl) throw new ApiError(400, 'invalid-data', 'longUrl is required');

  // R10：上游 ShortUrlCreation::hasTitle() = title !== null
  //      → 未提供标题才抓；抓到的标题标成「自动解析」
  const userProvidedTitle = body.title !== undefined && body.title !== null;
  let title = userProvidedTitle ? str(body.title) : null;
  let titleWasAutoResolved = false;
  if (!userProvidedTitle && autoResolveTitlesEnabled()) {
    const resolved = await resolveTitle(longUrl, { ...titleResolverDeps, log: logTitleResolve });
    if (resolved) {
      title = resolved;
      titleWasAutoResolved = true;
    }
  }

  try {
    return (await rpc('create_short_url', {
      p_long_url: longUrl,
      p_domain: str(body.domain),
      p_custom_slug: str(body.customSlug),
      p_title: title,
      p_title_was_auto_resolved: titleWasAutoResolved,
      p_tags: Array.isArray(body.tags) ? body.tags : null,
      p_crawlable: body.crawlable === true,
      p_forward_query: body.forwardQuery !== false,
      p_valid_since: str(body.validSince),
      p_valid_until: str(body.validUntil),
      p_max_visits: typeof body.maxVisits === 'number' ? body.maxVisits : null,
      p_short_code_length: typeof body.shortCodeLength === 'number' ? body.shortCodeLength : 5,
      p_find_if_exists: body.findIfExists === true,
      p_author_api_key_id: keyId,
    })) as Json;
  } catch (err) {
    // 控制台直接把 detail 显示给用户，别把 SQL 的 snake_case 错误码原样抛出去
    if (err instanceof ApiError && err.type === 'non-unique-slug') {
      throw new ApiError(409, 'non-unique-slug', `Custom slug "${body.customSlug}" is already in use`);
    }
    throw err;
  }
}

async function getShortUrl(code: string, domain: string | null): Promise<Json> {
  const row = await rpc('get_short_url', { p_code: code, p_domain: domain });
  if (!row) throw new ApiError(404, 'short-url-not-found', `Short URL "${code}" not found`);
  return row as Json;
}

async function updateShortUrl(code: string, domain: string | null, body: Json): Promise<Json> {
  // R10：上游 ShortUrlService 只在 longUrl !== null 时才触发标题解析；
  //      用户显式给了 title 就不抓（手填优先）。
  //      抓到的自动标题走独立参数 p_auto_title，绝不能塞进 p_patch
  //      —— p_patch 里有 title 键即代表「用户手填」，两者必须可区分。
  const patch: Json = { ...body };
  const userProvidedTitle = 'title' in patch;
  const longUrl = typeof patch.longUrl === 'string' ? patch.longUrl : null;
  let autoTitle: string | null = null;
  if (!userProvidedTitle && longUrl && autoResolveTitlesEnabled()) {
    const resolved = await resolveTitle(longUrl, { ...titleResolverDeps, log: logTitleResolve });
    if (resolved) autoTitle = resolved;
  }
  return (await rpc('update_short_url', {
    p_code: code,
    p_domain: domain,
    p_patch: patch,
    p_auto_title: autoTitle,
  })) as Json;
}

async function deleteShortUrl(code: string, domain: string | null): Promise<void> {
  await rpc('delete_short_url', { p_code: code, p_domain: domain });
}

function visitParams(url: URL): Json {
  const q = url.searchParams;
  return {
    p_page: int(q.get('page'), 1),
    p_items: int(q.get('itemsPerPage'), 20),
    p_start: str(q.get('startDate')),
    p_end: str(q.get('endDate')),
    p_exclude_bots: bool(q.get('excludeBots')),
  };
}

async function listVisits(scope: string, key: string | null, url: URL, extra?: Json): Promise<Json> {
  const result = await rpc('list_visits', {
    p_scope: scope,
    p_key: key,
    p_domain: str(url.searchParams.get('domain')),
    ...visitParams(url),
    ...extra,
  });
  return { visits: result };
}

async function deleteVisits(result: unknown): Promise<Json> {
  return { deletedVisits: typeof result === 'number' ? result : 0 };
}

function queryTags(url: URL): string[] {
  const q = url.searchParams;
  return [...q.getAll('tags[]'), ...q.getAll('tags')].filter((t) => t !== '');
}

async function listTags(): Promise<Json> {
  return { tags: await rpc('list_tags', {}) };
}

async function tagsStats(): Promise<Json> {
  return { tags: await rpc('tag_stats', {}) };
}

async function deleteTags(url: URL): Promise<void> {
  await rpc('delete_tags', { p_tags: queryTags(url) });
}

async function editTag(body: Json): Promise<void> {
  const oldName = str(body.oldName);
  const newName = str(body.newName);
  if (!oldName || !newName) throw new ApiError(400, 'invalid-data', 'oldName and newName are required');
  try {
    await rpc('edit_tag', { p_old_name: oldName, p_new_name: newName });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      throw new ApiError(409, 'non-unique-tag', `Tag "${newName}" already exists`);
    }
    throw err;
  }
}

async function listDomains(): Promise<Json> {
  return { domains: await rpc('list_domains', {}) };
}

async function editDomainRedirects(body: Json): Promise<Json> {
  return (await rpc('update_domain_redirects', {
    p_domain: str(body.domain),
    p_patch: body,
  })) as Json;
}

function shapeOk(): Json {
  return { status: 'pass', version: VERSION };
}

// ---- R4：内容协商（shlink CreateShortUrlContentNegotiationMiddleware 的口径）----
function wantsPlainText(url: URL, req: Request): boolean {
  const format = url.searchParams.get('format');
  if (format !== null) return format.toLowerCase() === 'txt';
  const accept = (req.headers.get('accept') ?? '').split(',')[0].toLowerCase();
  return accept.includes('text/plain');
}

// ---- R7：CSV 导出 ----
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// visitLocation 是对象或 null（见 0012 visit_json）；单列导出成 「国 / 省 / 市」
function locationCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  const o = v as Json;
  const parts = [o.countryCode, o.regionName, o.cityName]
    .filter((x) => typeof x === 'string' && x !== '');
  return parts.join(' / ');
}

async function exportVisits(url: URL, origin: string | null): Promise<Response> {
  const q = url.searchParams;
  const scope = str(q.get('scope')) ?? 'non-orphan';
  let key: string | null = null;
  if (scope === 'short') {
    key = str(q.get('code'));
    if (!key) throw new ApiError(400, 'invalid-data', 'code is required when scope=short');
  } else if (scope === 'tag') {
    key = str(q.get('tag'));
    if (!key) throw new ApiError(400, 'invalid-data', 'tag is required when scope=tag');
  } else if (scope === 'domain') {
    key = str(q.get('domain'));
    if (!key) throw new ApiError(400, 'invalid-data', 'domain is required when scope=domain');
  } else if (scope !== 'non-orphan' && scope !== 'orphan') {
    throw new ApiError(400, 'invalid-data', `invalid scope "${scope}"`);
  }

  const result = await rpc('list_visits', {
    p_scope: scope,
    p_key: key,
    p_domain: str(q.get('domain')),
    ...visitParams(url),
    ...(scope === 'orphan' ? { p_orphan_type: str(q.get('type')) } : {}),
  }) as { data?: Json[] };

  const header = ['date', 'referer', 'userAgent', 'potentialBot', 'visitLocation', 'visitedUrl', 'redirectUrl', 'type'];
  const lines = [header.join(',')];
  for (const row of result.data ?? []) {
    lines.push([
      csvCell(row.date),
      csvCell(row.referer),
      csvCell(row.userAgent),
      csvCell(row.potentialBot),
      csvCell(locationCell(row.visitLocation)),
      csvCell(row.visitedUrl),
      csvCell(row.redirectUrl),
      csvCell(row.type),
    ].join(','));
  }
  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="visits.csv"',
      ...corsHeaders(origin),
    },
  });
}

export async function handleRequest(req: Request): Promise<Response> {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  try {
    const url = new URL(req.url);
    // 函数既可能挂在 /functions/v1/compat/rest/v3/*，也可能被路由到自定义域名的 /rest/v3/*
    const marker = '/rest/v3';
    const at = url.pathname.indexOf(marker);
    const path = at < 0 ? '' : url.pathname.slice(at + marker.length) || '/';

    if (req.method === 'GET' && path === '/health') {
      // 连通性闸门，不校验 key（与 shlink 一致）
      return json(shapeOk(), 200, origin);
    }

    // R4：/short-urls/shorten 是 shlink 唯一的 query 鉴权例外；这里做成 header 或 query 都认
    const shortenRoute = req.method === 'GET' && path === '/short-urls/shorten';
    const apiKey = shortenRoute
      ? (req.headers.get('x-api-key') ?? url.searchParams.get('apiKey'))
      : req.headers.get('x-api-key');
    const key = await authenticate(apiKey);

    // ---- R4：单步建链 ----
    if (shortenRoute) {
      const longUrl = str(url.searchParams.get('longUrl'));
      if (!longUrl) throw new ApiError(400, 'invalid-data', 'longUrl is required');
      const created = await createShortUrl({
        longUrl,
        domain: str(url.searchParams.get('domain')),
      }, key.id);
      if (wantsPlainText(url, req)) {
        const body = typeof created.shortUrl === 'string' ? created.shortUrl : '';
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/plain', ...corsHeaders(origin) },
        });
      }
      return json(created, 200, origin);
    }

    if (path === '/short-urls') {
      if (req.method === 'GET') return json(await listShortUrls(url), 200, origin);
      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Json;
        return json(await createShortUrl(body, key.id), 200, origin);
      }
      throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
    }

    // ---- B3：标签 ----
    if (path === '/tags/stats') {
      if (req.method !== 'GET') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      return json(await tagsStats(), 200, origin);
    }
    if (path === '/tags') {
      if (req.method === 'GET') return json(await listTags(), 200, origin);
      if (req.method === 'PUT') {
        const body = (await req.json().catch(() => ({}))) as Json;
        await editTag(body);
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      if (req.method === 'DELETE') {
        await deleteTags(url);
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
    }

    // ---- B4：域名 / Mercure / 跳转规则 ----
    if (path === '/domains') {
      if (req.method !== 'GET') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      return json(await listDomains(), 200, origin);
    }
    if (path === '/domains/redirects') {
      if (req.method !== 'PATCH') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      const body = (await req.json().catch(() => ({}))) as Json;
      return json(await editDomainRedirects(body), 200, origin);
    }
    if (path === '/mercure-info') {
      if (req.method !== 'GET') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      throw new ApiError(404, 'MERCURE_NOT_CONFIGURED', 'Mercure is not configured');
    }
    const rulesMatch = /^\/short-urls\/([^/]+)\/redirect-rules$/.exec(path);
    if (rulesMatch) {
      const code = safeDecode(rulesMatch[1]);
      const domain = str(url.searchParams.get('domain'));
      if (req.method === 'GET') {
        return json(await rpc('get_short_url_redirect_rules', { p_code: code, p_domain: domain }), 200, origin);
      }
      if (req.method === 'POST' || req.method === 'PATCH') {
        // body 解析沿用本文件既有写法（req.json().catch(() => ({}))）
        const body = (await req.json().catch(() => ({}))) as Json;
        const rules = validateRules(body);
        const result = await rpc('set_short_url_redirect_rules', {
          p_code: code,
          p_domain: domain,
          p_rules: rules,
        });
        return json(result, 200, origin);
      }
      throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
    }

    // ---- B2：访问统计 ----
    if (path === '/visits') {
      if (req.method !== 'GET') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      return json({ visits: await rpc('visits_overview', {}) }, 200, origin);
    }
    // ---- R7：访问明细 CSV 导出（rxlink 扩展端点，不在 shlink 契约里）----
    if (path === '/visits/export') {
      if (req.method !== 'GET') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      // await 不能省：return promise 会把 rejection 甩到 try/catch 之外
      return await exportVisits(url, origin);
    }
    if (path === '/visits/orphan') {
      if (req.method === 'GET') {
        return json(
          await listVisits('orphan', null, url, { p_orphan_type: str(url.searchParams.get('type')) }),
          200,
          origin,
        );
      }
      if (req.method === 'DELETE') {
        return json(await deleteVisits(await rpc('delete_orphan_visits', {})), 200, origin);
      }
      throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
    }
    if (path === '/visits/non-orphan') {
      if (req.method !== 'GET') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      return json(await listVisits('non-orphan', null, url), 200, origin);
    }

    const visitsMatch = /^\/short-urls\/([^/]+)\/visits$/.exec(path);
    if (visitsMatch) {
      const code = safeDecode(visitsMatch[1]);
      if (req.method === 'GET') {
        return json(await listVisits('short', code, url), 200, origin);
      }
      if (req.method === 'DELETE') {
        const domain = str(url.searchParams.get('domain'));
        const n = await rpc('delete_short_url_visits', { p_code: code, p_domain: domain });
        return json(await deleteVisits(n), 200, origin);
      }
      throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
    }

    const tagVisitsMatch = /^\/tags\/([^/]+)\/visits$/.exec(path);
    if (tagVisitsMatch) {
      if (req.method !== 'GET') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      return json(await listVisits('tag', safeDecode(tagVisitsMatch[1]), url), 200, origin);
    }

    const domainVisitsMatch = /^\/domains\/([^/]+)\/visits$/.exec(path);
    if (domainVisitsMatch) {
      if (req.method !== 'GET') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      return json(await listVisits('domain', safeDecode(domainVisitsMatch[1]), url), 200, origin);
    }

    const match = /^\/short-urls\/([^/]+)$/.exec(path);
    if (match) {
      const code = safeDecode(match[1]);
      const domain = str(url.searchParams.get('domain'));
      if (req.method === 'GET') return json(await getShortUrl(code, domain), 200, origin);
      if (req.method === 'PATCH') {
        const body = (await req.json().catch(() => ({}))) as Json;
        return json(await updateShortUrl(code, domain, body), 200, origin);
      }
      if (req.method === 'DELETE') {
        await deleteShortUrl(code, domain);
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
    }

    throw new ApiError(404, 'not-found', `No route for ${req.method} ${url.pathname}`);
  } catch (err) {
    if (err instanceof ApiError) return problem(err, origin);
    console.error('compat unhandled', err);
    return problem(new ApiError(500, 'not-found', 'Internal error'), origin);
  }
}
