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
-- range, per load, per viewer. Panels 15/16/17 repeat the same shape.
--
-- Two problems, and only one of them is cost:
--   1. Every load pays a full window re-scan of three of the busiest tables on the cluster.
--   2. There is no HISTORY. The panels can only ever show the population as of NOW over a
--      trailing window. "Was DAU lower last March?" is not a question the current dashboards
--      can be asked at all.
--
-- These two tables fix both: the job writes one row per hour, and every panel reads merged
-- pre-aggregated state instead of raw rows.
--
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

-- ── Preflight — settle these THREE before applying ────────────────────────
-- None is a guess to be discovered at 3am; each has a one-command answer, and each changes
-- the file below if it comes back the other way.
--
-- (1) Is `orchestration.jobs` ORDER BY `createdAt` first? The whole per-run cost model assumes
--     every arm is a primary-key range scan, which is what
--     2026-09-04-user-activity-rollup.sql verified for the four `default.*` activity sources
--     ("All four are ORDER BY time first (checked in `system.tables`, 2026-09-04)").
--     `orchestration.jobs` is in a different database and was NOT part of that check, and this
--     repo does not carry its DDL. If it does not sort by `createdAt` first, the generators arm
--     is a table-wide scan every hour and needs its own approach.
--       SELECT database, table, sorting_key FROM system.tables
--       WHERE (database, table) IN (('orchestration','jobs'), ('default','buzzTransactions'),
--                                   ('default','views'), ('default','pageViews'),
--                                   ('default','reactions'), ('default','userActivities'));
--     (`default.buzzTransactions` is already known good — ORDER BY (date, fromAccountId,
--     toAccountId), and `date` is a DateTime, not a Date, so hourly bucketing of buyers is
--     possible at all. Both read out of containers/clickhouse/docker-init/init.sh.)
--
-- (2) Does an INSERT naming a COLUMN SUBSET fill the omitted AggregateFunction columns with
--     EMPTY states? The arms below do not rely on it — each writes all seven columns, using
--     `-StateIf(..., 0)` to build an explicitly empty state for the six it does not own — so
--     this is an optimisation, not a blocker. Verify before simplifying them:
--       INSERT INTO default.user_population_hourly (bucket, views_state)
--         SELECT toDateTime('2000-01-01 00:00:00'), uniqCombinedState(toInt32(1));
--       SELECT uniqCombinedMerge(generators_state) FROM default.user_population_hourly
--         WHERE bucket = toDateTime('2000-01-01 00:00:00');   -- expect 0, not an error
--       ALTER TABLE default.user_population_hourly DELETE WHERE bucket = toDateTime('2000-01-01 00:00:00');
--
-- (3) How heavy is the `civitai_pg.User` arm? It is the only arm that leaves ClickHouse — it
--     reads the production Postgres through the bridge. Per-hour it is a narrow `createdAt`
--     range and fine; the FULL-HISTORY daily backfill is a scan of the whole User table and is
--     the one step in this file that puts load on the main civitai database. Chunk it by month
--     (the backfill below already does) and run it off-peak.
--       SELECT count() FROM civitai_pg.User;

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


-- ── Reading these tables ──────────────────────────────────────────────────
-- Rows are PARTIAL STATES until a background merge, so a read MUST aggregate. Selecting a
-- `*_state` column directly returns an unreadable blob, not a number — the same trap
-- 2026-09-04-user-activity-rollup.sql calls out for `argMaxMerge(country)`.
--
-- Panel 21's funnel, re-pointed (the $window variable keeps its current meaning):
--
--   SELECT stage, users FROM (
--     SELECT 1 AS ord, 'Logged-in viewers' AS stage, uniqCombinedMerge(views_state) AS users
--       FROM default.user_population_hourly WHERE bucket > now() - INTERVAL $window DAY
--     UNION ALL
--     SELECT 2, 'Generators', uniqCombinedMerge(generators_state)
--       FROM default.user_population_hourly WHERE bucket > now() - INTERVAL $window DAY
--     UNION ALL
--     SELECT 3, 'Buzz buyers', uniqCombinedMerge(buyers_state)
--       FROM default.user_population_hourly WHERE bucket > now() - INTERVAL $window DAY
--   ) ORDER BY ord;
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
-- silently gives you a full scan per "partition" — the 2026-09-04 file flags the same trap:
--   default.views, default.reactions   PARTITION BY toYYYYMM(createdDate)
--   default.pageViews                  PARTITION BY toYYYYMM(time)
--   default.userActivities             PARTITION BY toYear(createdDate)
-- Confirm against system.tables.partition_key before running, do not trust this list:
--   SELECT table, partition_key FROM system.tables WHERE database = 'default'
--     AND table IN ('views','pageViews','reactions','userActivities');
--
-- Example — the `views` arm of the DAILY backfill, one month. Repeat for every value of
--   SELECT DISTINCT toYYYYMM(createdDate) AS p FROM default.views ORDER BY p;
-- and then structurally the same for the other three activity sources, swapping the table,
-- the time column and the owned column.

INSERT INTO default.user_population_daily
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
GROUP BY day;

-- The `-StateIf(..., 0)` columns build an explicitly EMPTY state, which is the identity under
-- merge, so each arm contributes only its own column. This is deliberate: it makes every arm
-- independent of whatever ClickHouse does with omitted AggregateFunction columns (preflight 2),
-- and it makes the arms uniform enough to generate from one helper in the job.
--
-- Generators — the three guards are byte-identical to pulse panels 15/16/17/21. Do not
-- "clean up" the regex or the cost bound; any drift makes the new panel disagree with the old
-- numbers for a reason nobody will find. Time column is `createdAt`, not `time`.

INSERT INTO default.user_population_daily
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
GROUP BY day;

-- Buyers — guards byte-identical to panels 15/16/21. Counts `toAccountId`, and the time column
-- is `date`. `fromAccountId = 0` plus the description prefix is what distinguishes a real
-- purchase from every other transaction type; keep both.

INSERT INTO default.user_population_daily
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
WHERE type = 'purchase'
  AND fromAccountId = 0
  AND description LIKE 'Purchase of %'
  AND date >= toDateTime('2024-09-01 00:00:00')
  AND date <  toDateTime('2024-10-01 00:00:00')
GROUP BY day;

-- Signups — the one arm that leaves ClickHouse (preflight 3). Chunk by month and run off-peak.

INSERT INTO default.user_population_daily
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
GROUP BY day;

-- The HOURLY backfill is the same seven arms with `toStartOfHour(<time col>)` instead of
-- `toDate(...)`, writing to default.user_population_hourly, restricted to the last 90 days.
-- Run it AFTER the daily backfill: if it has to be abandoned part-way the daily table still
-- carries the history, and the panels still work.


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
-- ACTUALS (fill in at apply time — leaving these blank makes the section decorative):
--   applied            <date>
--   daily rows         <n>      spanning <first> .. <last>
--   hourly rows        <n>      spanning <first> .. <last>
--   generators 30d     snapshot <n>  vs raw <n>  (<pct>% delta)
--   viewers 30d        snapshot <n>  vs raw <n>  (<pct>% delta)
--   buyers 30d         snapshot <n>  vs raw <n>  (<pct>% delta)
--   signups 30d        snapshot <n>  vs raw <n>  (expect EXACT)
