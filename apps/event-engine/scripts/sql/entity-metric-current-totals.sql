-- ============================================================================
-- entityMetricCurrentTotals_v2 — point-lookup "current totals" table
-- ============================================================================
--
-- WHY
-- The image feed / SSR hot path looks up the *current total* per
-- (entityType, entityId, metricType) for a small set of entity ids. Today it
-- reads the aggregating VIEW `entityMetricDailyAgg_v2`, which UNIONs the today
-- table (summed) with the history table (argMax-per-day then summed) and
-- GROUP BYs at read time. That view is ~86% of all ClickHouse traffic
-- (~28 q/s) and, while each query is individually cheap (~67ms CPU), the small
-- CH Cloud service (max_threads=6) is saturated so each request queues 2–5s.
--
-- This table holds the already-rolled-up running total per entity/metric so the
-- hot path can do a plain point lookup:
--   SELECT entityId, metricType, total
--   FROM entityMetricCurrentTotals_v2
--   WHERE entityType='Image' AND entityId IN (...) AND metricType IN (...)
-- — no GROUP BY / argMax / UNION at read time.
--
-- SEMANTICS (must stay IDENTICAL to entityMetricDailyAgg_v2)
-- current_total(entityType, entityId, metricType_remapped) =
--     sum over today rows (day >= today()-1)            -- already 1 row/key/day
--   + sum over history of argMax(total, sealedAt) per day (day < today()-1)
-- with the reaction remap multiIf(ReactionLike->Like, ReactionHeart->Heart,
-- ReactionLaugh->Laugh, ReactionCry->Cry, else metricType).
--
-- A naive `sum(total)` over the raw history table is WRONG: history is a
-- SharedReplacingMergeTree(ORDER BY entityType,entityId,metricType,day) deduped
-- on sealedAt, so un-merged rows would be double counted. The argMax(total,
-- sealedAt) GROUP BY day picks the latest sealed value per day, matching the
-- view exactly (validated: 100 sample Image ids -> 0 mismatches vs the view).
--
-- MAINTENANCE — SINGLE TABLE, single refreshable MV (recompute today+history
-- atomically), REFRESH EVERY 1 HOUR.
-- A REFRESHABLE materialized view recomputes the whole table on a schedule and
-- atomically swaps it into the `TO` target (same mechanism the existing
-- `entityMetricDaily_today_v2_mv` / `entityMetricDailySeal_v2_mv` use). The
-- single MV recomputes BOTH the today and history branches in ONE pass under a
-- SINGLE `today()` evaluation — that atomicity is what makes it correct.
--
-- WHY NOT SPLIT INTO TWO STAGGERED TABLES
-- A tempting optimization is to split into two tables — history recomputed once
-- daily, today recomputed every few minutes — UNIONed by a view. A re-audit
-- PROVED this is a correctness regression: the two MVs evaluate `today()` at
-- DIFFERENT refresh times, so around the day rollover the seam day `today()-2`
-- falls in NEITHER table for ~3h/night (e.g. 00:00–03:00) → the view
-- under-counts ~1 full day of metrics on every recently-active entity. The
-- single-table MV avoids the seam entirely because there is exactly one
-- `today()` per recompute. DO NOT re-split without an incremental seal-triggered
-- history MV (see TRADEOFF/FUTURE below).
--
-- TRADEOFF
-- Current totals are up to ~1h stale (the refresh cadence). Acceptable for
-- display counts on the feed/SSR hot path.
--
-- COST
-- REFRESH ... TO does a full recompute: the history side scans ~685M rows
-- (~159s, >8 GiB) once per refresh = 24×/day at 1 HOUR cadence. Still a large
-- net win — flipping the consumer flag to read this point table removes ~28 q/s
-- of expensive `entityMetricDailyAgg_v2` view reads (~86% of CH traffic). The
-- recompute cadence is tunable (raise/lower the REFRESH interval) if 24×/day
-- proves too heavy.
--
-- FUTURE (cheap AND fresh)
-- The path to both low recompute cost AND low staleness is an INCREMENTAL
-- seal-triggered history MV: maintain the history total incrementally as days
-- seal (history changes only once/day at the ~01:00 seal) and keep only the
-- tiny today branch recomputing frequently — without the staggered-today()
-- seam bug above. Left as a follow-up; this single-table hourly full-recompute
-- is the simplest provably-correct version.
--
-- DEPLOY ORDER: run section 1 (table) and 2 (MV) together; the MV starts empty
-- and the first refresh populates it. To populate immediately without waiting
-- for the schedule, run section 3 (one-time backfill) right after creating the
-- table, OR `SYSTEM REFRESH VIEW entityMetricCurrentTotals_v2_mv`.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Target table (point-lookup; SummingMergeTree so any residual same-key
--    rows collapse on merge — the refresh swaps a single row per key anyway).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS default.entityMetricCurrentTotals_v2
(
    `entityType` LowCardinality(String),
    `entityId`   Int32,
    `metricType` LowCardinality(String),  -- post-remap (Like/Heart/Laugh/Cry/...)
    `total`      Int64,
    `refreshedAt` DateTime DEFAULT now()
)
ENGINE = SummingMergeTree(total)
ORDER BY (entityType, entityId, metricType)
SETTINGS index_granularity = 8192;


