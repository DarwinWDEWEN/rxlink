// 地理富化函数单测：node --test fc/geo-enrich/test/
// lib.js 是纯逻辑（可直接测）；index.js 用依赖注入测「下载 → 拉批 → 回写」整条链路。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const lib = require('../lib');
const { createHandler } = require('../index');

const GZ = zlib.gzipSync(Buffer.from('fake-mmdb-bytes'));

// ---------------------------------------------------------------- lib.js

test('buildMmdbUrl：按 UTC 当前月份拼 DB-IP City Lite 的下载地址', () => {
  const url = lib.buildMmdbUrl(new Date('2026-11-01T00:00:00Z'));
  assert.equal(url, 'https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz');
  assert.equal(
    lib.buildMmdbUrl(new Date('2026-01-15T00:00:00Z')),
    'https://download.db-ip.com/free/dbip-city-lite-2026-01.mmdb.gz',
  );
});

test('buildMmdbUrl：允许用 GEO_MMDB_BASE 覆盖下载源', () => {
  const url = lib.buildMmdbUrl(new Date('2026-11-01T00:00:00Z'), 'https://mirror.example/free');
  assert.equal(url, 'https://mirror.example/free/dbip-city-lite-2026-11.mmdb.gz');
});

test('locationOf：完整记录 → 国/省/市/经纬度/时区', () => {
  const loc = lib.locationOf({
    city: { names: { en: 'San Francisco', 'zh-CN': '旧金山' } },
    country: { iso_code: 'US', names: { en: 'United States' } },
    subdivisions: [{ iso_code: 'CA', names: { en: 'California' } }],
    location: { latitude: 37.7749, longitude: -122.4194, time_zone: 'America/Los_Angeles' },
  });
  assert.deepEqual(loc, {
    country_code: 'US',
    country_name: 'United States',
    region_name: 'California',
    city_name: 'San Francisco',
    lat: '37.7749',
    lon: '-122.4194',
    timezone: 'America/Los_Angeles',
  });
});

test('locationOf：只有国家级信息时，其余留空串（SQL 侧 nullif 转 NULL）', () => {
  const loc = lib.locationOf({ country: { iso_code: 'DE', names: { en: 'Germany' } } });
  assert.equal(loc.country_code, 'DE');
  assert.equal(loc.country_name, 'Germany');
  assert.equal(loc.region_name, '');
  assert.equal(loc.city_name, '');
  assert.equal(loc.lat, '');
  assert.equal(loc.lon, '');
  assert.equal(loc.timezone, '');
});

test('locationOf：查不到记录 → 全空串', () => {
  const loc = lib.locationOf(null);
  assert.deepEqual(Object.values(loc), ['', '', '', '', '', '', '']);
});

test('locationOf：经纬度为 0 时不能被当成空值丢掉', () => {
  const loc = lib.locationOf({ location: { latitude: 0, longitude: 0 } });
  assert.equal(loc.lat, '0');
  assert.equal(loc.lon, '0');
});

test('makeLookup：非法 IP 返回 null（reader.get 不校验，会给出错误国家）', () => {
  const lookup = lib.makeLookup({ get: () => ({ country: { iso_code: 'US' } }) }, (ip) => ip === '1.1.1.1');
  assert.equal(lookup('1.2.3'), null);
  assert.equal(lookup('not-an-ip'), null);
  assert.equal(lookup(''), null);
  assert.equal(lookup(null), null);
});

test('makeLookup：reader 抛异常时返回 null，不让整批失败', () => {
  const lookup = lib.makeLookup({ get: () => { throw new Error('boom'); } }, () => true);
  assert.equal(lookup('1.1.1.1'), null);
});

test('makeLookup：reader 返回 undefined（库里没有该 IP）→ null', () => {
  const lookup = lib.makeLookup({ get: () => undefined }, () => true);
  assert.equal(lookup('10.0.0.1'), null);
});

test('enrichRows：查不到的 IP 也要产出一行（用于回写时清空 remote_addr）', () => {
  const rows = [{ id: 7, occurred_at: '2026-11-10T00:00:00+00:00', remote_addr: '10.0.0.1' }];
  const out = lib.enrichRows(rows, () => null);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 7);
  assert.equal(out[0].country_code, '');
  assert.equal(out[0].city_name, '');
});

test('enrichRows：产出的 payload 不含原始 IP（隐私红线）', () => {
  const rows = [{ id: 7, occurred_at: 'x', remote_addr: '203.0.113.45' }];
  const out = lib.enrichRows(rows, () => ({ country: { iso_code: 'US', names: { en: 'United States' } } }));
  assert.equal(JSON.stringify(out).includes('203.0.113.45'), false);
  assert.equal('remote_addr' in out[0], false);
});

