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
-- Step 3 — CHECK, then conditionally re-derive daily_views_mv
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `daily_views_mv` is a TO-table MV declared with an explicit column list that embeds the old
-- 9-value Enum8. Whether steps 1-2 alone refresh that stored structure is version-dependent, so
-- verify rather than assume. Run:
--
--   SHOW CREATE TABLE default.daily_views_mv;
--
-- If the printed `entityType` still stops at 'BountyEntry' = 9, run the MODIFY QUERY below,
-- which re-derives the MV's structure from the (now widened) source. If it already shows
-- 'ComicChapter' = 11, skip it — MODIFY QUERY is a no-op here but there is no reason to run it.

-- ALTER TABLE default.daily_views_mv
--   MODIFY QUERY
--     SELECT entityType, entityId, createdDate, count(*) AS views
--     FROM default.views
--     GROUP BY 1, 2, 3;


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
-- The probe rows are harmless (entityId 0 matches nothing) but can be dropped with a
-- partition-scoped DELETE if you'd rather not leave them.