-- ---------------------------------------------------------------------------
-- 2. Refreshable materialized view — full recompute, atomic swap into the table.
--    The SELECT is byte-for-byte the same semantics as entityMetricDailyAgg_v2,
--    minus the day dimension (rolled up to a single current total per key).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS default.entityMetricCurrentTotals_v2_mv
REFRESH EVERY 1 HOUR OFFSET 1 MINUTE
TO default.entityMetricCurrentTotals_v2
(
    `entityType` LowCardinality(String),
    `entityId`   Int32,
    `metricType` LowCardinality(String),
    `total`      Int64,
    `refreshedAt` DateTime
)
DEFINER = default SQL SECURITY DEFINER
AS
SELECT
    entityType,
    entityId,
    metricType,
    sum(total) AS total,
    now() AS refreshedAt
FROM
(
    -- Branch A: today (day >= today()-1), already 1 row per key/day.
    SELECT
        entityType,
        entityId,
        multiIf(metricType = 'ReactionLike', 'Like', metricType = 'ReactionHeart', 'Heart', metricType = 'ReactionLaugh', 'Laugh', metricType = 'ReactionCry', 'Cry', metricType) AS metricType,
        total
    FROM default.entityMetricDailyAgg_today_v2
    WHERE day >= (today() - 1)

    UNION ALL

    -- Branch B: history (day < today()-1), argMax(total, sealedAt) per day.
    SELECT
        entityType,
        entityId,
        multiIf(metricType = 'ReactionLike', 'Like', metricType = 'ReactionHeart', 'Heart', metricType = 'ReactionLaugh', 'Laugh', metricType = 'ReactionCry', 'Cry', metricType) AS metricType,
        t AS total
    FROM
    (
        SELECT
            entityType,
            entityId,
            metricType,
            day,
            argMax(total, sealedAt) AS t
        FROM default.entityMetricDailyAgg_history_v2
        WHERE day < (today() - 1)
        GROUP BY
            entityType,
            entityId,
            metricType,
            day
    )
)
GROUP BY
    entityType,
    entityId,
    metricType
SETTINGS max_bytes_before_external_group_by = 6000000000;


-- ---------------------------------------------------------------------------
-- 3. ONE-TIME BACKFILL (optional — REFRESH does the same thing, but run this to
--    populate immediately on create). Same SELECT as the MV body. Heavy: scans
--    the full ~690M-row history table. HUMAN-GATED — see runbook in PR body.
--    Run inside a single INSERT; do NOT chunk by entityId (the history argMax
--    is per (key, day) and is correct over the full set).
-- ---------------------------------------------------------------------------
-- INSERT INTO default.entityMetricCurrentTotals_v2 (entityType, entityId, metricType, total, refreshedAt)
-- SELECT
--     entityType,
--     entityId,
--     metricType,
--     sum(total) AS total,
--     now() AS refreshedAt
-- FROM
-- (
--     SELECT
--         entityType,
--         entityId,
--         multiIf(metricType = 'ReactionLike', 'Like', metricType = 'ReactionHeart', 'Heart', metricType = 'ReactionLaugh', 'Laugh', metricType = 'ReactionCry', 'Cry', metricType) AS metricType,
--         total
--     FROM default.entityMetricDailyAgg_today_v2
--     WHERE day >= (today() - 1)
--     UNION ALL
--     SELECT
--         entityType,
--         entityId,
--         multiIf(metricType = 'ReactionLike', 'Like', metricType = 'ReactionHeart', 'Heart', metricType = 'ReactionLaugh', 'Laugh', metricType = 'ReactionCry', 'Cry', metricType) AS metricType,
--         t AS total
--     FROM
--     (
--         SELECT entityType, entityId, metricType, day, argMax(total, sealedAt) AS t
--         FROM default.entityMetricDailyAgg_history_v2
--         WHERE day < (today() - 1)
--         GROUP BY entityType, entityId, metricType, day
--     )
-- )
-- GROUP BY entityType, entityId, metricType
-- SETTINGS max_bytes_before_external_group_by = 6000000000;


-- ---------------------------------------------------------------------------
-- 4. TEARDOWN (rollback)
-- ---------------------------------------------------------------------------
-- DROP VIEW IF EXISTS default.entityMetricCurrentTotals_v2_mv;
-- DROP TABLE IF EXISTS default.entityMetricCurrentTotals_v2;