test('isStale：超过上限天数算过期', () => {
  const day = 86400000;
  const now = Date.parse('2026-11-20T00:00:00Z');
  assert.equal(lib.isStale(now - 10 * day, now, 14), false);
  assert.equal(lib.isStale(now - 15 * day, now, 14), true);
  assert.equal(lib.isStale(0, now, 14), true, '文件不存在 → 视为过期');
});

test('shouldDownload：1 小时内失败过就不再重试（不打数据源）', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  assert.equal(lib.shouldDownload(0, now, 3600000), true);
  assert.equal(lib.shouldDownload(now - 10 * 60000, now, 3600000), false);
  assert.equal(lib.shouldDownload(now - 90 * 60000, now, 3600000), true);
});

// --------------------------------------------------------------- index.js

function makeFs(overrides = {}) {
  const files = new Map();
  const calls = { stat: 0, writeFile: 0, rename: 0 };
  return {
    files,
    calls,
    prom: {
      stat: async (p) => {
        calls.stat++;
        if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return { mtimeMs: files.get(p).mtimeMs, size: files.get(p).size };
      },
      readFile: async (p) => {
        if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return files.get(p).data;
      },
      writeFile: async (p, data) => {
        calls.writeFile++;
        files.set(p, { data: Buffer.from(data), mtimeMs: Date.parse('2026-11-19T00:00:00Z'), size: data.length });
      },
      rename: async (from, to) => {
        calls.rename++;
        const v = files.get(from);
        files.delete(from);
        files.set(to, v);
      },
    },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const fsx = makeFs();
  const logs = [];
  const rpcCalls = [];
  const downloads = [];
  const deps = {
    env: {
      SUPABASE_URL: 'http://db.internal',
      SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
      GEO_MMDB_PATH: '/tmp/dbip-city-lite.mmdb',
      GEO_BATCH_LIMIT: '500',
    },
    now: () => new Date('2026-11-19T00:00:00Z'),
    fsPromises: fsx.prom,
    gunzip: (buf) => zlib.gunzipSync(buf),
    log: (...a) => logs.push(a.join(' ')),
    fetchImpl: async (url) => {
      downloads.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => GZ };
    },
    openReader: async () => ({
      get: (ip) => (ip === '203.0.113.45'
        ? {
            city: { names: { en: 'San Francisco' } },
            country: { iso_code: 'US', names: { en: 'United States' } },
            subdivisions: [{ names: { en: 'California' } }],
            location: { latitude: 37.7749, longitude: -122.4194, time_zone: 'America/Los_Angeles' },
          }
        : undefined),
    }),
    rpc: async (name, body) => {
      rpcCalls.push({ name, body });
      if (name === 'visits_pending_location') {
        if (rpcCalls.filter((c) => c.name === 'visits_pending_location').length > 1) return [];
        return [{ id: 42, occurred_at: '2026-11-10T00:00:00+00:00', remote_addr: '203.0.113.45' }];
      }
      return 1;
    },
    ...overrides,
  };
  return { deps, fsx, logs, rpcCalls, downloads };
}

test('handler：mmdb 已存在且新鲜 → 不下载，直接拉批并回写', async () => {
  const { deps, fsx, rpcCalls, downloads } = makeDeps();
  fsx.files.set('/tmp/dbip-city-lite.mmdb', { mtimeMs: Date.parse('2026-11-18T00:00:00Z'), size: 10 });
  const handler = createHandler(deps);
  const res = await handler({}, {});
  assert.equal(downloads.length, 0, '新鲜文件不该重新下载');
  const names = rpcCalls.map((c) => c.name);
  assert.deepEqual(names, ['visits_pending_location', 'apply_visit_locations']);
  const payload = rpcCalls[1].body.p_rows[0];
  assert.equal(payload.id, 42);
  assert.equal(payload.country_code, 'US');
  assert.equal(payload.city_name, 'San Francisco');
  assert.equal(res.statusCode, 200);
});

test('handler：mmdb 缺失 → 先下载再回写', async () => {
  const { deps, downloads, rpcCalls } = makeDeps();
  const handler = createHandler(deps);
  await handler({}, {});
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0], 'https://download.db-ip.com/free/dbip-city-lite-2026-11.mmdb.gz');
  assert.equal(rpcCalls.length, 2);
});

test('handler：回写 payload 不含原始 IP，日志也不含 IP', async () => {
  const { deps, logs, rpcCalls } = makeDeps();
  const handler = createHandler(deps);
  await handler({}, {});
  assert.equal(JSON.stringify(rpcCalls[1].body).includes('203.0.113.45'), false);
  assert.equal(logs.join('\n').includes('203.0.113.45'), false);
});

