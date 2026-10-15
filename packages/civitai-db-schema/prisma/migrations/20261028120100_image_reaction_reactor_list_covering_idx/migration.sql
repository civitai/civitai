-- Image "who reacted" lists now filter on "createdAt", which none of the (imageId, userId) indexes
-- carry, so each row scanned costs a heap fetch. On an
-- image whose reactions mostly predate the lists, a page scans most of them. This covering index
-- lets the scan stay index-only.
--
-- MANUAL APPLY: optional for correctness, independent of deploy order. Large build (~777M rows).
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "ImageReaction_imageId_userId_createdAt_idx", then re-run.
-- Retiring the old "ImageReaction_imageId_userId_idx" afterwards is a separate decision.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ImageReaction_imageId_userId_createdAt_idx"
  ON "ImageReaction" ("imageId", "userId") INCLUDE (reaction, "createdAt");
