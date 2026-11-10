// shlink 兼容层（/rest/v3），I3：B1 短链读写 5 方法 + /health 闸门
// 部署：./functions-cli deploy compat --no-verify-jwt
// 服务端 RPC 见 supabase/migrations/0008_compat_api.sql
//
// 契约细节见 docs/shlink-api-contract.md：
//   只认 /rest/v3；鉴权只有 X-Api-Key（哈希后查 api_key）；错误体 RFC7807。
const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? Deno.env.get('SUPABASE_API_URL') ?? '')
  .replace(/\/+$/, '');
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const VERSION = '4.0.0';

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
  if (!key) throw new ApiError(401, 'invalid-api-key', 'Provided API key does not exist or is disabled');
  return key;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
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

async function listShortUrls(url: URL): Promise<Json> {
  const q = url.searchParams;
  const order = parseOrder(q.get('orderBy'));
  const tags = [...q.getAll('tags[]'), ...q.getAll('tags')].filter((t) => t !== '');
  const result = await rpc('list_short_urls', {
    p_page: int(q.get('page'), 1),
    p_items: int(q.get('itemsPerPage'), 20),
    p_search: str(q.get('searchTerm')),
    p_domain: str(q.get('domain')),
    p_tags: tags.length ? tags : null,
    p_tags_mode: str(q.get('tagsMode')) ?? 'all',
    p_order_field: order.field,
    p_order_dir: order.dir,
    p_exclude_max: bool(q.get('excludeMaxVisitsReached')),
    p_exclude_expired: bool(q.get('excludePastValidUntil')),
    p_start: str(q.get('startDate')),
    p_end: str(q.get('endDate')),
  });
  // SDK 解包的是 { shortUrls: { data, pagination } }，不是 data 本身
  return { shortUrls: result };
}

async function createShortUrl(body: Json, keyId: number): Promise<Json> {
  const longUrl = str(body.longUrl);
  if (!longUrl) throw new ApiError(400, 'invalid-data', 'longUrl is required');
  try {
    return (await rpc('create_short_url', {
      p_long_url: longUrl,
      p_domain: str(body.domain),
      p_custom_slug: str(body.customSlug),
      p_title: str(body.title),
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
  return (await rpc('update_short_url', { p_code: code, p_domain: domain, p_patch: body })) as Json;
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

Deno.serve(async (req): Promise<Response> => {
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

    const key = await authenticate(req.headers.get('x-api-key'));

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
      const code = decodeURIComponent(rulesMatch[1]);
      const domain = str(url.searchParams.get('domain'));
      if (req.method === 'GET') {
        return json(await rpc('get_short_url_redirect_rules', { p_code: code, p_domain: domain }), 200, origin);
      }
      if (req.method === 'POST') {
        throw new ApiError(501, 'not-implemented', 'Redirect rules are not supported until M3');
      }
      throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
    }

    // ---- B2：访问统计 ----
    if (path === '/visits') {
      if (req.method !== 'GET') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      return json({ visits: await rpc('visits_overview', {}) }, 200, origin);
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
      const code = decodeURIComponent(visitsMatch[1]);
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
      return json(await listVisits('tag', decodeURIComponent(tagVisitsMatch[1]), url), 200, origin);
    }

    const domainVisitsMatch = /^\/domains\/([^/]+)\/visits$/.exec(path);
    if (domainVisitsMatch) {
      if (req.method !== 'GET') throw new ApiError(405, 'not-found', `Method ${req.method} not allowed`);
      return json(await listVisits('domain', decodeURIComponent(domainVisitsMatch[1]), url), 200, origin);
    }

    const match = /^\/short-urls\/([^/]+)$/.exec(path);
    if (match) {
      const code = decodeURIComponent(match[1]);
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
});
