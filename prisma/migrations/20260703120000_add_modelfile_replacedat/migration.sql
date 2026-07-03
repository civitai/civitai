-- Quarantine marker for files replaced by a linked component (see
-- docs/link-existing-files-quarantine-design.md). NULL = active file.
ALTER TABLE "ModelFile" ADD COLUMN "replacedAt" timestamptz;

-- Partial index: the purge job and read-path filters only ever look at rows
-- where replacedAt IS NOT NULL, so keep the index tiny. CONCURRENTLY cannot run
-- inside a transaction — apply this statement on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModelFile_replacedAt_idx"
  ON "ModelFile" ("replacedAt") WHERE "replacedAt" IS NOT NULL;
