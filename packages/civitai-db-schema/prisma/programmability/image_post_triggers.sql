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

-- Retire the 2024 predecessors (migration 20240719172747). Two authors wrote
-- sortAt back then: update_image_sort_at() (Post side, later neutered by this
-- file to an updatedAt-only body) and new_image_sort_at/update_new_image_sort_at()
-- (Image side, AFTER UPDATE OF postId OR INSERT, formula coalesce(publishedAt,
-- createdAt)). The Image-side pair was never replaced and is still live: as an
-- AFTER trigger it would OVERWRITE the value set_image_sort_at() computes below,
-- with the older scannedAt-less formula. Drop it so the new BEFORE trigger — a
-- strict superset of its firing conditions — is the sole Image-side author.
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
--    IS DISTINCT FROM skips rows whose value is unchanged, avoiding no-op row
--    churn (and the redundant downstream change-emissions it would cause). The
--    "updatedAt" bump is preserved from the previous version of this function so
--    the existing search-index change signal keyed on it is not lost.
CREATE OR REPLACE FUNCTION update_image_sort_at()
  RETURNS TRIGGER AS
$$
BEGIN
  UPDATE "Image"
  SET "sortAt" = GREATEST(NEW."publishedAt", "scannedAt", "createdAt"),
      "updatedAt" = now()
  WHERE "postId" = NEW."id"
    AND "sortAt" IS DISTINCT FROM GREATEST(NEW."publishedAt", "scannedAt", "createdAt");
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
