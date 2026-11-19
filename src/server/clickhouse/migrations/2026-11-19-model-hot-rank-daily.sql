-- Nightly Hot rank snapshot per model — ClickHouse DDL.
--
-- Apply MANUALLY, before turning on the `model-hot-rank-snapshot` Flipt flag. Writer:
-- src/server/jobs/model-hot-rank-snapshot.ts (once a night, 04:20 UTC). Nothing reads these tables
-- in the app; they exist to measure a model's Hot rank over time.
--
-- Rank is the position in ORDER BY hotScore DESC, modelId over every model the Hot feed can show
-- (Published, not Private, not Archived or TakenDown), BEFORE any per-viewer filter. A model with
-- no score yet ranks first with a NULL hotScore, because the feed shows it there. A viewer's rank
-- is re-derived at read time from the stored flags (example below). The default browsing add-ons'
-- excluded tags are not stored, so such a rank is an approximation of the live feed.
--
-- paid: has a live gate on a Published version (paidAccessLiveSql). paidPermanent: one of those gates
-- has no timeframe. hidePaidKeeps: the browse feed's Hide Paid still shows the model (it has a free
-- Public Published version, or no live gate). These cannot be rebuilt for past days.
--
-- ⚠️ The table carries per-model poi and minor flags. Never put it behind a public Metabase link or
-- a public dashboard.
--
-- Retention: 400 days, dropped a whole day-partition at a time.

CREATE TABLE IF NOT EXISTS default.model_hot_rank_daily
(
    `day`                 Date,
    `modelId`             Int32,
    `rank`                UInt32,
    `hotScore`            Nullable(Int32),
    `nsfwLevel`           UInt16,
    `availability`        LowCardinality(String),
    `poi`                 UInt8,
    `minor`               UInt8,
    `paid`                UInt8,
    `paidPermanent`       UInt8,
    `hidePaidKeeps`       UInt8
)
ENGINE = MergeTree
PARTITION BY day
ORDER BY (day, rank)
TTL day + INTERVAL 400 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Same structure, partition key and sort key as the daily table, which REPLACE PARTITION requires.
-- The job empties its partition after each swap; the TTL is only a backstop.
CREATE TABLE IF NOT EXISTS default.model_hot_rank_staging AS default.model_hot_rank_daily;

-- A day counts only if it has a row here; the job writes it last, after the swap.
CREATE TABLE IF NOT EXISTS default.model_hot_rank_runs
(
    `day`         Date,
    `rows`        UInt32,
    `completedAt` DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY day
TTL day + INTERVAL 400 DAY;

-- ── Apply checks ──────────────────────────────────────────────────────────
-- 1. Before the real CREATEs, create both MergeTree tables under scratch names, insert one row into
--    the scratch staging table, run REPLACE PARTITION into the scratch daily table, confirm the row
--    moved, then DROP both. This proves REPLACE PARTITION works on this cluster's engine.
-- 2. After the CREATEs, read create_table_query from system.tables: ClickHouse normalises the TTL to
--    toIntervalDay(400), so a text search for "INTERVAL 400 DAY" finds nothing.

-- ── Reading it ────────────────────────────────────────────────────────────
-- Complete days only:
--   SELECT d.* FROM default.model_hot_rank_daily d
--   WHERE d.day IN (SELECT day FROM default.model_hot_rank_runs);
--
-- One model's rank over time:
--   SELECT day, rank, hotScore FROM default.model_hot_rank_daily
--   WHERE modelId = {modelId:Int32} AND day IN (SELECT day FROM default.model_hot_rank_runs)
--   ORDER BY day;
--
-- An anonymous default viewer's rank (browsing level as a bitmask; poi hidden):
--   SELECT day, modelId,
--          row_number() OVER (PARTITION BY day ORDER BY rank) AS viewerRank
--   FROM default.model_hot_rank_daily
--   WHERE bitAnd(nsfwLevel, {browsingLevel:UInt16}) != 0 AND poi = 0
--     AND day IN (SELECT day FROM default.model_hot_rank_runs);
--
-- Missed nights in the last 30 days (a missed night cannot be backfilled):
--   SELECT today() - number AS d FROM numbers(30)
--   WHERE d NOT IN (SELECT day FROM default.model_hot_rank_runs);
--
-- ── Before arming the flag ──────────────────────────────────────────────
-- Time the job's statement (hotRankSnapshotSql) with EXPLAIN (ANALYZE, BUFFERS) on the replica; it
-- must stay well inside the job's 60 s read timeout. The measured figures are in the PR that added
-- this file.

-- ── Actuals ───────────────────────────────────────────────────────────────
-- Not yet applied. After night one, record counts and overlap rates in the PR or the plan; no
-- model ids.
