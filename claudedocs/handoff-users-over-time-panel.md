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
- 2026-09-25 (second session): 5 questions closed, design written. Branch
  `zach/users-over-time-snapshot` off `origin/main` carries the migration file +
  this doc update. NOT pushed, no PR yet.
- What's IN FLIGHT: nothing running. Branch is local and uncommitted upstream.
- Deploy/verify status: **nothing applied.** No DDL has been run against ClickHouse,
  no job deployed, no dashboard changed. The three preflights in the migration header
  are unrun — in particular `orchestration.jobs`'s sorting key is ASSUMED, not measured.

## Decisions taken (2026-09-25) — all five questions are CLOSED
Four were answered by the user; the fifth was settled from the repo and needed no ask.
1. **Scope** — all four populations: active, generators, buyers, new signups.
2. **Job home** — civitai app job (`src/server/jobs/`), registered in the run-jobs
   webhook. Mirrors `user-activity-rollup.ts`, the closest live precedent.
3. **Retention** — hourly for 90d, daily forever. Two tables, not one.
4. **Alerting** — panel-only for now. No Prometheus gauges in the first PR.
5. **Extend vs new table — NEW, settled by evidence, not preference.** There are two
   live ClickHouse rollups and NEITHER has the right shape:
   - `default.user_activity_rollup` is `ORDER BY userId` — a CURRENT-STATE table
     (last-seen per user). It has no time bucket and cannot express history at all.
     Adding one would change its semantics and break Creator Studio's audience panels.
   - `default.daily_downloads_unique` is per `(modelId, modelVersionId, createdDate)`
     — right shape, wrong subject.
   So: new tables, with those two as the TEMPLATES rather than the hosts.

**The design is written and lives in the repo**, in this codebase's own idiom (a
migration file carrying the reasoning, like `2026-09-04-user-activity-rollup.sql`):
`src/server/clickhouse/migrations/2026-09-25-user-population-snapshot.sql`
on branch `zach/users-over-time-snapshot`. Tables `default.user_population_hourly`
(TTL 90d) + `default.user_population_daily` (no TTL), seven HLL state columns each,
`SharedAggregatingMergeTree`. Read that file before implementing — it carries the
three preflights, the backfill arms and the reconciliation queries.
🔴 It supersedes the placeholder name `metrics.users_hourly` used below: repo
convention is the `default.` database (both precedents live there).

**HLL states: YES, decided up front.** Two reasons, the second the operational one:
- A stored COUNT cannot be summed into a window (a user active in nine hours counts
  nine times), so rolling DAU/WAU/MAU needs the sketch. Retrofitting means
  re-deriving every historical bucket from raw tables — the scan being eliminated.
- Idempotency. `2026-09-04-user-activity-rollup.sql` warns in its own words that the
  `SharedSummingMergeTree` targets "silently double when their refresh is re-run" and
  says not to add "a `count`-shaped column". A uniq-state merges with itself as the
  identity, exactly like the `max`/`argMax` that file relies on — so re-runs,
  catch-ups and overlapping backfills cannot double.
- 🔴 Accepted cost: `uniqCombined` is ~0.8% approximate where the panels use
  `uniqExact`. The FILTER GUARDS stay byte-identical; only the aggregator changes.
  Re-pointed panels will differ by <1% and that is the price of rolling windows, not
  a defect. `signups_state` uses `uniqExact` (low cardinality, exact figures).

**Seven columns, not one** — sketches union but do not SUBTRACT, so the column split
is the other thing that cannot be retrofitted. The four activity sources are stored
separately because panel 21's "Logged-in viewers" is `default.views` ALONE while
DAU is the union of all four (the 2026-09-04 migration measured the three non-pageViews
sources adding +7.5% users over 30d).

## Next steps (ranked)
1. ~~Get the 5 clarifying questions answered~~ — DONE, see Decisions above.
2. ~~Inspect cohort-health + business-history for an existing rollup to extend~~ — DONE.
   Findings in State now / Decisions. forcing: none
3. ~~Design the snapshot table, HLL decided up front~~ — DONE, the migration file is
   written on branch `zach/users-over-time-snapshot`. **Remaining: run the three
   PREFLIGHTS at the top of that file before applying any DDL.** The load-bearing one
   is #1 — whether `orchestration.jobs` is `ORDER BY createdAt` first. The per-run
   cost model assumes every arm is a primary-key range scan; that was verified for the
   four `default.*` activity sources on 2026-09-04 but `orchestration.jobs` is in
   another database and was NOT part of that check, and this repo does not carry its
   DDL. If it sorts otherwise, the generators arm is a full scan every hour and needs
   rethinking. forcing: none
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
- 🔴 **`civitai-business-history-dashboard.json` is NOT history, despite the name.** All 12
  panels are `prometheus` targets (`civitai_business_*`), produced by the WEEKLY CronJob
  `clusters/production/apps/civitai-business-digest/` (talos-infra) pushing gauges to
  Pushgateway. CLAUDE.md records Pushgateway as last-value-wins and dp-1 Prometheus
  retention as ~14 days — so a weekly producer leaves roughly TWO points per series
  inside retention. Do not treat this dashboard as an existing long-history store, and
  do not "extend" it; it is the exact problem the ClickHouse snapshot replaces. (It is
  also a standing argument for later re-pointing those panels at
  `default.user_population_daily`, which is out of scope here.)
- The existing `civitai-business-digest` CronJob is still the best REFERENCE for the
  cluster-side option (python stdlib → ClickHouse HTTP, creds already in a SOPS secret,
  `concurrencyPolicy: Forbid`), and `spend-exporter/snapshot.py` + `snapshot-cronjob.yaml`
  is the precedent for a cluster CronJob writing durable ClickHouse rollups — both were
  weighed and NOT chosen (decision 2). Revisit only if the app-job route hits a blocker.
- Exact guards to keep byte-identical (read off the live dashboard 2026-09-25):
  - viewers — `default.views`, `userId > 0`, time col `time`
  - generators — `orchestration.jobs`, `userId > 0`,
    `match(jobType, '^[A-Za-z0-9_-]{2,40}$')`, `cost BETWEEN 0 AND 1000000`,
    time col `createdAt`
  - buyers — `default.buzzTransactions`, `type='purchase'`, `fromAccountId=0`,
    `description LIKE 'Purchase of %'`, counts **`toAccountId`**, time col `date`
    (a `DateTime`, so hourly bucketing is possible — confirmed in
    `containers/clickhouse/docker-init/init.sh`)
  - signups — `civitai_pg.User`, cols `id` / `createdAt` (reachable from ClickHouse;
    this is the only arm that leaves ClickHouse and touches production Postgres)
- 🔴 `uniqCombinedMerge(a) + uniqCombinedMerge(b)` DOUBLE-COUNTS users active in both
  sources and returns a plausible larger number rather than an error. To union across
  COLUMNS use `UNION ALL` of the state columns, then one merge. Worked query is in the
  migration's "Reading these tables" section.
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
