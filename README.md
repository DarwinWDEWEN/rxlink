# rxlink — a shlink-compatible short-link platform

[English](README.md) · [中文](README.zh-CN.md)

rxlink is a short-link platform that reimplements the **shlink REST contract** (`/rest/v3/*`) on serverless infrastructure, and drives the official shlink web console ([shlink-web-client v4.9.0](https://github.com/shlinkio/shlink-web-client)) as its admin UI. The point is not to run upstream shlink in the cloud — it is a ground-up implementation of the data plane and redirect path behind the shlink API.

- Console: the shlink web console you deploy yourself (see [Self-hosting](#self-hosting-private-deployment))
- Short-link domain: `https://<your-short-link-domain>/{code}`
- Compatibility layer: `https://<your-supabase-project>/functions/v1/compat/rest/v3/*`

> **Project status** — feature-complete against the shlink contract (23 / 24 REST actions ✅, 1 ⚠️ degraded, 0 ❌), but **not yet in production**: the Supabase free tier (1C2G) cannot be used for production traffic; a paid plan is required. See [Status & release blockers](#status--release-blockers).

## Highlights

- **Official shlink console works out of the box.** Create/edit short URLs, tags, domains, redirect rules, QR codes, visit stats and multi-server management — all through shlink-web-client, no custom UI.
- **Millisecond redirect hot path.** In-memory snapshot + queue-based persistence keep redirects fast; statistics never slow them down.
- **Second-level link updates.** Writes bump `link_version.seq`; the redirect function polls and refreshes its snapshot.
- **Full visit analytics.** Time series, browser/OS/referrer breakdowns, geo enrichment (DB-IP City Lite), per-visit details with CSV export, plus *orphan visits* that reveal dead links and scanners.
- **Privacy-conscious.** Raw IPs are cleared right after enrichment; a hard 7-day retention cap backs it up.
- **11 dynamic redirect conditions** — device / browser / language / query param / IP / geo / date.
- **Bilingual console** — build-time i18n pipeline produces Chinese (`zh-CN`) or English (`en`) builds with literal-count assertions.

## Architecture

| Component | Role | Code |
|---|---|---|
| Redirect hot path | Serves `/code` → `302`/`404`; queues visits | `fc/redirect/` |
| Data plane | Short URLs, visits, API keys | `supabase/migrations/` (21 migrations) |
| Compatibility layer | Translates shlink REST contract into DB ops | `supabase/functions/compat/` (Deno) |
| Console | Vendored shlink-web-client v4.9.0 + zh-CN i18n | `shlink-web-client/` → `fc/console/` |
| Geo enrichment | IP → country/city (hourly) | `fc/geo-enrich/` |

```
user hits https://example.com/abc123
   │
   ▼
FC redirect function (in-memory snapshot)
   ├─ cache hit  → 302 immediately (dur≈0)
   └─ cache miss → ADB Supabase lookup → 302 / 404
   │
   └─ meanwhile: who / when / which IP / what browser → visit_inbox
   │
   ▼
cron drain_visit_inbox(500) every minute → visit table (monthly partitions)
   │
   ▼
FC geo-enrich (hourly) → DB-IP lookup → write back country/city/lat-lng
   │
   ▼
console reads the visit table → charts and per-visit detail
```

The split is deliberate: redirect is a hot path that must answer in milliseconds, so it uses an in-memory snapshot and queued writes; statistics are cold and can tolerate minute-level delay. Decoupling means redirects are never slowed by analytics.

## Repository layout

| Path | Contents |
|---|---|
| `fc/redirect/`, `fc/geo-enrich/`, `fc/console/` | First-party FC functions |
| `supabase/functions/compat/` | Compatibility layer (Deno) |
| `supabase/migrations/` | Database migrations (0001–0021) |
| `scripts/` | Build / deploy / i18n / ops scripts |
| `shlink-web-client/` | Vendored upstream shlink-web-client v4.9.0 (MIT), including our zh-CN i18n changes |
| `docs/` | Manual, runbook, design notes |

## Quick start

1. Generate an API key on your deployment (plaintext printed once; only its sha256 is stored):

   ```bash
   nvm use 24
   bash scripts/new-api-key.sh <name>            # optional: --expires-at 2027-01-01T00:00:00Z
   ```

2. Open your console and add a server:

   | Field | Value |
   |---|---|
   | Name | any display name |
   | URL | `https://<your-supabase-project>/functions/v1/compat` |
   | API key | the `rxl_…` plaintext from step 1 |

3. Verify the compat layer: `…/functions/v1/compat/rest/v3/health` should return `{"status":"pass","version":"5.1.0"}`.

## Self-hosting (private deployment)

Platform-bound to Alibaba Cloud (ADB PostgreSQL Supabase + Function Compute). Minimum requirements:

| Dependency | Notes |
|---|---|
| ADB PostgreSQL Supabase project | Needs Edge Functions, `pg_cron`, `pg_net`; **free tier is not allowed for production** |
| Alibaba Cloud Function Compute | Web functions (redirect / console) + event function (geo enrichment) + scheduled triggers (cron expressions use **6 fields**) |
| Node.js ≥ 20 | Local default is 16 — use `nvm use 24` |
| Deno 2.x | Type checking and tests for the compat layer |
| DB-IP City Lite mmdb | Downloaded automatically by scripts (CC BY 4.0); >50 MB compressed, deployed via an FC Layer |
| Domains | Short-link + console domains, with DNS/filing |

Deployment outline:

1. **Database**: replay `supabase/migrations/*.sql` in order on an empty database (`supabase db reset` locally).
2. **Compat layer**: `node scripts/build-compat-function.mjs` → `functions-cli deploy compat`.
3. **Redirect function**: build `china-geo.bin` → zip 7 files → upload as an FC Web function.
4. **Console**: `npm run build` → `node scripts/build-console-fc.mjs` → upload `dist/console.zip`.
5. **Geo enrichment**: `build-geoip-bundle.mjs` + `build-geo-enrich-fc.mjs` → upload Layer and code package.
6. **Scheduling**: create 4 `pg_cron` jobs + 1 hourly FC trigger.
7. **Domains**: point the short-link domain at the redirect function, the console domain at the console function.

Exact commands and configuration knobs live in [docs/runbook.md](docs/runbook.md).

## Testing

```bash
# Node side (real subprocesses + mock gateway)
node --test fc/console/test/console.test.js \
          fc/geo-enrich/test/geo-enrich.test.js \
          fc/redirect/test/*.test.js \
          scripts/i18n/test/*.test.mjs \
          scripts/test-production-baseline.mjs

# Deno side (compat layer)
deno test --allow-env supabase/functions/compat/test/compat.test.ts \
                      supabase/functions/compat/test/title-resolver.test.ts
deno check supabase/functions/compat/index.ts \
            supabase/functions/compat/handler.ts \
            supabase/functions/compat/title-resolver.ts
```

CI (`.github/workflows/ci.yml`) runs two jobs:

- **quality** — the tests above + frontend quality gates + both zh-CN/en builds (asserts `<html lang="zh-CN">` / `lang="en"`).
- **database** — `supabase start && supabase db reset` replays migrations from an empty database and asserts no `probe_%` residue, default domain `example.com|https`, and 4 cron jobs.

## Status & release blockers

- **shlink REST contract**: 23 / 24 actions ✅, 1 ⚠️ (`mercureInfo` degrades to 404), 0 ❌. The server side also implements `/{code}` redirect, `/{code}/track` pixel, and `robots.txt`. Details in [docs/shlink-feature-checklist.md](docs/shlink-feature-checklist.md).
- **Blocking**: 🔴 production use requires a paid Supabase plan (the only real blocker); 🟠 confirm FC scheduled-trigger cron uses 6 fields. Full list in [docs/release-checklist.md](docs/release-checklist.md).

## Operations

Health query (backlog + drain liveness):

```sql
select
  (select count(*) from visit_inbox where processed_at is null)::text as inbox_pending,
  (select coalesce(max(extract(epoch from (now()-occurred_at)))::int,0)
     from visit_inbox where processed_at is null)::text as inbox_oldest_sec,
  (select coalesce(extract(epoch from (now()-max(start_time)))::int,-1)
     from cron.job_run_details where jobid=6 and status='succeeded')::text as drain_last_success_sec,
  (select seq from link_version where id=1)::text as link_seq;
```

Thresholds: `inbox_oldest_sec > 120` or `inbox_pending > 1000` ⇒ persistence backlog; `drain_last_success_sec > 180` ⇒ drain stalled.

| Job | Name | Schedule | Purpose |
|---|---|---|---|
| 6 | `rxlink-drain` | every minute | `drain_visit_inbox(500)` |
| 8 | `rxlink-prune` | daily 19:00 | `prune_dead_links(180,false)` (soft-delete, reversible) |
| 9 | `rxlink-retire-ip` | hourly | `retire_remote_addr(7)` (clear IPs older than 7 days) |
| 10 | `rxlink-expired` | daily 20:00 GMT | `delete_expired_short_urls(false)` (soft-delete) |
| — | `geo-enrich` trigger | hourly | FC event function, geo enrichment |

The full troubleshooting tree, add-a-domain SOP, rollback procedure and FC log conventions are in [docs/runbook.md](docs/runbook.md).

## Contributing

- Branch from `main`, open PRs back to `main`; commit messages follow `feat/fix/docs/chore(scope): 中文描述`.
- CI (quality + database) must pass before merge.
- Console copy: edit `scripts/i18n/zh-CN.json`, not upstream `node_modules`; after an upstream upgrade run `npm run build` to re-verify literal counts.
- For destructive/platform-wide changes (migrations, cron, function deploys), describe impact and rollback in the PR body.

## License & third-party notices

**First-party code is MIT licensed** — see [LICENSE](LICENSE).

Vendored upstream source and dependencies carry their own licenses; keep their copyright notices when redistributing:

| Component | License | Copyright / notes |
|---|---|---|
| [shlink-web-client](https://github.com/shlinkio/shlink-web-client) (`shlink-web-client/`) | MIT | Copyright (c) 2018-2020 shlinkio; includes our zh-CN i18n changes |
| `@shlinkio/*` (frontend-kit / web-component / js-sdk / data-manipulation) | MIT | shlinkio |
| `react-leaflet` / `@react-leaflet/core` (via `@shlinkio/shlink-web-component`) | **Hippocratic-2.1** | Non-OSI license with use restrictions; bundled into the console. Remove map features or replace the component if you cannot accept these terms |
| Font Awesome Free | CC BY 4.0 + MIT (dual) | Attribution required |
| DB-IP City Lite mmdb | CC BY 4.0 | Distributed with the geo-enrichment Layer; attributed in the console footer |
| [shlink](https://github.com/shlinkio/shlink) server (contract reference) | MIT | Copyright (c) 2016-2026 Alejandro Celaya — referenced during development; not vendored in this repository |

Notes:

- Console build output is minified by Vite and **does not retain per-MIT-dependency copyright banners**. If you redistribute the artifact, add a `THIRD-PARTY-NOTICES` file or preserve banners in the build.
- Hippocratic-2.1 is not copyleft and does not "infect" first-party code, but it adds use restrictions — so distributed artifacts cannot claim to be pure MIT; mark them separately per the table above.
- No GPL/AGPL/SSPL copyleft dependencies are used.

## Security boundaries

- Secrets appear only as variable names in this repo; values live in `supabase/functions/.env` (gitignored) and FC function environment variables.
- API key plaintext is generated locally and printed once; only its sha256 is stored. Lost keys can only be regenerated.
- No function echoes or logs request headers (including plaintext DB passwords and access keys); `Location` always comes from the stored `long_url` — request input never participates in assembly.
