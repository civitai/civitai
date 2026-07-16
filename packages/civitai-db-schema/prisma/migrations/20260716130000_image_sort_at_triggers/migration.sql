-- Image.sortAt — PG becomes the author of the feed sort key.
--
-- Until now Image."sortAt" carried a client/DB default of now() and nothing ever
-- rewrote it: it was effectively dead. BitDex (and Meili) sort image feeds by
-- GREATEST(post.publishedAt, image.scannedAt, image.createdAt); BitDex has been
-- computing that itself, engine-side, and the recompute has been the source of
-- out-of-order and post-publish visibility bugs. This migration makes PG author
-- sortAt transactionally so the value is correct-by-construction and diffable
-- (PG.sortAt vs BitDex.sortAt is a reconcile query, not a forensic hunt).
--
-- Two triggers, deliberately disjoint so they never fight and never recurse:
--   1. set_image_sort_at()    BEFORE INSERT OR UPDATE OF scannedAt, postId ON "Image"
--      Owns changes originating on the Image row (insert, scan completion, an
--      image moving between posts). A BEFORE trigger writes the column in the
--      same row version — zero extra row updates.
--   2. update_image_sort_at() AFTER UPDATE OF publishedAt ON "Post"
--      Fans a Post publishedAt move (publish / schedule / reschedule / unpublish,
--      including the model + model-version publish/unpublish flows, which all
--      rewrite Post.publishedAt) out to every image on that post.
-- The Post fan-out writes only "sortAt"/"updatedAt"; the Image BEFORE trigger
-- fires only on {scannedAt, postId}. Disjoint column sets ⇒ the fan-out's UPDATE
-- does not re-fire the BEFORE trigger (no recursion), and even if it did both
-- paths compute the identical GREATEST value (idempotent). IS DISTINCT FROM on
-- the fan-out skips rows whose value is unchanged (no no-op row churn / redundant
-- downstream change-emissions). GREATEST ignores NULLs, so a draft / unpublished
-- / postless image (publishedAt NULL) collapses to GREATEST(scannedAt, createdAt)
-- — matching the engine semantics BitDex used before, with no sentinel.
--
-- These CREATE OR REPLACE statements mirror
--   packages/civitai-db-schema/prisma/programmability/image_post_triggers.sql
-- (re-applied on every `db:program` run); they are repeated here so a manual
-- apply of this migration alone installs them. The BEFORE trigger is created
-- BEFORE the column default is dropped so no INSERT window exists where sortAt
-- has neither a default nor a trigger to populate it.
--
-- MANUAL APPLY ONLY: the main civitai DB (CNPG nvme0) does NOT auto-apply Prisma
-- migrations. Apply this SQL by hand to the target env; _prisma_migrations is not
-- the source of truth here. Safe to run in a transaction (DDL only; no backfill —
-- existing rows keep their current sortAt until the separate backfill runs).

-- 0. Retire the 2024 predecessor (migration 20240719172747) --------------------
-- new_image_sort_at (AFTER UPDATE OF postId OR INSERT ON "Image") still writes
-- sortAt = coalesce(publishedAt, createdAt). As an AFTER trigger it would clobber
-- the value set_image_sort_at() computes below with the older, scannedAt-less
-- formula. The new BEFORE trigger is a strict superset of its firing conditions,
-- so drop it. (Its Post-side sibling update_image_sort_at() is REPLACED in place
-- below; post_published_at_change keeps its name.)
DROP TRIGGER IF EXISTS new_image_sort_at ON "Image";
DROP FUNCTION IF EXISTS update_new_image_sort_at();

-- 1. Per-row author -----------------------------------------------------------
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

CREATE OR REPLACE TRIGGER image_sort_at_before
  BEFORE INSERT OR UPDATE OF "scannedAt", "postId"
  ON "Image"
  FOR EACH ROW
EXECUTE FUNCTION set_image_sort_at();

-- 2. Post publishedAt fan-out author ------------------------------------------
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

CREATE OR REPLACE TRIGGER post_published_at_change
  AFTER UPDATE OF "publishedAt"
  ON "Post"
  FOR EACH ROW
  WHEN (NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt")
EXECUTE FUNCTION update_image_sort_at();

-- 3. Drop the literal default now that the BEFORE trigger owns the column ------
-- The Prisma field becomes @default(dbgenerated()): DB-authored, still NOT NULL,
-- still optional in the generated client (create() calls need not pass sortAt).
ALTER TABLE "Image" ALTER COLUMN "sortAt" DROP DEFAULT;
