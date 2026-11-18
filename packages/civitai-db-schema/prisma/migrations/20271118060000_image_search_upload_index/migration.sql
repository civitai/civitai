-- Search-by-upload rows (private, unposted Image rows marked with the searchUploadAppId metadata key).
-- search-upload-sweep finds them through this partial index; it skips its run until the index is valid.
-- CONCURRENTLY: apply outside a transaction. If it fails part-way, DROP INDEX CONCURRENTLY
-- "Image_searchUpload_idx" and run it again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Image_searchUpload_idx"
  ON "Image" ("createdAt")
  WHERE "postId" IS NULL AND (metadata ? 'searchUploadAppId');
