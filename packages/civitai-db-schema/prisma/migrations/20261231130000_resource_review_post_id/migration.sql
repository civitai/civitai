-- ResourceReview.postId: the unpublished post a review was written from. The review stays hidden, and
-- the model owner is not notified, until that post is live. Deleting the post nulls the link.
-- ResourceReview.releasedAt: when such a review was announced (notified, recounted) after its post
-- went live; cleared when the post is unpublished.
--
-- MANUAL APPLY ONLY, in each environment, BEFORE the deploy that reads it (every review read joins on
-- the column). Run it with psql in autocommit mode, one statement at a time, NOT inside a transaction:
-- `CREATE INDEX CONCURRENTLY` refuses to run in a transaction block. Every statement is idempotent, so
-- re-running the file is safe.
--
-- The CONCURRENTLY index build runs with no lock timeout (`SET lock_timeout = 0`). If it fails or is
-- interrupted it leaves an INVALID index behind, which `IF NOT EXISTS` then skips. Check with
--   SELECT indisvalid FROM pg_index WHERE indexrelid = '"ResourceReview_postId_idx"'::regclass;
-- and if it is false, run `DROP INDEX CONCURRENTLY "ResourceReview_postId_idx";`, then the CREATE again.

SET lock_timeout = '3s';

-- Nullable with no default: metadata-only changes. No backfill: no existing review has a post.
ALTER TABLE "ResourceReview" ADD COLUMN IF NOT EXISTS "postId" INTEGER;
ALTER TABLE "ResourceReview" ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3);

-- Added without scanning (NOT VALID), then validated separately: VALIDATE takes a lock that does not
-- block reads or writes. Every existing row is NULL, so the validation finds nothing to check.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ResourceReview_postId_fkey') THEN
    ALTER TABLE "ResourceReview" ADD CONSTRAINT "ResourceReview_postId_fkey" FOREIGN KEY ("postId")
      REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE "ResourceReview" VALIDATE CONSTRAINT "ResourceReview_postId_fkey";

-- 0, not RESET: RESET restores a role or database default.
SET lock_timeout = 0;

-- Serves the post-delete SET NULL and the release lookup by post.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ResourceReview_postId_idx" ON "ResourceReview" ("postId");

-- Without fresh stats on the new column the per-minute review release sweep seq-scans the table until
-- autovacuum analyzes it. Run after the index; safe to repeat.
ANALYZE "ResourceReview" ("postId", "releasedAt");
