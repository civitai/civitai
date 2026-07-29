-- Image."sortAt" is the feed sort key. PG is its author:
--   sortAt = GREATEST(post.publishedAt, image.scannedAt, image.createdAt)
-- GREATEST ignores NULLs, so a draft / unpublished / postless image (no
-- publishedAt) collapses to GREATEST(scannedAt, createdAt); createdAt is NOT
-- NULL so a value always results. This matches the formula the downstream feed
-- index (and Meili) already use — there is no sentinel, and visibility is still
-- gated elsewhere; this only fixes the sort *position*.
--
-- Two authors:
--   1. set_image_sort_at()   BEFORE INSERT OR UPDATE ON Image (ALL columns)
--      — recomputes NEW.sortAt on EVERY image write from the current Post +
--        NEW.scannedAt/createdAt. Correct-on-write: any touch of a row fixes its
--        sortAt before anything downstream reads it.
--   2. update_image_sort_at() AFTER UPDATE OF publishedAt ON Post
--      — fans a publishedAt move out to every image on the post.
--
-- Why the BEFORE trigger fires on ALL updates, not just {scannedAt, postId}:
-- there is deliberately NO backfill of the ~92M historical rows still holding a
-- stale default-now() sortAt (Zuri, 2026-07-16: 88.1% mismatch ⇒ ~92M-row
-- rewrite, 200-400GB WAL — cancelled). The sortAt column is NOT NULL, so a
-- COALESCE(NEW.sortAt, …) belt in the downstream bitdex sync trigger cannot fall
-- back — it would read and emit the stale value. Recomputing on every write means
-- an unrelated UPDATE (e.g. an nsfwLevel-only edit) repairs the row's sortAt
-- before the sync trigger's emission expression reads it. A column-listed trigger
-- would leave those rows stale until they happened to receive a scannedAt/postId
-- write.
--
-- Fight / recursion: the Post fan-out's UPDATE (sortAt, updatedAt) now DOES fire
-- the BEFORE trigger. No fight — at fan-out time the Post row already holds the
-- new publishedAt (AFTER trigger), so set_image_sort_at recomputes the IDENTICAL
-- GREATEST value the fan-out's SET clause used, and leaves updatedAt untouched. No
-- recursion — a BEFORE trigger only mutates NEW in place; it issues no new UPDATE.
-- The fan-out still WRITES sortAt (rather than only bumping updatedAt and letting
-- the BEFORE trigger compute it) because the bitdex sync trigger detects publish
-- changes via OLD≠NEW on the stored column; a purely-computed emission expression
-- would evaluate the Post subselect identically for OLD and NEW at fire time and
-- MISS the publish (rejected alternative).

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
-- 1. Per-row author. Reads the parent Post's publishedAt directly and restamps
--    sortAt on every image write — insert, scan completion, postId move, or any
--    other column edit (see the all-updates rationale in the header).
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
  BEFORE INSERT OR UPDATE
  ON "Image"
  FOR EACH ROW
EXECUTE FUNCTION set_image_sort_at();
---
-- 2. Fan-out author. A Post's publishedAt moving (publish, schedule, reschedule,
--    unpublish — including the model/version publish/unpublish flows, which all
--    rewrite Post.publishedAt) restamps every image on that post. It WRITES sortAt
--    (not a bare updatedAt touch) so the bitdex sync trigger sees OLD≠NEW on the
--    column and emits the publish change (see header). The BEFORE trigger re-fires
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
