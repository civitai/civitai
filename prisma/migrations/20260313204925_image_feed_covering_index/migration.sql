-- Partial covering index for the default image feed query (getAllImages).
--
-- The feed query does ORDER BY i.id DESC LIMIT N with WHERE filters that
-- can't use existing indexes (bitwise nsfwLevel, ingestion, modelRestricted).
-- On the 106M-row Image table this causes Postgres to walk the PK index
-- backward, reading heap pages for every row to evaluate filters.
--
-- This index:
--   1. Filters out rows via partial WHERE (postId, needsReview, acceptableMinor)
--      so Postgres skips them during the index scan.
--   2. INCLUDEs columns checked in remaining WHERE conditions so Postgres can
--      evaluate them from the index leaf pages without heap access (index-only
--      or visibility-map-guided scan).
--
-- Expected size: ~3-4 GB for 106M rows (narrow: id + 7 included columns).

CREATE INDEX CONCURRENTLY "Image_feed_covering_idx"
  ON "Image" (id DESC)
  INCLUDE ("nsfwLevel", "ingestion", "modelRestricted", "userId", "poi", "minor", "type")
  WHERE "postId" IS NOT NULL
    AND "needsReview" IS NULL
    AND "acceptableMinor" = FALSE;
