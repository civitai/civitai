# Handoff: users-over-time-panel — 2026-09-25

## Run this first — the index, one command
```bash
cairn recall --repo /home/zach/workspace/civit/civitai
```
Terse pointers this doc does not carry, curated by past sessions and outliving it.
🔴 RECALL, NOT LIVE OBSERVATION — every line is a pointer to VERIFY, never a current
reading, and it may describe a gotcha already fixed. Non-blocking on non-zero exit.
Second useful recall (the dashboards + RUM ingest side):
`cairn recall --repo /home/zach/workspace/civit/datapacket-talos` — `datapacket-talos/faro.md`
carries the Loki-query traps this plan leans on.

## Goal
Give the business dashboards a "users over time" panel (DAU/active-population history)
backed by an hourly snapshot job, so panels stop re-scanning raw ClickHouse tables
(`default.views`, `orchestration.jobs`, `default.buzzTransactions`) on every load and
the history is long (months), not window-limited.
- **closing-condition:** `check` — a merged PR adding the snapshot table + hourly job +
  "Users over time" panel, verified by the panel rendering from the snapshot table with
  a backfilled history (>=30d) and the old funnel panel re-pointed at it (dashboard
  query no longer hits raw tables).

## State now
- Branch: civitai `main` @ b8fb27a71e (behind origin/main by 28 — fetch before any work);
  datapacket-talos `trunk` @ d88232eee (behind 136; two dirty skill files PRE-EXIST this
  session — not ours, do not commit them).
- What's DONE this session (recon only, ZERO commits, read-only):
  - Read index entries `civitai/faro.md` + `datapacket-talos/faro.md` (stamp
    synced=1790379245 ≈ 2026-09-25 23:14 UTC; coverage=ALL).
  - Dashboard analysis: `datapacket-talos/clusters/production/apps/prometheus-stack/grafana-dashboards/civitai-business-pulse.json`
    — row "Active population funnel", panel 21 "Funnel: viewers → generators → buyers"
    runs LIVE `uniqExact(userId)` over raw tables per load, with `$window` filter;
    panels 15/16/17 (generator:buyer ratio, unmonetized generator share, daily
    generation volume) are the same live-scan pattern. Generator definition there =
    `userId > 0 AND match(jobType, '^[A-Za-z0-9_-]{2,40}$') AND cost BETWEEN 0 AND 1000000`.
  - `civitai-dp-prod-frontend-rum.json` has a Sessions stat:
    `count(count by (session_id) (count_over_time({source="faro-rum"} | logfmt kind, session_id | kind=event ...)))`
    — same per-load heavy pattern, and Loki-side (72h retention).
  - `civitai-cohort-health.json` has 3 tier-count user panels — NOT yet inspected in
    detail (listed as next step 2).
- What's IN FLIGHT: nothing.
- Deploy/verify status: N/A — no code or dashboards changed.

## Next steps (ranked)
1. Get the user's answers to the 5 clarifying questions already asked (scope of
   "users": DAU/WAU/MAU vs new signups vs buyers vs generators; job home — civitai
   worker/scheduler vs standalone cron; retention horizon; alerting wanted or
   panel-only; whether cohort-health/business-history already share a rollup to
   extend instead of a new table). forcing: user
2. Inspect `civitai-cohort-health.json` + `civitai-business-history-dashboard.json`
   (same dir) for raw-table scans or an existing rollup table to extend — determines
   new-table vs extend. forcing: user
   (blocked behind 1's scope answer only for schema; the inspection itself is free)
3. Design the snapshot table: one row per hour; DECIDE UP FRONT whether to store
   `uniqCombinedState(userId)` HLL states per hour (enables any rolling 7d/30d/90d
   DAU later without re-scanning raw tables — hard to retrofit). Backfill: re-run
   safe per hour (ReplacingMergeTree or dedupe by hour bucket). forcing: none
4. Implement the hourly job in civitai following existing patterns:
   `src/server/jobs/user-activity-rollup.ts` (closest precedent — CH rollup cron,
   idempotent-overlap design) and `src/server/jobs/update-metrics.ts` /
   `base.metrics.ts`. Register in `src/pages/api/webhooks/run-jobs/[[...run]].ts`.
   One-time backfill of history before the panel ships (empty table reads as
   "0.0% active" — see user-activity-rollup.sql warning). forcing: none
5. Panel work in datapacket-talos
   `clusters/production/apps/prometheus-stack/grafana-dashboards/`: add "Users over
   time" timeseries; re-point pulse panel 21 at the snapshot table; register the
   dashboard in that dir's `kustomization.yaml` (gate 14 = dashboard metric-seam —
   it only checks registered dashboards). Generate dashboard JSON with a script,
   never by hand (regexp escaping — see `claudedocs/faro-rum-logql-query-patterns.md`
   §JSON gotchas). forcing: none
6. Optional: emit Prometheus gauges from the same job (civitai_app_* prefix, PROM
   helpers in `src/server/prom/client.ts`) so DAU drop / signup-floor becomes
   alertable (manage-alerts skill, two alert tracks). forcing: none

## Defects (batched)
- (none yet — no audit ran; recon-only session)

## Gotchas / decisions / dead-ends
- 🔴 Loki RUM is the WRONG store for users-over-time: `{source="faro-rum"}` has 72h
  retention (no `retention_stream` override), 10h unqualified-logfmt windows TIME OUT
  (measured, `datapacket-talos/faro.md` 2026-09-22), and `count(count by (session_id))`
  per panel load is exactly the heavy-query pattern being eliminated. History must
  come from ClickHouse.
- 🔴 Prometheus pushgateway is last-value-wins + short retention — wrong for year-scale
  history. ClickHouse snapshot table is the chosen store (same datasource as the rest
  of the dashboard).
- Keep generator/buyer definitions BYTE-IDENTICAL to pulse panel 21's SQL guards, or
  the new panel silently disagrees with the old numbers.
- ClickHouse does NOT support correlated subqueries — LEFT ANTI JOIN instead
  (business-metrics-pipeline skill).
- The existing "Sessions" RUM stat counts FARO SESSIONS (browser, 100%-ramped, 72h),
  not accounts — do not present it as "users"; the snapshot job counts account ids.
- civitai repo is 28 behind origin/main; datapacket-talos trunk 136 behind — sync first.

## How to verify
1. Snapshot job: manual trigger via the run-jobs webhook; re-run the same hour and
   confirm row count does NOT double (idempotency), then
   `SELECT count() FROM metrics.users_hourly` after backfill >= 30d of rows.
2. Panel: open the pulse dashboard; the funnel/Users-over-time panels render from
   `metrics.users_hourly`; confirm via Grafana query inspector that no target hits
   `default.views` / `orchestration.jobs` raw scans any more.
3. Timing: old panel 21 query vs new — expect ms-level on the snapshot table vs
   seconds-to-minutes on raw `uniqExact` over `$window`.
