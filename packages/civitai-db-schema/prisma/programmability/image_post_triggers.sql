-- Image."sortAt" is the feed sort key. PG is its author:
--   sortAt = GREATEST(post.publishedAt, image.scannedAt, image.createdAt)
-- GREATEST ignores NULLs, so a draft / unpublished / postless image (no
-- publishedAt) collapses to GREATEST(scannedAt, createdAt); createdAt is NOT
-- NULL so a value always results. This matches the formula the downstream feed
-- index (and Meili) already use — there is no sentinel, and visibility is still
-- gated elsewhere; this only fixes the sort *position*.
--
-- Two authors, deliberately disjoint so they never fight and never recurse:
--   1. set_image_sort_at()   BEFORE INSERT OR UPDATE OF scannedAt, postId ON Image
--      — owns changes that originate on the Image row itself.
--   2. update_image_sort_at() AFTER UPDATE OF publishedAt ON Post
--      — fans a publishedAt move out to every image on the post.
-- The Post fan-out writes only "sortAt"/"updatedAt"; the Image BEFORE trigger
-- fires only on {scannedAt, postId}. Because those column sets are disjoint, the
-- fan-out's UPDATE does not re-fire the BEFORE trigger (no recursion), and even
-- if it did both paths compute the identical GREATEST value (idempotent).

-- Retire the 2024 predecessors (migration 20240719172747). Back then two authors
-- wrote sortAt: update_image_sort_at() (Post side, later neutered by this file to
-- an updatedAt-only body, now restored to author sortAt below) and
-- new_image_sort_at/update_new_image_sort_at() (Image side, AFTER UPDATE OF postId
-- OR INSERT, formula coalesce(publishedAt, createdAt)). The Image-side pair is NOT
-- present on prod (verified absent from pg_trigger/pg_proc) — so these DROPs are
-- no-ops there. They matter only on a dev/local DB where the old objects linger:
-- an AFTER trigger would clobber the value set_image_sort_at() computes below with
-- the older scannedAt-less formula. The new BEFORE trigger is a strict superset of
-- its firing conditions.
DROP TRIGGER IF EXISTS new_image_sort_at ON "Image";
---
DROP FUNCTION IF EXISTS update_new_image_sort_at();
---
-- 1. Per-row author. Reads the parent Post's publishedAt directly, so a fresh
--    insert, a scan completing (scannedAt bump), or an image moving between
--    posts (postId change) all restamp sortAt from the correct post.
CREATE OR REPLACE FUNCTION set_image_sort_at()
  RETURNS TRIGGER AS
$$
DECLARE
  post_published_at timestamptz;
BEGIN
  IF NEW."postId" IS NOT NULL THEN
    SELECT p."publishedAt" INTO post_published_at
    FROM "Post" p
    WHERE p.id = NEW."postId";
  END IF;
  NEW."sortAt" := GREATEST(post_published_at, NEW."scannedAt", NEW."createdAt");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER image_sort_at_before
  BEFORE INSERT OR UPDATE OF "scannedAt", "postId"
  ON "Image"
  FOR EACH ROW
EXECUTE FUNCTION set_image_sort_at();
---
-- 2. Fan-out author. A Post's publishedAt moving (publish, schedule, reschedule,
--    unpublish — including the model/version publish/unpublish flows, which all
--    rewrite Post.publishedAt) restamps every image on that post. Computed
--    inline once here (not a bare touch) because the Image BEFORE trigger does
--    NOT fire on a sortAt-only UPDATE — its column list is {scannedAt, postId}.
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
  SET "sortAt" = GREATEST(NEW."publishedAt", "scannedAt", "createdAt"),
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
