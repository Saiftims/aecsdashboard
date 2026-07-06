# Silent Witness GTM Operating System

Sales + Customer Success dashboard for a usage-based business ($250/case,
configurable). **HubSpot is the source of truth** - this app reads from a
Supabase cache filled by scheduled syncs and writes important changes back to
HubSpot (gated by `HUBSPOT_APPLY`).

## Architecture

- **Next.js (App Router, TS, Tailwind)** on Vercel - 6 pages + API routes
- **Supabase Postgres** - read cache, settings, targets, firm mapping, audit log, sync runs
- **Supabase Auth** - email/password, 3 roles: `executive`, `ae`, `cs`
- **Sync** (Vercel cron):
  - `/api/cron/hubspot` every 15 min - incremental HubSpot sync (companies,
    contacts, deals, calls/meetings/notes/tasks)
  - `/api/cron/cases` nightly - Silent Witness case pull, per-firm usage
    metrics, health scores, risk flags, activation-lifecycle automation,
    rollup write-back to HubSpot, handoff automation
  - Manual "Sync now" / "Full sync" buttons in Admin Settings
- **Virtual activation pipeline**: the HubSpot tier allows one deal pipeline,
  so the 12-stage Customer Activation lifecycle lives in the
  `sw_activation_stage` deal property. Re-run `hubspot_migration.py` after a
  plan upgrade to convert it into a real pipeline.

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. Run `supabase/migrations/0001_init.sql` in the SQL editor.
3. Auth -> create users for the team, then insert their roles:

```sql
insert into app_users (id, email, full_name, role, hubspot_owner_id) values
  ('<auth-uid>', 'exec@silentwitness.ai', 'Exec Name', 'executive', null),
  ('<auth-uid>', 'victoria@silentwitness.ai', 'Victoria Vizcardo', 'ae', '35454790'),
  ('<auth-uid>', 'cs@silentwitness.ai', 'CS Name', 'cs', '<their-hubspot-owner-id>');
```

`hubspot_owner_id` links an app user to their HubSpot owner so "my leads"
filtering and activity attribution work.

### 2. HubSpot

The Phase-1 migration (already applied from the agent repo) created all
`sw_*` properties and the extended sales stages. The private-app token needs:
contacts/companies/deals read+write, tasks read+write, calls/meetings/notes
read+write, pipelines read. Optional (currently missing, features degrade
gracefully): `sales-email-read` + email object scopes, automation scope.

### 3. Environment

Copy `.env.example` to `.env.local` and fill everything in. Key flags:

- `HUBSPOT_APPLY=false` - the app runs read-only against HubSpot (writes are
  refused with a clear error and still audited). Set `true` to go live.
- `CRON_SECRET` - set the same value in Vercel project env; cron calls are
  rejected without it.

### 4. Local dev

```bash
npm install
npm run dev        # http://localhost:3000
npx vitest run     # unit tests
```

### 5. Deploy (Vercel)

1. Push this folder to a Git repo; import into Vercel.
2. Set every var from `.env.example` in Project Settings -> Environment Variables.
3. `vercel.json` registers the two crons automatically.
4. After first deploy: log in, open **Settings**, run **Full sync**, then map
   each customer firm to its Silent Witness id in **Firm mapping** (one-time,
   human-confirmed - never name-matching).

## Data flow

```
HubSpot  <-- write-back (gated) --  Next.js API  <-- users
   |                                    ^
   +--> 15-min incremental sync --> Supabase cache --> pages
SilentWitness API --> nightly case sync --> usage metrics/health/lifecycle
                                            --> rollups written back to HubSpot
```

## Key modules

| Path | Purpose |
|---|---|
| `src/lib/hubspot/client.ts` | HubSpot API client: pagination, 429 retry, guarded writes |
| `src/lib/hubspot/stages.ts` | Canonical stage ids/labels + activation stages |
| `src/lib/cases/provider.ts` | `CaseDataProvider` interface + Silent Witness impl |
| `src/lib/metrics.ts` | Per-firm usage windows, trend, revenue (pure, tested) |
| `src/lib/health.ts` | Transparent 7-factor health score + risk flags (tested) |
| `src/lib/lifecycle.ts` | Activation-stage automation rules (tested, never churns) |
| `src/lib/sync/*` | Sync jobs + orchestrator with `sync_runs` bookkeeping |
| `src/lib/queries.ts` | Page data assembly (exec KPIs, queues, data quality) |
| `src/app/api/writeback/route.ts` | All dashboard->HubSpot mutations, audited |

## Safety rules (enforced in code)

- All HubSpot writes go through one gate (`HUBSPOT_APPLY`), drop empty values
  (never blank manual data), and land in `audit_log`.
- Churned/Inactive is **never** set automatically - the sync only flags At Risk.
- Firm mapping uses stable ids and one-time human confirmation.
- Sync upserts are idempotent (keyed by HubSpot / SW ids).

## Operating guide (one page)

**AE - every morning:** open **AE Dashboard**, work the queue top-to-bottom
(new leads -> awaiting contact -> overdue follow-ups -> demos today ->
post-demo -> qualified w/o next step -> stalled -> walk-ins). Log every
meaningful touch with the quick logger (type + outcome + 1-line summary +
next step/date - takes 15 seconds). A deal without a future next step is a
data-quality violation. Close a firm? Complete the **Handoff** form on the
firm page - it won't submit without the required fields.

**CS - every morning:** open **CS Dashboard**, work the queue (new handoffs ->
awaiting onboarding -> no first case -> first cases in flight -> delivered
w/o follow-up -> inactive 30d -> at-risk -> issues -> expansion). Accept
handoffs from the firm page. Your goals: first case inside 14 days, second
case inside 45, keep firms green. The activation stage moves itself from real
case data - you only manage onboarding, reactivation and human judgment calls.

**Management - weekly:** open **Executive Overview** for both funnels and the
usage economics; check **Data Quality** is trending to zero; adjust targets,
thresholds and the per-case price in **Settings**.
