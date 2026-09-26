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
- **civitai#5159 MERGED** 2026-09-26T17:15:49Z, squash `539b1428f0`. Verified by CONTENT
  not ancestry (a squash never makes the head an ancestor): all three files on
  `origin/main`, job registered in the run-jobs route. Branch auto-deleted.
- **Released and deployed.** `origin/release` = `eb57472dbe`; `civitai-dp-prod-jobs` serves
  `ghcr.io/civitai/civitai-prod:20260926172247-eb57472`, 3/3 pods Ready on it.
- **The job is REGISTERED and ARMED, not yet observed running.**
  - App serves it: `/api/internal/get-jobs` went 183 → 184 names;
    `{"name":"user-population-snapshot","cron":"15 * * * *","options":{"lockExpiration":1200}}`
  - Hangfire registry went 183 → 184 at 17:50Z (the refresh that ran DURING the pod roll
    missed it; the next one caught it).
  - Served cron `[15 * * * *]` == registered cron `[15 * * * *]`.
  - Invocation is `CreateJob`, NOT `DisabledJob`. `NextExecution 2026-09-26T18:15:00Z`,
    `LastExecution` absent (never run).
- **DDL applied + full history backfilled** (both done 2026-09-26, before the merge):
  `default.user_population_daily` 1,397 distinct days 2022-11-12..2026-09-26;
  `default.user_population_hourly` holds only an 8-day validation slice.
- **talos-infra#1642 is OPEN and DELIBERATELY A DRAFT.** Dashboard: pulse panel 21
  re-pointed at the snapshot, new panel 22 "Users over time (daily)". Head `970e667e7`
  after a round-0 rework. `tekton / gitops-ci` passed in-cluster (`gitops-ci-1642-htmh7`).
- **Audit coverage:** civitai#5159 ran round 0 + rounds 1-5 (ladder stopped on round 5:
  behavioural payload zero, one prose finding, auditor recommended stop). talos#1642 has
  had round 0 only — **the nine correctness axes have NOT run on it.**

## Decisions taken (2026-09-25) — all five questions are CLOSED
Four were answered by the user; the fifth was settled from the repo and needed no ask.
1. **Scope** — all four populations: active, generators, buyers, new signups.
2. **Job home** — civitai app job (`src/server/jobs/`), registered in the run-jobs
   webhook. Mirrors `user-activity-rollup.ts`, the closest live precedent.
