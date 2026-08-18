-- Comic view tracking — ClickHouse DDL.
--
-- Apply this MANUALLY, in the order written, BEFORE the app code that emits comic views is
-- deployed. We do not auto-run DDL (same policy as the Postgres migrations).
--
-- What this adds: two arms on each of the `views` Enum8 columns, so `TrackView` on the comic
-- reader can write rows the way every other entity already does.
--
--   type:       'ComicProjectView' = 10, 'ComicChapterView' = 11
--   entityType: 'ComicProject'     = 10, 'ComicChapter'     = 11
--
-- Appending values at unused indexes is a metadata-only ALTER — no data is rewritten and no
-- mutation is scheduled. Do NOT renumber or rename any existing value; that WOULD rewrite
-- 7.6B rows.
--
-- Note that `entityType` is part of the SORTING KEY in both tables — `views` is
-- ORDER BY (time, entityType, entityId, userId), `daily_views` is
-- ORDER BY (entityType, entityId, createdDate). Extending an Enum8 on a key column is permitted
-- as a safe key conversion and appending 10/11 preserves the ordinal ordering of every existing
-- value, so the parts stay sorted and nothing is rewritten. Called out because a reader who
-- assumes these are ordinary non-key columns would not think to check.
--
-- ⚠️ MODIFY COLUMN on an Enum8 REPLACES the type; it does not append to it. Every statement below
-- restates the whole enum, which makes the ordering between separate migrations load-bearing: a
-- later migration that restates the enum WITHOUT these arms silently deletes them and invalidates
-- every row already written with them. Comics hold 10 and 11. Anything adding 12 or beyond must
-- carry 'ComicProject' = 10, 'ComicChapter' = 11 on entityType and 'ComicProjectView' = 10,
-- 'ComicChapterView' = 11 on type, and must be applied after this file.
--
-- No new rollup table. `default.daily_views` is already keyed
-- ORDER BY (entityType, entityId, createdDate), so once it knows the Comic arms a query like
--   SELECT entityId, sum(views) FROM daily_views
--   WHERE entityType = 'ComicProject' AND entityId IN (...) AND createdDate >= ...
-- is a primary-key prefix seek. Chapter rows key on chapterId; the chapter -> project mapping
-- lives in Postgres, where the caller already is.


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 0 — what reads `views`, and what actually breaks
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Seven materialized views read default.views:
--   daily_views_mv, uniqueViewsDaily, user_views, views_images_counts_mv,
--   daily_user_counts_mv, cohorts_first_seen, cohorts_monthly_activity
--
-- Only ONE of them stores an Enum8 and can therefore reject a Comic row:
--   daily_views_mv -> default.daily_views (entityType Enum8)
--
-- The rest are safe and need no DDL:
--   uniqueViewsDaily.type is String, not an enum.
--   user_views / cohorts_* / daily_user_counts_mv store no enum column.
--   views_images_counts_mv filters entityType = 'Image' and stores only (imageId, views).
--   image_views_daily_by_owner reads daily_views, not views, and stores (ownerId, createdDate,
--     views) — no enum column, so it is untouched by any of this.
--
-- Hence the order below: widen the TARGET first, then the SOURCE. Reversed, any comic row
-- inserted in the gap fails the MV push and takes the parent INSERT down with it.


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 0b — read the starting state before touching anything
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Read-only. Because MODIFY COLUMN replaces the enum rather than appending to it, running this
-- file against a state that already differs — someone else's arms already applied, or applied with
-- different names — would delete their values. Print what is actually there first.

SELECT table, name, type
FROM system.columns
WHERE database = 'default'
  AND ((table = 'views' AND name IN ('type', 'entityType'))
    OR (table = 'daily_views' AND name = 'entityType'))
ORDER BY table, name;

