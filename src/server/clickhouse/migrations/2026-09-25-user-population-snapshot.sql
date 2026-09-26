-- Hourly + daily user-population snapshot (HLL states) — ClickHouse DDL.
--
-- Apply this MANUALLY, in the order written, BEFORE deploying the `user-population-snapshot`
-- job (src/server/jobs/user-population-snapshot.ts) or re-pointing the business dashboards at
-- these tables. We do not auto-run DDL (same policy as the Postgres migrations).
--
-- ── What this is for ──────────────────────────────────────────────────────
-- The business dashboards answer "how many users" by re-scanning raw tables on every panel
-- load. In `civitai-business-pulse.json` (talos-infra
-- clusters/production/apps/prometheus-stack/grafana-dashboards/), panel 21
-- "Funnel: viewers → generators → buyers" runs three `uniqExact` aggregations over
-- `default.views`, `orchestration.jobs` and `default.buzzTransactions` across a `$window`-day
-- range, per load, per viewer. Both dashboards auto-refresh (pulse 5 m, business-ops 1 m).
--
-- 🔴 WHICH PANELS THIS CAN ACTUALLY SERVE — an earlier draft of this paragraph said "panels
-- 15/16/17 repeat the same shape", which overstated the deliverable, and a reader would have
-- planned the follow-up dashboard PR from it. The re-pointable set is TWO of the four:
--   panel 21  three `uniqExact` stages                          SERVABLE
--   panel 15  ratio of two `uniqExact`                          SERVABLE
--   panel 16  countIf(userId NOT IN (SELECT ... buyers_90d))    NOT SERVABLE, EVER — that is a
--             set DIFFERENCE, and sketches union but do not subtract (see the seven-column
--             section below, which states the same property as a reason FOR the column split).
--   panel 17  count() AS jobs, sum(cost) AS buzz, per day       NOT SERVABLE — two of its three
--             series are row counts and a sum, neither of which is in these tables, so the
--             panel keeps its full `orchestration.jobs` scan either way.
-- Panels 16 and 17 keep paying the raw scan. Do not plan otherwise.
--
-- Two problems, and only one of them is cost:
--   1. Every load pays a full window re-scan of three of the busiest tables on the cluster.
--   2. There is no history for the FUNNEL AS A WHOLE. The panels can only show the population
--      as of NOW over a trailing window.
--
-- 🔴 That second point was written as a flat "there is no HISTORY" and that is FALSE — corrected
-- after an audit found the counter-example. `default.daily_user_counts` already holds a daily,
-- incrementally-maintained, zero-cron HLL state for the logged-in-viewer population, measured
-- 2026-09-25 at 1,154 rows spanning 2023-08-08 to the current day. On complete days it agrees
-- with this table's `views_state` to within 0.01–1.05%.
--
-- It is NOT a substitute, for one measured reason: its column is
-- `AggregateFunction(uniqIf, Int32, UInt8)`, and a `uniqCombinedMerge` over it ERRORS rather
-- than returning a wrong number — so it cannot be unioned with the other three activity sources,
-- which is the whole point of storing them as compatible states. Its guard also differs
-- (`userId != 0` vs the panel's `userId > 0`). So it covers ONE population at ONE grain and
-- cannot compose; these tables cover four populations that can.
--
-- These tables address both problems: the job writes one row per hour, and a panel reads merged
-- pre-aggregated state instead of raw rows.
--
-- ── 🔴 A REFRESHABLE MV MAY BE THE RIGHT MECHANISM AND WAS NOT CONSIDERED ─
-- Recording this as OPEN rather than supplying a justification after the fact.
--
-- This design inherited its "why a scheduled job and not an MV" argument from
-- 2026-09-04-user-activity-rollup.sql, which says an MV "would have to hang off four tables,
-- two of which are among the hottest ingest paths". That argument is about an INCREMENTAL MV,
-- which fires per insert. It does NOT transfer to a REFRESHABLE MV, which is schedule-driven —
-- and refreshable MVs are a live, first-class mechanism in this deployment, not a hypothetical:
-- measured 2026-09-25, `system.view_refreshes` holds SEVEN, all `Scheduled` and refreshing on
-- real cadences (`impressions_daily_by_owner_mv` daily, `transactions_final_mv` every 15 s).
-- `src/server/jobs/clickhouse-refresh-monitor.ts` already monitors them.
--
-- So the job route was chosen without the alternative ever being priced. What follows:
--   - the `civitai_pg.User` arm reads a bridge engine, so it may not transfer to an MV at all.
--     That arm is the reason this is an open question and not a straightforward switch.
--
-- 🔴 RETRACTED, and it was MY OWN sentence one commit earlier: "the MV route would inherit that
-- monitor and its alerting for free, whereas this job ships with NO staleness monitoring at
-- all". The second half is FALSE, and it was the load-bearing half — it was the strongest
-- argument for switching. I repeated it from the audit that raised it without checking it.
--
-- Every `createJob` job already emits `job_duration_seconds` and `job_errors_total` labelled by
-- job name, and `seedJobMetrics` (packages/civitai-telemetry/src/client.ts) deliberately seeds
-- both at ZERO at module load for exactly this purpose — its own comment says that without
-- seeding, "a cron that is dead, a cron that has not run since this pod started, and a cron
-- that was deleted from the codebase are all the SAME observation". Verified live 2026-09-25:
-- `civitai_app_job_duration_seconds_count{cluster="dp-1"}` is present in production for
-- `user-activity-rollup`, `clickhouse-refresh-monitor` and `bot-account-detection`, 161 series
-- each. This job will emit it automatically, with no code here.
--
-- So the two routes are much closer on observability than that sentence claimed, and the
-- monitoring argument for switching is withdrawn. The comparison genuinely was never run and
-- the question stays open — on the remaining merits, not on that one. Do not delete this
-- paragraph in favour of a rationale composed later.
--
-- ── If staleness monitoring IS wanted later, the cheap form already exists ─
-- Do NOT add a read-side guard or a bespoke gauge. There is a proven pattern in talos-infra —
-- `bot-account-detection-alerts-configmap.yaml` and `new-order-abuse-detection-alerts-configmap.yaml`
-- both alert on `civitai_app_job_duration_seconds_count{job="<name>"}` over a lookback, which is
-- precisely "did this cron run". One configmap rule, zero application code.
-- ⚠️ Read those files' own warning first: alert on the DURATION COUNT, not on
-- `civitai_app_job_errors_total` — they record that the error counter is in NO alert rule at all.
-- Not added here: no such incident has occurred, this job does not yet run in production, and a
-- guard for an incident that has never happened is the thing that taxes every later change.

-- ── Why HLL STATE columns and not counts — decided up front ───────────────
-- This is the decision that cannot be retrofitted, so it is worth stating why.
--
-- A stored COUNT per bucket can only ever answer "how many distinct users in THAT bucket".
-- It cannot be summed into a window: a user active in nine hours of a day contributes nine
-- times, so summing 24 hourly counts does not give DAU, it gives something with no meaning.
-- Storing `uniqCombinedState(userId)` instead stores the SKETCH, and sketches UNION. Any
-- rolling window — 24h, 7d, 30d, 90d, an arbitrary incident range — becomes
-- `uniqCombinedMerge` over the buckets in it, with no re-scan of raw tables and no new column.
-- Adding that later means re-deriving every historical bucket from raw tables, which is
-- exactly the scan this table exists to avoid.
--
-- The second reason is idempotency, and it is the one that matters operationally.
-- 2026-09-04-user-activity-rollup.sql records the hazard in its own words: the
-- `SharedSummingMergeTree` targets in src/server/jobs/clickhouse-refresh-monitor.ts "silently
-- double when their refresh is re-run", and it warns against adding "a `count`-shaped column"
-- for that reason. A uniq-state column has the same safety property that file relies on for
-- `max`/`argMax`: merging a sketch with itself is the identity. So re-running an hour — a
-- catch-up after a missed run, a backfill overlapping live data, a retried job — cannot
-- double anything. A count column here would carry the doubling hazard while looking exactly
-- like the columns beside it.
--
-- 🔴 The cost of the decision, stated plainly: `uniqCombined` is APPROXIMATE (~0.8% error at
-- the default precision 17). The current panels use `uniqExact`. So re-pointed panels will
-- disagree with today's numbers by well under a percent, and that is not a bug to be fixed
-- later — it is the price of any snapshot that supports rolling windows. The FILTER GUARDS
-- below are byte-identical to the panels'; only the aggregator changes. See Verification for
-- the reconciliation query to run at apply time.
--
-- `signups_state` is the one exception: `uniqExact`, not `uniqCombined`. Signup counts are
-- exact business figures people quote, the per-bucket cardinality is small (one row per
-- account, in exactly one bucket ever), so the exact hash-set state stays cheap. Same
-- idempotency, no approximation. If you would rather have seven identical columns than one
-- justified exception, `uniqCombined` there is a one-word change — make it before the
-- backfill, not after.
--
-- ── Why SEVEN state columns and not one ───────────────────────────────────
-- Sketches union, but they do not SUBTRACT. A single `active_state` per bucket can never be
-- decomposed back into its sources, so the column set is the other thing that cannot be
-- retrofitted without re-deriving history.
--
-- The four activity sources are stored separately because the dashboards need different
-- combinations of them:
--   - panel 21's "Logged-in viewers" is `default.views` ALONE. Collapsing the four into one
--     column makes that stage unreproducible, and the funnel is the panel this work exists
--     to re-point.
--   - DAU/WAU/MAU is the UNION of all four, which is what
--     2026-09-04-user-activity-rollup.sql settled on after measuring that the three
--     non-pageViews sources add 66,560 users (+7.5%) over 30 days that `pageViews` alone
--     calls dormant — `userActivities` especially, because it carries `Login`, the only
--     signal for someone whose traffic is API/generation and fires no pageview.
-- Keeping them split costs storage and buys both readings, plus per-source attribution when
-- a number moves.
--
-- ── Grain and retention ───────────────────────────────────────────────────
-- Hourly for 90 days, daily forever. Hourly is where people zoom in (incidents, a deploy, a
-- campaign); nobody zooms to the hour a year back. The reason it is not hourly-forever is
-- state size: a `uniqCombined` state at precision 17 tops out near 96 KiB, and seven of those
-- per row for 8,760 rows a year is multi-GB of sketch with no reader. Daily is ~1/24th of it.
--
-- The daily table is NOT merely a decimation of the hourly one — see Backfill. It can be
-- filled from raw tables for the platform's whole history, while the hourly table only ever
-- holds 90 days. That is where the long history in "users over time" actually comes from.

-- ── Preflight — MEASURED 2026-09-25, all read-only ────────────────────────
-- Re-derive rather than trusting these; they are a snapshot, and the point of recording them
-- is that a re-application can be CHECKED against them.
--
--   SELECT database || '.' || table AS t, sorting_key, partition_key, total_rows
--   FROM system.tables
--   WHERE (database='default' AND table IN ('views','pageViews','reactions','userActivities','buzzTransactions'))
--      OR (database='orchestration' AND table='jobs') ORDER BY t;
--
--   table                      sorting_key                                  partition_key           rows
--   default.views              time, entityType, entityId, userId           toYYYYMM(createdDate)   7.95B
--   default.pageViews          time, pageId, userId                         toYYYYMM(time)          4.75B
--   default.reactions          time, reaction, entityId, userId             toYYYYMM(createdDate)   865M
--   default.userActivities     time, type, userId                           toYear(createdDate)     45.8M
--   default.buzzTransactions   date, fromAccountId, toAccountId, ...        toYYYYMM(date)          1.61B
--   orchestration.jobs         createdAt                                    (NONE)                  2.63B
--   civitai_pg.User            —                                            —                       13.2M
--
-- (1) ✅ PASSES. `orchestration.jobs` sorts by `createdAt` FIRST, so the generators arm is a
--     primary-key range scan like the other five and the per-run cost model holds. This was the
--     one that could have sunk the hourly design: 2026-09-04-user-activity-rollup.sql verified
--     "ORDER BY time first" for the four `default.*` activity sources only, and this table is in
--     another database that check never covered.
--
--     🔴 But it has NO PARTITION KEY, so the backfill cannot be chunked by partition the way the
--     `default.*` arms can. Chunk it by explicit `createdAt` RANGE instead — which is what the
--     generators arm below does, and which still prunes, because `createdAt` is the sort key.
--     Do not "fix" that arm to use a `toYYYYMM(...)` predicate to match its neighbours.
--
--     🔴 And `createdAt` is `DateTime64(3)`, not `DateTime` — the only column here that is.
--     `toStartOfHour` of a DateTime64 does not reliably give a DateTime across versions, so the
--     generators arm wraps it in `toDateTime(...)` to match the `bucket` column exactly. An
--     implicit cast here is the kind of thing that works until it silently does not.
--     Other measured types on that table: `userId` Int32, `cost` Float64,
--     `jobType` LowCardinality(String).
--
-- (2) ✅ RUN 2026-09-25, after the CREATEs. RESULT: a column-subset INSERT is ACCEPTED, and the
--     omitted AggregateFunction columns read as an EMPTY state (0) rather than erroring —
--     positive control: the column that WAS written read 1, so the probe measured something.
--     Consequence, and it is the one that matters: omitting a column fails SILENTLY. That is
--     what the warning beside the CREATE is about. The arms below still write all seven columns
--     explicitly, which costs nothing and keeps each arm independent of this behaviour.
--
--     🔴 AND THE PROBE ITSELF TAUGHT SOMETHING THE FIRST TWO ATTEMPTS GOT WRONG — worth reading
--     before you write any backfill: A ROW WHOSE `bucket` IS OUTSIDE THE 90-DAY TTL IS SILENTLY
--     DROPPED ON INSERT. The INSERT returns success, no error is raised, and the row simply
--     never appears. Measured both ways the same day: a bucket at `now() - 30 DAY` inserted and
--     read back fine; the identical statement at `now() - 200 DAY` was ACCEPTED and the row
--     never became visible. The first two runs of this preflight used a year-2000 sentinel and
--     returned a confident `0` for every column — which read like "omitted columns are empty"
--     and was actually "there is no row at all". Two different mechanisms, one observable.
--     🔴 THE OPERATIONAL CONSEQUENCE: the HOURLY backfill below is scoped to "the last 90 days",
--     i.e. exactly the TTL boundary. Anything you backfill into the HOURLY table older than the
--     TTL vanishes with no error and no row count to check against. Backfill history into the
--     DAILY table, which has no TTL; keep the hourly backfill comfortably inside 90 days; and
--     when a bucket you wrote is missing, suspect the TTL before suspecting the query.
--
--     The probe, for re-running (use a bucket INSIDE the TTL, and keep the positive control):
--       INSERT INTO default.user_population_hourly (bucket, views_state)
--         SELECT toStartOfHour(now() - INTERVAL 30 DAY), uniqCombinedState(toInt32(1));
--       -- CONTROL FIRST: the row must be visible and views_state must read 1, or the next
--       -- query's zeros mean "no row", not "empty state".
--       SELECT count(), uniqCombinedMerge(views_state) FROM default.user_population_hourly
--         WHERE bucket = toStartOfHour(now() - INTERVAL 30 DAY);            -- expect 1, 1
--       SELECT uniqCombinedMerge(generators_state) FROM default.user_population_hourly
--         WHERE bucket = toStartOfHour(now() - INTERVAL 30 DAY);            -- expect 0, not an error
--       ALTER TABLE default.user_population_hourly DELETE
--         WHERE bucket = toStartOfHour(now() - INTERVAL 30 DAY);
--
-- (3) ✅ REACHABLE, and the size is now known: `civitai_pg.User` holds 13,239,217 rows. Per-hour
--     that arm is a narrow `createdAt` range and cheap. The FULL-HISTORY daily backfill is a
--     13.2M-row scan through the Postgres bridge and is the one step in this file that puts load
--     on the main civitai database — chunk it by month (the backfill below does) and run it
--     off-peak.
--
-- Also confirmed: there is NO `metrics` database (the databases are INFORMATION_SCHEMA, buzz,
-- civitai_pg, clickpipes, cost, cpu, default, information_schema, internal, kafka, monitoring,
-- orchestration, plausible, release, storage, system), which is why these tables live in
-- `default` alongside both precedents. And no `user_population%` table exists yet, so the
-- CREATEs below are genuinely creating, not silently adopting something.

-- ── Table 1: hourly, 90-day TTL ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS default.user_population_hourly
(
    -- Bucket start, UTC. `toStartOfHour` of the source row's own time column.
    `bucket`              DateTime,

    -- The four activity sources, kept separate so both "viewers" (views alone) and
    -- "active" (the union of all four) are readable. Ids are Int32 across all four.
    `views_state`         AggregateFunction(uniqCombined, Int32),
    `pageviews_state`     AggregateFunction(uniqCombined, Int32),
    `reactions_state`     AggregateFunction(uniqCombined, Int32),
    `useractivities_state` AggregateFunction(uniqCombined, Int32),

    -- orchestration.jobs, carrying panel 21's three guards verbatim.
    `generators_state`    AggregateFunction(uniqCombined, Int32),

    -- buzzTransactions purchases. Note this counts `toAccountId`, not `userId`.
    `buyers_state`        AggregateFunction(uniqCombined, Int32),

    -- civitai_pg.User.id. uniqExact, not uniqCombined — see the header.
    `signups_state`       AggregateFunction(uniqExact, Int32)
)
ENGINE = SharedAggregatingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY bucket
-- Hourly detail is worth keeping for a quarter. Past that the daily table carries the history.
-- 🔴 This TTL is what bounds the daily roll-up's lookback: a day whose hourly rows have already
-- expired can never be rolled up, only re-derived from raw tables. The job's daily arm uses a
-- 7-day lookback against this 90-day TTL, i.e. ~83 days of margin. Do not shrink either without
-- re-reading the other.
TTL bucket + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;


-- ── Table 2: daily, no TTL ────────────────────────────────────────────────
-- Same seven columns, `Date` bucket, kept forever.

CREATE TABLE IF NOT EXISTS default.user_population_daily
(
    `day`                 Date,
    `views_state`         AggregateFunction(uniqCombined, Int32),
    `pageviews_state`     AggregateFunction(uniqCombined, Int32),
    `reactions_state`     AggregateFunction(uniqCombined, Int32),
    `useractivities_state` AggregateFunction(uniqCombined, Int32),
    `generators_state`    AggregateFunction(uniqCombined, Int32),
    `buyers_state`        AggregateFunction(uniqCombined, Int32),
    `signups_state`       AggregateFunction(uniqExact, Int32)
)
ENGINE = SharedAggregatingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY day
SETTINGS index_granularity = 8192;

-- 🔴 IF YOU ADD A STATE COLUMN TO EITHER TABLE, ADD IT TO `STATE_COLUMNS` IN
-- src/server/jobs/user-population-snapshot.sql.ts IN THE SAME CHANGE.
-- Every INSERT here and in the job now names its columns explicitly, which closes the
-- permutation hazard but INVERTS this one: a positional insert used to fail loudly on a column
-- count mismatch, whereas a named insert simply OMITS the new column, which then reads as an
-- empty state forever. Nothing checks the DDL against `STATE_COLUMNS` — verified by mutation,
-- renaming a column here leaves the TypeScript suite fully green.
--
-- ✅ MEASURED 2026-09-25, so this is no longer an assertion: preflight (2) ABOVE has now been
-- RUN against the live tables. A column-subset INSERT is ACCEPTED with no error, and the omitted
-- columns read as a readable EMPTY state (0), not an error — with a positive control confirming
-- the column that WAS written reads 1, so the probe was measuring something. The failure is
-- therefore silent, exactly as this warning says.


-- ── Reading these tables ──────────────────────────────────────────────────
-- Rows are PARTIAL STATES until a background merge, so a read MUST aggregate. Selecting a
-- `*_state` column directly returns an unreadable blob, not a number — the same trap
-- 2026-09-04-user-activity-rollup.sql calls out for `argMaxMerge(country)`.
--
-- Panel 21's funnel, re-pointed. 🔴 READ IT FROM THE **DAILY** TABLE, NOT THE HOURLY ONE.
--
-- The dashboard's `$window` variable offers {7, 30, 90} DAYS, and the hourly table's TTL is
-- `bucket + INTERVAL 90 DAY`. At `$window = 90` a query against the hourly table puts its lower
-- bound exactly ON the TTL horizon, so the answer depends on when the last TTL merge happened
-- to run — it under-reports by a drifting amount, with nothing to indicate it. An earlier draft
-- of this section documented exactly that query, and the TTL-coupling note above reasoned only
-- about the daily roll's 7-day lookback and never noticed the panel this file exists to re-point.
--
-- The daily table has no TTL and is the correct source for ANY window measured in days:
--
--   SELECT stage, users FROM (
--     SELECT 1 AS ord, 'Logged-in viewers' AS stage, uniqCombinedMerge(views_state) AS users
--       FROM default.user_population_daily WHERE day > today() - $window
--     UNION ALL
--     SELECT 2, 'Generators', uniqCombinedMerge(generators_state)
--       FROM default.user_population_daily WHERE day > today() - $window
--     UNION ALL
--     SELECT 3, 'Buzz buyers', uniqCombinedMerge(buyers_state)
--       FROM default.user_population_daily WHERE day > today() - $window
--   ) ORDER BY ord;
--
-- ⚠️ Two accuracy notes before anyone compares this panel to its old numbers.
--   - The RECONCILIATION in the ACTUALS below was measured HOUR-ALIGNED on both sides. This
--     query is DAY-aligned and the live panel it replaces is aligned to neither — it filters
--     `time > now() - INTERVAL $window DAY` from an arbitrary instant. So the sub-1% agreement
--     recorded below is not the agreement this panel will show.
--
--     🔴 THE SIZE OF THAT DISAGREEMENT IS NOT MEASURED. An earlier draft of this note borrowed
--     the "0.2–0.5% low, signups off by exactly 19" figures from the ACTUALS below — but those
--     measure a DIFFERENT mechanism: a backfill that opened mid-hour and left its first bucket
--     genuinely short of rows. That was a DEFECT, and it was FIXED. Reusing its numbers here
--     presents a repaired one-off as an inherent property of day-alignment, which it is not.
--
--     🔴 And it would disarm this file's own best control. The ACTUALS section explains that
--     `signups_state` is `uniqExact` and therefore CANNOT approximate, so a signups disagreement
--     is proof the PIPELINE LOST ROWS rather than proof the sketch is estimating. A note telling
--     an operator to EXPECT signups off by ~19 trains exactly the response that rule exists to
--     prevent — it makes the alarm read as normal. If signups disagrees, investigate; it is the
--     one column that cannot be explained away by approximation.
--     If the day-alignment effect matters to you, measure it on its own.
--   - The newest `day` row is a PARTIAL day, rewritten by every run as more hours land. Any
--     chart ending at `today()` therefore has a final point that is a fraction of a day and
--     dips — the same "reads as a catastrophic collapse" shape this file warns about elsewhere,
--     arrived at from the other direction. Nothing marks a day row partial; end a trend chart at
--     `today() - 1`, or accept the dip and label it.
--
-- "Users over time" — DAU as a trailing 24h at each daily point, from the long table:
--
--   SELECT day AS time, uniqCombinedMerge(s) AS dau FROM (
--     SELECT day, views_state AS s FROM default.user_population_daily
--     UNION ALL SELECT day, pageviews_state FROM default.user_population_daily
--     UNION ALL SELECT day, reactions_state FROM default.user_population_daily
--     UNION ALL SELECT day, useractivities_state FROM default.user_population_daily
--   ) GROUP BY day ORDER BY day;
--
-- 🔴 That UNION ALL is how you union ACROSS COLUMNS. `uniqCombinedMerge(col)` merges one column
-- across ROWS; there is no `uniqCombinedMerge(a, b, c, d)`. Writing
-- `uniqCombinedMerge(views_state) + uniqCombinedMerge(pageviews_state) + ...` instead is the
-- mistake this note exists to prevent: it DOUBLE-COUNTS every user active in more than one
-- source, which is most of them, and it returns a plausible larger number rather than an error.
--
-- WAU/MAU are the same query with a windowed bucket filter instead of GROUP BY day — that is
-- the whole point of storing states.

-- ── Backfill ──────────────────────────────────────────────────────────────
-- Run once, after both CREATEs, BEFORE the panels ship.
--
-- 🔴 An empty table does not error — it answers every panel with 0. 2026-09-04-user-activity-
-- rollup.sql learned this the expensive way ("'0.0% active' is a number a creator will
-- believe"). A "users over time" panel reading zero looks like a catastrophic traffic
-- collapse, not like a missing backfill. Finish the backfill before re-pointing any panel.
--
-- Fill the DAILY table from raw tables for the whole history, and the HOURLY table for the
-- last 90 days only. The daily table is the long history; the hourly table is the zoom.
--
-- Every statement below is idempotent (uniq-state union), so a partial or repeated run is
-- safe and a failed arm can simply be re-run.
--
-- Run each arm ONE PARTITION AT A TIME where noted. The reason is peak memory, not table
-- size: grouping by bucket multiplies the number of in-flight aggregate states by the number
-- of buckets, which the flat per-user rollup in the 2026-09-04 file did not have to carry.
--
-- ⚠️ The partition expressions DIFFER per table, and copying the wrong one prunes NOTHING and
-- silently gives you a full scan per "partition" — the 2026-09-04 file flags the same trap.
-- Measured 2026-09-25 (the full table is in the preflight block above):
--   default.views, default.reactions   PARTITION BY toYYYYMM(createdDate)
--   default.pageViews                  PARTITION BY toYYYYMM(time)      -- `time`, not createdDate
--   default.userActivities             PARTITION BY toYear(createdDate) -- a YEAR, so chunks are big
--   default.buzzTransactions           PARTITION BY toYYYYMM(date)
--   orchestration.jobs                 NO PARTITION KEY — chunk by createdAt range instead
-- Re-confirm rather than trusting the list; it is a snapshot:
--   SELECT table, partition_key FROM system.tables WHERE database = 'default'
--     AND table IN ('views','pageViews','reactions','userActivities','buzzTransactions');
--
-- Example — the `views` arm of the DAILY backfill, one month. Repeat for every value of
--   SELECT DISTINCT toYYYYMM(createdDate) AS p FROM default.views ORDER BY p;
-- and then structurally the same for the other three activity sources, swapping the table,
-- the time column and the owned column.

INSERT INTO default.user_population_daily
    (day, views_state, pageviews_state, reactions_state, useractivities_state,
            generators_state, buyers_state, signups_state)
SELECT
    toDate(time)                          AS day,
    uniqCombinedState(userId)             AS views_state,
    uniqCombinedStateIf(userId, 0)        AS pageviews_state,
    uniqCombinedStateIf(userId, 0)        AS reactions_state,
    uniqCombinedStateIf(userId, 0)        AS useractivities_state,
    uniqCombinedStateIf(userId, 0)        AS generators_state,
    uniqCombinedStateIf(userId, 0)        AS buyers_state,
    uniqExactStateIf(userId, 0)           AS signups_state
FROM default.views
WHERE userId > 0
  AND toYYYYMM(createdDate) = 202409
  -- 🔴 BOUND THE BUCKET COLUMN, NOT JUST THE PARTITION COLUMN. The partition predicate is on
  -- `createdDate`; the bucket is `toDate(time)`. They are DIFFERENT columns, so without the line
  -- below nothing bounds `time` at all and one future-dated row mints a permanent day row in a
  -- table that has NO TTL. This is the same hazard the `<= now()` bound in the job exists for,
  -- and the same one `daily_generation_user_counts` already has (its range reaches 2036-02-07).
  -- Carry both lines into EVERY arm you derive from this one.
  --
  -- The FLOOR is a separate claim from the ceiling and needs its own evidence, because copying it
  -- into an arm whose data starts EARLIER would silently drop real rows into a table with no TTL.
  -- Measured 2026-09-25 — minimum `time` where `userId > 0`, and what this floor would discard:
  --   views 2023-04-27 · pageViews 2024-09-26 · reactions 2023-04-27 · userActivities 2023-04-27
  --   rows dropped by the floor, all four sources: 0
  -- So it is safe for these four and is a sentinel guard, not a date filter. Re-measure before
  -- carrying it to any OTHER source.
  AND time >= toDateTime('2022-01-01 00:00:00') AND time <= now()
GROUP BY day;

-- The `-StateIf(..., 0)` columns build an explicitly EMPTY state, which is the identity under
-- merge, so each arm contributes only its own column. This is deliberate: it makes every arm
-- independent of whatever ClickHouse does with omitted AggregateFunction columns (preflight 2),
-- and it makes the arms uniform enough to generate from one helper in the job.
--
-- Generators — the three guards are byte-identical to pulse panels 15/16/17/21. Do not
-- "clean up" the regex or the cost bound; any drift makes the new panel disagree with the old
-- numbers for a reason nobody will find. Time column is `createdAt`, not `time`, and it is a
-- `DateTime64(3)` — see preflight 1. `toDate()` of a DateTime64 is unambiguous so the daily arm
-- needs no cast; the HOURLY arm does (`toDateTime(toStartOfHour(createdAt))`).
-- The range predicate replaces a partition filter here: this table has no partition key, but
-- `createdAt` is its sort key, so the range still prunes.

INSERT INTO default.user_population_daily
    (day, views_state, pageviews_state, reactions_state, useractivities_state,
            generators_state, buyers_state, signups_state)
SELECT
    toDate(createdAt)                     AS day,
    uniqCombinedStateIf(userId, 0)        AS views_state,
    uniqCombinedStateIf(userId, 0)        AS pageviews_state,
    uniqCombinedStateIf(userId, 0)        AS reactions_state,
    uniqCombinedStateIf(userId, 0)        AS useractivities_state,
    uniqCombinedState(userId)             AS generators_state,
    uniqCombinedStateIf(userId, 0)        AS buyers_state,
    uniqExactStateIf(userId, 0)           AS signups_state
FROM orchestration.jobs
WHERE userId > 0
  AND match(jobType, '^[A-Za-z0-9_-]{2,40}$')
  AND cost BETWEEN 0 AND 1000000
  AND createdAt >= toDateTime('2024-09-01 00:00:00')
  AND createdAt <  toDateTime('2024-10-01 00:00:00')
  AND createdAt <= now()   -- the ceiling the job carries; a future-dated row inside the
                           -- final month's range would otherwise still land. See the views arm.
GROUP BY day;

-- Buyers — guards byte-identical to panels 15/16/21. Counts `toAccountId`, and the time column
-- is `date`. `fromAccountId = 0` plus the description prefix is what distinguishes a real
-- purchase from every other transaction type; keep both. Spelled UNSPACED, matching the
-- panel byte-for-byte — see the same guard in user-population-snapshot.sql.ts.

INSERT INTO default.user_population_daily
    (day, views_state, pageviews_state, reactions_state, useractivities_state,
            generators_state, buyers_state, signups_state)
SELECT
    toDate(date)                          AS day,
    uniqCombinedStateIf(toAccountId, 0)   AS views_state,
    uniqCombinedStateIf(toAccountId, 0)   AS pageviews_state,
    uniqCombinedStateIf(toAccountId, 0)   AS reactions_state,
    uniqCombinedStateIf(toAccountId, 0)   AS useractivities_state,
    uniqCombinedStateIf(toAccountId, 0)   AS generators_state,
    uniqCombinedState(toAccountId)        AS buyers_state,
    uniqExactStateIf(toAccountId, 0)      AS signups_state
FROM default.buzzTransactions
WHERE type='purchase'
  AND fromAccountId=0
  AND description LIKE 'Purchase of %'
  AND date >= toDateTime('2024-09-01 00:00:00')
  AND date <  toDateTime('2024-10-01 00:00:00')
  AND date <= now()
GROUP BY day;

-- Signups — the one arm that leaves ClickHouse (preflight 3). Chunk by month and run off-peak.

INSERT INTO default.user_population_daily
    (day, views_state, pageviews_state, reactions_state, useractivities_state,
            generators_state, buyers_state, signups_state)
SELECT
    toDate(createdAt)                     AS day,
    uniqCombinedStateIf(id, 0)            AS views_state,
    uniqCombinedStateIf(id, 0)            AS pageviews_state,
    uniqCombinedStateIf(id, 0)            AS reactions_state,
    uniqCombinedStateIf(id, 0)            AS useractivities_state,
    uniqCombinedStateIf(id, 0)            AS generators_state,
    uniqCombinedStateIf(id, 0)            AS buyers_state,
    uniqExactState(id)                    AS signups_state
FROM civitai_pg.User
WHERE createdAt >= toDateTime('2024-09-01 00:00:00')
  AND createdAt <  toDateTime('2024-10-01 00:00:00')
  AND createdAt <= now()
GROUP BY day;

-- The HOURLY backfill is the same seven arms with `toStartOfHour(<time col>)` instead of
-- `toDate(...)`, writing to default.user_population_hourly.
--
-- 🔴 SCOPE IT COMFORTABLY INSIDE THE TTL — NOT "the last 90 days", which is the TTL horizon
-- itself. An earlier draft said 90 and that is the hazard preflight (2) above documents: a bucket
-- at or past `now() - 90 DAY` is silently DROPPED on insert, with no error and no row to count.
-- Use ~80 days or less. The loss at exactly 90 is only a bucket or two of about-to-expire hourly
-- detail, so this is coherence rather than damage — but a reader following the old wording gets a
-- window whose first buckets vanish and no signal saying why.
-- Long history belongs in the DAILY table, which has no TTL.
-- Run it AFTER the daily backfill: if it has to be abandoned part-way the daily table still
-- carries the history, and the panels still work.


-- ── Pre-apply validation — MEASURED 2026-09-25, read-only ─────────────────
-- Run against live ClickHouse BEFORE any DDL existed, by stripping each arm's `INSERT INTO`
-- and wrapping the remaining SELECT in a counter. That exercises every column name, guard,
-- bucket expression and state combinator without writing anything.
--
-- The instrument was validated first: an arm with `userId` replaced by a nonexistent column
-- returned `Code: 47 … Missing columns`, so a green result below is a claim about the SQL and
-- not about a probe wired to nothing.
--
--   arm                     buckets     users    time
--   views_state                   4    35,590     0.2s
--   pageviews_state               4    38,917     0.2s
--   reactions_state               4     4,650     0.2s
--   useractivities_state          4     3,957     0.2s
--   generators_state              4     4,437     0.2s
--   buyers_state                  4        77     0.2s
--   signups_state                 4       787     2.2s   <- the Postgres bridge, as expected
--
-- Four buckets from a three-hour window is the designed shape (three whole hours plus the
-- partial current one). ~3.4 s for a whole run, against an hourly period.
--
-- Two properties the whole design rests on, both confirmed rather than assumed:
--
--   -- merge-then-re-emit round-trips, which is what the daily roll does (expect 100 twice)
--   SELECT uniqCombinedMerge(rolled) FROM (
--     SELECT uniqCombinedMergeState(st) AS rolled FROM (
--       SELECT uniqCombinedState(toInt32(number)) AS st FROM numbers(100) GROUP BY number % 7));
--   -- (and the same with uniqExact, for signups_state)
--
--   -- 🔴 IDEMPOTENCY: merging a state with ITSELF does not double (expect 100, NOT 200)
--   SELECT uniqCombinedMerge(st) FROM (
--     SELECT uniqCombinedState(toInt32(number)) AS st FROM numbers(100)
--     UNION ALL SELECT uniqCombinedState(toInt32(number)) AS st FROM numbers(100));
--
-- Both returned exactly 100. That second one is the property that makes re-runs, catch-ups and
-- overlapping backfills safe, so it is worth re-running after any ClickHouse upgrade rather
-- than taking it on trust.

-- ── Verification ──────────────────────────────────────────────────────────
-- 🔴 Reconciliation is the check that matters, and it is the one that can actually fail. Run
-- it against a window the raw tables can still answer, and record the actuals here the way
-- 2026-09-04-user-activity-rollup.sql does — a future re-application is checked against these
-- numbers, not against "it looked right".
--
-- Expect agreement within ~1% on the three uniqCombined populations and EXACT agreement on
-- signups. A gap far larger than that means an arm did not land, which does NOT error — it
-- leaves that population reading low.
--
--   -- new (snapshot)
--   SELECT uniqCombinedMerge(generators_state) FROM default.user_population_daily
--   WHERE day > today() - 30;
--
--   -- old (raw), the exact query panel 21 runs today
--   SELECT uniqExact(userId) FROM orchestration.jobs
--   WHERE createdAt > now() - INTERVAL 30 DAY AND userId > 0
--     AND match(jobType, '^[A-Za-z0-9_-]{2,40}$') AND cost BETWEEN 0 AND 1000000;
--
-- Repeat for views/buyers/signups against their raw forms above.
--
-- Coverage — a hole reads as a dip in the panel, not as an error:
--
--   SELECT min(day), max(day), count() FROM default.user_population_daily;
--   SELECT min(bucket), max(bucket), count() FROM default.user_population_hourly;
--   -- expect count() ≈ 24 × days covered; a short count means missing hours
--
--   -- name the missing days explicitly rather than eyeballing a count
--   SELECT arrayJoin(range(0, 90)) AS n, today() - n AS d
--   FROM numbers(1) WHERE d NOT IN (SELECT day FROM default.user_population_daily);
--
-- Idempotency — the property the whole design rests on. Re-run ONE arm for ONE already-filled
-- bucket and confirm the merged figure is UNCHANGED, not doubled. Do this once, by hand,
-- before trusting any catch-up run:
--
--   SELECT uniqCombinedMerge(views_state) FROM default.user_population_daily WHERE day = today() - 1;
--   -- re-run the views arm for that day, then repeat the SELECT. Same number = idempotent.
--
-- 🔴 A BACKFILL WINDOW MUST START ON AN HOUR BOUNDARY, or the first bucket is silently
-- PARTIAL — it holds only the fraction of the hour after the window opened, and nothing ever
-- repairs it. The job's rolling lookback only re-covers RECENT hours, so a partial bucket at
-- the start of a backfill stays wrong forever, reading as a dip nobody can explain.
--
-- Measured 2026-09-25, and worth reading as a method rather than a fact: a 7-day slice was
-- backfilled with `> now() - INTERVAL 7 DAY` at 03:12, so its first bucket (03:00) was missing
-- 03:00–03:12 — exactly 19 signups. All four populations read ~0.2–0.5% low and that looked
-- exactly like HLL approximation error. It was not. **`signups_state` is uniqExact and
-- therefore CANNOT approximate, so its disagreement was proof the cause was structural.**
-- Dropping the first bucket made signups reconcile EXACTLY, which confirmed it.
--
-- Keep that property in mind when something looks off: the exact column is a built-in control
-- that separates "the sketch is approximating" from "the pipeline lost rows". Do not "simplify"
-- it to uniqCombined for uniformity — that removes the only arm that can tell you which.
--
-- The fix is the same idempotent re-cover the design already promises:
--   ... WHERE <timecol> >= toStartOfHour(now() - INTERVAL 8 DAY)   -- aligned, one day wider
-- Re-covering good buckets is a no-op, so widening is always safe.
--
-- ACTUALS — applied 2026-09-25, 7-day validation slice (the full-history backfill had NOT run
-- at this point; re-record these after it does):
--   tables created     default.user_population_hourly, default.user_population_daily
--                      SharedAggregatingMergeTree, ORDER BY bucket/day, no partition key
--                      hourly TTL present, normalised by ClickHouse to `toIntervalDay(90)`
--                      (⚠️ a regex looking for `INTERVAL 90 DAY` finds nothing and reads as a
--                      MISSING TTL — read `create_table_query`, not a pattern match)
--   hourly rows        1,183  spanning 2026-09-19 03:00 .. 2026-09-26 03:00  (at first measure)
--   ⚠️ RE-MEASURED hours later: 748 rows spanning 2026-09-18 03:00 .. 2026-09-26 03:00 — MORE
--   coverage, FEWER rows. Both figures are correct. The span widened because the repair re-ran the
--   arms one day wider; the count FELL because AggregatingMergeTree collapses a bucket's seven
--   per-arm rows into one as background merges run. So a raw row count is not a coverage measure
--   and drifts downward on its own. Compare DISTINCT BUCKETS, or merged values — never `count()`.
--   daily rows         8      spanning 2026-09-19 .. 2026-09-26
--   backfill cost      7 arms over 7 days: 0.3–1.9 s each, ~5 s total; daily roll 0.8 s
--   per-run cost       ~3.4 s for all 7 arms over the job's 3 h window
--
--   reconciliation, hour-aligned on both sides (7 d):
--     viewers          437,264 vs 437,033 raw    +0.05%   (hour-ALIGNED, post-repair)
--     generators        39,676 vs  39,761 raw    -0.21%
--     buyers             3,408 vs   3,408 raw    EXACT   (cardinality below the sketch's
--                                                         exact-representation threshold)
--     signups           57,249 vs  57,249 raw    EXACT   (uniqExact — must always be exact;
--                                                         if it is not, suspect the pipeline)
--
--   idempotency on real data: re-running the views arm left the merged 7-day figure
--   unchanged at 436,383 (not doubled). ⚠️ That figure is NOT the 437,264 above and does not
--   contradict it: this one is the UNALIGNED `bucket > now() - INTERVAL 7 DAY` read taken
--   BEFORE the partial-first-bucket repair. Two different windows, two different instants.
