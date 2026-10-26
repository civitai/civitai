-- The batch-draft-images-cleanup job selects composer drafts that were never scheduled: postless,
-- marked, older than the retention window, oldest first. Without this it walks every postless
-- image (1.3M+ rows) once a day. Apply BEFORE the job's first production run. CONCURRENTLY: run
-- outside a transaction.
-- IF NOT EXISTS also skips an INVALID index left by an interrupted build; after applying, check
-- pg_index.indisvalid, and if false, DROP INDEX CONCURRENTLY and run this again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Image_batchDraft_createdAt_idx"
  ON "Image" ("createdAt")
  WHERE "postId" IS NULL AND (metadata->>'batchDraft') = 'true';