-- Expected before this file runs: all three stop at 9 ('BountyEntry' / 'BountyEntryView').
-- If any already carries values past 9, STOP and reconcile — do not run the statements below as
-- written, they would drop whatever is there.


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1 — widen the MV target
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE default.daily_views
  MODIFY COLUMN entityType Enum8(
    'User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6,
    'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9, 'ComicProject' = 10, 'ComicChapter' = 11
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2 — widen the source
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE default.views
  MODIFY COLUMN entityType Enum8(
    'User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5, 'Article' = 6,
    'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9, 'ComicProject' = 10, 'ComicChapter' = 11
  ),
  MODIFY COLUMN type Enum8(
    'ProfileView' = 1, 'ImageView' = 2, 'PostView' = 3, 'ModelView' = 4, 'ModelVersionView' = 5,
    'ArticleView' = 6, 'CollectionView' = 7, 'BountyView' = 8, 'BountyEntryView' = 9,
    'ComicProjectView' = 10, 'ComicChapterView' = 11
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3 — re-derive daily_views_mv's stored structure. NOT optional.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `daily_views_mv` is a TO-table MV whose CREATE restates the entityType Enum8, and neither ALTER
-- above rewrites that stored copy. If the MV converts its SELECT result to its own DECLARED
-- structure rather than re-reading the target's, the first row carrying a new entityType fails the
-- MV push — and a failed MV push fails the INSERT INTO views itself. That is not "comic views
-- don't record", it is every view type on the site failing to record.
--
-- The SELECT below is the existing one restated byte-for-byte. It changes no behaviour and is
-- metadata-only. Run it unconditionally: there is exactly one ClickHouse and no way to test which
-- conversion path is taken without a prod write, so pay the free statement instead of finding out.
--
-- ⚠️ It must run AFTER step 2, not between steps 1 and 2. MODIFY QUERY re-derives the MV's
-- structure from the result types of its SELECT, and that SELECT reads default.views. Run before
-- views is widened and it re-derives the OLD 9-value enum from the un-widened source — pinning in
-- place exactly the stale metadata this step exists to clear.

ALTER TABLE default.daily_views_mv
  MODIFY QUERY
    SELECT entityType, entityId, createdDate, count(*) AS views
    FROM default.views
    GROUP BY 1, 2, 3;


-- ─────────────────────────────────────────────────────────────────────────────
-- Step 4 — verify before deploying the app
-- ─────────────────────────────────────────────────────────────────────────────

-- Both columns should list ComicProject/ComicChapter and ComicProjectView/ComicChapterView:
--   SHOW CREATE TABLE default.views;
--   SHOW CREATE TABLE default.daily_views;

-- End-to-end proof that a comic row survives the MV push. Writes two throwaway rows under
-- entityId 0, which no real project or chapter uses, then reads them back through daily_views:
--
--   INSERT INTO default.views (type, entityType, entityId, browsingLevel)
--   VALUES ('ComicProjectView', 'ComicProject', 0, 1), ('ComicChapterView', 'ComicChapter', 0, 1);
--
--   SELECT entityType, entityId, sum(views) FROM default.daily_views
--   WHERE entityType IN ('ComicProject', 'ComicChapter') AND entityId = 0
--   GROUP BY entityType, entityId;
--
-- Expect two rows. If the INSERT raises instead, step 3 was needed and was skipped.
--
-- The probe rows are harmless — entityId 0 matches no project or chapter. To remove them, note
-- that `daily_views` has NO PARTITION BY: it is a single `tuple()` partition holding ~1.68B rows,
-- so there is nothing partition-scoped to drop and a DROP PARTITION would take the whole table.
-- Use a lightweight delete:
--
--   DELETE FROM default.daily_views
--   WHERE entityType IN ('ComicProject', 'ComicChapter') AND entityId = 0;
--
-- Same applies to clearing a bad backfill run.
--
-- The backfill itself lives in the civitai-scripts repo, at backfill/comic-views.js. It refuses to
-- run until tracking is deployed and a real comic view has landed, so the order is: this file,
-- then deploy, then the backfill.
