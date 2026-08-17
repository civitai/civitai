-- Model3D view tracking — ClickHouse enum widening.
--
-- APPLY ORDER (across the three tracking PRs):
--   1. Scarlet's comics DDL FIRST (src/server/clickhouse/migrations/2026-08-17-comic-views.sql
--      on feat/comic-view-tracking, PR #3993) — it takes enum indexes 10 and 11.
--   2. Then this file. It takes index 12.
--
-- `ALTER TABLE ... MODIFY COLUMN` on an Enum8 REPLACES the whole type, it does
-- not append to it. So every statement below restates all twelve arms,
-- including Scarlet's 10 and 11. Applying a version of this file that omits her
-- arms AFTER hers would silently delete 'ComicProject'/'ComicChapter' and
-- invalidate any row already written with them.
--
-- Three columns carry an affected enum, not one: `views.entityType`,
-- `views.type`, and `daily_views.entityType` (a separate enum on a separate
-- table). All three are restated below.
--
-- ⚠️ Step 0 is not optional. Run it and confirm the current types match what
-- this file expects before running anything else.
--
-- Appending enum values is metadata-only on both tables: no data rewrite, no
-- part mutation, no downtime.

-- === Step 0: confirm current state (read-only, run before anything else) =====
SELECT table, name, type FROM system.columns
WHERE database = 'default'
  AND ((table = 'views' AND name IN ('type', 'entityType'))
    OR (table = 'daily_views' AND name = 'entityType'))
ORDER BY table, name;

-- === Step 1: widen the MV target BEFORE the source ==========================
-- `daily_views` is the sole materialized-view target carrying an Enum8 (verified
-- against the other six MVs reading `views`: uniqueViewsDaily stores `type` as
-- String, user_views/views_images_counts_mv compare the enum but store neither,
-- and cohorts_first_seen/cohorts_monthly_activity/daily_user_counts_mv never
-- reference it). If `views` were widened first, the first Model3D row would
-- reach a target that cannot represent it.
ALTER TABLE default.daily_views
  MODIFY COLUMN entityType Enum8(
    'User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5,
    'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9,
    'ComicProject' = 10, 'ComicChapter' = 11, 'Model3D' = 12
  );

-- === Step 2: widen the source table =========================================
ALTER TABLE default.views
  MODIFY COLUMN entityType Enum8(
    'User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5,
    'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9,
    'ComicProject' = 10, 'ComicChapter' = 11, 'Model3D' = 12
  );

ALTER TABLE default.views
  MODIFY COLUMN type Enum8(
    'ProfileView' = 1, 'ImageView' = 2, 'PostView' = 3, 'ModelView' = 4,
    'ModelVersionView' = 5, 'ArticleView' = 6, 'CollectionView' = 7,
    'BountyView' = 8, 'BountyEntryView' = 9,
    'ComicProjectView' = 10, 'ComicChapterView' = 11, 'Model3DView' = 12
  );

-- === Step 3: re-resolve the MV's own stored structure — AFTER steps 1 AND 2 ==
-- `daily_views_mv` is a TO-materialized-view whose CREATE statement declares its
-- own copy of the Enum8. Steps 1 and 2 do not rewrite that metadata, and if the
-- MV converts pushed blocks to its declared structure rather than re-reading the
-- target's, a Model3D row would fail the MV push — failing the insert into
-- `views` for every view type, not just this one.
--
-- MODIFY QUERY re-derives the stored structure from the RESULT TYPES OF ITS
-- SELECT, and that SELECT reads `default.views`. Running it before step 2 would
-- re-derive the old nine-value enum off the un-widened source, pinning in place
-- exactly the stale metadata this step exists to clear — and doing so in a way
-- that looks handled. It must come last. (Caught by @scarlet; I had it between
-- steps 1 and 2.)
--
-- The SELECT is the existing one restated byte-for-byte: this changes no
-- behaviour, only the declared structure. Metadata-only.
ALTER TABLE default.daily_views_mv
  MODIFY QUERY
    SELECT entityType, entityId, createdDate, count(*) AS views
    FROM default.views
    GROUP BY 1, 2, 3;

-- === Step 4: verify (read-only) =============================================
-- Expect three rows, each type ending in 'Model3D' = 12 / 'Model3DView' = 12 AND
-- still carrying Scarlet's 10 and 11.
SELECT table, name, type FROM system.columns
WHERE database = 'default'
  AND ((table = 'views' AND name IN ('type', 'entityType'))
    OR (table = 'daily_views' AND name = 'entityType'))
ORDER BY table, name;

-- Confirms step 3 landed: the MV's own declared entityType must show twelve arms
-- too, not nine.
SELECT create_table_query FROM system.tables
WHERE database = 'default' AND name = 'daily_views_mv';
