-- Per-user last-seen + last-known country rollup — ClickHouse DDL.
--
-- Apply this MANUALLY, in the order written, BEFORE deploying the `user-activity-rollup` job
-- (src/server/jobs/user-activity-rollup.ts) or the Creator Studio audience panels that read it.
-- We do not auto-run DDL (same policy as the Postgres migrations).
--
-- ── What this is for ──────────────────────────────────────────────────────
-- Creator Studio needs two things about a creator's FOLLOWER SET: what share of it is still
-- active (30/60/100 days), and roughly where it is. Both are a per-user lookup over an id list
-- pulled from Postgres — up to 53,304 ids for the platform's most-followed creator.
--
-- Answering that from the source tables directly is not affordable. `pageViews` is 4.55B rows
-- sorted by `(time, pageId, userId)`, so a follower-id filter cannot skip granules: measured
-- 2026-09-04, one 10,000-id chunk over a 100-day window read **5.59 GiB in 2.19 s**, and a 53k
-- id list needs six such chunks (the list also blows ClickHouse's 256 KB `max_query_size`, so
-- chunking is forced regardless). That is ~33 GiB per creator per cache miss, on a panel that
-- renders for every creator who opens the page.
--
-- Against this table the same probe is a primary-key seek. Proxy-measured on `user_views`
-- (11.2M rows, also ORDER BY userId): 20,000 ids in ~0.5 s.
--
-- ── Why a scheduled job and not an incremental MV ─────────────────────────
-- An incremental MV would have to hang off four tables, two of which (`views`, `pageViews`) are
-- among the hottest ingest paths on the platform, to keep a number whose smallest bucket is 30
-- days. The staleness budget is hours, so the cost belongs on a cron, not on every insert.
--
-- ── Why re-running the job is safe, and why that is not automatic ─────────
-- The merge semantics here are `max` and `argMax`, both idempotent: inserting the same source
-- rows twice yields the same merged state. So the job re-scans an overlapping window each run
-- and needs no watermark, and a catch-up after a missed run cannot double anything.
--
-- That is a property of THIS engine choice, not of rollups in general. The two
-- `SharedSummingMergeTree` targets described in src/server/jobs/clickhouse-refresh-monitor.ts
-- silently double when their refresh is re-run. Do not change this table to Summing, and do not
-- add a `count`-shaped column to it — a counter here would carry exactly that hazard while
-- looking like the columns beside it.
--
-- ── Reading it ────────────────────────────────────────────────────────────
-- Rows are partial states until a merge, so a read MUST aggregate:
--
--   SELECT userId, max(lastSeen) AS lastSeen, argMaxMerge(country) AS country
--   FROM default.user_activity_rollup
--   WHERE userId IN (...)
--   GROUP BY userId
--
-- Selecting `country` without `argMaxMerge` returns an unreadable state blob, not a country.

CREATE TABLE IF NOT EXISTS default.user_activity_rollup
(
    `userId`   Int32,
    -- Newest activity across all four sources below.
    `lastSeen` SimpleAggregateFunction(max, DateTime),
    -- Country at the user's most recent `pageViews` row. `String`, not `LowCardinality(String)`:
    -- the aggregate state is the storage here and the dictionary buys nothing inside one.
    -- Sources other than `pageViews` carry no country and insert a state stamped at the epoch, so
    -- they can never win the argMax; a user with no pageView ever merges to '' — read as Unknown.
    `country`  AggregateFunction(argMax, String, DateTime)
)
ENGINE = SharedAggregatingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY userId
SETTINGS index_granularity = 8192;


