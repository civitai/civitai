-- Image."firstVisibleAt": when the row first passed the public feed gates. set_image_sort_at
-- stamps it once and adds it to sortAt while it falls within 7 days of the post's publish, so an
-- image held from upload and released later sorts at its release instead of far back in the feed.
-- The function bodies below are copied from programmability/image_post_triggers.sql; keep them equal.
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production. The column is `@no-type` (raw SQL only), so Prisma never selects it and the code may
-- deploy before or after this runs.
--
-- Before applying, check which publications carry "Image" (pg_publication_tables) and with which
-- columns: a publication of "Image" without a column list would ship the new column, and its
-- subscribers then need the column added FIRST.
--
-- A nullable column with no default is a catalog-only change: no table rewrite. No backfill: rows
-- that exist when this runs stay NULL and are fenced off by image_first_visible_min_id(), which
-- records the highest "Image".id at apply time, so they keep today's sort. The short lock_timeout
-- keeps a waiting ALTER from queueing every query on "Image" behind it; on a timeout nothing is
-- applied, so re-run it. Idempotent.

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "firstVisibleAt" TIMESTAMP(3);

-- 0. Shared pieces.
--
-- The public feed's row-level gates (getAllImages): no review flag, not acceptableMinor, a
-- browsable level, reviewed (imageReviewedSql), not blocked, not a ToS removal. Per-viewer
-- rules (browsing level choice, restricted models, POI opt-out) are not row facts and stay out.
-- image-first-visible-sort-at.pglite.test.ts fails if this and the TS helpers disagree.
CREATE OR REPLACE FUNCTION image_row_public(
  ingestion "ImageIngestionStatus", needs_review text, blocked_for text, tos_violation boolean,
  acceptable_minor boolean, nsfw_level int, nsfw_level_locked boolean, metadata jsonb,
  scan_jobs jsonb
) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS
$$
SELECT COALESCE(
  needs_review IS NULL
  AND NOT acceptable_minor
  AND (nsfw_level & 31) <> 0
  AND blocked_for IS NULL
  AND NOT tos_violation
  AND (
    ingestion = 'Scanned'
    OR (
      nsfw_level_locked
      AND ingestion NOT IN ('Blocked', 'NotFound')
      AND NOT (
        ingestion = 'Error'
        AND (
          COALESCE(metadata->>'nsfwLevelReason', '') = 'Knights Vote'
          OR COALESCE(scan_jobs->'error'->>'failureClass', '') = 'permanent'
          OR COALESCE(scan_jobs->'lastFailure'->>'failureClass', '') = 'permanent'
          OR COALESCE(scan_jobs->'permanentFailure' = 'true'::jsonb, FALSE)
        )
      )
    )
  ),
  FALSE
)
$$;
---
-- The highest Image id when firstVisibleAt was introduced. Rows at or below it predate the
-- column, so whether they were ever served is unknown: they never get a firstVisibleAt and
-- keep the old sort. Created once per database, at apply time; re-running keeps the value.
DO
$$
BEGIN
  IF to_regprocedure('image_first_visible_min_id()') IS NULL THEN
    EXECUTE format(
      'CREATE FUNCTION image_first_visible_min_id() RETURNS int LANGUAGE sql IMMUTABLE AS %L',
      'SELECT ' || (SELECT COALESCE(max(id), 0) FROM "Image")
    );
  END IF;
END
$$;
---
-- The sort rule both authors below use. A first visibility more than 7 days after publish
-- (the release cap, a product default) does not move the image.
CREATE OR REPLACE FUNCTION image_sort_at(
  published_at timestamp, scanned_at timestamp, created_at timestamp, first_visible_at timestamp
) RETURNS timestamp
  LANGUAGE sql IMMUTABLE AS
$$
SELECT GREATEST(
  published_at, scanned_at, created_at,
  CASE WHEN first_visible_at <= published_at + interval '7 days' THEN first_visible_at END
)
$$;
---
-- 1. Per-row author. Reads the parent Post's publishedAt directly and restamps
--    sortAt on every image write — insert, scan completion, postId move, or any
--    other column edit (see the all-updates rationale in the header).
--    It also owns firstVisibleAt: set the first time the row turns public, never
--    changed after, and any client write to it is discarded.
CREATE OR REPLACE FUNCTION set_image_sort_at()
  RETURNS TRIGGER AS
$$
DECLARE
  post_published_at timestamp;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."firstVisibleAt" := NULL;
  ELSE
    NEW."firstVisibleAt" := OLD."firstVisibleAt";
  END IF;
  IF NEW."firstVisibleAt" IS NULL
    AND NEW.id > image_first_visible_min_id()
    AND image_row_public(NEW.ingestion, NEW."needsReview", NEW."blockedFor", NEW."tosViolation",
      NEW."acceptableMinor", NEW."nsfwLevel", NEW."nsfwLevelLocked", NEW.metadata, NEW."scanJobs")
    AND (
      TG_OP = 'INSERT'
      OR NOT image_row_public(OLD.ingestion, OLD."needsReview", OLD."blockedFor",
        OLD."tosViolation", OLD."acceptableMinor", OLD."nsfwLevel", OLD."nsfwLevelLocked",
        OLD.metadata, OLD."scanJobs")
    )
  THEN
    NEW."firstVisibleAt" := now();
  END IF;

  IF NEW."postId" IS NOT NULL THEN
    SELECT p."publishedAt" INTO post_published_at
    FROM "Post" p
    WHERE p.id = NEW."postId";
  END IF;
  NEW."sortAt" := image_sort_at(post_published_at, NEW."scannedAt", NEW."createdAt",
    NEW."firstVisibleAt");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER image_sort_at_before
  BEFORE INSERT OR UPDATE
  ON "Image"
  FOR EACH ROW
EXECUTE FUNCTION set_image_sort_at();
---
-- 2. Fan-out author. A Post's publishedAt moving (publish, schedule, reschedule,
--    unpublish — including the model/version publish/unpublish flows, which all
--    rewrite Post.publishedAt) restamps every image on that post. It WRITES sortAt
--    (not a bare updatedAt touch); see the header note on why that write is kept
--    now its original consumer is gone. The BEFORE trigger re-fires
--    on this UPDATE and recomputes the same value — harmless.
--    UNCONDITIONAL (no IS DISTINCT FROM guard): every image on the post gets its
--    "updatedAt" bumped even when sortAt is unchanged. Meili's incremental image
--    sync selects `WHERE updatedAt > lastUpdate` (images.search-index.ts:298-304),
--    so a publishedAt move that leaves sortAt unchanged (e.g. unpublish of a post
--    whose images have scannedAt > publishedAt) must still bump updatedAt or Meili
--    never re-syncs the publish-state change. Write volume is identical to the
--    prior prod trigger, which also bumped all post images unconditionally.
CREATE OR REPLACE FUNCTION update_image_sort_at()
  RETURNS TRIGGER AS
$$
BEGIN
  UPDATE "Image"
  SET "sortAt" = image_sort_at(NEW."publishedAt", "scannedAt", "createdAt", "firstVisibleAt"),
      "updatedAt" = now()
  WHERE "postId" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER post_published_at_change
  AFTER UPDATE OF "publishedAt"
  ON "Post"
  FOR EACH ROW
  WHEN (NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt")
EXECUTE FUNCTION update_image_sort_at();

COMMIT;
