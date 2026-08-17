-- Model3D view tracking — ClickHouse enum widening.
--
-- ✅ APPLIED TO PRODUCTION 2026-08-17, after the comics DDL. Kept as the record of
-- what ran. Verified afterwards: all three columns and the MV's own declared
-- header carry twelve arms, and a write probe confirmed a row survives the MV push
-- (one row into `views`, out of `daily_views` as exactly 1, then removed).
-- Re-running it is a no-op, but there is no reason to.
--
-- APPLY EVERY STEP BELOW BEFORE DEPLOYING THE CODE THAT EMITS Model3DView, and run
-- steps 1-3 back to back without a pause. Between step 2 and step 3, `views`
-- accepts a Model3D row while `daily_views_mv`'s declared header still holds
-- nine arms — and if the MV push converts to its own header (the reason step 3
-- exists), that push fails. Every view type on the site shares that insert path,
-- and the client is configured `wait_for_async_insert: 0`, so the failure
-- surfaces in Axiom and nowhere a human is looking.
--
-- APPLY ORDER ACROSS THE THREE TRACKING PRs:
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
-- Appending is metadata-only ONLY because every existing name→index pair is
-- preserved. `entityType` is a sorting-key column in both tables, so renumbering
-- or dropping an arm turns this from a metadata change into a rewrite of 1.68B
-- `daily_views` rows and the whole of `views`.

-- === Step 0: confirm the starting state (read-only) =========================
-- EXPECTED: all three types end at 'BountyEntry' = 9 / 'BountyEntryView' = 9 if
-- Scarlet's file has not run yet, or at 'ComicChapter' = 11 /
-- 'ComicChapterView' = 11 if it has. Anything carrying an arm past 11 means a
-- migration this file does not know about has claimed indexes — STOP and
-- reconcile, because the statements below would overwrite it.
SELECT table, name, type FROM system.columns
WHERE database = 'default'
  AND ((table = 'views' AND name IN ('type', 'entityType'))
    OR (table = 'daily_views' AND name = 'entityType'))
ORDER BY table, name;

-- === Step 1: widen the MV target BEFORE the source ==========================
-- `daily_views` is the sole materialized-view target carrying an Enum8. If
-- `views` were widened first, the first Model3D row would reach a target that
-- cannot represent it.
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
-- own copy of the Enum8, which steps 1 and 2 do not rewrite.
--
-- MODIFY QUERY re-derives that stored structure from the RESULT TYPES OF ITS
-- SELECT, and the SELECT reads `default.views`. Running it before step 2 would
-- re-derive the old nine-value enum off the un-widened source, pinning in place
-- exactly the stale metadata this step exists to clear — and doing so in a way
-- that looks handled. It must come last.
ALTER TABLE default.daily_views_mv
  MODIFY QUERY
    SELECT entityType, entityId, createdDate, count(*) AS views
    FROM default.views
    GROUP BY 1, 2, 3;

-- === Step 4: verify (read-only) =============================================
-- Expect three rows, each carrying 'Model3D' = 12 / 'Model3DView' = 12 AND still
-- carrying Scarlet's 10 and 11.
SELECT table, name, type FROM system.columns
WHERE database = 'default'
  AND ((table = 'views' AND name IN ('type', 'entityType'))
    OR (table = 'daily_views' AND name = 'entityType'))
ORDER BY table, name;

-- Confirms step 3 landed: the MV's own declared entityType must show twelve arms
-- too, not nine.
SELECT create_table_query FROM system.tables
WHERE database = 'default' AND name = 'daily_views_mv';