-- ── Backfill ──────────────────────────────────────────────────────────────
-- Run once, after the CREATE. Order against enabling the JOB does not matter (its window overlaps),
-- but order against DEPLOYING THE APP does: a created-but-empty table answers every query with zeros
-- rather than erroring, and "0.0% active" is a number a creator will believe. `assertRollupUsable` in
-- apps/creator-studio/src/lib/server/follower-reach.ts refuses an empty or 12-hour-stale table for
-- exactly that reason, so the panel reads "temporarily unavailable" instead — but do not lean on it.
-- Finish the backfill.
--
-- Run the `pageViews` arm ONE PARTITION AT A TIME. The unpartitioned form groups 7.36M users
-- over 4.55B rows in a single pass; partitioning bounds peak memory, and because the merge is
-- `max`/`argMax` the partial results combine to exactly the same answer. `pageViews` is
-- PARTITION BY toYYYYMM(time) and spans 2024-09 through the current month.
--
-- Repeat for every value returned by the query below, substituting it for the 202409 literal:
--   SELECT DISTINCT toYYYYMM(time) AS p FROM default.pageViews ORDER BY p;
--
-- One partition measured 2026-09-04: 1.8 s for 902,986 users (2026-08). Twenty-four of them.

INSERT INTO default.user_activity_rollup
SELECT
    userId,
    max(time) AS lastSeen,
    argMaxState(CAST(country AS String), time) AS country
FROM default.pageViews
WHERE userId > 0
  AND toYYYYMM(time) = 202409
GROUP BY userId;

-- The other three sources carry no country, so each stamps a losing state at the epoch. Run each
-- whole — `views` is the biggest table here (7.78B rows / 116 GiB, larger than `pageViews`), but the
-- grouping state is one DateTime plus a constant argMax rather than a per-group country, so it holds:
-- measured 2026-09-04, `views` whole took 78 s for 9,493,900 users and `reactions` 3 s for 1,381,562.
-- Only the `pageViews` arm above needs partitioning, and its size is not the reason — its state is.
--
-- ⚠️ If you do decide to partition one of these anyway, do NOT copy the `toYYYYMM(time)` predicate from
-- the arm above. These three partition by `createdDate`, not `time` — `views` and `reactions` on
-- `toYYYYMM(createdDate)`, `userActivities` on `toYear(createdDate)` — so the `time` form prunes nothing
-- and you get a full scan per "partition", once per partition.
--
-- `userActivities` matters more than its row count suggests: it carries `Login`, which is the
-- only signal for someone whose activity is API/generation traffic that fires no pageview.
-- Measured over 30 days, 2026-09-04 — distinct users per source, and the union:
--   pageViews 886,856 · views 831,634 · reactions 97,032 · userActivities 643,188 · union 953,416
-- i.e. the three extra sources add 66,560 users (+7.5%) that `pageViews` alone calls dormant.

INSERT INTO default.user_activity_rollup
SELECT userId, max(time) AS lastSeen, argMaxState(CAST('' AS String), toDateTime(0)) AS country
FROM default.views
WHERE userId > 0
GROUP BY userId;

INSERT INTO default.user_activity_rollup
SELECT userId, max(time) AS lastSeen, argMaxState(CAST('' AS String), toDateTime(0)) AS country
FROM default.reactions
WHERE userId > 0
GROUP BY userId;

INSERT INTO default.user_activity_rollup
SELECT userId, max(time) AS lastSeen, argMaxState(CAST('' AS String), toDateTime(0)) AS country
FROM default.userActivities
WHERE userId > 0
GROUP BY userId;


-- ── Verification ──────────────────────────────────────────────────────────
-- Applied 2026-09-04 (246 s end to end; `views` was 109 s of it). Actuals, which are the numbers to
-- check a re-application against:
--
--   distinct users   10,719,260
--   no country        3,361,661   — accounts with no pageView since 2024-09-26
--   with a country    7,357,599
--
-- That last figure is the arm-by-arm correctness check, not a coincidence: `pageViews` held 7,356,496
-- distinct users when measured a few hours earlier, and only `pageViews` can set a country. A total far
-- from these means an arm did not land — which does NOT error, it just leaves those users reading as
-- dormant with an unknown country. Re-run; every statement is idempotent.
--
-- The 31% platform-wide unknown rate is not the rate a creator sees. Follower sets are far more engaged:
-- a 15,000-follower sample of the most-followed creator came back 86.2% with a country.
--
--   SELECT uniqExact(userId) FROM default.user_activity_rollup;
--
--   SELECT country, count() FROM (
--     SELECT userId, argMaxMerge(country) AS country
--     FROM default.user_activity_rollup GROUP BY userId
--   ) GROUP BY country ORDER BY count() DESC LIMIT 20;
