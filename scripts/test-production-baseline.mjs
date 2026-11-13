import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'supabase', 'config.toml');
const migrationPath = path.join(
  root,
  'supabase',
  'migrations',
  '0021_production_baseline.sql',
);

test('Supabase 空库重放不依赖缺失的 seed 文件', () => {
  const config = readFileSync(configPath, 'utf8');
  const seedSection = config.match(/\[db\.seed\]([\s\S]*?)(?=\n\[|$)/);

  assert.ok(seedSection, 'supabase/config.toml 缺少 [db.seed]');
  assert.match(seedSection[1], /\benabled\s*=\s*false\b/);
});

test('0021 收口探针对象、默认域名和生产 cron', () => {
  assert.ok(existsSync(migrationPath), '缺少 0021_production_baseline.sql');
  const sql = readFileSync(migrationPath, 'utf8').toLowerCase();

  for (const objectName of [
    'probe_drain_batch',
    'probe_env_report',
    'probe_link_seq',
    'probe_link_snapshot',
    'probe_prune_dead_links',
    'probe_resolve',
    'probe_time_writes',
    'probe_unlogged_write',
    'probe_inbox',
    'probe_prune_report',
    'probe_short_url',
    'probe_sink',
    'probe_unlogged',
    'probe_visits_counts',
  ]) {
    assert.match(sql, new RegExp(`drop (?:function|table) if exists ${objectName}\\b`));
  }

  assert.match(
    sql,
    /update\s+domain[\s\S]*authority\s*=\s*'example\.com'[\s\S]*scheme\s*=\s*'https'[\s\S]*where\s+id\s*=\s*0[\s\S]*authority\s*=\s*'__default__'/,
  );
  assert.match(sql, /create extension if not exists pg_cron/);

  for (const jobName of [
    'rxlink-drain',
    'rxlink-prune',
    'rxlink-retire-ip',
    'rxlink-expired',
  ]) {
    assert.match(sql, new RegExp(`cron\\.schedule\\(\\s*'${jobName}'`));
  }
});

test('根级 CI 覆盖全部验收门禁', () => {
  const ciPath = path.join(root, '.github', 'workflows', 'ci.yml');
  assert.ok(existsSync(ciPath), '缺少根级 .github/workflows/ci.yml');
  const workflow = readFileSync(ciPath, 'utf8');

  for (const command of [
    'node --test',
    'deno test',
    'deno check',
    'npm run cs',
    'npm run types',
    'npm test',
    'npm run build',
    'npm run build:en',
    'supabase db reset',
  ]) {
    assert.ok(workflow.includes(command), `CI 缺少命令：${command}`);
  }
});

test('发布门禁依赖 CI 成功并生成全部部署包', () => {
  const releasePath = path.join(root, '.github', 'workflows', 'release.yml');
  assert.ok(existsSync(releasePath), '缺少根级 .github/workflows/release.yml');
  const workflow = readFileSync(releasePath, 'utf8');

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /conclusion\s*==\s*'success'/);
  assert.match(workflow, /build-geoip-bundle\.mjs/);
  assert.match(workflow, /build-china-geo\.mjs/);
  assert.match(workflow, /build-compat-function\.mjs/);
  assert.match(workflow, /build-console-fc\.mjs/);
  assert.match(workflow, /build-geo-enrich-fc\.mjs/);
  assert.match(workflow, /dist\/redirect\.zip/);
  assert.match(workflow, /fc\/redirect\/index\.js/);
});
