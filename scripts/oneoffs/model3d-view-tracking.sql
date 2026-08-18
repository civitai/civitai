-- Model3D view tracking — ClickHouse enum widening. APPLIED TO PRODUCTION
-- 2026-08-17, after the comics DDL. Kept as the record of what ran.
--
-- `MODIFY COLUMN` on an Enum8 REPLACES the type rather than appending, which is
-- why every statement restates all twelve arms including comics' 10 and 11.
-- Dropping an arm invalidates rows already written with it, and renumbering one
-- turns this from a metadata change into a rewrite of 1.68B `daily_views` rows —
-- `entityType` is a sorting key in both tables.
--
-- Order matters twice over: `daily_views` before `views`, so no row can reach a
-- target that cannot represent it; and `daily_views_mv` LAST, because MODIFY
-- QUERY re-derives the MV's stored header from its SELECT's result types, and
-- that SELECT reads `views`.

-- Step 0 — expect all three to end at 'ComicChapter' = 11 / 'ComicChapterView' = 11.
-- Anything past 11 means another migration claimed indexes: STOP.
SELECT table, name, type FROM system.columns
WHERE database = 'default'
  AND ((table = 'views' AND name IN ('type', 'entityType'))
    OR (table = 'daily_views' AND name = 'entityType'))
ORDER BY table, name;

-- Step 1 — MV target first.
ALTER TABLE default.daily_views
  MODIFY COLUMN entityType Enum8(
    'User' = 1, 'Image' = 2, 'Post' = 3, 'Model' = 4, 'ModelVersion' = 5,
    'Article' = 6, 'Collection' = 7, 'Bounty' = 8, 'BountyEntry' = 9,
    'ComicProject' = 10, 'ComicChapter' = 11, 'Model3D' = 12
  );

-- Step 2 — source table.
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

-- Step 3 — MV header, last. SELECT restated unchanged.
ALTER TABLE default.daily_views_mv
  MODIFY QUERY
    SELECT entityType, entityId, createdDate, count(*) AS views
    FROM default.views
    GROUP BY 1, 2, 3;

-- Step 4 — verify. Expect twelve arms on all three columns and on the MV's own header.
SELECT table, name, type FROM system.columns
WHERE database = 'default'
  AND ((table = 'views' AND name IN ('type', 'entityType'))
    OR (table = 'daily_views' AND name = 'entityType'))
ORDER BY table, name;

SELECT create_table_query FROM system.tables
WHERE database = 'default' AND name = 'daily_views_mv';