test('handler：下载失败 → 本轮跳过富化，不报错崩掉', async () => {
  const { deps, logs, rpcCalls } = makeDeps({
    fetchImpl: async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  const handler = createHandler(deps);
  const res = await handler({}, {});
  assert.equal(res.statusCode, 200);
  assert.equal(rpcCalls.length, 0, '没有 mmdb 就不该拉批');
  assert.match(logs.join('\n'), /mmdb/);
});

test('handler：下载失败后 1 小时内不再重试', async () => {
  let attempts = 0;
  const { deps } = makeDeps({
    fetchImpl: async () => {
      attempts++;
      return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  const handler = createHandler(deps);
  await handler({}, {});
  assert.equal(attempts, 1);
  await handler({}, {});
  assert.equal(attempts, 1, '退避期内不该再打数据源');
});

test('handler：拉不到待富化行时不调用回写', async () => {
  const { deps, rpcCalls } = makeDeps({
    rpc: async (name) => { rpcCalls.push({ name }); return []; },
  });
  const handler = createHandler(deps);
  await handler({}, {});
  assert.deepEqual(rpcCalls.map((c) => c.name), ['visits_pending_location']);
});

test('handler：配置缺失时安全退出，不抛异常', async () => {
  const { deps } = makeDeps({ env: {} });
  const handler = createHandler(deps);
  const res = await handler({}, {});
  assert.equal(res.statusCode, 200);
});

// ------------------------------------------------------- 包内自带 mmdb

test('handler：代码包内自带 mmdb 时不联网下载', async () => {
  const { deps, fsx, downloads, rpcCalls } = makeDeps();
  deps.env.GEO_MMDB_BUNDLE = '/code/geoip/dbip-city-lite.mmdb';
  fsx.files.set('/code/geoip/dbip-city-lite.mmdb', {
    data: Buffer.from('raw-mmdb-bytes'),
    mtimeMs: Date.parse('2026-11-01T00:00:00Z'),
    size: 14,
  });
  const handler = createHandler(deps);
  await handler({}, {});
  assert.equal(downloads.length, 0, '包内有就不该下载');
  assert.equal(rpcCalls.length, 2, '照常拉批 + 回写');
});

test('handler：包内是 .br 时先解压落地再读', async () => {
  const { deps, fsx, downloads } = makeDeps();
  deps.env.GEO_MMDB_BUNDLE = '/code/geoip/dbip-city-lite.mmdb.br';
  const br = zlib.brotliCompressSync(Buffer.from('expanded-mmdb-bytes'));
  fsx.files.set('/code/geoip/dbip-city-lite.mmdb.br', {
    data: br,
    mtimeMs: Date.parse('2026-11-01T00:00:00Z'),
    size: br.length,
  });
  const handler = createHandler(deps);
  await handler({}, {});
  assert.equal(downloads.length, 0);
  const landed = fsx.files.get('/tmp/dbip-city-lite.mmdb');
  assert.ok(landed, '解压结果应落到 /tmp');
  assert.equal(landed.data.toString(), 'expanded-mmdb-bytes');
});

test('handler：包内 mmdb 坏了 → 回落到运行时下载', async () => {
  const { deps, fsx, downloads } = makeDeps();
  deps.env.GEO_MMDB_BUNDLE = '/code/geoip/dbip-city-lite.mmdb';
  fsx.files.set('/code/geoip/dbip-city-lite.mmdb', {
    data: Buffer.from('bad'), mtimeMs: Date.parse('2026-11-01T00:00:00Z'), size: 3,
  });
  // 只有 /tmp 那份（下载后落地的）能打开，包内这份视为损坏
  const handler = createHandler({
    ...deps,
    openReader: async (p) => {
      if (p === '/code/geoip/dbip-city-lite.mmdb') throw new Error('corrupt');
      return { get: () => undefined };
    },
  });
  await handler({}, {});
  assert.equal(downloads.length, 1, '包内坏了应该下载兜底');
});

// ------------------------------------------------------- 时间预算

test('handler：超过时间预算提前退出，不硬撑到超时', async () => {
  let clock = Date.parse('2026-11-19T00:00:00Z');
  const { deps } = makeDeps({ now: () => new Date(clock) });
  deps.env.GEO_TIME_BUDGET_MS = '1000';
  deps.env.GEO_BATCH_LIMIT = '2';
  let pulls = 0;
  deps.rpc = async (name) => {
    if (name === 'visits_pending_location') {
      pulls++;
      clock += 600; // 每批耗时 600ms
      // 返回满批 → 不会因为「没满」提前退出
      return [
        { id: pulls * 2 - 1, occurred_at: 'x', remote_addr: '203.0.113.45' },
        { id: pulls * 2, occurred_at: 'x', remote_addr: '203.0.113.46' },
      ];
    }
    return 2;
  };
  const handler = createHandler(deps);
  const res = await handler({}, {});
  // 预算 1000ms：第 1 批耗时 600ms，第 2 批后累计 1200ms > 1000 → 第 3 轮前退出
  assert.equal(pulls, 2, `预算内应只拉 2 批，实际 ${pulls}`);
  assert.equal(res.statusCode, 200);
});