3. **Retention** — hourly for 90d, daily forever. Two tables, not one.
4. **Alerting** — panel-only for now. No Prometheus gauges in the first PR.
5. **Extend vs new table — NEW.** ⚠️ **The original wording here was "settled by
   evidence, not preference", and the METHOD behind it was wrong — corrected after
   round 0 of the audit caught it.** It enumerated TWO candidates out of the ~30+
   aggregate tables and ~31 MVs in `containers/clickhouse/docker-init/init.sh`, then
   generalised to a negative claim ("NEITHER has the right shape"). That is sampling
   presented as enumeration — the exact shape CLAUDE.md's gotcha #13 warns about, and
   the fuller sweep did turn up near-neighbours the pair had missed:
   `default.daily_user_counts`, `default.daily_generation_user_counts`,
   `cohorts_monthly_activity`, `uniqueViewsDaily`.
   **The conclusion survives, but on different and now-measured grounds** (2026-09-25):
   - `default.user_activity_rollup` is `ORDER BY userId` — a CURRENT-STATE table
     (last-seen per user). It has no time bucket and cannot express history at all.
     Adding one would change its semantics and break Creator Studio's audience panels.
   - `default.daily_downloads_unique` is per `(modelId, modelVersionId, createdDate)`
     — right shape, wrong subject.
   - `default.daily_user_counts` — the one the original pair MISSED, and the closest
     thing to a real counter-example. It is populated: 1,154 rows, 2023-08-08 → today,
     incrementally maintained, zero cron, covering the logged-in-viewer population, and
     agreeing with our `views_state` to within 0.01–1.05% on complete days. **It is
     still not extendable, for a measured reason rather than an assumed one:** its
     column is `AggregateFunction(uniqIf, Int32, UInt8)`, and `uniqCombinedMerge` over
     it ERRORS — so it cannot be unioned with the other three activity sources, which
     is the entire purpose of storing them as compatible states.
   - `default.daily_generation_user_counts` — reads `orchestration.textToImageJobs`
     (one job type, not the panel's population) and carries none of panel 21's guards.
     Its own date range is 1970-01-01 → 2036-02-07, i.e. it has the sentinel-date
     problem our `<= now()` bound exists to prevent.
   So: new tables, with the above as TEMPLATES rather than hosts.
   🔴 **Open, not settled: a REFRESHABLE materialized view was never considered.**
   Seven are live in this deployment. The "why not an MV" argument this design
   inherited is about INCREMENTAL MVs and does not transfer. See the migration's own
   section on it — it is recorded as open, deliberately, rather than back-filled with
   a justification.

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
1. **Confirm the 18:15Z run fired AND wrote** (both signals above), then confirm the
   snapshot's today-figure converges toward the live count. Repo: none — observation only.
   forcing: gate — talos#1642 must not leave draft until this holds.
2. **Un-draft and merge talos-infra#1642** once (1) holds. `gh pr ready 1642 --repo
   civitai/talos-infra` then merge. Touches
   `clusters/production/apps/prometheus-stack/grafana-dashboards/civitai-business-pulse.json`.
   IN FLIGHT: civitai/talos-infra#1642. forcing: gate — the closing condition needs a merged panel.
3. **Run the nine correctness axes on talos#1642** — only round 0 has run; round 0 explicitly
   cannot license skipping a round. `/audit-pr 1642`. forcing: gate — an unaudited production
   dashboard change.
4. **Backfill the HOURLY table to ~80 days** (it holds an 8-day slice). Statements are in
   `<civitai>/src/server/clickhouse/migrations/2026-09-25-user-population-snapshot.sql`
   §Backfill. 🔴 Scope INSIDE the 90-day TTL — a bucket at/past the horizon is silently
   dropped on insert. forcing: none
5. **Decide the refreshable-MV question**, recorded as OPEN in the migration. Seven refreshable
   MVs are live; the inherited "why not an MV" argument is about INCREMENTAL MVs and does not
   transfer. forcing: none
6. **Rotate/redesign the job-scheduler webhook token.** It is stored in PLAINTEXT in the
   Hangfire registry arguments for all 184 jobs, so anyone with read access to
   `civitai_job_scheduler` has it. Pre-existing, not introduced here. forcing: security

## Defects (batched)
- **Round 0 (talos#1642), all fixed in `970e667e7`:** two of panel 22's four series duplicated
  panels already on the same dashboard (buyers was byte-identical, diff 0 on all 7 days);
  panel 22 was the only long-format ClickHouse timeseries in 147 dashboards (unverifiable
  render, now wide format, one scan not seven); four series spanned three orders of magnitude
  on one linear axis; a pre-existing `isMember` caveat was silently deleted; the PR body's
  "Both panel descriptions now say so" was false; "zero gaps" was false (18 missing days).
- **Rounds 1-5 (civitai#5159), all fixed before merge:** positional `INSERT … SELECT` with six
  type-identical columns; a backfill arm bounding `createdDate` while bucketing on `time`
  (unbounded, into a no-TTL table); one failing arm truncating the rest and skipping the daily
  roll; a TTL guard that was vacuous (proved by mutating the DDL and watching the suite stay
  green); a recycled measurement that disarmed the uniqExact control; ten mutants surviving a
  green suite because guards covered 3 of 7 arms.

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

- **SETTLED, carried forward from the old Next-steps preflight:** `orchestration.jobs` DOES
  sort by `createdAt` first, so every arm is a primary-key range scan and the hourly cost model
  holds (~3.4s per run). The 2026-09-04 check had covered only the four `default.*` activity
  sources. Two consequences it turned up: that table has **no partition key** (chunk a backfill
  by `createdAt` RANGE, not partition) and its `createdAt` is **`DateTime64(3)`**, the only
  non-`DateTime` time column in the set. All recorded in the migration's preflight block.
- 🔴 **Registered ≠ running, and the registry lags a pod roll.** The scheduler's refresh runs
  every ~10 min; the one that ran DURING the roll read `get-jobs` from a pre-roll pod, so the
  job was absent at 17:49 (183 registered vs 184 served) and present at 17:50. A positive
  control on a known job confirmed the absence was real rather than a bad query shape. Do not
  start debugging a missing registration until a full refresh cycle has passed since the roll.
- 🔴 **NEVER add a Kubernetes CronJob for a civitai job.** The scheduler registers every name
  `get-jobs` serves (184 now). A CronJob is a second, duplicate trigger — `rewards-daily-reset`,
  `announcement-media-check` and `reap-dev-tunnels` each ran TWICE per tick until theirs were
  removed, and Redis locks do NOT reliably dedupe two triggers of the same job. For
  Buzz-mutating jobs that means double-delivery. (`dp-jobs` skill.)
- 🔴 **`preview / component-tests` on #5159 was red and NOT reproducible.** An earlier audit
  called it a shared pre-existing red; that was WRONG — PR #5134 was `success` on the same
  check. Read precisely, the bot said `component:fail`, which the `pr-previews` skill
  distinguishes from the common "exceeded its runner budget — no verdict" (rc 124) case. The
  PipelineRun was pruned, so it was re-fired by TOGGLING THE `preview` LABEL — which re-runs
  WITHOUT moving the head sha, keeping every audit sha valid. The task then Succeeded at the
  identical sha. Blocking checks (Typecheck, Unit tests, ESLint+Prettier, event-engine-common
  pin, preview build) were green throughout.
- **Merging civitai `main` does NOT deploy.** dp-prod serves an image built from `release`;
  `main` was 8 commits ahead at merge time. A release cut is what deploys.
- 🔴 **A raw row count is not a coverage measure for these tables.** Re-measuring hours apart
  gave 1,183 → 748 rows over a WIDER span: the span grew because a repair re-ran one day wider,
  the count FELL because AggregatingMergeTree collapses a bucket's seven per-arm rows into one
  as merges run. Compare DISTINCT BUCKETS or merged values, never `count()`.
- 🔴 **A bucket outside the 90-day TTL is SILENTLY DROPPED on insert** — accepted, no error,
  row never appears. Found because a preflight probe used a year-2000 sentinel and returned a
  confident `0` for every column, which read as "omitted columns are empty" and was actually
  "there is no row at all". Two mechanisms, one observable. Always assert row visibility and a
  positive control BEFORE reading the thing you came to measure.
- **The gate verdict is BASE-DEPENDENT.** `gitops-delta-gate.sh origin/trunk HEAD` blocked on
  an unrelated `app-capture/SKILL.md` size complaint because this clone's `origin/trunk` had
  moved past the branch point. Use the MERGE-BASE; it then passes with only the dashboard in
  the delta.
- **The gate does not validate ClickHouse SQL.** Negative-controlled: malformed JSON in the
  dashboard IS blocked, but a bogus aggregate function name PASSES. It checks
  gauge-aggregation and LogQL invariants. What validates the SQL is running it.

## How to verify
1. **Job is running** (the current gate):
   ```bash
   CNPG=$(KUBECONFIG=$KC_DPPROD kubectl get pods -n cnpg-database -l cnpg.io/cluster=cnpg-cluster-nvme0 -o name | grep '^pod/cnpg-cluster' | head -1); CNPG=${CNPG#pod/}
   KUBECONFIG=$KC_DPPROD kubectl exec -n cnpg-database "$CNPG" -c postgres -- psql -tA -d civitai_job_scheduler \
     -c "select field||'='||value from hangfire.hash where key='recurring-job:user-population-snapshot' and field in ('Cron','LastExecution','NextExecution');"
   ```
   Then the write, which is the signal that matters:
   `SELECT table, max(modification_time) FROM system.parts WHERE database='default' AND active AND table LIKE 'user_population%' GROUP BY table`
   — must advance past `2026-09-26 05:19:16`. Two consecutive hourly advances, not one:
   a single write could be another backfill.
2. **Reconciliation** (re-run after any backfill): snapshot vs raw over a day-aligned window.
   Last run 2026-09-26: viewers +0.29%, generators +0.10%, buyers +0.18%, **signups EXACT**.
   🔴 `signups_state` is `uniqExact` and CANNOT approximate — a signups disagreement is proof
   the pipeline lost rows, never sketch error. Investigate it; do not expect it.
3. **All-time cross-check** — the one that caught a silent 1,047,513-account hole a per-window
   reconciliation could not see: compare `uniqExactMerge(signups_state)` over the whole table
   against `SELECT uniqExact(id) FROM civitai_pg.User`. A single-digit gap is arrivals between
   the two queries; a four-digit one is a real hole.
4. **Panels** (after #1642 merges): open the pulse dashboard; panel 21 and panel 22 render from
   `default.user_population_daily`. Panels 16 and 17 still hit raw tables BY DESIGN and always
   will — 16 is a set difference, 17 needs a row count and a sum; sketches express neither.
## Open investigations — live diagnosis state
### Has the hourly job actually RUN and WRITTEN? (armed, unobserved as of 17:56Z)
- as-of: 2026-09-26
- **Symptom + exact repro:** not a bug — an unfinished verification. The job is registered
  but has never executed. `registered != running` is the failure this must exclude; the
  `reap-dev-tunnels` reaper was dead code in prod for months while registered.
- **Observed (with values):**
  - Hangfire `LastExecution` for `recurring-job:user-population-snapshot`: **absent**
    (polled every 60s from 17:51:16 to 17:56:21Z, `<never>` every time).
  - `system.parts` last write, unchanged across the same window:
    `user_population_daily 2026-09-26 05:19:16` · `user_population_hourly 2026-09-26 04:28:31`
    — both my backfill, ~12h stale.
  - Consequence if it never fires, measured 17:0xZ: snapshot reads **5,982** generators for
    today against **12,410** live — 52% understated, and it returns rows rather than erroring.
- **Ruled out:** "the scheduler never picked it up" — `via: measurement`. Registry count
  went 183 → 184 and the record exists with the right cron and a `CreateJob` invocation.
- **Ruled out:** "a Kubernetes CronJob is needed" — `via: doc`. The `dp-jobs` skill states
  the scheduler auto-registers every name `get-jobs` serves; adding a CronJob creates a
  DUPLICATE TRIGGER (three jobs previously double-ran that way). Do not add one.
- **Leading hypothesis:** it will fire normally at 18:15:00Z. Nothing observed contradicts it;
  it simply has not happened yet.
- **Next probe:** a background watcher is running (session task `b36n9cjs5`). If that session
  is gone, re-run it verbatim:
  `bash /tmp/claude-1000/.../scratchpad/watch_first_run.sh` — or directly:
  `CNPG=$(KUBECONFIG=$KC_DPPROD kubectl get pods -n cnpg-database -l cnpg.io/cluster=cnpg-cluster-nvme0 -o name | grep '^pod/cnpg-cluster' | head -1); CNPG=${CNPG#pod/}; KUBECONFIG=$KC_DPPROD kubectl exec -n cnpg-database "$CNPG" -c postgres -- psql -tA -d civitai_job_scheduler -c "select field||'='||value from hangfire.hash where key='recurring-job:user-population-snapshot' and field in ('LastExecution','NextExecution');"`
  🔴 Require BOTH signals: `LastExecution` advancing AND `system.parts` gaining a write past
  `2026-09-26 05:19:16`. A run that fires and writes nothing shows the first without the second.
